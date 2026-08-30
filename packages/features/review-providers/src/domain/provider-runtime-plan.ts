import {
  cliToolsForProvider,
  getProviderCatalogEntry,
  getProviderAuthModeMetadata,
  providerAuthModeBelongsToKind,
  type ProviderAuthMode,
  type ProviderCliTool,
  type ProviderKind,
  type RuntimeAuthMode,
} from "./provider-catalog";
import type { CodexReasoningEffort } from "./provider-models";

export type RuntimePlanReasoningEffort = CodexReasoningEffort;

export type RuntimePlanProviderConfiguration = {
  readonly kind: ProviderKind;
  readonly authMode: ProviderAuthMode;
  readonly model: string;
  readonly reasoningEffort: RuntimePlanReasoningEffort;
  readonly agenticContext: boolean;
  readonly fastMode: boolean;
  readonly requiredHealthy?: boolean;
};

export type RuntimePlanExecutionConfiguration = {
  readonly providerLimit: number;
  readonly providerMaxParallel: number;
  readonly inlineMinAgreement: number;
};

export type RuntimePlanBlockingPolicy = {
  readonly failOnSeverity: "off" | "critical" | "major";
};

export type RuntimePlanLimits = {
  readonly inlineMaxComments: number;
  readonly targetTokensPerBatch: number;
};

export type ProviderRuntimePlanInput = {
  readonly schemaVersion: number;
  readonly providers: readonly RuntimePlanProviderConfiguration[];
  readonly provider?: RuntimePlanProviderConfiguration;
  readonly execution: RuntimePlanExecutionConfiguration;
  readonly blockingPolicy: RuntimePlanBlockingPolicy;
  readonly limits: RuntimePlanLimits;
};

export type ProviderRuntimePlan = {
  readonly runtimeEnv: Readonly<Record<string, string>>;
  readonly providerIds: readonly string[];
  readonly synthesisModel: string;
  readonly requiredSecretNames: readonly string[];
  readonly requiredCliTools: readonly ProviderCliTool[];
  readonly primaryRuntimeAuthMode: RuntimeAuthMode;
};

export function buildProviderRuntimePlan(
  input: ProviderRuntimePlanInput,
): ProviderRuntimePlan {
  const providers = normalizeRuntimePlanProviders(input);
  const providerIds = providers.map(toRuntimeProviderId);
  const requiredProviderIds = providers
    .filter((provider) => provider.requiredHealthy)
    .map(toRuntimeProviderId);
  const requiredSecretNames = uniqueStable(
    providers.flatMap(
      (provider) => getProviderAuthModeMetadata(provider.authMode).secretNames,
    ),
  );
  const requiredCliTools = uniqueStable(
    providers.flatMap((provider) => cliToolsForProvider(provider.kind)),
  );
  const primary = providers[0]!;
  const primaryAuth = getProviderAuthModeMetadata(primary.authMode);
  const runtimeEnv: Record<string, string> = {
    REVIEWROUTER_CONFIG_SCHEMA_VERSION: String(input.schemaVersion),
    REVIEW_AUTH_MODE: primaryAuth.runtimeAuthMode,
    REVIEW_PROVIDERS: providerIds.join(","),
    REQUIRED_HEALTHY_PROVIDERS: requiredProviderIds.join(","),
    SYNTHESIS_MODEL: providerIds[0]!,
    PROVIDER_LIMIT: String(providers.length),
    PROVIDER_MAX_PARALLEL: String(
      Math.min(input.execution.providerMaxParallel, providers.length),
    ),
    INLINE_MIN_AGREEMENT: String(input.execution.inlineMinAgreement),
    INLINE_MAX_COMMENTS: String(input.limits.inlineMaxComments),
    TARGET_TOKENS_PER_BATCH: String(input.limits.targetTokensPerBatch),
    FAIL_ON_SEVERITY: input.blockingPolicy.failOnSeverity,
  };

  const codexProvider = providers.find((provider) => provider.kind === "codex");
  if (codexProvider) {
    runtimeEnv.CODEX_MODEL = codexProvider.model;
  }

  const codexBackedProvider = providers.find(isCodexBackedProvider);
  if (codexBackedProvider) {
    runtimeEnv.CODEX_REASONING_EFFORT = codexBackedProvider.reasoningEffort;
    runtimeEnv.CODEX_AGENTIC_CONTEXT = String(
      codexBackedProvider.agenticContext,
    );
    runtimeEnv.CODEX_FAST_MODE = String(codexBackedProvider.fastMode);
  }

  const claudeProvider = providers.find(
    (provider) => provider.kind === "claude",
  );
  if (claudeProvider) {
    runtimeEnv.CLAUDE_MODEL = claudeProvider.model;
    runtimeEnv.CLAUDE_AGENTIC_CONTEXT = String(claudeProvider.agenticContext);
  }

  assertRuntimeEnvIsNonSecret(runtimeEnv);

  return {
    runtimeEnv,
    providerIds,
    synthesisModel: providerIds[0]!,
    requiredSecretNames,
    requiredCliTools,
    primaryRuntimeAuthMode: primaryAuth.runtimeAuthMode,
  };
}

export function toRuntimeProviderId(
  provider: RuntimePlanProviderConfiguration,
): string {
  const validatedProvider = validateRuntimePlanProvider(provider);
  const runtimePrefix = getProviderCatalogEntry(
    validatedProvider.kind,
  ).runtimeProviderPrefix;
  return `${runtimePrefix}/${validatedProvider.model}`;
}

export function assertRuntimeEnvIsNonSecret(
  runtimeEnv: Readonly<Record<string, string>>,
): void {
  for (const [key, value] of Object.entries(runtimeEnv)) {
    if (looksLikeSecretValue(value)) {
      throw new Error(`runtime_env_contains_secret_value:${key}`);
    }
  }
}

function normalizeRuntimePlanProviders(
  input: ProviderRuntimePlanInput,
): readonly RuntimePlanProviderConfiguration[] {
  const providers = input.providers.length
    ? input.providers
    : input.provider
      ? [input.provider]
      : [];
  if (!providers.length) {
    throw new Error("provider_runtime_plan_requires_provider");
  }
  const validatedProviders = providers.map(validateRuntimePlanProvider);
  if (validatedProviders.some((provider) => provider.requiredHealthy)) {
    return validatedProviders;
  }

  return validatedProviders.map((provider, index) => ({
    ...provider,
    requiredHealthy: index === 0,
  }));
}

function validateRuntimePlanProvider(
  provider: RuntimePlanProviderConfiguration,
): RuntimePlanProviderConfiguration {
  if (!providerAuthModeBelongsToKind(provider.authMode, provider.kind)) {
    throw new Error("provider_auth_mode_kind_mismatch");
  }
  if (!provider.model.trim()) {
    throw new Error("provider_model_required");
  }
  return {
    ...provider,
    model: provider.model.trim(),
    requiredHealthy: provider.requiredHealthy === true,
  };
}

export function isCodexBackedProvider(
  provider: RuntimePlanProviderConfiguration,
): boolean {
  return (
    provider.kind === "openrouter" ||
    getProviderCatalogEntry(provider.kind).runtimeProviderPrefix.startsWith(
      "codex",
    )
  );
}

function uniqueStable<T>(values: readonly T[]): readonly T[] {
  return [...new Set(values)];
}

function looksLikeSecretValue(value: string): boolean {
  return [
    /sk-ant-oat01-[A-Za-z0-9._-]{12,}/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /github_pat_[A-Za-z0-9_]+/,
    /ghp_[A-Za-z0-9_]+/,
    /xox[baprs]-[A-Za-z0-9-]+/,
    /\bsk-[A-Za-z0-9]{16,}\b/,
  ].some((pattern) => pattern.test(value));
}
