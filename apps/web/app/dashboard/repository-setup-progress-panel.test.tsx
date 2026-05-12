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
import type { ProviderSecretSetupGuidance } from "@reviewrouter/features-provider-setup";
import { ProviderSecretSetupDialog } from "./provider-secret-setup-dialog";
import { RepositorySetupProgressPanel } from "./repository-setup-progress-panel";
import { providerSetupConfirmedEvent } from "./repository-setup-optimistic-events";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
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
      await screen.findByText(/Provider setup is marked complete/i),
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

  it("does not mount a hidden provider action for rows that are already complete", () => {
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

    expect(screen.queryByRole("button", { name: "Enable review" })).toBeNull();
    expect(actionMounts).toBe(0);
  });
});

function guidance(secretName: string): ProviderSecretSetupGuidance {
  return {
    provider:
      secretName === "CODEX_AUTH_JSON"
        ? "codex_oauth"
        : secretName === "OPENAI_API_KEY"
          ? "openai_api_key"
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
