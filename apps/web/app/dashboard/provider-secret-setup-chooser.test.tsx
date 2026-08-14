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
  it("shows a loading state while provider setup verification is pending", async () => {
    const pendingResponse = deferredProviderSetupResponse();
    mockProviderSetupFetch().mockReturnValueOnce(pendingResponse.promise);

    renderProviderSecretSetupChooser();

    fireEvent.click(
      screen.getByRole("button", { name: "Verify versioned setup" }),
    );

    const loadingButton = await screen.findByRole("button", {
      name: "Checking versioned setup...",
    });
    expect((loadingButton as HTMLButtonElement).disabled).toBe(true);
    expect(loadingButton.getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByRole("button", { name: "Confirmed" })).toBeNull();

    pendingResponse.resolve(
      providerSetupResponse({
        params: {
          notice: "provider_setup_confirmed",
          workspace: "workspace_1",
          section: "repositories",
          repository: "777genius/plugin-kit-ai-starter-claude-python",
        },
      }),
    );

    expect(
      await screen.findByText(/Authorized versioned setup is active/i),
    ).toBeTruthy();
  });

  it("shows a saving state while manual provider setup confirmation is pending", async () => {
    const pendingResponse = deferredProviderSetupResponse();
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
      .mockReturnValueOnce(pendingResponse.promise);

    renderProviderSecretSetupChooser();
    fireEvent.click(screen.getByTestId("provider-choice-openrouter-api-key"));

    fireEvent.click(screen.getByRole("button", { name: "I ran this script" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Confirm manually" }),
    );

    const savingButton = await screen.findByRole("button", {
      name: "Saving...",
    });
    expect((savingButton as HTMLButtonElement).disabled).toBe(true);
    expect(savingButton.getAttribute("aria-busy")).toBe("true");

    pendingResponse.resolve(
      providerSetupResponse({
        params: {
          notice: "provider_setup_confirmed",
          workspace: "workspace_1",
          section: "repositories",
          repository: "777genius/plugin-kit-ai-starter-claude-python",
        },
      }),
    );

    expect(
      await screen.findByText(/Provider setup was manually marked complete/i),
    ).toBeTruthy();
  });

  it("keeps provider setup errors inside the dialog when the action rejects", async () => {
    mockProviderSetupFetch().mockRejectedValueOnce(
      new Error("provider setup failed"),
    );

    renderProviderSecretSetupChooser();

    fireEvent.click(
      screen.getByRole("button", { name: "Verify versioned setup" }),
    );

    expect(
      await screen.findByText(
        /dashboard was updated while this page was open/i,
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Verify versioned setup" }),
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
    fireEvent.click(screen.getByTestId("provider-choice-openrouter-api-key"));

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

  it("never offers manual confirmation for rotating readiness", async () => {
    mockProviderSetupFetch().mockResolvedValueOnce(
      providerSetupResponse({
        params: {
          error: "repository_not_visible_to_github_app",
          workspace: "workspace_1",
          section: "repositories",
        },
      }),
    );

    renderProviderSecretSetupChooser();
    fireEvent.click(
      screen.getByRole("button", { name: "Verify versioned setup" }),
    );

    await screen.findByText(/could not save provider setup/i);
    expect(
      screen.queryByRole("button", { name: "Confirm manually" }),
    ).toBeNull();
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
    fireEvent.click(screen.getByTestId("provider-choice-openrouter-api-key"));

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
    fireEvent.click(screen.getByTestId("provider-choice-openrouter-api-key"));

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
    fireEvent.click(screen.getByTestId("provider-choice-openrouter-api-key"));

    fireEvent.click(
      screen.getByTestId("provider-scope-organization_private_repositories"),
    );
    expect(pageText()).toContain(
      "gh secret set OPENROUTER_API_KEY --org agent-teams-ai --visibility private --app actions",
    );

    fireEvent.click(
      screen.getByTestId("provider-scope-organization_all_repositories"),
    );
    expect(pageText()).toContain(
      "gh secret set OPENROUTER_API_KEY --org agent-teams-ai --visibility all --app actions",
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
    fireEvent.click(screen.getByTestId("provider-choice-openrouter-api-key"));

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
      "gh secret set OPENROUTER_API_KEY --repo 777genius/plugin-kit-ai-starter-claude-python",
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
    fireEvent.click(screen.getByTestId("provider-choice-openrouter-api-key"));

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
        screen.getByRole("button", { name: "Verify versioned setup" }),
      );

      expect(
        await screen.findByText(/Authorized versioned setup is active/i),
      ).toBeTruthy();
      expect(
        screen.getByText(/matched the active provider, claim/i),
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
        providerKind: "codex",
        authMode: "codex_subscription_oauth_rotating",
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

  it("marks the confirmed provider tab as complete", async () => {
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

    renderProviderSecretSetupChooser();
    fireEvent.click(
      screen.getByRole("button", { name: "Verify versioned setup" }),
    );

    await screen.findByText(/Authorized versioned setup is active/i);
    expect(
      screen.getByTestId("provider-choice-codex-oauth-rotating-confirmed"),
    ).toBeTruthy();
    expect(
      screen.queryByTestId("provider-choice-openrouter-api-key-confirmed"),
    ).toBeNull();

    fireEvent.click(screen.getByTestId("provider-choice-openrouter-api-key"));
    expect(
      screen.getByTestId("provider-choice-codex-oauth-rotating-confirmed"),
    ).toBeTruthy();
    expect(
      screen.queryByTestId("provider-choice-openrouter-api-key-confirmed"),
    ).toBeNull();
  });

  it("renders provider brand icons in the credential tabs", () => {
    renderProviderSecretSetupChooser();

    expect(
      screen.getByTestId("provider-choice-codex-oauth-rotating-logo"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("provider-choice-claude-code-oauth-logo"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("provider-choice-openrouter-api-key-logo"),
    ).toBeTruthy();
  });

  it("clears stale secret-status cache after provider confirmation", async () => {
    await checkProviderSecretStatusWithCache({
      workspaceId: "workspace_1",
      repositoryId: "repo_1",
      authMode: "codex_subscription_oauth_rotating",
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
    fireEvent.click(
      screen.getByRole("button", { name: "Verify versioned setup" }),
    );
    await screen.findByText(/Authorized versioned setup is active/i);

    await expect(
      checkProviderSecretStatusWithCache({
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
        authMode: "codex_subscription_oauth_rotating",
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

  it("shows one production Codex setup and hides legacy Codex credential modes", () => {
    renderProviderSecretSetupChooser();

    expect(
      screen.getByTestId("provider-choice-codex-oauth-rotating"),
    ).toBeTruthy();
    expect(screen.queryByTestId("provider-choice-codex-oauth")).toBeNull();
    expect(screen.queryByTestId("provider-choice-codex-api-key")).toBeNull();
    expect(pageText()).toContain("Server-authorized versioned secret");
    expect(pageText()).not.toContain("REVIEWROUTER_CODEX_AUTH_JSON");
    expect(pageText()).not.toContain("gh secret set CODEX_AUTH_JSON");
    expect(pageText()).not.toContain("OPENAI_API_KEY");
  });

  it("orders rotating preparation before its workflow while generic setup stays PR-first", () => {
    renderProviderSecretSetupChooser();

    expect(pageText()).toContain(
      "write the exact server-authorized versioned credential",
    );
    expect(pageText()).toContain("Create and merge the setup PR");
    expect(pageText()).toContain(
      "Verify versioned setup to confirm the merged namespace is active",
    );

    fireEvent.click(screen.getByTestId("provider-choice-openrouter-api-key"));
    expect(pageText()).toContain(
      "Merge the setup PR for 777genius/plugin-kit-ai-starter-claude-python",
    );
  });

  it("limits the pre-workflow phase to rotating Codex", () => {
    renderProviderSecretSetupChooser({ rotatingPreparationOnly: true });

    expect(
      screen.getByTestId("provider-choice-codex-oauth-rotating"),
    ).toBeTruthy();
    expect(
      screen.queryByTestId("provider-choice-claude-code-oauth"),
    ).toBeNull();
    expect(
      screen.queryByTestId("provider-choice-openrouter-api-key"),
    ).toBeNull();
  });

  it("mints rotating setup commands on demand when dashboard guidance has no serialized command", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      setupCommandResponse({
        command: "set -euo pipefail\n# server nonce command",
        expiresAt: "2026-05-25T12:15:00.000Z",
        providerInstanceId: "codex-rotating:123456",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderProviderSecretSetupChooser({
      codexOAuthRotatingGuidance: {
        provider: "codex_oauth_rotating",
        recommendedScope: "repository",
        commands: [],
        warnings: [],
      },
    });

    expect(await screen.findByText(/server nonce command/i)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/dashboard/codex-rotating/setup-command",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("shows a retryable setup command error instead of a provider-save error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        setupCommandErrorResponse("codex_rotating_installer_missing"),
      )
      .mockResolvedValueOnce(
        setupCommandResponse({
          command: "set -euo pipefail\n# retry nonce command",
          expiresAt: "2026-05-25T12:15:00.000Z",
          providerInstanceId: "codex-rotating:123456",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    renderProviderSecretSetupChooser({
      codexOAuthRotatingGuidance: {
        provider: "codex_oauth_rotating",
        recommendedScope: "repository",
        commands: [],
        warnings: [],
      },
    });

    expect(
      await screen.findByText(/could not load the Codex installer/i),
    ).toBeTruthy();
    expect(pageText()).not.toContain("could not save provider setup");
    expect(
      (
        screen.getByRole("button", {
          name: "Verify versioned setup",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    fireEvent.click(
      screen.getByRole("button", { name: "Retry setup command" }),
    );

    expect(await screen.findByText(/retry nonce command/i)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("explains an active rotating setup conflict", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          setupCommandErrorResponse("codex_rotating_setup_in_progress"),
        ),
    );

    renderProviderSecretSetupChooser({
      codexOAuthRotatingGuidance: {
        provider: "codex_oauth_rotating",
        recommendedScope: "repository",
        commands: [],
        warnings: [],
      },
    });

    expect(
      await screen.findByText(/Another unfetched Codex setup/i),
    ).toBeTruthy();
  });

  it("requires acknowledgement and requests one forced recovery command", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        setupCommandErrorResponse("codex_rotating_setup_recovery_required"),
      )
      .mockResolvedValueOnce(
        setupCommandResponse({
          command: "set -euo pipefail\n# recovered forced reseed",
          expiresAt: "2026-05-25T12:15:00.000Z",
          providerInstanceId: "codex-rotating:123456",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    renderProviderSecretSetupChooser({
      codexOAuthRotatingGuidance: {
        provider: "codex_oauth_rotating",
        recommendedScope: "repository",
        commands: [],
        warnings: [],
      },
    });

    const recoverButton = await screen.findByRole("button", {
      name: "Recover and issue forced reseed",
    });
    expect((recoverButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(
      screen.getByLabelText(/GitHub secret may already have changed/i),
    );
    fireEvent.click(recoverButton);

    expect(await screen.findByText(/recovered forced reseed/i)).toBeTruthy();
    const recoveryCall = fetchMock.mock.calls[1]!;
    expect(recoveryCall[0]).toBe(
      "/api/dashboard/codex-rotating/setup-recovery",
    );
    const body = recoveryCall[1]?.body as FormData;
    expect(body.get("acknowledgement")).toBe(
      "all_prior_installers_and_writers_are_stopped",
    );
    expect(String(body.get("recoveryRequestId"))).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("verifies an already merged setup before forcing recovery", async () => {
    const fetchMock = mockProviderSetupFetch()
      .mockResolvedValueOnce(
        setupCommandErrorResponse("codex_rotating_setup_recovery_required"),
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

    renderProviderSecretSetupChooser({
      codexOAuthRotatingGuidance: {
        provider: "codex_oauth_rotating",
        recommendedScope: "repository",
        commands: [],
        warnings: [],
      },
    });

    expect(
      await screen.findByText(/setup pull request is already merged/i),
    ).toBeTruthy();
    const verifyButton = screen.getByRole("button", {
      name: "Verify versioned setup",
    });
    expect((verifyButton as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(verifyButton);

    expect(
      await screen.findByText(/Authorized versioned setup is active/i),
    ).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "/api/dashboard/provider-secret-setup/confirm",
    );
  });

  it("explains setup lock contention as retryable", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          setupCommandErrorResponse("codex_rotating_setup_lock_failed"),
        ),
    );

    renderProviderSecretSetupChooser({
      codexOAuthRotatingGuidance: {
        provider: "codex_oauth_rotating",
        recommendedScope: "repository",
        commands: [],
        warnings: [],
      },
    });

    expect(
      await screen.findByText(/another request held the setup lock/i),
    ).toBeTruthy();
  });

  it("explains the external-write grace refusal", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          setupCommandErrorResponse("codex_rotating_mutation_still_active"),
        ),
    );
    renderProviderSecretSetupChooser({
      codexOAuthRotatingGuidance: {
        provider: "codex_oauth_rotating",
        recommendedScope: "repository",
        commands: [],
        warnings: [],
      },
    });
    expect(await screen.findByText(/external-write deadline/i)).toBeTruthy();
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
    fireEvent.click(
      screen.getByRole("button", { name: "Verify versioned setup" }),
    );

    expect(
      await screen.findByText(/Authorized versioned setup is active/i),
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
  readonly codexOAuthRotatingGuidance?: ProviderSecretSetupGuidance;
  readonly codexRotatingOAuthEnabled?: boolean;
  readonly claudeCodeProviderEnabled?: boolean;
  readonly rotatingPreparationOnly?: boolean;
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
      codexOAuthRotatingGuidance={
        input?.codexOAuthRotatingGuidance ?? rotatingGuidance()
      }
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
      codexRotatingOAuthEnabled={input?.codexRotatingOAuthEnabled ?? true}
      claudeCodeProviderEnabled={input?.claudeCodeProviderEnabled ?? true}
      rotatingPreparationOnly={input?.rotatingPreparationOnly ?? false}
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
        codexOAuthRotating: rotatingGuidance(),
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

function deferredProviderSetupResponse(): {
  readonly promise: Promise<Response>;
  readonly resolve: (value: Response) => void;
} {
  let resolveResponse: (value: Response) => void = () => {};
  const promise = new Promise<Response>((resolve) => {
    resolveResponse = resolve;
  });

  return {
    promise,
    resolve: resolveResponse,
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

function setupCommandResponse(body: {
  readonly command: string;
  readonly expiresAt: string;
  readonly providerInstanceId: string;
}): Response {
  return {
    ok: true,
    json: async () => body,
  } as Response;
}

function rotatingGuidance(): ProviderSecretSetupGuidance {
  return {
    provider: "codex_oauth_rotating",
    recommendedScope: "repository",
    commands: [
      {
        scope: "repository",
        title: "Versioned repository secret",
        description: "Allocates one server-authorized versioned secret.",
        command: "set -euo pipefail\n# versioned rotating installer",
        storesSecretIn: "github_repository_secret",
        targetLabel:
          "777genius/plugin-kit-ai-starter-claude-python repository secret",
        secretNames: ["Server-authorized versioned secret"],
        selectedRepositories: ["777genius/plugin-kit-ai-starter-claude-python"],
        validatesBeforeWrite: true,
        failureRecovery: "Recover through the versioned setup flow.",
        sendsSecretToReviewRouter: false,
      },
    ],
    warnings: [],
  };
}

function setupCommandErrorResponse(error: string): Response {
  return {
    ok: false,
    json: async () => ({ error }),
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
