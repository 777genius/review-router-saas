// @vitest-environment jsdom
import { useEffect, useState, type ReactNode } from "react";
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
import { confirmSetupPullRequestMergedClientAction } from "./actions";
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
    fireEvent.click(screen.getByRole("button", { name: "I ran this script" }));

    expect(
      await screen.findByText(/Provider secret metadata was verified/i),
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

    const renderCustomToast = vi.mocked(toast.custom).mock.calls.at(-1)?.[0] as
      | ((id: string | number) => ReactNode)
      | undefined;
    expect(renderCustomToast).toBeTruthy();

    render(<>{renderCustomToast!("setup-action-toast")}</>);
    expect(
      screen.getByText(/GitHub refused the setup PR update/i),
    ).toBeTruthy();
    expect(
      screen.queryByText("The dashboard action could not be completed."),
    ).toBeNull();
  });
});

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

function providerSetupResponse(body: {
  readonly params: Record<string, string>;
}): Response {
  return {
    ok: true,
    json: async () => body,
  } as Response;
}
