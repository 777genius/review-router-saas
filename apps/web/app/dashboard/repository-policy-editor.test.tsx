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
import { readReviewConfigurationForm } from "./dashboard-action-form-readers";
import {
  safeDefaultReviewConfiguration,
  type ReviewConfiguration,
  type ReviewProviderConfiguration,
} from "@reviewrouter/features-review-config";
import {
  checkProviderRepositorySecretClientAction,
  clearRepositoryReviewConfigClientAction,
  saveRepositoryReviewConfigClientAction,
  saveWorkspaceReviewConfigClientAction,
} from "./actions";
import {
  clearProviderSecretStatusCacheForTest,
  ReviewConfigForm,
  WorkspaceReviewConfigForm,
  RepositoryPolicyEditor,
  RepositoryPolicyOverrideDetails,
} from "./repository-policy-editor";
import type {
  AccountView,
  AccountsPage,
  AccountsResult,
} from "../../src/server/account-gateway-accounts";

const routerMock = vi.hoisted(() => ({
  refresh: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

vi.mock("./actions", () => ({
  checkProviderRepositorySecretClientAction: vi.fn(),
  clearRepositoryReviewConfigClientAction: vi.fn(),
  saveRepositoryReviewConfigClientAction: vi.fn(),
  saveWorkspaceReviewConfigClientAction: vi.fn(),
}));

const modelOptions = [
  {
    value: "gpt-5.6-sol",
    label: "gpt-5.6-sol",
    provider: "codex" as const,
    description: "Codex default model.",
  },
  {
    value: "gpt-5.5",
    label: "gpt-5.5",
    provider: "codex" as const,
    description: "Codex model.",
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
    value: "mimo-v2.6-pro",
    label: "mimo-v2.6-pro",
    provider: "codex-mimo" as const,
    description: "MiMo Token Plan public engine model.",
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
  vi.mocked(clearRepositoryReviewConfigClientAction).mockReset();
  vi.mocked(saveRepositoryReviewConfigClientAction).mockReset();
  vi.mocked(saveWorkspaceReviewConfigClientAction).mockReset();
  clearProviderSecretStatusCacheForTest();
  cleanup();
});

function pageText(): string {
  return document.body.textContent?.replace(/\s+/g, " ") ?? "";
}

const gatewayPage: AccountsPage = {
  profiles: [
    {
      id: "profile-mimo",
      label: "MiMo",
      protocol: "openai-responses",
      models: ["mimo-v2-pro", "openai/gpt-5.6-sol"],
    },
    {
      id: "profile-codex",
      label: "Codex",
      protocol: "openai-responses",
      models: ["gpt-6.1-sol"],
    },
  ],
  accounts: ["mimo", "codex"].map(
    (name): AccountView => ({
      connectionId: `connection-${name}`,
      label: `Workspace ${name}`,
      profileId: `profile-${name}`,
      profileLabel: name,
      state: "active",
      gatewayRevision: 1,
      mirrorRevision: 1,
      binding: {
        id: `binding-${name}`,
        revision: 1,
        state: "active",
        fencePending: false,
      },
    }),
  ),
  nextCursor: null,
};
function choose(label: string, option: RegExp): void {
  fireEvent.click(screen.getByRole("combobox", { name: label }));
  fireEvent.click(screen.getByRole("option", { name: option }));
}

describe("ReviewConfigForm", () => {
  it.each(["remove-direct", "remove-gateway", "switch-to-direct"])(
    "blocks unsupported saved gateway combinations until explicit %s repair",
    async (repair) => {
      const provider = {
        ...safeDefaultReviewConfiguration.provider,
        kind: "codex",
        authMode: "codex_account_gateway",
        gatewayBindingId: "binding-mimo",
        gatewayProfileRef: "profile-mimo",
        model: "mimo-v2-pro",
        fastMode: false,
        requiredHealthy: true,
      } satisfies ReviewProviderConfiguration;
      const extra =
        repair === "remove-gateway"
          ? { ...provider, model: "openai/gpt-5.6-sol", requiredHealthy: false }
          : {
              ...openRouterReviewConfiguration().provider,
              model: "anthropic/claude-sonnet-4.5",
            };
      const action = vi.fn();
      render(
        <ReviewConfigForm
          action={action}
          config={{
            ...safeDefaultReviewConfiguration,
            provider,
            providers: [provider, extra],
          }}
          gatewayAccounts={{ status: "ok", value: gatewayPage }}
          modelOptions={modelOptions}
          hiddenFields={[]}
          mutationsEnabled={true}
          submitLabel="Save"
        />,
      );
      const form = document.querySelector("form")!;
      const payload = () => readReviewConfigurationForm(new FormData(form));
      const submit = screen.getByRole("button", { name: "Save" });
      const add = screen.getByRole("button", { name: "Add provider" });
      expect(payload().providers).toEqual([provider, extra]);
      expect(submit.hasAttribute("disabled")).toBe(true);
      fireEvent.submit(form);
      expect(action).not.toHaveBeenCalled();
      expect(pageText()).toContain(
        "Account Gateway currently supports only one provider",
      );

      if (repair === "switch-to-direct") {
        fireEvent.click(
          screen.getAllByRole("combobox", { name: "Provider auth" })[0]!,
        );
        fireEvent.click(
          screen.getByRole("option", { name: /OpenRouter API key/i }),
        );
        expect(payload().providers[1]).toEqual(extra);
        expect(payload().provider.authMode).toBe("openrouter_api_key");
        expect(payload().provider.gatewayBindingId).toBeUndefined();
        expect(payload().provider.gatewayProfileRef).toBeUndefined();
        expect(add.hasAttribute("disabled")).toBe(false);
        fireEvent.click(add);
        expect(new FormData(form).get("providerCount")).toBe("3");
        fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[2]!);
        expect(payload().providers).toHaveLength(2);
        fireEvent.click(
          screen.getAllByRole("combobox", { name: "Provider auth" })[0]!,
        );
        const gateway = screen.getByRole("option", { name: /Account Gateway/ });
        expect(gateway.getAttribute("aria-disabled")).toBe("true");
        expect(gateway.textContent).toContain("only one provider");
        fireEvent.keyDown(gateway, { key: "Escape" });
      } else {
        fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[1]!);
        expect(payload().providers).toEqual([provider]);
        expect(add.hasAttribute("disabled")).toBe(true);
        fireEvent.click(add);
        expect(payload().providers).toEqual([provider]);
      }
      expect(submit.hasAttribute("disabled")).toBe(false);
      fireEvent.click(submit);
      await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
      const saved = readReviewConfigurationForm(action.mock.calls[0]![0]);
      expect(saved.providers).toEqual(payload().providers);
      expect(
        saved.providers.some((candidate) => candidate.requiredHealthy),
      ).toBe(true);
    },
  );

  // Regression: a newly configured provider could not enter gateway mode or submit a scoped tuple.
  it.each(["workspace", "repository"])(
    "chooses gateway account/profile/model in the %s form",
    async (scope) => {
      vi.mocked(checkProviderRepositorySecretClientAction).mockResolvedValue({
        status: "available_repository",
      });
      const save =
        scope === "workspace"
          ? saveWorkspaceReviewConfigClientAction
          : saveRepositoryReviewConfigClientAction;
      vi.mocked(save).mockResolvedValue({
        params: { notice: "review_config_saved" },
      });
      const common = {
        workspaceId: "workspace_1",
        modelOptions,
        gatewayAccounts: { status: "ok", value: gatewayPage } as const,
        mutationsEnabled: true,
      };
      if (scope === "workspace")
        render(
          <WorkspaceReviewConfigForm
            {...common}
            config={safeDefaultReviewConfiguration}
          />,
        );
      else {
        render(
          <RepositoryPolicyEditor
            {...common}
            effectiveConfig={safeDefaultReviewConfiguration}
            repositoryConfig={null}
            repository={{
              id: "repo_1",
              fullName: "test/disposable",
              selected: true,
              archived: false,
            }}
          />,
        );
        fireEvent.click(screen.getByRole("button", { name: /Edit settings/ }));
      }
      const legacySecretChecks = vi.mocked(
        checkProviderRepositorySecretClientAction,
      ).mock.calls.length;
      choose("Provider auth", /Account Gateway/);
      const submit = screen.getByRole("button", {
        name: /Save workspace default|Save repo settings/,
      });
      expect(submit.hasAttribute("disabled")).toBe(true);
      fireEvent.submit(document.querySelector("form")!);
      expect(save).not.toHaveBeenCalled();
      choose("Account", /Workspace mimo/);
      fireEvent.click(screen.getByRole("combobox", { name: "Model" }));
      expect(screen.queryByRole("option", { name: "gpt-6.1-sol" })).toBeNull();
      fireEvent.click(screen.getByRole("option", { name: "mimo-v2-pro" }));
      expect(submit.hasAttribute("disabled")).toBe(false);
      choose("Account", /Workspace codex/);
      expect(submit.hasAttribute("disabled")).toBe(true);
      fireEvent.submit(document.querySelector("form")!);
      expect(save).not.toHaveBeenCalled();
      choose("Model", /^gpt-6.1-sol$/);
      fireEvent.click(submit);
      await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
      const payload = vi.mocked(save).mock.calls[0]![0];
      expect(payload.get("workspaceId")).toBe("workspace_1");
      if (scope === "repository")
        expect(payload.get("repositoryId")).toBe("repo_1");
      expect(readReviewConfigurationForm(payload).provider).toMatchObject({
        authMode: "codex_account_gateway",
        gatewayBindingId: "binding-codex",
        gatewayProfileRef: "profile-codex",
        model: "gpt-6.1-sol",
        requiredHealthy: true,
      });
      expect(checkProviderRepositorySecretClientAction).toHaveBeenCalledTimes(
        legacySecretChecks,
      );
    },
  );

  // Regression: refreshed choices must not replace a saved tuple or admit stale selections.
  it.each([
    "disabled",
    "revoked",
    "unbound",
    "fence",
    "wrong-profile",
    "stale-model",
    "denied",
    "unavailable",
    "pagination",
  ])("preserves selection and blocks save after %s refresh", (condition) => {
    const provider = {
      ...safeDefaultReviewConfiguration.provider,
      kind: "codex",
      authMode: "codex_account_gateway",
      gatewayBindingId: "binding-mimo",
      gatewayProfileRef: "profile-mimo",
      model: "mimo-v2-pro",
    } satisfies ReviewProviderConfiguration;
    const props = {
      action: vi.fn(),
      config: {
        ...safeDefaultReviewConfiguration,
        provider,
        providers: [provider],
      },
      modelOptions,
      hiddenFields: [],
      mutationsEnabled: true,
      submitLabel: "Save",
    };
    const { rerender } = render(
      <ReviewConfigForm
        {...props}
        gatewayAccounts={{ status: "ok", value: gatewayPage }}
      />,
    );
    const account: AccountView = {
      ...gatewayPage.accounts[0]!,
      binding: { ...gatewayPage.accounts[0]!.binding! },
    };
    if (condition === "disabled") account.state = "disabled";
    if (condition === "revoked") account.binding!.state = "revoked";
    if (condition === "unbound") account.binding = null;
    if (condition === "fence") account.binding!.fencePending = true;
    if (condition === "wrong-profile") account.profileId = "profile-codex";
    const page: AccountsResult<AccountsPage> =
      condition === "denied" || condition === "unavailable"
        ? { status: condition }
        : {
            status: "ok",
            value: {
              ...gatewayPage,
              profiles: gatewayPage.profiles.map((profile) => ({
                ...profile,
                models:
                  condition === "stale-model"
                    ? profile.models.filter((model) => model !== provider.model)
                    : profile.models,
              })),
              accounts:
                condition === "pagination"
                  ? [gatewayPage.accounts[1]!]
                  : [account, gatewayPage.accounts[1]!],
              nextCursor: condition === "pagination" ? "next-page" : null,
            },
          };
    rerender(<ReviewConfigForm {...props} gatewayAccounts={page} />);
    expect(
      screen.getByRole("button", { name: "Save" }).hasAttribute("disabled"),
    ).toBe(true);
    const form = document.querySelector("form")!;
    expect(readReviewConfigurationForm(new FormData(form)).provider).toEqual(
      provider,
    );
    fireEvent.submit(form);
    expect(props.action).not.toHaveBeenCalled();
    expect(pageText()).toContain(
      "Choose an available account and model before saving",
    );
    if (condition === "pagination")
      expect(pageText()).toContain("Additional accounts are not available");
    if (condition === "denied" || condition === "unavailable") {
      fireEvent.click(screen.getByRole("combobox", { name: "Provider auth" }));
      expect(
        screen
          .getByRole("option", { name: /Account Gateway/ })
          .getAttribute("aria-disabled"),
      ).toBe("true");
    }
  });

  it("preserves saved gateway model whitespace and ultra effort and offers max and ultra", () => {
    const provider = {
      kind: "codex",
      authMode: "codex_account_gateway",
      model: "openai/gpt-5.6-sol ",
      reasoningEffort: "ultra",
      agenticContext: true,
      fastMode: false,
      requiredHealthy: true,
      gatewayBindingId: "binding-mimo",
      gatewayProfileRef: "profile-mimo",
    } satisfies ReviewProviderConfiguration;
    renderReviewConfigForm({
      config: {
        ...safeDefaultReviewConfiguration,
        provider,
        providers: [provider],
      },
      repositoryFullName: "test/disposable-gateway",
      repositorySecretCheckTarget: {
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
      },
    });

    const form = document.querySelector("form");
    expect(form).not.toBeNull();
    const serialized = readReviewConfigurationForm(new FormData(form!));
    const normalized = { ...provider, model: provider.model.trim() };
    expect(serialized.provider).toEqual(normalized);
    expect(serialized.providers).toEqual([normalized]);
    choose("Model", /^mimo-v2-pro$/);
    expect(
      readReviewConfigurationForm(new FormData(form!)).provider.reasoningEffort,
    ).toBe("ultra");

    fireEvent.click(screen.getByRole("combobox", { name: "Reasoning effort" }));
    expect(screen.getByRole("option", { name: /Max/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /Ultra/ })).toBeTruthy();
    expect(checkProviderRepositorySecretClientAction).not.toHaveBeenCalled();
  });

  it("round-trips a saved gateway selection without a GitHub secret probe and clears refs when switching auth", () => {
    vi.mocked(checkProviderRepositorySecretClientAction).mockResolvedValue({
      status: "missing",
    });
    const provider = {
      kind: "codex",
      authMode: "codex_account_gateway",
      model: "mimo-v2-pro",
      reasoningEffort: "xhigh",
      agenticContext: true,
      fastMode: false,
      requiredHealthy: true,
      gatewayBindingId: "binding-mimo",
      gatewayProfileRef: "profile-mimo",
    } satisfies ReviewProviderConfiguration;
    renderReviewConfigForm({
      config: {
        ...safeDefaultReviewConfiguration,
        provider,
        providers: [provider],
      },
      repositoryFullName: "test/disposable-gateway",
      repositorySecretCheckTarget: {
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
      },
    });
    const form = document.querySelector("form");
    expect(form).not.toBeNull();
    expect(
      readReviewConfigurationForm(new FormData(form!)).provider,
    ).toMatchObject({
      authMode: "codex_account_gateway",
      gatewayBindingId: "binding-mimo",
      gatewayProfileRef: "profile-mimo",
    });
    expect(checkProviderRepositorySecretClientAction).not.toHaveBeenCalled();
    expect(pageText()).toContain("Credentials stay on the server");
    fireEvent.click(screen.getByRole("combobox", { name: "Provider auth" }));
    fireEvent.click(
      screen.getByRole("option", { name: /OpenRouter API key/i }),
    );
    const switched = readReviewConfigurationForm(new FormData(form!)).provider;
    expect(switched.authMode).toBe("openrouter_api_key");
    expect(switched.gatewayBindingId).toBeUndefined();
    expect(switched.gatewayProfileRef).toBeUndefined();
  });

  it("preserves configured investigation rollout values in dashboard submissions", () => {
    renderReviewConfigForm({
      config: {
        ...safeDefaultReviewConfiguration,
        investigationRollout: {
          recordingEnabled: true,
          shadowEnabled: true,
          contextCriticEnabled: true,
          verifiedCleanEnabled: true,
          crossRevisionReplayEnabled: true,
          productionEffectsEnabled: true,
        },
      },
    });

    for (const flag of [
      "recordingEnabled",
      "shadowEnabled",
      "contextCriticEnabled",
      "verifiedCleanEnabled",
      "crossRevisionReplayEnabled",
      "productionEffectsEnabled",
    ]) {
      expect(
        (
          document.querySelector(
            `input[name="investigationRollout.${flag}"]`,
          ) as HTMLInputElement
        ).value,
      ).toBe("true");
    }
  });

  it("keeps at least one provider and adds an OpenRouter provider", () => {
    renderReviewConfigForm({ config: openRouterReviewConfiguration() });

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
    expect(
      (
        screen.getAllByRole("checkbox", {
          name: "Required healthy",
        })[0] as HTMLInputElement
      ).checked,
    ).toBe(true);
    expect(
      (
        screen.getAllByRole("checkbox", {
          name: "Required healthy",
        })[1] as HTMLInputElement
      ).checked,
    ).toBe(false);
    expect(screen.getAllByText("FREE RECOMMENDED").length).toBeGreaterThan(0);
    expect(
      (
        screen.getAllByRole("button", {
          name: "Remove",
        })[1] as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("keeps one provider marked as required healthy", () => {
    renderReviewConfigForm({ config: openRouterReviewConfiguration() });

    const requiredToggle = screen.getByRole("checkbox", {
      name: "Required healthy",
    }) as HTMLInputElement;

    expect(requiredToggle.checked).toBe(true);
    fireEvent.click(requiredToggle);
    expect(requiredToggle.checked).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]!);

    expect(
      (
        screen.getByRole("checkbox", {
          name: "Required healthy",
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
  });

  it("filters model options by selected provider", () => {
    renderReviewConfigForm();

    fireEvent.click(
      screen.getAllByRole("button", { name: "Open model options" })[0]!,
    );

    expect(screen.getByRole("option", { name: /gpt-5\.6-sol/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Poolside/ })).toBeNull();
  });

  it("allows paid model options when they match the typed search", () => {
    renderReviewConfigForm({ config: openRouterReviewConfiguration() });

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
    renderReviewConfigForm({ config: openRouterReviewConfiguration() });

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

  it("derives rotating Codex readiness from the exact versioned activation chain", async () => {
    vi.mocked(checkProviderRepositorySecretClientAction).mockResolvedValue({
      status: "available_repository",
    });

    renderReviewConfigForm({
      config: codexReviewConfiguration("codex_subscription_oauth_rotating"),
      repositoryFullName: "777genius/agent-teams-ai",
      repositorySecretCheckTarget: {
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
      },
    });

    await waitFor(() => {
      const status = screen.getByRole("status");
      expect(status.textContent).toContain(
        "Authorized versioned Codex setup is active for this repository",
      );
      expect(status.textContent).toContain(
        "Readiness comes from the confirmed versioned claim and namespace activation chain",
      );
      expect(status.textContent).not.toContain("REVIEWROUTER_CODEX_AUTH_JSON");
      expect(status.textContent).not.toContain("can use this secret in CI");
    });
  });

  it("never offers a generic stable-secret fallback for rotating Codex", async () => {
    vi.mocked(checkProviderRepositorySecretClientAction).mockResolvedValue({
      status: "missing",
    });

    renderReviewConfigForm({
      config: codexReviewConfiguration("codex_subscription_oauth_rotating"),
      repositoryFullName: "777genius/agent-teams-ai",
      repositorySecretCheckTarget: {
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
      },
    });

    expect(
      await screen.findByText(
        /Rotating Codex setup is not ready for this repository/i,
      ),
    ).toBeTruthy();
    expect(pageText()).toContain(
      "A generic repository secret cannot satisfy this readiness check",
    );
    expect(pageText()).not.toContain("REVIEWROUTER_CODEX_AUTH_JSON");
    expect(pageText()).not.toContain("gh secret set");
  });

  it.each(["codex_subscription_oauth", "codex_openai_api_key"] as const)(
    "migrates legacy Codex auth mode %s to rotating OAuth in the form",
    async (authMode) => {
      vi.mocked(checkProviderRepositorySecretClientAction).mockResolvedValue({
        status: "missing",
      });

      renderReviewConfigForm({
        config: codexReviewConfiguration(authMode),
        repositoryFullName: "777genius/agent-teams-ai",
        repositorySecretCheckTarget: {
          workspaceId: "workspace_1",
          repositoryId: "repo_1",
        },
      });

      await waitFor(() => {
        expect(
          screen.getByText(/Rotating Codex setup is not ready/i),
        ).toBeTruthy();
      });
      expect(
        screen.getByText(/Legacy Codex setup requires reconnect/i),
      ).toBeTruthy();
      expect(pageText()).toContain("server-authorized versioned namespace");
      expect(pageText()).not.toContain("REVIEWROUTER_CODEX_AUTH_JSON");
      expect(pageText()).not.toContain("gh secret set");
      expect(pageText()).not.toContain("gh secret set CODEX_AUTH_JSON");
      expect(pageText()).not.toContain("OPENAI_API_KEY");
      const formData = vi.mocked(checkProviderRepositorySecretClientAction).mock
        .calls[0]?.[0] as FormData;
      expect(formData.get("providerKind")).toBe("codex");
      expect(formData.get("authMode")).toBe(
        "codex_subscription_oauth_rotating",
      );
    },
  );

  it("preserves inherited legacy Codex hybrid config as rotating Codex plus other providers", async () => {
    vi.mocked(checkProviderRepositorySecretClientAction).mockResolvedValue({
      status: "missing",
    });

    renderReviewConfigForm({
      config: legacyCodexMultiProviderReviewConfiguration(),
      repositoryFullName: "777genius/agent-teams-ai",
      repositorySecretCheckTarget: {
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
      },
    });

    await waitFor(() => {
      expect(
        screen.getByText(/Rotating Codex setup is not ready/i),
      ).toBeTruthy();
    });
    expect(screen.getByText("Provider 1")).toBeTruthy();
    expect(screen.getByText("Provider 2")).toBeTruthy();
    expect(screen.getByText("Provider 3")).toBeTruthy();
    expect(
      (
        document.querySelector(
          'input[name="providerCount"]',
        ) as HTMLInputElement
      ).value,
    ).toBe("3");
    expect(
      (
        screen.getByRole("button", {
          name: "Add provider",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    const formData = vi.mocked(checkProviderRepositorySecretClientAction).mock
      .calls[0]?.[0] as FormData;
    expect(formData.get("providerKind")).toBe("codex");
    expect(formData.get("authMode")).toBe("codex_subscription_oauth_rotating");
  });

  it("switching one provider to Codex rotating keeps other providers and blocks a second rotating Codex", () => {
    renderReviewConfigForm({
      config: duplicateOpenRouterReviewConfiguration(),
      repositoryFullName: "777genius/agent-teams-ai",
    });

    expect(screen.getByText("Provider 2")).toBeTruthy();

    fireEvent.click(
      screen.getAllByRole("combobox", { name: "Provider auth" })[0]!,
    );
    fireEvent.click(
      screen.getByRole("option", { name: /Codex OAuth with refresh/i }),
    );

    expect(screen.getByText("Provider 2")).toBeTruthy();
    expect(
      (
        document.querySelector(
          'input[name="providerCount"]',
        ) as HTMLInputElement
      ).value,
    ).toBe("2");
    expect(
      (
        screen.getByRole("button", {
          name: "Add provider",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);

    fireEvent.click(
      screen.getAllByRole("combobox", { name: "Provider auth" })[1]!,
    );
    expect(
      screen
        .getByRole("option", { name: /Only one Codex OAuth with refresh/i })
        .getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("selects the MiMo model and shows the repository-specific interactive secret command", async () => {
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

    fireEvent.click(screen.getByRole("combobox", { name: "Provider auth" }));
    fireEvent.click(screen.getByRole("option", { name: /MiMo Token Plan/i }));

    expect(
      (screen.getByRole("textbox", { name: "Model" }) as HTMLInputElement)
        .value,
    ).toBe("mimo-v2.6-pro");
    expect(
      await screen.findByText(
        "gh secret set MIMO_TOKEN_PLAN_API_KEY --repo 777genius/agent-teams-ai --app actions",
      ),
    ).toBeTruthy();
    expect(pageText()).toContain(
      "Without this secret, this provider will fail in CI.",
    );
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

  it("shows only the production Codex OAuth mode", () => {
    renderReviewConfigForm();
    fireEvent.click(screen.getByRole("combobox", { name: "Provider auth" }));
    expect(
      screen.getByRole("option", { name: /Codex OAuth with refresh/i }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("option", { name: /Codex legacy OAuth/i }),
    ).toBeNull();
    expect(screen.queryByRole("option", { name: /Codex API key/i })).toBeNull();
  });

  it("offers max and ultra reasoning effort for Codex", () => {
    renderReviewConfigForm();

    fireEvent.click(screen.getByRole("combobox", { name: "Reasoning effort" }));

    expect(screen.getByRole("option", { name: /Max/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /Ultra/ })).toBeTruthy();
  });

  it("hides max and ultra for an older Codex model", () => {
    renderReviewConfigForm({
      config: codexReviewConfiguration("codex_subscription_oauth_rotating"),
    });

    fireEvent.click(screen.getByRole("combobox", { name: "Reasoning effort" }));

    expect(screen.queryByRole("option", { name: /Max/ })).toBeNull();
    expect(screen.queryByRole("option", { name: /Ultra/ })).toBeNull();
    expect(screen.getByRole("option", { name: /XHigh/ })).toBeTruthy();
  });

  it("clamps ultra to xhigh when the model changes away from gpt-5.6-sol", () => {
    renderReviewConfigForm();

    fireEvent.click(screen.getByRole("combobox", { name: "Reasoning effort" }));
    fireEvent.click(screen.getByRole("option", { name: /Ultra/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Model" }), {
      target: { value: "gpt-5.5" },
    });

    expect(
      screen.getByRole("combobox", { name: "Reasoning effort" }).textContent,
    ).toContain("XHigh");
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
  readonly codexRotatingOAuthEnabled?: boolean;
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
      gatewayAccounts={{ status: "ok", value: gatewayPage }}
      codexRotatingOAuthEnabled={input?.codexRotatingOAuthEnabled ?? true}
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
    requiredHealthy: true,
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
    requiredHealthy: true,
  };
  const secondOpenRouterProvider: ReviewProviderConfiguration = {
    ...firstOpenRouterProvider,
    model: "anthropic/claude-sonnet-4.5",
    requiredHealthy: false,
  };

  return {
    ...safeDefaultReviewConfiguration,
    provider: firstOpenRouterProvider,
    providers: [firstOpenRouterProvider, secondOpenRouterProvider],
  };
}

function legacyCodexMultiProviderReviewConfiguration(): ReviewConfiguration {
  const codexProvider: ReviewProviderConfiguration = {
    kind: "codex",
    authMode: "codex_subscription_oauth",
    model: "gpt-5.5",
    reasoningEffort: "high",
    agenticContext: true,
    fastMode: false,
    requiredHealthy: true,
  };
  const firstOpenRouterProvider: ReviewProviderConfiguration = {
    kind: "openrouter",
    authMode: "openrouter_api_key",
    model: "poolside/laguna-m.1:free",
    reasoningEffort: "medium",
    agenticContext: true,
    fastMode: false,
    requiredHealthy: false,
  };
  const secondOpenRouterProvider: ReviewProviderConfiguration = {
    ...firstOpenRouterProvider,
    model: "anthropic/claude-sonnet-4.5",
  };

  return {
    ...safeDefaultReviewConfiguration,
    provider: codexProvider,
    providers: [
      codexProvider,
      firstOpenRouterProvider,
      secondOpenRouterProvider,
    ],
    execution: {
      ...safeDefaultReviewConfiguration.execution,
      providerLimit: 3,
      providerMaxParallel: 2,
    },
  };
}

function codexReviewConfiguration(
  authMode:
    | "codex_subscription_oauth"
    | "codex_subscription_oauth_rotating"
    | "codex_openai_api_key",
): ReviewConfiguration {
  const codexProvider: ReviewProviderConfiguration = {
    kind: "codex",
    authMode,
    model: "gpt-5.5",
    reasoningEffort: "medium",
    agenticContext: true,
    fastMode: false,
    requiredHealthy: true,
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
    requiredHealthy: true,
  };

  return {
    ...safeDefaultReviewConfiguration,
    provider: claudeProvider,
    providers: [claudeProvider],
  };
}
