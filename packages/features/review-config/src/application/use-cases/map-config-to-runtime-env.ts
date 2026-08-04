import { buildProviderRuntimePlan } from "@reviewrouter/features-review-providers";
import type { ReviewConfiguration } from "../../domain/review-configuration";

export function mapConfigToRuntimeEnv(
  config: ReviewConfiguration,
): Record<string, string> {
  const investigation = config.investigationRollout;
  const runtimeEnv: Record<string, string> = {
    ...buildProviderRuntimePlan(config).runtimeEnv,
    REVIEW_ROUTER_REVIEW_INVESTIGATION_RECORDING_ENABLED: runtimeToggle(
      investigation.recordingEnabled,
    ),
    REVIEW_ROUTER_REVIEW_INVESTIGATION_SHADOW_ENABLED: runtimeToggle(
      investigation.shadowEnabled,
    ),
    REVIEW_ROUTER_REVIEW_INVESTIGATION_CONTEXT_CRITIC_ENABLED: runtimeToggle(
      investigation.contextCriticEnabled,
    ),
    REVIEW_ROUTER_REVIEW_INVESTIGATION_VERIFIED_CLEAN_ENABLED: runtimeToggle(
      investigation.verifiedCleanEnabled,
    ),
    REVIEW_ROUTER_REVIEW_INVESTIGATION_CROSS_REVISION_REPLAY_ENABLED:
      runtimeToggle(investigation.crossRevisionReplayEnabled),
    REVIEW_ROUTER_REVIEW_INVESTIGATION_PRODUCTION_EFFECTS_ENABLED:
      runtimeToggle(investigation.productionEffectsEnabled),
  };
  const reviewLanguage = config.reviewLanguage?.trim();
  if (reviewLanguage) {
    runtimeEnv.REVIEW_OUTPUT_LANGUAGE = reviewLanguage;
  }
  return runtimeEnv;
}

function runtimeToggle(enabled: boolean): "0" | "1" {
  return enabled ? "1" : "0";
}
