import { z } from "zod";

export const reviewProviderKinds = ["codex", "claude", "openrouter"] as const;

export const reviewProviderAuthModes = [
  "codex_subscription_oauth",
  "codex_subscription_oauth_rotating",
  "codex_subscription_oauth_hosted_pool",
  "codex_openai_api_key",
  "claude_code_oauth",
  "openrouter_api_key",
] as const;

export const providerKindSchema = z.enum(reviewProviderKinds);
export const providerAuthModeSchema = z.enum(reviewProviderAuthModes);

export type ProviderKind = (typeof reviewProviderKinds)[number];
export type ProviderAuthMode = (typeof reviewProviderAuthModes)[number];

export type RuntimeAuthMode =
  | "codex-oauth"
  | "codex-oauth-rotating"
  | "codex-oauth-hosted-pool"
  | "openai-api"
  | "claude-oauth"
  | "openrouter-api";

export type ProviderCliTool = "codex" | "claude";
export type RuntimeProviderPrefix = "codex" | "claude" | "openrouter";
export const defaultProviderReasoningEffort = "xhigh" as const;

export type ProviderCapability =
  | "static_model_catalog"
  | "dynamic_model_catalog"
  | "subscription_oauth"
  | "rotating_oauth"
  | "hosted_account_pool"
  | "api_key"
  | "reasoning_effort"
  | "fast_mode"
  | "agentic_context";

export type ProviderSetupKind =
  | "codex_oauth"
  | "codex_oauth_rotating"
  | "codex_oauth_hosted_pool"
  | "openai_api_key"
  | "claude_code_oauth"
  | "openrouter_api_key";

export type ProviderCatalogEntry = {
  readonly kind: ProviderKind;
  readonly label: string;
  readonly authModes: readonly ProviderAuthMode[];
  readonly defaultAuthMode: ProviderAuthMode;
  readonly defaultModel: string;
  readonly runtimeProviderPrefix: RuntimeProviderPrefix;
  readonly capabilities: readonly ProviderCapability[];
};

export type ProviderAuthModeMetadata = {
  readonly authMode: ProviderAuthMode;
  readonly providerKind: ProviderKind;
  readonly runtimeAuthMode: RuntimeAuthMode;
  readonly setupKind: ProviderSetupKind;
  readonly label: string;
  readonly secretNames: readonly string[];
};

export const defaultCodexModel = "gpt-5.6-sol";

const providerCatalog = {
  codex: {
    kind: "codex",
    label: "Codex",
    authModes: [
      "codex_subscription_oauth_rotating",
      "codex_subscription_oauth_hosted_pool",
    ],
    defaultAuthMode: "codex_subscription_oauth_rotating",
    defaultModel: defaultCodexModel,
    runtimeProviderPrefix: "codex",
    capabilities: [
      "static_model_catalog",
      "subscription_oauth",
      "rotating_oauth",
      "hosted_account_pool",
      "reasoning_effort",
      "fast_mode",
      "agentic_context",
    ],
  },
  claude: {
    kind: "claude",
    label: "Claude Code",
    authModes: ["claude_code_oauth"],
    defaultAuthMode: "claude_code_oauth",
    defaultModel: "sonnet",
    runtimeProviderPrefix: "claude",
    capabilities: ["static_model_catalog", "subscription_oauth"],
  },
  openrouter: {
    kind: "openrouter",
    label: "OpenRouter",
    authModes: ["openrouter_api_key"],
    defaultAuthMode: "openrouter_api_key",
    defaultModel: "openai/gpt-5.3-codex",
    runtimeProviderPrefix: "openrouter",
    capabilities: ["dynamic_model_catalog", "api_key"],
  },
} as const satisfies Record<ProviderKind, ProviderCatalogEntry>;

const authModeMetadata = {
  codex_subscription_oauth: {
    authMode: "codex_subscription_oauth",
    providerKind: "codex",
    runtimeAuthMode: "codex-oauth",
    setupKind: "codex_oauth",
    label: "Codex subscription",
    secretNames: ["CODEX_AUTH_JSON"],
  },
  codex_subscription_oauth_rotating: {
    authMode: "codex_subscription_oauth_rotating",
    providerKind: "codex",
    runtimeAuthMode: "codex-oauth-rotating",
    setupKind: "codex_oauth_rotating",
    label: "Codex subscription rotating",
    // Rotating credentials use a server-authorized, never-reused namespace;
    // there is no stable catalog secret name to probe or inject.
    secretNames: [],
  },
  codex_subscription_oauth_hosted_pool: {
    authMode: "codex_subscription_oauth_hosted_pool",
    providerKind: "codex",
    runtimeAuthMode: "codex-oauth-hosted-pool",
    setupKind: "codex_oauth_hosted_pool",
    label: "Codex subscription hosted pool",
    // GitHub Actions receives only an invocation-bounded relay grant.
    secretNames: [],
  },
  codex_openai_api_key: {
    authMode: "codex_openai_api_key",
    providerKind: "codex",
    runtimeAuthMode: "openai-api",
    setupKind: "openai_api_key",
    label: "OpenAI API key",
    secretNames: ["OPENAI_API_KEY"],
  },
  claude_code_oauth: {
    authMode: "claude_code_oauth",
    providerKind: "claude",
    runtimeAuthMode: "claude-oauth",
    setupKind: "claude_code_oauth",
    label: "Claude Code subscription",
    secretNames: ["CLAUDE_CODE_OAUTH_TOKEN"],
  },
  openrouter_api_key: {
    authMode: "openrouter_api_key",
    providerKind: "openrouter",
    runtimeAuthMode: "openrouter-api",
    setupKind: "openrouter_api_key",
    label: "OpenRouter API key",
    secretNames: ["OPENROUTER_API_KEY"],
  },
} as const satisfies Record<ProviderAuthMode, ProviderAuthModeMetadata>;

export function getProviderCatalogEntry(
  kind: ProviderKind,
): ProviderCatalogEntry {
  return providerCatalog[kind];
}

export function getProviderAuthModeMetadata(
  authMode: ProviderAuthMode,
): ProviderAuthModeMetadata {
  return authModeMetadata[authMode];
}

export function providerKindForAuthMode(
  authMode: ProviderAuthMode,
): ProviderKind {
  return getProviderAuthModeMetadata(authMode).providerKind;
}

export function providerAuthModeBelongsToKind(
  authMode: ProviderAuthMode,
  kind: ProviderKind,
): boolean {
  return providerKindForAuthMode(authMode) === kind;
}

export function assertProviderAuthModeBelongsToKind(
  authMode: ProviderAuthMode,
  kind: ProviderKind,
): void {
  if (!providerAuthModeBelongsToKind(authMode, kind)) {
    throw new Error("provider_auth_mode_kind_mismatch");
  }
}

export function getProviderSecretNames(
  authMode: ProviderAuthMode,
): readonly string[] {
  return getProviderAuthModeMetadata(authMode).secretNames;
}

export function getProviderCapabilities(
  kind: ProviderKind,
): readonly ProviderCapability[] {
  return getProviderCatalogEntry(kind).capabilities;
}

export function providerHasCapability(
  kind: ProviderKind,
  capability: ProviderCapability,
): boolean {
  return getProviderCapabilities(kind).includes(capability);
}

export function toLegacyRuntimeAuthMode(
  authMode: ProviderAuthMode,
): RuntimeAuthMode {
  return getProviderAuthModeMetadata(authMode).runtimeAuthMode;
}

export function toProviderSetupKind(
  authMode: ProviderAuthMode,
): ProviderSetupKind {
  return getProviderAuthModeMetadata(authMode).setupKind;
}

export function fromProviderSetupKind(
  setupKind: ProviderSetupKind,
): ProviderAuthMode {
  const match = reviewProviderAuthModes.find(
    (authMode) => authModeMetadata[authMode].setupKind === setupKind,
  );
  if (!match) {
    throw new Error("unknown_provider_setup_kind");
  }
  return match;
}

export function cliToolsForProvider(
  kind: ProviderKind,
): readonly ProviderCliTool[] {
  switch (kind) {
    case "codex":
      return ["codex"];
    case "claude":
      return ["claude"];
    case "openrouter":
      return ["codex"];
  }
}

export function getDefaultProviderConfigForAuthMode(
  authMode: ProviderAuthMode,
): {
  readonly kind: ProviderKind;
  readonly authMode: ProviderAuthMode;
  readonly model: string;
  readonly reasoningEffort: typeof defaultProviderReasoningEffort;
  readonly agenticContext: boolean;
  readonly fastMode: boolean;
} {
  const kind = providerKindForAuthMode(authMode);
  return {
    kind,
    authMode,
    model: getProviderCatalogEntry(kind).defaultModel,
    reasoningEffort: defaultProviderReasoningEffort,
    agenticContext: true,
    fastMode: false,
  };
}

export function allProviderCatalogEntries(): readonly ProviderCatalogEntry[] {
  return reviewProviderKinds.map(getProviderCatalogEntry);
}

export function allProviderAuthModeMetadata(): readonly ProviderAuthModeMetadata[] {
  return reviewProviderAuthModes.map(getProviderAuthModeMetadata);
}
