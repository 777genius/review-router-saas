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
import { confirmProviderSecretSetupClientAction } from "./actions";
import { ProviderSecretSetupChooser } from "./provider-secret-setup-chooser";

const routerMock = vi.hoisted(() => ({
  refresh: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

vi.mock("./actions", () => ({
  confirmProviderSecretSetupClientAction: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
  cleanup();
});

describe("ProviderSecretSetupChooser", () => {
  it("keeps provider setup errors inside the dialog when the action rejects", async () => {
    vi.mocked(confirmProviderSecretSetupClientAction).mockRejectedValueOnce(
      new Error("server action failed"),
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
    vi.mocked(confirmProviderSecretSetupClientAction).mockResolvedValueOnce({
      params: {
        error: "provider_secret_check_permission_required",
        workspace: "workspace_1",
        section: "repositories",
      },
    });

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
