import {
  parseReviewConfiguration,
  type ReviewConfiguration,
} from "../../domain/review-configuration";
import type { ReviewConfigurationTarget } from "../../domain/review-configuration-target";
import type {
  PersistedReviewConfiguration,
  ReviewConfigurationRepositoryPort,
} from "../ports/review-configuration-repository-port";

export async function saveReviewConfiguration(
  input: {
    readonly target: ReviewConfigurationTarget;
    readonly config: ReviewConfiguration;
  },
  dependencies: {
    readonly configurations: ReviewConfigurationRepositoryPort;
  },
): Promise<PersistedReviewConfiguration> {
  const config = parseReviewConfiguration(input.config);

  return dependencies.configurations.saveNextVersion({
    target: input.target,
    config,
  });
}

export async function findReviewConfiguration(
  target: ReviewConfigurationTarget,
  dependencies: {
    readonly configurations: ReviewConfigurationRepositoryPort;
  },
): Promise<PersistedReviewConfiguration | null> {
  return dependencies.configurations.findLatest(target);
}

export async function clearReviewConfiguration(
  target: ReviewConfigurationTarget,
  dependencies: {
    readonly configurations: ReviewConfigurationRepositoryPort;
  },
): Promise<boolean> {
  return dependencies.configurations.deleteTarget(target);
}
