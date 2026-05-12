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
  cleanup();
});

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
    expect(screen.getByText(/Could not verify automatically/i)).toBeTruthy();
    expect(routerMock.replace).not.toHaveBeenCalled();
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
      await screen.findByText(/Provider setup is marked complete/i),
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
        await screen.findByText(/Provider setup is marked complete/i),
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

  it("keeps the dialog open after confirmation and refreshes after the user closes it", async () => {
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
      await screen.findByText(/Provider setup is marked complete/i),
    ).toBeTruthy();
    expect(routerMock.refresh).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Close provider secrets dialog" }),
    );

    await waitFor(() => {
      expect(routerMock.refresh).toHaveBeenCalledTimes(1);
    });
  });
});

function renderProviderSecretSetupChooser(): void {
  render(
    <ProviderSecretSetupChooser
      workspaceId="workspace_1"
      repositoryId="repo_1"
      repositoryFullName="777genius/plugin-kit-ai-starter-claude-python"
      organizationLogin={null}
      codexOAuthGuidance={guidance("CODEX_AUTH_JSON")}
      codexApiKeyGuidance={guidance("OPENAI_API_KEY")}
      openRouterApiKeyGuidance={guidance("OPENROUTER_API_KEY")}
    />,
  );
}

function renderProviderSecretSetupDialog(): void {
  render(
    <ProviderSecretSetupDialog
      workspaceId="workspace_1"
      repositoryId="repo_1"
      repositoryFullName="777genius/plugin-kit-ai-starter-claude-python"
      organizationLogin={null}
      guidanceSet={{
        codexOAuth: guidance("CODEX_AUTH_JSON"),
        codexApiKey: guidance("OPENAI_API_KEY"),
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
        title: "Repository secret",
        description: `Stores ${secretName} directly in this repository.`,
        command: `gh secret set ${secretName} --repo 777genius/plugin-kit-ai-starter-claude-python`,
        storesSecretIn: "github_repository_secret",
        targetLabel:
          "777genius/plugin-kit-ai-starter-claude-python repository secret",
        secretNames: [secretName],
        selectedRepositories: ["777genius/plugin-kit-ai-starter-claude-python"],
        validatesBeforeWrite: false,
        failureRecovery: "Retry the command.",
        sendsSecretToReviewRouter: false,
      },
    ],
    warnings: [],
  };
}
