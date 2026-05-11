import type { ReviewConfiguration } from "../../domain/review-configuration";

export function mapConfigToRuntimeEnv(
  config: ReviewConfiguration,
): Record<string, string> {
  const common = {
    REVIEWROUTER_CONFIG_SCHEMA_VERSION: String(config.schemaVersion),
    CODEX_MODEL: config.provider.model,
    CODEX_REASONING_EFFORT: config.provider.reasoningEffort,
    CODEX_AGENTIC_CONTEXT: String(config.provider.agenticContext),
    CODEX_FAST_MODE: String(config.provider.fastMode),
    INLINE_MAX_COMMENTS: String(config.limits.inlineMaxComments),
    TARGET_TOKENS_PER_BATCH: String(config.limits.targetTokensPerBatch),
    FAIL_ON_SEVERITY: config.blockingPolicy.failOnSeverity,
  };

  switch (config.provider.authMode) {
    case "codex_subscription_oauth":
      return { ...common, REVIEW_AUTH_MODE: "codex-oauth" };
    case "codex_openai_api_key":
      return { ...common, REVIEW_AUTH_MODE: "openai-api" };
    case "openrouter_api_key":
      const openRouterProvider = `openrouter/${config.provider.model}`;
      return {
        ...common,
        REVIEW_AUTH_MODE: "openrouter-api",
        REVIEW_PROVIDERS: openRouterProvider,
        SYNTHESIS_MODEL: openRouterProvider,
      };
  }
}
