import { buildProviderRuntimePlan } from "@reviewrouter/features-review-providers";
import type { ReviewConfiguration } from "../../domain/review-configuration";

export function mapConfigToRuntimeEnv(
  config: ReviewConfiguration,
): Record<string, string> {
  const runtimeEnv: Record<string, string> = {
    ...buildProviderRuntimePlan(config).runtimeEnv,
  };
  const reviewLanguage = config.reviewLanguage?.trim();
  if (reviewLanguage) {
    runtimeEnv.REVIEW_OUTPUT_LANGUAGE = reviewLanguage;
  }
  return runtimeEnv;
}
