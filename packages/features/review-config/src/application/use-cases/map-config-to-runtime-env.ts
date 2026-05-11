import type {
  ReviewConfiguration,
  ReviewProviderConfiguration,
} from "../../domain/review-configuration";

export function mapConfigToRuntimeEnv(
  config: ReviewConfiguration,
): Record<string, string> {
  const providers = config.providers.length
    ? config.providers
    : [config.provider];
  const providerIds = providers.map(toRuntimeProviderId);
  const synthesisModel = providerIds[0] ?? toRuntimeProviderId(config.provider);
  const codexProvider =
    providers.find((provider) => provider.kind === "codex") ?? config.provider;

  return {
    REVIEWROUTER_CONFIG_SCHEMA_VERSION: String(config.schemaVersion),
    CODEX_MODEL: codexProvider.model,
    CODEX_REASONING_EFFORT: codexProvider.reasoningEffort,
    CODEX_AGENTIC_CONTEXT: String(codexProvider.agenticContext),
    CODEX_FAST_MODE: String(codexProvider.fastMode),
    INLINE_MAX_COMMENTS: String(config.limits.inlineMaxComments),
    INLINE_MIN_AGREEMENT: String(config.execution.inlineMinAgreement),
    TARGET_TOKENS_PER_BATCH: String(config.limits.targetTokensPerBatch),
    FAIL_ON_SEVERITY: config.blockingPolicy.failOnSeverity,
    PROVIDER_LIMIT: String(providers.length),
    PROVIDER_MAX_PARALLEL: String(
      Math.min(config.execution.providerMaxParallel, providers.length),
    ),
    REVIEW_AUTH_MODE: resolveReviewAuthMode(providers),
    REVIEW_PROVIDERS: providerIds.join(","),
    SYNTHESIS_MODEL: synthesisModel,
  };
}

function toRuntimeProviderId(provider: ReviewProviderConfiguration): string {
  switch (provider.kind) {
    case "codex":
      return `codex/${provider.model}`;
    case "openrouter":
      return `openrouter/${provider.model}`;
  }
}

function resolveReviewAuthMode(
  providers: readonly ReviewProviderConfiguration[],
): "codex-oauth" | "openai-api" | "openrouter-api" {
  if (
    providers.some(
      (provider) => provider.authMode === "codex_subscription_oauth",
    )
  ) {
    return "codex-oauth";
  }
  if (
    providers.some((provider) => provider.authMode === "codex_openai_api_key")
  ) {
    return "openai-api";
  }
  return "openrouter-api";
}
