// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderSecretSetupGuidance } from "@reviewrouter/features-provider-setup";
import { ProviderSecretSetupChooser } from "./provider-secret-setup-chooser";
import { ProviderSecretSetupDialog } from "./provider-secret-setup-dialog";
import type { OrganizationSecretPolicy } from "./provider-secret-setup-chooser";
import {
  checkProviderSecretStatusWithCache,
  clearProviderSecretStatusCacheForTest,
} from "./provider-secret-status-cache";
import {
  providerSetupConfirmedEventName,
  type ProviderSetupConfirmedEventDetail,
} from "./repository-setup-optimistic-events";

const routerMock = vi.hoisted(() => ({
  refresh: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  clearProviderSecretStatusCacheForTest();
  cleanup();
});

function pageText(): string {
  return document.body.textContent?.replace(/\s+/g, " ") ?? "";
}

describe("ProviderSecretSetupChooser", () => {
  it("keeps provider setup errors inside the dialog when the action rejects", async () => {
    mockProviderSetupFetch().mockRejectedValueOnce(
      new Error("provider setup failed"),
    );

    renderProviderSecretSetupChooser();

    fireEvent.click(screen.getByRole("button", { name: "I ran this script" }));

    expect(
      await screen.findByText(/The dashboard action failed/i),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "I ran this script" }),
    ).toBeTruthy();
    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(routerMock.refresh).not.toHaveBeenCalled();
  });

  it("shows manual confirmation when automatic verification cannot read GitHub secrets", async () => {
    mockProviderSetupFetch().mockResolvedValueOnce(
      providerSetupResponse({
        params: {
          error: "provider_secret_check_permission_required",
          workspace: "workspace_1",
          section: "repositories",
        },
      }),
    );

    renderProviderSecretSetupChooser();

    fireEvent.click(screen.getByRole("button", { name: "I ran this script" }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Confirm manually" }),
      ).toBeTruthy();
    });
    expect(
      screen.getByText(
        /could not verify GitHub secret metadata automatically/i,
      ),
    ).toBeTruthy();
    expect(routerMock.replace).not.toHaveBeenCalled();
  });

  it("keeps verification mode when the repository secret is missing", async () => {
    mockProviderSetupFetch().mockResolvedValueOnce(
      providerSetupResponse({
        params: {
          error: "provider_secret_not_found",
          workspace: "workspace_1",
          section: "repositories",
        },
      }),
    );

    renderProviderSecretSetupChooser();

    fireEvent.click(screen.getByRole("button", { name: "I ran this script" }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Check secrets again" }),
      ).toBeTruthy();
    });
    expect(
      screen.getByText(
        /was not found in 777genius\/plugin-kit-ai-starter-claude-python repository Actions secrets/i,
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Confirm manually" }),
    ).toBeNull();
  });

  it("explains when an organization secret is not selected for this repository", async () => {
    mockProviderSetupFetch().mockResolvedValueOnce(
      providerSetupResponse({
        params: {
          error: "provider_secret_not_available_to_repository",
          workspace: "workspace_1",
          section: "repositories",
        },
      }),
    );

    renderProviderSecretSetupChooser({ organizationLogin: "agent-teams-ai" });

    fireEvent.click(screen.getByRole("button", { name: "I ran this script" }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Check secrets again" }),
      ).toBeTruthy();
    });
    expect(screen.getByText(/not selected for access/i)).toBeTruthy();
    expect(screen.getByText(/Repository access settings/i)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Confirm manually" }),
    ).toBeNull();
  });

  it("lets users choose private or all organization secret commands", () => {
    renderProviderSecretSetupChooser({ organizationLogin: "agent-teams-ai" });

    fireEvent.click(
      screen.getByTestId("provider-scope-organization_private_repositories"),
    );
    expect(pageText()).toContain(
      "gh secret set CODEX_AUTH_JSON --org agent-teams-ai --visibility private --app actions",
    );

    fireEvent.click(
      screen.getByTestId("provider-scope-organization_all_repositories"),
    );
    expect(pageText()).toContain(
      "gh secret set CODEX_AUTH_JSON --org agent-teams-ai --visibility all --app actions",
    );
  });

  it("disables organization secret scopes for private repositories on a free organization plan", () => {
    renderProviderSecretSetupChooser({
      organizationLogin: "agent-teams-ai",
      repositoryVisibility: "private",
      organizationSecretPolicy: {
        planName: "free",
        privateRepositoriesAvailable: false,
        status: "available",
      },
    });

    expect(
      (
        screen.getByTestId(
          "provider-scope-organization_selected_repositories",
        ) as HTMLInputElement
      ).disabled,
    ).toBe(true);
    expect(
      screen.getByText(/do not make organization secrets available/i),
    ).toBeTruthy();
    expect(pageText()).toContain(
      "gh secret set CODEX_AUTH_JSON --repo 777genius/plugin-kit-ai-starter-claude-python",
    );
  });

  it("shows a final confirmed state after manual confirmation succeeds", async () => {
    mockProviderSetupFetch()
      .mockResolvedValueOnce(
        providerSetupResponse({
          params: {
            error: "provider_secret_check_permission_required",
            workspace: "workspace_1",
            section: "repositories",
          },
        }),
      )
      .mockResolvedValueOnce(
        providerSetupResponse({
          params: {
            notice: "provider_setup_confirmed",
            workspace: "workspace_1",
            section: "repositories",
            repository: "777genius/plugin-kit-ai-starter-claude-python",
          },
        }),
      );

    renderProviderSecretSetupChooser();

    fireEvent.click(screen.getByRole("button", { name: "I ran this script" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Confirm manually" }),
    );

    expect(
      await screen.findByText(/Provider setup was manually marked complete/i),
    ).toBeTruthy();
    expect(
      screen.getByText(/did not verify GitHub secret metadata automatically/i),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Confirmed" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.queryByText(/Could not verify automatically/i)).toBeNull();
  });

  it("confirms provider setup in place and emits an optimistic progress event", async () => {
    mockProviderSetupFetch().mockResolvedValueOnce(
      providerSetupResponse({
        params: {
          notice: "provider_setup_confirmed",
          workspace: "workspace_1",
          section: "repositories",
          repository: "777genius/plugin-kit-ai-starter-claude-python",
        },
      }),
    );
    const providerSetupConfirmed = vi.fn();
    window.addEventListener(
      providerSetupConfirmedEventName,
      providerSetupConfirmed,
    );

    try {
      renderProviderSecretSetupChooser();

      fireEvent.click(
        screen.getByRole("button", { name: "I ran this script" }),
      );

      expect(
        await screen.findByText(/Provider secret metadata was verified/i),
      ).toBeTruthy();
      expect(
        screen.getByText(/verified the GitHub secret metadata it can read/i),
      ).toBeTruthy();
      expect(
        (screen.getByRole("button", { name: "Confirmed" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
      expect(providerSetupConfirmed).toHaveBeenCalledTimes(1);
      const event = providerSetupConfirmed.mock
        .calls[0]?.[0] as CustomEvent<ProviderSetupConfirmedEventDetail>;
      expect(event.detail).toEqual({
        repositoryId: "repo_1",
        repositoryFullName: "777genius/plugin-kit-ai-starter-claude-python",
      });
      expect(routerMock.replace).not.toHaveBeenCalled();
      expect(routerMock.refresh).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(
        providerSetupConfirmedEventName,
        providerSetupConfirmed,
      );
    }
  });

  it("clears stale secret-status cache after provider confirmation", async () => {
    await checkProviderSecretStatusWithCache({
      workspaceId: "workspace_1",
      repositoryId: "repo_1",
      authMode: "codex_subscription_oauth",
      formData: new FormData(),
      forceRefresh: false,
      check: vi.fn().mockResolvedValue({ status: "missing" }),
    });
    mockProviderSetupFetch().mockResolvedValueOnce(
      providerSetupResponse({
        params: {
          notice: "provider_setup_confirmed",
          workspace: "workspace_1",
          section: "repositories",
          repository: "777genius/plugin-kit-ai-starter-claude-python",
        },
      }),
    );
    const refreshedCheck = vi
      .fn()
      .mockResolvedValue({ status: "available_repository" });

    renderProviderSecretSetupChooser();
    fireEvent.click(screen.getByRole("button", { name: "I ran this script" }));
    await screen.findByText(/Provider secret metadata was verified/i);

    await expect(
      checkProviderSecretStatusWithCache({
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
        authMode: "codex_subscription_oauth",
        formData: new FormData(),
        forceRefresh: false,
        check: refreshedCheck,
      }),
    ).resolves.toEqual({ status: "available_repository" });
    expect(refreshedCheck).toHaveBeenCalledTimes(1);
  });

  it("shows Claude Code setup by default and allows disabling it", () => {
    renderProviderSecretSetupChooser();
    expect(screen.getByText("Claude Code subscription")).toBeTruthy();

    cleanup();
    renderProviderSecretSetupChooser({ claudeCodeProviderEnabled: false });
    expect(screen.queryByText("Claude Code subscription")).toBeNull();

    cleanup();
    renderProviderSecretSetupChooser();

    fireEvent.click(screen.getByTestId("provider-choice-claude-code-oauth"));
    expect(pageText()).toContain("claude setup-token");
    expect(pageText()).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(pageText()).toContain(
      "gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo 777genius/plugin-kit-ai-starter-claude-python",
    );
  });
});

describe("ProviderSecretSetupDialog", () => {
  it("renders the dialog trigger as a button, not a form submit", () => {
    renderProviderSecretSetupDialog();

    expect(
      (
        screen.getByRole("button", {
          name: "Enable review",
        }) as HTMLButtonElement
      ).type,
    ).toBe("button");
  });

  it("keeps the dialog open after confirmation without refreshing the repository list on close", async () => {
    mockProviderSetupFetch().mockResolvedValueOnce(
      providerSetupResponse({
        params: {
          notice: "provider_setup_confirmed",
          workspace: "workspace_1",
          section: "repositories",
          repository: "777genius/plugin-kit-ai-starter-claude-python",
        },
      }),
    );

    renderProviderSecretSetupDialog();

    fireEvent.click(screen.getByRole("button", { name: "Enable review" }));
    fireEvent.click(screen.getByRole("button", { name: "I ran this script" }));

    expect(
      await screen.findByText(/Provider secret metadata was verified/i),
    ).toBeTruthy();
    expect(routerMock.refresh).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Close provider secrets dialog" }),
    );

    expect(routerMock.refresh).not.toHaveBeenCalled();
  });
});

function renderProviderSecretSetupChooser(input?: {
  readonly organizationLogin?: string | null;
  readonly repositoryVisibility?: string;
  readonly organizationSecretPolicy?: OrganizationSecretPolicy | null;
  readonly claudeCodeProviderEnabled?: boolean;
}): void {
  const organizationLogin = input?.organizationLogin ?? null;
  render(
    <ProviderSecretSetupChooser
      workspaceId="workspace_1"
      repositoryId="repo_1"
      repositoryFullName="777genius/plugin-kit-ai-starter-claude-python"
      repositoryVisibility={input?.repositoryVisibility ?? "public"}
      organizationLogin={organizationLogin}
      organizationSecretPolicy={input?.organizationSecretPolicy ?? null}
      codexOAuthGuidance={guidance("CODEX_AUTH_JSON", organizationLogin)}
      codexApiKeyGuidance={guidance("OPENAI_API_KEY", organizationLogin)}
      claudeCodeOAuthGuidance={guidance(
        "CLAUDE_CODE_OAUTH_TOKEN",
        organizationLogin,
      )}
      openRouterApiKeyGuidance={guidance(
        "OPENROUTER_API_KEY",
        organizationLogin,
      )}
      claudeCodeProviderEnabled={input?.claudeCodeProviderEnabled ?? true}
    />,
  );
}

function renderProviderSecretSetupDialog(): void {
  render(
    <ProviderSecretSetupDialog
      workspaceId="workspace_1"
      repositoryId="repo_1"
      repositoryFullName="777genius/plugin-kit-ai-starter-claude-python"
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
    />,
  );
}

function mockProviderSetupFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function providerSetupResponse(body: {
  readonly params: Record<string, string>;
}): Response {
  return {
    ok: true,
    json: async () => body,
  } as Response;
}

function guidance(
  secretName: string,
  organizationLogin: string | null = null,
): ProviderSecretSetupGuidance {
  const repositoryCommand = {
    scope: "repository" as const,
    title: "Repository secret",
    description: `Stores ${secretName} directly in this repository.`,
    command: `gh secret set ${secretName} --repo 777genius/plugin-kit-ai-starter-claude-python`,
    storesSecretIn: "github_repository_secret" as const,
    targetLabel:
      "777genius/plugin-kit-ai-starter-claude-python repository secret",
    secretNames: [secretName],
    selectedRepositories: ["777genius/plugin-kit-ai-starter-claude-python"],
    validatesBeforeWrite: false,
    failureRecovery: "Retry the command.",
    sendsSecretToReviewRouter: false as const,
  };

  return {
    provider:
      secretName === "CODEX_AUTH_JSON"
        ? "codex_oauth"
        : secretName === "OPENAI_API_KEY"
          ? "openai_api_key"
          : secretName === "CLAUDE_CODE_OAUTH_TOKEN"
            ? "claude_code_oauth"
            : "openrouter_api_key",
    recommendedScope: organizationLogin
      ? "organization_selected_repositories"
      : "repository",
    commands: organizationLogin
      ? [
          {
            scope: "organization_selected_repositories" as const,
            title: "Organization selected-repository secret",
            description: `Stores ${secretName} in ${organizationLogin}.`,
            command: `gh secret set ${secretName} --org ${organizationLogin} --repos plugin-kit-ai-starter-claude-python --app actions`,
            storesSecretIn: "github_org_secret" as const,
            targetLabel: `${organizationLogin} organization secret, selected repo plugin-kit-ai-starter-claude-python`,
            secretNames: [secretName],
            selectedRepositories: [
              "777genius/plugin-kit-ai-starter-claude-python",
            ],
            validatesBeforeWrite: false,
            failureRecovery: "Add this repository to Repository access.",
            sendsSecretToReviewRouter: false as const,
          },
          {
            scope: "organization_private_repositories" as const,
            title: "Organization private-repositories secret",
            description: `Stores ${secretName} in ${organizationLogin}.`,
            command: `gh secret set ${secretName} --org ${organizationLogin} --visibility private --app actions`,
            storesSecretIn: "github_org_secret" as const,
            targetLabel: `${organizationLogin} organization secret, private repositories`,
            secretNames: [secretName],
            selectedRepositories: [],
            validatesBeforeWrite: false,
            failureRecovery: "Use a paid organization plan.",
            sendsSecretToReviewRouter: false as const,
          },
          {
            scope: "organization_all_repositories" as const,
            title: "Organization all-repositories secret",
            description: `Stores ${secretName} in ${organizationLogin}.`,
            command: `gh secret set ${secretName} --org ${organizationLogin} --visibility all --app actions`,
            storesSecretIn: "github_org_secret" as const,
            targetLabel: `${organizationLogin} organization secret, all repositories`,
            secretNames: [secretName],
            selectedRepositories: [],
            validatesBeforeWrite: false,
            failureRecovery: "Use a paid organization plan.",
            sendsSecretToReviewRouter: false as const,
          },
          repositoryCommand,
        ]
      : [repositoryCommand],
    warnings: [],
  };
}
