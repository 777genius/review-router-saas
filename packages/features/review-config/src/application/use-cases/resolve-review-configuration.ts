import { createHash } from "node:crypto";
import {
  safeDefaultReviewConfiguration,
  type ReviewConfiguration,
} from "../../domain/review-configuration";
import type { ReviewConfigurationTarget } from "../../domain/review-configuration-target";
import type {
  PersistedReviewConfiguration,
  ReviewConfigurationRepositoryPort,
} from "../ports/review-configuration-repository-port";
import { mapConfigToRuntimeEnv } from "./map-config-to-runtime-env";

export type ResolvedReviewConfigurationSource =
  | "repository"
  | "workspace"
  | "default";

export type ResolvedReviewConfiguration = {
  readonly version: number;
  readonly source: ResolvedReviewConfigurationSource;
  readonly revisionToken: string;
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
        revisionToken: revisionTokenFor("repository", repositoryConfig),
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
      revisionToken: revisionTokenFor("workspace", workspaceConfig),
    };
  }

  return {
    version: 1,
    source: "default",
    config: safeDefaultReviewConfiguration,
    revisionToken: revisionTokenFor("default", {
      version: 1,
      config: safeDefaultReviewConfiguration,
    }),
  };
}

function revisionTokenFor(
  source: ResolvedReviewConfigurationSource,
  persisted: PersistedReviewConfiguration,
): string {
  if (persisted.revisionToken) return persisted.revisionToken;
  const digest = createHash("sha256")
    .update(JSON.stringify(persisted.config))
    .digest("hex");
  return `logical:${source}:${persisted.version}:${digest}`;
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
