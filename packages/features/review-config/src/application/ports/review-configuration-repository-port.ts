import type { ReviewConfiguration } from "../../domain/review-configuration";
import type { ReviewConfigurationTarget } from "../../domain/review-configuration-target";

export type PersistedReviewConfiguration = {
  readonly version: number;
  readonly config: ReviewConfiguration;
};

export interface ReviewConfigurationRepositoryPort {
  findLatest(
    target: ReviewConfigurationTarget,
  ): Promise<PersistedReviewConfiguration | null>;

  saveNextVersion(input: {
    readonly target: ReviewConfigurationTarget;
    readonly config: ReviewConfiguration;
  }): Promise<PersistedReviewConfiguration>;
}
