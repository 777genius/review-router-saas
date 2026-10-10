import { describe, expect, it } from "vitest";
import {
  allProviderAuthModeMetadata,
  allProviderCatalogEntries,
  assertProviderAuthModeBelongsToKind,
  cliToolsForProvider,
  fromProviderSetupKind,
  getDefaultProviderConfigForAuthMode,
  getProviderCatalogEntry,
  getProviderSecretNames,
  providerAuthModeBelongsToKind,
  providerKindForAuthMode,
  reviewProviderAuthModes,
  reviewProviderKinds,
  toLegacyRuntimeAuthMode,
  toProviderSetupKind,
} from "../index";

describe("provider catalog", () => {
  it("has exhaustive provider and auth mode metadata", () => {
    expect(allProviderCatalogEntries().map((entry) => entry.kind)).toEqual([
      "codex",
      "codex-mimo",
      "claude",
      "openrouter",
    ]);
    expect(
      allProviderAuthModeMetadata().map((entry) => entry.authMode),
    ).toEqual([
      "codex_subscription_oauth",
      "codex_subscription_oauth_rotating",
      "codex_subscription_oauth_hosted_pool",
      "codex_account_gateway",
      "codex_openai_api_key",
      "mimo_token_plan_api_key",
      "claude_code_oauth",
      "openrouter_api_key",
    ]);
    expect(allProviderCatalogEntries()).toHaveLength(
      reviewProviderKinds.length,
    );
    expect(allProviderAuthModeMetadata()).toHaveLength(
      reviewProviderAuthModes.length,
    );
  });

  it("keeps auth modes owned by exactly one provider kind", () => {
    expect(providerKindForAuthMode("codex_subscription_oauth")).toBe("codex");
    expect(providerKindForAuthMode("codex_subscription_oauth_rotating")).toBe(
      "codex",
    );
    expect(
      providerKindForAuthMode("codex_subscription_oauth_hosted_pool"),
    ).toBe("codex");
    expect(providerKindForAuthMode("codex_openai_api_key")).toBe("codex");
    expect(providerKindForAuthMode("mimo_token_plan_api_key")).toBe(
      "codex-mimo",
    );
    expect(providerKindForAuthMode("claude_code_oauth")).toBe("claude");
    expect(providerKindForAuthMode("openrouter_api_key")).toBe("openrouter");

    expect(providerAuthModeBelongsToKind("claude_code_oauth", "codex")).toBe(
      false,
    );
    expect(() =>
      assertProviderAuthModeBelongsToKind("claude_code_oauth", "codex"),
    ).toThrow("provider_auth_mode_kind_mismatch");
  });

  it("maps secret names and legacy runtime auth modes", () => {
    expect(getProviderSecretNames("claude_code_oauth")).toEqual([
      "CLAUDE_CODE_OAUTH_TOKEN",
    ]);
    expect(toLegacyRuntimeAuthMode("claude_code_oauth")).toBe("claude-oauth");
    expect(toLegacyRuntimeAuthMode("codex_subscription_oauth")).toBe(
      "codex-oauth",
    );
    expect(toLegacyRuntimeAuthMode("codex_subscription_oauth_rotating")).toBe(
      "codex-oauth-rotating",
    );
    expect(getProviderSecretNames("codex_subscription_oauth_rotating")).toEqual(
      [],
    );
    expect(
      toLegacyRuntimeAuthMode("codex_subscription_oauth_hosted_pool"),
    ).toBe("codex-oauth-hosted-pool");
    expect(
      getProviderSecretNames("codex_subscription_oauth_hosted_pool"),
    ).toEqual([]);
    expect(toLegacyRuntimeAuthMode("codex_openai_api_key")).toBe("openai-api");
    expect(getProviderSecretNames("mimo_token_plan_api_key")).toEqual([
      "MIMO_TOKEN_PLAN_API_KEY",
    ]);
    expect(toLegacyRuntimeAuthMode("mimo_token_plan_api_key")).toBe(
      "mimo-token-plan-api",
    );
    expect(toLegacyRuntimeAuthMode("openrouter_api_key")).toBe(
      "openrouter-api",
    );
  });

  it("bridges provider setup kinds without dashboard truth tables", () => {
    expect(toProviderSetupKind("claude_code_oauth")).toBe("claude_code_oauth");
    expect(fromProviderSetupKind("claude_code_oauth")).toBe(
      "claude_code_oauth",
    );
    expect(fromProviderSetupKind("codex_oauth")).toBe(
      "codex_subscription_oauth",
    );
    expect(fromProviderSetupKind("codex_oauth_rotating")).toBe(
      "codex_subscription_oauth_rotating",
    );
    expect(fromProviderSetupKind("codex_oauth_hosted_pool")).toBe(
      "codex_subscription_oauth_hosted_pool",
    );
    expect(toProviderSetupKind("mimo_token_plan_api_key")).toBe(
      "mimo_token_plan_api_key",
    );
  });

  it("provides safe defaults by auth mode", () => {
    expect(getDefaultProviderConfigForAuthMode("claude_code_oauth")).toEqual({
      kind: "claude",
      authMode: "claude_code_oauth",
      model: "sonnet",
      reasoningEffort: "xhigh",
      agenticContext: true,
      fastMode: false,
    });
    expect(getProviderCatalogEntry("claude").capabilities).toEqual([
      "static_model_catalog",
      "subscription_oauth",
    ]);
    expect(getProviderCatalogEntry("codex").authModes).toEqual([
      "codex_subscription_oauth_rotating",
      "codex_subscription_oauth_hosted_pool",
    ]);
    expect(getProviderCatalogEntry("codex").defaultAuthMode).toBe(
      "codex_subscription_oauth_rotating",
    );
    expect(getProviderCatalogEntry("codex").defaultModel).toBe("gpt-5.6-sol");
    expect(getProviderCatalogEntry("codex").capabilities).not.toContain(
      "api_key",
    );
    expect(getDefaultProviderConfigForAuthMode("openrouter_api_key")).toEqual({
      kind: "openrouter",
      authMode: "openrouter_api_key",
      model: "openai/gpt-5.3-codex",
      reasoningEffort: "xhigh",
      agenticContext: true,
      fastMode: false,
    });
    expect(getProviderCatalogEntry("openrouter").runtimeProviderPrefix).toBe(
      "openrouter",
    );
    expect(cliToolsForProvider("openrouter")).toEqual(["codex"]);
    expect(
      getDefaultProviderConfigForAuthMode("mimo_token_plan_api_key"),
    ).toEqual({
      kind: "codex-mimo",
      authMode: "mimo_token_plan_api_key",
      model: "mimo-v2.6-pro",
      reasoningEffort: "xhigh",
      agenticContext: true,
      fastMode: false,
    });
    expect(getProviderCatalogEntry("codex-mimo").runtimeProviderPrefix).toBe(
      "codex-mimo",
    );
    expect(cliToolsForProvider("codex-mimo")).toEqual(["codex"]);
  });
});

// Detects accidental UI advertisement, legacy auth coercion or secret requirements.
it("keeps Account Gateway opt-in and owned by Codex", () => {
  expect(providerKindForAuthMode("codex_account_gateway")).toBe("codex");
  expect(toLegacyRuntimeAuthMode("codex_account_gateway")).toBe(
    "codex-account-gateway",
  );
  expect(toProviderSetupKind("codex_account_gateway")).toBe("account_gateway");
  expect(fromProviderSetupKind("account_gateway")).toBe(
    "codex_account_gateway",
  );
  expect(getProviderSecretNames("codex_account_gateway")).toEqual([]);
  expect(getProviderCatalogEntry("codex").authModes).not.toContain(
    "codex_account_gateway",
  );
  for (const kind of ["claude", "openrouter"] as const) {
    expect(() =>
      assertProviderAuthModeBelongsToKind("codex_account_gateway", kind),
    ).toThrow("provider_auth_mode_kind_mismatch");
  }
});

// Detects unknown input resolving through inherited JavaScript object properties.
it("rejects unknown kind/auth metadata instead of inventing a fallback", () => {
  expect(() => getProviderCatalogEntry("toString" as never)).toThrow(
    "unknown_provider_kind",
  );
  expect(() => providerKindForAuthMode("toString" as never)).toThrow(
    "unknown_provider_auth_mode",
  );
});
