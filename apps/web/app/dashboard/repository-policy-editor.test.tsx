// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  safeDefaultReviewConfiguration,
  type ReviewConfiguration,
  type ReviewProviderConfiguration,
} from "@reviewrouter/features-review-config";
import { checkProviderRepositorySecretClientAction } from "./actions";
import {
  clearProviderSecretStatusCacheForTest,
  ReviewConfigForm,
  RepositoryPolicyOverrideDetails,
} from "./repository-policy-editor";

vi.mock("./actions", () => ({
  checkProviderRepositorySecretClientAction: vi.fn(),
  clearRepositoryReviewConfigClientAction: vi.fn(),
  saveRepositoryReviewConfigClientAction: vi.fn(),
}));

const modelOptions = [
  {
    value: "gpt-5.5",
    label: "gpt-5.5",
    provider: "codex" as const,
    description: "Codex default model.",
  },
  {
    value: "poolside/laguna-m.1:free",
    label: "Poolside: Laguna M.1",
    provider: "openrouter" as const,
    description: "poolside/laguna-m.1:free - $0/$0 per 1M - 131K context",
    badge: "FREE RECOMMENDED" as const,
  },
  {
    value: "anthropic/claude-sonnet-4.5",
    label: "Anthropic: Claude Sonnet 4.5",
    provider: "openrouter" as const,
    description:
      "anthropic/claude-sonnet-4.5 - $3.00/$15.00 per 1M input/output",
    badge: "PAID" as const,
  },
  {
    value: "sonnet",
    label: "sonnet",
    provider: "claude" as const,
    description: "Claude Code default model.",
  },
  {
    value: "opus",
    label: "opus",
    provider: "claude" as const,
    description: "Claude Code model.",
  },
];

afterEach(() => {
  vi.clearAllMocks();
  clearProviderSecretStatusCacheForTest();
  cleanup();
});

describe("ReviewConfigForm", () => {
  it("keeps at least one provider and adds an OpenRouter provider", () => {
    renderReviewConfigForm();

    expect(
      (screen.getByRole("button", { name: "Remove" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));

    expect(screen.getByText("Provider 2")).toBeTruthy();
    expect(
      screen.getAllByRole("combobox", { name: "Provider auth" }),
    ).toHaveLength(2);
    expect(
      (screen.getAllByRole("textbox", { name: "Model" })[1] as HTMLInputElement)
        .value,
    ).toBe("poolside/laguna-m.1:free");
    expect(screen.getAllByText("FREE RECOMMENDED").length).toBeGreaterThan(0);
    expect(
      (
        screen.getAllByRole("button", {
          name: "Remove",
        })[1] as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("filters model options by selected provider", () => {
    renderReviewConfigForm();

    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
    fireEvent.click(
      screen.getAllByRole("button", { name: "Open model options" })[0]!,
    );

    expect(screen.getByRole("option", { name: /gpt-5\.5/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Poolside/ })).toBeNull();
  });

  it("allows paid model options when they match the typed search", () => {
    renderReviewConfigForm();

    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
    const modelInput = screen.getAllByRole("textbox", {
      name: "Model",
    })[1] as HTMLInputElement;
    modelInput.focus();
    fireEvent.change(modelInput, { target: { value: "anthropic" } });

    const listbox = screen.getByRole("listbox");
    const paidOption = within(listbox).getByRole("option", {
      name: /Anthropic: Claude/,
    });
    expect(paidOption).toHaveProperty("disabled", false);
    expect(
      within(listbox).queryByRole("option", { name: /Poolside/ }),
    ).toBeNull();

    fireEvent.click(paidOption);
    expect(
      (screen.getAllByRole("textbox", { name: "Model" })[1] as HTMLInputElement)
        .value,
    ).toBe("anthropic/claude-sonnet-4.5");
  });

  it("filters model options by typed model text while keeping custom input", () => {
    renderReviewConfigForm();

    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
    const modelInput = screen.getAllByRole("textbox", {
      name: "Model",
    })[1] as HTMLInputElement;
    modelInput.focus();
    fireEvent.change(modelInput, { target: { value: "anthropic" } });

    const listbox = screen.getByRole("listbox");
    expect(
      within(listbox).getByRole("option", { name: /Anthropic: Claude/ }),
    ).toBeTruthy();
    expect(
      within(listbox).queryByRole("option", { name: /Poolside/ }),
    ).toBeNull();

    fireEvent.change(modelInput, { target: { value: "custom/new-model" } });

    expect(modelInput.value).toBe("custom/new-model");
    expect(screen.getByText(/custom model value will be saved/i)).toBeTruthy();
  });

  it("allows custom model text", () => {
    renderReviewConfigForm();

    const modelInput = screen.getByRole("textbox", {
      name: "Model",
    }) as HTMLInputElement;
    modelInput.focus();
    fireEvent.change(modelInput, { target: { value: "custom/model-1" } });

    const updatedModelInput = screen.getByRole("textbox", {
      name: "Model",
    }) as HTMLInputElement;
    expect(document.activeElement).toBe(updatedModelInput);

    fireEvent.change(updatedModelInput, {
      target: { value: "custom/model-123" },
    });

    expect(updatedModelInput.value).toBe("custom/model-123");
  });

  it("shows a green OpenRouter secret status when the repository secret exists", async () => {
    vi.mocked(checkProviderRepositorySecretClientAction).mockResolvedValue({
      status: "available_repository",
    });

    renderReviewConfigForm({
      config: openRouterReviewConfiguration(),
      repositoryFullName: "777genius/agent-teams-ai",
      repositorySecretCheckTarget: {
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
      },
    });

    await waitFor(() => {
      const status = screen.getByRole("status");
      expect(status.textContent).toContain(
        "OPENROUTER_API_KEY is set in this repository's GitHub Actions secrets",
      );
    });
    expect(screen.queryByText(/OpenRouter requires/i)).toBeNull();
  });

  it("checks the Codex OAuth secret for the selected auth mode", async () => {
    vi.mocked(checkProviderRepositorySecretClientAction).mockResolvedValue({
      status: "missing",
    });

    renderReviewConfigForm({
      config: codexReviewConfiguration("codex_subscription_oauth"),
      repositoryFullName: "777genius/agent-teams-ai",
      repositorySecretCheckTarget: {
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
      },
    });

    await waitFor(() => {
      expect(
        screen.getByText(/Codex OAuth uses CODEX_AUTH_JSON/i),
      ).toBeTruthy();
    });
    expect(
      screen.getByText(
        "gh secret set CODEX_AUTH_JSON --repo 777genius/agent-teams-ai < ~/.codex/auth.json",
      ),
    ).toBeTruthy();
    const formData = vi.mocked(checkProviderRepositorySecretClientAction).mock
      .calls[0]?.[0] as FormData;
    expect(formData.get("providerKind")).toBe("codex");
    expect(formData.get("authMode")).toBe("codex_subscription_oauth");
  });

  it("checks the Codex API-key secret for the selected auth mode", async () => {
    vi.mocked(checkProviderRepositorySecretClientAction).mockResolvedValue({
      status: "missing",
    });

    renderReviewConfigForm({
      config: codexReviewConfiguration("codex_openai_api_key"),
      repositoryFullName: "777genius/agent-teams-ai",
      repositorySecretCheckTarget: {
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
      },
    });

    await waitFor(() => {
      expect(
        screen.getByText(/Codex API-key mode uses OPENAI_API_KEY/i),
      ).toBeTruthy();
    });
    expect(
      screen.getByText(
        "gh secret set OPENAI_API_KEY --repo 777genius/agent-teams-ai",
      ),
    ).toBeTruthy();
    const formData = vi.mocked(checkProviderRepositorySecretClientAction).mock
      .calls[0]?.[0] as FormData;
    expect(formData.get("providerKind")).toBe("codex");
    expect(formData.get("authMode")).toBe("codex_openai_api_key");
  });

  it("shows Claude Code by default, allows disabling it, and hides Codex controls after selection", () => {
    renderReviewConfigForm();
    fireEvent.click(screen.getByRole("combobox", { name: "Provider auth" }));
    expect(
      screen.getByRole("option", { name: /Claude Code subscription/i }),
    ).toBeTruthy();

    cleanup();
    renderReviewConfigForm({ claudeCodeProviderEnabled: false });
    fireEvent.click(screen.getByRole("combobox", { name: "Provider auth" }));
    expect(
      screen.queryByRole("option", { name: /Claude Code subscription/i }),
    ).toBeNull();

    cleanup();
    renderReviewConfigForm();
    fireEvent.click(screen.getByRole("combobox", { name: "Provider auth" }));
    fireEvent.click(
      screen.getByRole("option", { name: /Claude Code subscription/i }),
    );

    expect(
      (screen.getByRole("textbox", { name: "Model" }) as HTMLInputElement)
        .value,
    ).toBe("sonnet");
    expect(screen.queryByText("Reasoning effort")).toBeNull();
    expect(screen.queryByText("Fast mode")).toBeNull();
    expect(screen.queryByText("Agentic context")).toBeNull();
  });

  it("checks the Claude Code OAuth secret for a saved Claude provider", async () => {
    vi.mocked(checkProviderRepositorySecretClientAction).mockResolvedValue({
      status: "missing",
    });

    renderReviewConfigForm({
      config: claudeReviewConfiguration(),
      claudeCodeProviderEnabled: false,
      repositoryFullName: "777genius/agent-teams-ai",
      repositorySecretCheckTarget: {
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
      },
    });

    await waitFor(() => {
      expect(
        screen.getByText(
          /Claude Code subscription mode uses CLAUDE_CODE_OAUTH_TOKEN/i,
        ),
      ).toBeTruthy();
    });
    expect(
      screen.getByText(
        "gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo 777genius/agent-teams-ai --app actions",
      ),
    ).toBeTruthy();
    const formData = vi.mocked(checkProviderRepositorySecretClientAction).mock
      .calls[0]?.[0] as FormData;
    expect(formData.get("providerKind")).toBe("claude");
    expect(formData.get("authMode")).toBe("claude_code_oauth");
  });

  it("shows a loader instead of a setup warning while secret status is loading", () => {
    vi.mocked(checkProviderRepositorySecretClientAction).mockReturnValue(
      new Promise(() => undefined),
    );

    renderReviewConfigForm({
      config: openRouterReviewConfiguration(),
      repositoryFullName: "777genius/agent-teams-ai",
      repositorySecretCheckTarget: {
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
      },
    });

    expect(
      screen.getByText(/Checking GitHub Actions secret metadata/i),
    ).toBeTruthy();
    expect(screen.queryByText(/Set a repository secret/i)).toBeNull();
  });

  it("refreshes provider secret status on demand", async () => {
    vi.mocked(checkProviderRepositorySecretClientAction)
      .mockResolvedValueOnce({ status: "missing" })
      .mockResolvedValueOnce({ status: "available_repository" });

    renderReviewConfigForm({
      config: openRouterReviewConfiguration(),
      repositoryFullName: "777genius/agent-teams-ai",
      repositorySecretCheckTarget: {
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
      },
    });

    await screen.findByText(/OpenRouter providers use OPENROUTER_API_KEY/i);

    fireEvent.click(
      screen.getByRole("button", { name: "Refresh secret status" }),
    );

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain(
        "OPENROUTER_API_KEY is set in this repository's GitHub Actions secrets",
      );
    });
    expect(checkProviderRepositorySecretClientAction).toHaveBeenCalledTimes(2);
  });

  it("keeps the setup warning when OpenRouter secret metadata is missing", async () => {
    vi.mocked(checkProviderRepositorySecretClientAction).mockResolvedValue({
      status: "missing",
    });

    renderReviewConfigForm({
      config: openRouterReviewConfiguration(),
      repositoryFullName: "777genius/agent-teams-ai",
      repositorySecretCheckTarget: {
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
      },
    });

    await waitFor(() => {
      expect(
        screen.getByText(/OpenRouter providers use OPENROUTER_API_KEY/i),
      ).toBeTruthy();
    });
    expect(
      screen.getByText(
        "gh secret set OPENROUTER_API_KEY --repo 777genius/agent-teams-ai",
      ),
    ).toBeTruthy();
  });

  it("checks a shared provider secret only once for duplicate auth modes", async () => {
    vi.mocked(checkProviderRepositorySecretClientAction).mockResolvedValue({
      status: "available_repository",
    });

    renderReviewConfigForm({
      config: duplicateOpenRouterReviewConfiguration(),
      repositoryFullName: "777genius/agent-teams-ai",
      repositorySecretCheckTarget: {
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
      },
    });

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain(
        "OPENROUTER_API_KEY is set in this repository's GitHub Actions secrets",
      );
    });
    expect(
      screen.getByText(
        "Checked once for 2 providers using OpenRouter API key.",
      ),
    ).toBeTruthy();
    expect(checkProviderRepositorySecretClientAction).toHaveBeenCalledTimes(1);
  });

  it("does not mount repository override secret checks until the row is opened", async () => {
    vi.mocked(checkProviderRepositorySecretClientAction).mockResolvedValue({
      status: "available_repository",
    });

    renderRepositoryPolicyOverrideDetails({
      repositoryConfig: {
        version: 6,
        config: duplicateOpenRouterReviewConfiguration(),
      },
    });

    expect(screen.getByText("777genius/agent-teams-ai")).toBeTruthy();
    expect(screen.queryByText("Provider 1")).toBeNull();
    expect(checkProviderRepositorySecretClientAction).not.toHaveBeenCalled();

    const rowButton = screen
      .getByText("777genius/agent-teams-ai")
      .closest("button");
    expect(rowButton).not.toBeNull();
    fireEvent.click(rowButton!);

    expect(screen.getByText("Provider 1")).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain(
        "OPENROUTER_API_KEY is set in this repository's GitHub Actions secrets",
      );
    });
    expect(checkProviderRepositorySecretClientAction).toHaveBeenCalledTimes(1);

    fireEvent.click(rowButton!);
    expect(screen.queryByText("Provider 1")).toBeNull();
    fireEvent.click(rowButton!);

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain(
        "OPENROUTER_API_KEY is set in this repository's GitHub Actions secrets",
      );
    });
    expect(checkProviderRepositorySecretClientAction).toHaveBeenCalledTimes(1);
  });

  it("explains when an organization OpenRouter secret is not selected for this repository", async () => {
    vi.mocked(checkProviderRepositorySecretClientAction).mockResolvedValue({
      status: "not_available_to_repository",
    });

    renderReviewConfigForm({
      config: openRouterReviewConfiguration(),
      repositoryFullName: "777genius/agent-teams-ai",
      repositorySecretCheckTarget: {
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
      },
    });

    await waitFor(() => {
      expect(screen.getByText(/not selected for access/i)).toBeTruthy();
    });
    expect(screen.getByText(/Repository access/i)).toBeTruthy();
    expect(
      screen.getByText(
        "gh secret set OPENROUTER_API_KEY --repo 777genius/agent-teams-ai",
      ),
    ).toBeTruthy();
  });
});

function renderReviewConfigForm(input?: {
  readonly config?: ReviewConfiguration;
  readonly repositoryFullName?: string;
  readonly claudeCodeProviderEnabled?: boolean;
  readonly repositorySecretCheckTarget?: {
    readonly workspaceId: string;
    readonly repositoryId: string;
  };
}): void {
  render(
    <ReviewConfigForm
      action={() => undefined}
      config={input?.config ?? safeDefaultReviewConfiguration}
      modelOptions={modelOptions}
      claudeCodeProviderEnabled={input?.claudeCodeProviderEnabled ?? true}
      hiddenFields={[{ name: "workspaceId", value: "workspace_1" }]}
      mutationsEnabled={true}
      submitLabel="Save workspace default"
      repositoryFullName={input?.repositoryFullName}
      repositorySecretCheckTarget={input?.repositorySecretCheckTarget}
    />,
  );
}

function renderRepositoryPolicyOverrideDetails(input?: {
  readonly repositoryConfig?: {
    readonly version: number;
    readonly config: ReviewConfiguration;
  } | null;
}): void {
  const repositoryConfig = input?.repositoryConfig ?? null;
  render(
    <RepositoryPolicyOverrideDetails
      workspaceId="workspace_1"
      repository={{
        id: "repo_1",
        fullName: "777genius/agent-teams-ai",
        selected: true,
        archived: false,
      }}
      repositoryConfig={repositoryConfig}
      effectiveConfig={
        repositoryConfig?.config ?? duplicateOpenRouterReviewConfiguration()
      }
      configVersion={repositoryConfig?.version ?? 6}
      modelOptions={modelOptions}
      mutationsEnabled={true}
      saveAction={() => undefined}
      clearAction={() => undefined}
    />,
  );
}

function openRouterReviewConfiguration(): ReviewConfiguration {
  const openRouterProvider: ReviewProviderConfiguration = {
    kind: "openrouter",
    authMode: "openrouter_api_key",
    model: "poolside/laguna-m.1:free",
    reasoningEffort: "medium",
    agenticContext: true,
    fastMode: false,
  };

  return {
    ...safeDefaultReviewConfiguration,
    provider: openRouterProvider,
    providers: [openRouterProvider],
  };
}

function duplicateOpenRouterReviewConfiguration(): ReviewConfiguration {
  const firstOpenRouterProvider: ReviewProviderConfiguration = {
    kind: "openrouter",
    authMode: "openrouter_api_key",
    model: "poolside/laguna-m.1:free",
    reasoningEffort: "medium",
    agenticContext: true,
    fastMode: false,
  };
  const secondOpenRouterProvider: ReviewProviderConfiguration = {
    ...firstOpenRouterProvider,
    model: "anthropic/claude-sonnet-4.5",
  };

  return {
    ...safeDefaultReviewConfiguration,
    provider: firstOpenRouterProvider,
    providers: [firstOpenRouterProvider, secondOpenRouterProvider],
  };
}

function codexReviewConfiguration(
  authMode: "codex_subscription_oauth" | "codex_openai_api_key",
): ReviewConfiguration {
  const codexProvider: ReviewProviderConfiguration = {
    kind: "codex",
    authMode,
    model: "gpt-5.5",
    reasoningEffort: "medium",
    agenticContext: true,
    fastMode: false,
  };

  return {
    ...safeDefaultReviewConfiguration,
    provider: codexProvider,
    providers: [codexProvider],
  };
}

function claudeReviewConfiguration(): ReviewConfiguration {
  const claudeProvider: ReviewProviderConfiguration = {
    kind: "claude",
    authMode: "claude_code_oauth",
    model: "sonnet",
    reasoningEffort: "medium",
    agenticContext: true,
    fastMode: false,
  };

  return {
    ...safeDefaultReviewConfiguration,
    provider: claudeProvider,
    providers: [claudeProvider],
  };
}
