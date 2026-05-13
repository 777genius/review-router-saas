import { buildProviderRuntimePlan } from "@reviewrouter/features-review-providers";
import type { ReviewConfiguration } from "../../domain/review-configuration";

export function mapConfigToRuntimeEnv(
  config: ReviewConfiguration,
): Record<string, string> {
  return { ...buildProviderRuntimePlan(config).runtimeEnv };
}
