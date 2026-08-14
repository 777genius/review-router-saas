// @vitest-environment jsdom
import { useEffect, useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type { ProviderSecretSetupGuidance } from "@reviewrouter/features-provider-setup";
import { ProviderSecretSetupDialog } from "./provider-secret-setup-dialog";
import {
  confirmSetupPullRequestMergedClientAction,
  createSetupPullRequestClientAction,
} from "./actions";
import { RepositorySetupProgressPanel } from "./repository-setup-progress-panel";
import {
  providerSetupConfirmedEvent,
  setupPullRequestMergedEvent,
} from "./repository-setup-optimistic-events";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("sonner", () => ({
  toast: {
    custom: vi.fn(),
    dismiss: vi.fn(),
  },
}));

vi.mock("./actions", () => ({
  confirmSetupPullRequestMergedClientAction: vi.fn(),
  createSetupPullRequestClientAction: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  cleanup();
});

describe("RepositorySetupProgressPanel", () => {
  it("exposes rotating preparation before the first setup PR", () => {
    render(
      <RepositorySetupProgressPanel
        workspaceId="workspace_1"
        repositoryId="repo_1"
        repositoryFullName="777genius/example"
        selected
        archived={false}
        initialSetupStatus="not_configured"
        initialSetupPullRequestUrl={null}
        workflowCurrent={false}
        mutationsEnabled
        initialStep={1}
        providerSetupBeforeWorkflow
        enableReviewAction={
          <button type="button">Set up versioned provider</button>
        }
      />,
    );

    expect(screen.getByText("1 of 4 - prepare versioned setup")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Set up versioned provider" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Create setup PR/i }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Seed the versioned provider namespace, then add its workflow by PR.",
      ),
    ).toBeTruthy();
  });

  it("keeps generic provider setup locked until after merge", () => {
    render(
      <RepositorySetupProgressPanel
        workspaceId="workspace_1"
        repositoryId="repo_1"
        repositoryFullName="777genius/example"
        selected
        archived={false}
        initialSetupStatus="not_configured"
        initialSetupPullRequestUrl={null}
        workflowCurrent={false}
        mutationsEnabled
        initialStep={1}
        enableReviewAction={<button type="button">Connect provider</button>}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Connect provider" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Enable review" }),
    ).toHaveProperty("disabled", true);
  });

  it("keeps the real provider dialog open when confirmation advances progress", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        providerSetupResponse({
          params: {
            notice: "provider_setup_confirmed",
            workspace: "workspace_1",
            section: "repositories",
            repository: "777genius/example",
          },
        }),
      ),
    );

    render(
      <RepositorySetupProgressPanel
        workspaceId="workspace_1"
        repositoryId="repo_1"
        repositoryFullName="777genius/example"
        selected
        archived={false}
        initialSetupStatus="configured"
        initialSetupPullRequestUrl={null}
        workflowCurrent
        mutationsEnabled
        initialStep={3}
        enableReviewAction={
          <ProviderSecretSetupDialog
            workspaceId="workspace_1"
            repositoryId="repo_1"
            repositoryFullName="777genius/example"
            repositoryVisibility="public"
            organizationLogin={null}
            organizationSecretPolicy={null}
            guidanceSet={{
              codexOAuthRotating: rotatingGuidance(),
              codexOAuth: guidance("CODEX_AUTH_JSON"),
              codexApiKey: guidance("OPENAI_API_KEY"),
              claudeCodeOAuth: guidance("CLAUDE_CODE_OAUTH_TOKEN"),
              openRouterApiKey: guidance("OPENROUTER_API_KEY"),
            }}
            triggerLabel="Enable review"
          />
        }
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Enable review" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Verify versioned setup" }),
    );

    expect(
      await screen.findByText(/Authorized versioned setup is active/i),
    ).toBeTruthy();
    expect(screen.getByText("4 of 4 - complete")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Close provider secrets dialog" }),
    ).toBeTruthy();
  });

  it("keeps the provider dialog mounted when provider confirmation advances progress", async () => {
    let actionUnmounts = 0;

    function StatefulEnableReviewAction(): React.ReactElement {
      const [open, setOpen] = useState(false);
      useEffect(() => {
        return () => {
          actionUnmounts += 1;
        };
      }, []);

      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Enable review
          </button>
          {open ? <div>Provider dialog still open</div> : null}
        </>
      );
    }

    render(
      <RepositorySetupProgressPanel
        workspaceId="workspace_1"
        repositoryId="repo_1"
        repositoryFullName="777genius/example"
        selected
        archived={false}
        initialSetupStatus="configured"
        initialSetupPullRequestUrl={null}
        workflowCurrent
        mutationsEnabled
        initialStep={3}
        enableReviewAction={<StatefulEnableReviewAction />}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Enable review" }));
    expect(screen.getByText("Provider dialog still open")).toBeTruthy();

    window.dispatchEvent(
      providerSetupConfirmedEvent({
        repositoryId: "repo_1",
        repositoryFullName: "777genius/example",
      }),
    );

    await waitFor(() => {
      expect(screen.getByText("4 of 4 - complete")).toBeTruthy();
    });
    expect(screen.getByText("Provider dialog still open")).toBeTruthy();
    expect(actionUnmounts).toBe(0);
  });

  it("allows a rotating provider namespace to refresh its merged workflow", async () => {
    vi.mocked(createSetupPullRequestClientAction).mockResolvedValueOnce({
      params: {
        notice: "setup_pr_ready",
        repository: "777genius/example",
        pr: "https://github.com/777genius/example/pull/2",
      },
    });

    render(
      <RepositorySetupProgressPanel
        workspaceId="workspace_1"
        repositoryId="repo_1"
        repositoryFullName="777genius/example"
        selected
        archived={false}
        initialSetupStatus="configured"
        initialSetupPullRequestUrl={null}
        workflowCurrent
        mutationsEnabled
        initialStep={3}
        enableReviewAction={<button type="button">Set up provider</button>}
        providerSetupBeforeWorkflow
      />,
    );

    const updateForm = screen
      .getByRole("button", { name: "Update setup PR" })
      .closest("form");
    expect(updateForm).toBeTruthy();
    updateForm!.requestSubmit();

    expect(await screen.findByText("2 of 4 - merge setup PR")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Open setup PR/i })).toBeTruthy();
  });

  it("does not advance progress for a provider setup outside the effective config", () => {
    render(
      <RepositorySetupProgressPanel
        workspaceId="workspace_1"
        repositoryId="repo_1"
        repositoryFullName="777genius/example"
        selected
        archived={false}
        initialSetupStatus="configured"
        initialSetupPullRequestUrl={null}
        workflowCurrent
        mutationsEnabled
        initialStep={3}
        expectedProviderAuthModes={["codex_subscription_oauth_rotating"]}
        enableReviewAction={<button type="button">Enable review</button>}
      />,
    );

    window.dispatchEvent(
      providerSetupConfirmedEvent({
        repositoryId: "repo_1",
        repositoryFullName: "777genius/example",
        providerKind: "openrouter",
        authMode: "openrouter_api_key",
      }),
    );

    expect(screen.getByText("3 of 4 - enable review")).toBeTruthy();
  });

  it("does not advance multi-auth progress after a single provider confirmation", () => {
    render(
      <RepositorySetupProgressPanel
        workspaceId="workspace_1"
        repositoryId="repo_1"
        repositoryFullName="777genius/example"
        selected
        archived={false}
        initialSetupStatus="configured"
        initialSetupPullRequestUrl={null}
        workflowCurrent
        mutationsEnabled
        initialStep={3}
        expectedProviderAuthModes={["openrouter_api_key", "claude_code_oauth"]}
        enableReviewAction={<button type="button">Enable review</button>}
      />,
    );

    window.dispatchEvent(
      providerSetupConfirmedEvent({
        repositoryId: "repo_1",
        repositoryFullName: "777genius/example",
        providerKind: "openrouter",
        authMode: "openrouter_api_key",
      }),
    );

    expect(screen.getByText("3 of 4 - enable review")).toBeTruthy();
  });

  it("advances multi-auth progress after all expected providers are confirmed", async () => {
    render(
      <RepositorySetupProgressPanel
        workspaceId="workspace_1"
        repositoryId="repo_1"
        repositoryFullName="777genius/example"
        selected
        archived={false}
        initialSetupStatus="configured"
        initialSetupPullRequestUrl={null}
        workflowCurrent
        mutationsEnabled
        initialStep={3}
        expectedProviderAuthModes={["openrouter_api_key", "claude_code_oauth"]}
        enableReviewAction={<button type="button">Enable review</button>}
      />,
    );

    window.dispatchEvent(
      providerSetupConfirmedEvent({
        repositoryId: "repo_1",
        repositoryFullName: "777genius/example",
        providerKind: "openrouter",
        authMode: "openrouter_api_key",
      }),
    );
    expect(screen.getByText("3 of 4 - enable review")).toBeTruthy();

    window.dispatchEvent(
      providerSetupConfirmedEvent({
        repositoryId: "repo_1",
        repositoryFullName: "777genius/example",
        providerKind: "claude",
        authMode: "claude_code_oauth",
      }),
    );

    await waitFor(() => {
      expect(screen.getByText("4 of 4 - complete")).toBeTruthy();
    });
  });

  it("keeps the provider action available for rows that are already complete", () => {
    let actionMounts = 0;

    function MountedAction(): React.ReactElement {
      useEffect(() => {
        actionMounts += 1;
      }, []);

      return <button type="button">Enable review</button>;
    }

    render(
      <RepositorySetupProgressPanel
        workspaceId="workspace_1"
        repositoryId="repo_1"
        repositoryFullName="777genius/example"
        selected
        archived={false}
        initialSetupStatus="configured"
        initialSetupPullRequestUrl={null}
        workflowCurrent
        mutationsEnabled
        initialStep={4}
        enableReviewAction={<MountedAction />}
      />,
    );

    expect(screen.getByRole("button", { name: "Enable review" })).toBeTruthy();
    expect(actionMounts).toBe(1);
  });

  it("advances to provider setup when merge confirmation is detected in the background", async () => {
    render(
      <RepositorySetupProgressPanel
        workspaceId="workspace_1"
        repositoryId="repo_1"
        repositoryFullName="777genius/example"
        selected
        archived={false}
        initialSetupStatus="setup_pr_open"
        initialSetupPullRequestUrl="https://github.com/777genius/example/pull/1"
        workflowCurrent={false}
        mutationsEnabled
        initialStep={2}
        enableReviewAction={<button type="button">Enable review</button>}
      />,
    );

    window.dispatchEvent(
      setupPullRequestMergedEvent({ repositoryId: "repo_1" }),
    );

    await waitFor(() => {
      expect(screen.getByText("3 of 4 - enable review")).toBeTruthy();
    });
    expect(screen.getByRole("button", { name: "Enable review" })).toBeTruthy();
  });

  it("shows a recovery action when the saved setup PR was closed", () => {
    render(
      <RepositorySetupProgressPanel
        workspaceId="workspace_1"
        repositoryId="repo_1"
        repositoryFullName="777genius/example"
        selected
        archived={false}
        initialSetupStatus="needs_attention"
        initialSetupPullRequestUrl="https://github.com/777genius/example/pull/1"
        initialSetupIssue="setup_pr_closed"
        workflowCurrent={false}
        mutationsEnabled
        initialStep={1}
        enableReviewAction={<button type="button">Enable review</button>}
      />,
    );

    expect(screen.getByText("Recover setup PR")).toBeTruthy();
    expect(
      screen.getByText("Previous setup PR was closed. Recreate it."),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Recreate setup PR/i }),
    ).toBeTruthy();
  });

  it("turns a deleted setup branch merge check into a recovery step", async () => {
    vi.mocked(confirmSetupPullRequestMergedClientAction).mockResolvedValueOnce({
      params: {
        error: "setup_pr_branch_deleted",
        workspace: "workspace_1",
        section: "repositories",
      },
    });

    render(
      <RepositorySetupProgressPanel
        workspaceId="workspace_1"
        repositoryId="repo_1"
        repositoryFullName="777genius/example"
        selected
        archived={false}
        initialSetupStatus="setup_pr_open"
        initialSetupPullRequestUrl="https://github.com/777genius/example/pull/1"
        workflowCurrent={false}
        mutationsEnabled
        initialStep={2}
        enableReviewAction={<button type="button">Enable review</button>}
      />,
    );

    const mergeForm = screen
      .getByRole("button", { name: "I merged it" })
      .closest("form");
    expect(mergeForm).toBeTruthy();

    mergeForm!.requestSubmit();

    expect(
      await screen.findByText("Setup PR branch was deleted. Recreate it."),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Recreate setup PR/i }),
    ).toBeTruthy();
  });

  it("shows a specific GitHub permission error for setup actions", async () => {
    vi.mocked(confirmSetupPullRequestMergedClientAction).mockResolvedValueOnce({
      params: {
        error: "github_operation_forbidden",
        workspace: "workspace_1",
        section: "repositories",
      },
    });

    render(
      <RepositorySetupProgressPanel
        workspaceId="workspace_1"
        repositoryId="repo_1"
        repositoryFullName="777genius/example"
        selected
        archived={false}
        initialSetupStatus="setup_pr_open"
        initialSetupPullRequestUrl="https://github.com/777genius/example/pull/1"
        workflowCurrent={false}
        mutationsEnabled
        initialStep={2}
        enableReviewAction={<button type="button">Enable review</button>}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "I merged it" }));

    await waitFor(() => {
      expect(toast.custom).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(
        hasCustomToastMessage(
          /GitHub refused the setup PR update/i,
          "The dashboard action could not be completed.",
        ),
      ).toBe(true);
    });
  });

  it("shows Codex reconnect guidance for legacy setup PR actions", async () => {
    vi.mocked(createSetupPullRequestClientAction).mockResolvedValueOnce({
      params: {
        error: "codex_legacy_auth_requires_reconnect",
        workspace: "workspace_1",
        section: "repositories",
      },
    });

    render(
      <RepositorySetupProgressPanel
        workspaceId="workspace_1"
        repositoryId="repo_1"
        repositoryFullName="777genius/example"
        selected
        archived={false}
        initialSetupStatus="not_configured"
        initialSetupPullRequestUrl={null}
        workflowCurrent={false}
        mutationsEnabled
        initialStep={1}
        enableReviewAction={<button type="button">Enable review</button>}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Create setup PR/i }));

    await waitFor(() => {
      expect(
        hasCustomToastMessage(
          /Reconnect Codex with the rotating setup command/i,
          "The dashboard action could not be completed.",
        ),
      ).toBe(true);
    });
  });

  it("shows stale dashboard guidance when a server action id changed after deploy", async () => {
    vi.mocked(confirmSetupPullRequestMergedClientAction).mockRejectedValueOnce(
      new Error("Failed to find Server Action"),
    );

    render(
      <RepositorySetupProgressPanel
        workspaceId="workspace_1"
        repositoryId="repo_1"
        repositoryFullName="777genius/example"
        selected
        archived={false}
        initialSetupStatus="setup_pr_open"
        initialSetupPullRequestUrl="https://github.com/777genius/example/pull/1"
        workflowCurrent={false}
        mutationsEnabled
        initialStep={2}
        enableReviewAction={<button type="button">Enable review</button>}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "I merged it" }));

    await waitFor(() => {
      expect(
        hasCustomToastMessage(
          /dashboard was updated while this page was open/i,
          "inspect server logs",
        ),
      ).toBe(true);
    });
  });
});

function hasCustomToastMessage(expected: RegExp, forbidden: string): boolean {
  type ToastRenderer = Parameters<typeof toast.custom>[0];
  const renderers = vi
    .mocked(toast.custom)
    .mock.calls.map((call) => call[0])
    .filter(
      (renderer): renderer is ToastRenderer => typeof renderer === "function",
    );

  return renderers.some((renderer, index) => {
    const rendered = render(<>{renderer(`setup-action-toast-${index}`)}</>);
    const matched =
      rendered.queryByText(expected) !== null &&
      rendered.queryByText(forbidden) === null;
    rendered.unmount();
    return matched;
  });
}

function guidance(secretName: string): ProviderSecretSetupGuidance {
  return {
    provider:
      secretName === "CODEX_AUTH_JSON"
        ? "codex_oauth"
        : secretName === "OPENAI_API_KEY"
          ? "openai_api_key"
          : secretName === "CLAUDE_CODE_OAUTH_TOKEN"
            ? "claude_code_oauth"
            : "openrouter_api_key",
    recommendedScope: "repository",
    commands: [
      {
        scope: "repository",
        title: "Repository secret",
        description: `Stores ${secretName} directly in this repository.`,
        command: `gh secret set ${secretName} --repo 777genius/example`,
        storesSecretIn: "github_repository_secret",
        targetLabel: "777genius/example repository secret",
        secretNames: [secretName],
        selectedRepositories: ["777genius/example"],
        validatesBeforeWrite: false,
        failureRecovery: "Retry the command.",
        sendsSecretToReviewRouter: false,
      },
    ],
    warnings: [],
  };
}

function rotatingGuidance(): ProviderSecretSetupGuidance {
  return {
    provider: "codex_oauth_rotating",
    recommendedScope: "repository",
    commands: [
      {
        scope: "repository",
        title: "Versioned repository setup",
        description: "Claims one server-authorized versioned setup attempt.",
        command: "set -euo pipefail\n# versioned rotating installer",
        storesSecretIn: "github_repository_secret",
        targetLabel: "777genius/example repository secret",
        secretNames: ["Server-authorized versioned secret"],
        selectedRepositories: ["777genius/example"],
        validatesBeforeWrite: true,
        failureRecovery: "Recover through the versioned setup flow.",
        sendsSecretToReviewRouter: false,
      },
    ],
    warnings: [],
  };
}

function providerSetupResponse(body: {
  readonly params: Record<string, string>;
}): Response {
  return {
    ok: true,
    json: async () => body,
  } as Response;
}
