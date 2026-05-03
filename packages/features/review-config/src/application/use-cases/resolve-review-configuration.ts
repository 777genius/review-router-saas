import {
  safeDefaultReviewConfiguration,
  type ReviewConfiguration,
} from "../../domain/review-configuration";
import type { ReviewConfigurationTarget } from "../../domain/review-configuration-target";
import type { ReviewConfigurationRepositoryPort } from "../ports/review-configuration-repository-port";
import { mapConfigToRuntimeEnv } from "./map-config-to-runtime-env";

export type ResolvedReviewConfigurationSource =
  | "repository"
  | "workspace"
  | "default";

export type ResolvedReviewConfiguration = {
  readonly version: number;
  readonly source: ResolvedReviewConfigurationSource;
  readonly config: ReviewConfiguration;
};

export type ResolvedReviewRuntimeEnv = ResolvedReviewConfiguration & {
  readonly runtimeEnv: Record<string, string>;
};

export async function resolveReviewConfiguration(
  target: ReviewConfigurationTarget,
  dependencies: {
    readonly configurations: ReviewConfigurationRepositoryPort;
  },
): Promise<ResolvedReviewConfiguration> {
  if (target.scope === "repository") {
    const repositoryConfig =
      await dependencies.configurations.findLatest(target);
    if (repositoryConfig) {
      return {
        ...repositoryConfig,
        source: "repository",
      };
    }
  }

  const workspaceConfig = await dependencies.configurations.findLatest({
    scope: "workspace",
    workspaceId: target.workspaceId,
  });
  if (workspaceConfig) {
    return {
      ...workspaceConfig,
      source: "workspace",
    };
  }

  return {
    version: 1,
    source: "default",
    config: safeDefaultReviewConfiguration,
  };
}

export async function resolveReviewRuntimeEnv(
  target: ReviewConfigurationTarget,
  dependencies: {
    readonly configurations: ReviewConfigurationRepositoryPort;
  },
): Promise<ResolvedReviewRuntimeEnv> {
  const resolved = await resolveReviewConfiguration(target, dependencies);

  return {
    ...resolved,
    runtimeEnv: mapConfigToRuntimeEnv(resolved.config),
  };
}
