import type { ReviewConfiguration } from "../../domain/review-configuration";
import type { ReviewConfigurationTarget } from "../../domain/review-configuration-target";

export type PersistedReviewConfiguration = {
  readonly version: number;
  readonly config: ReviewConfiguration;
  readonly revisionToken?: string;
};

export class ReviewConfigurationWriteConflictError extends Error {
  readonly code = "review_configuration_write_conflict";

  constructor() {
    super("review_configuration_write_conflict");
    this.name = "ReviewConfigurationWriteConflictError";
  }
}

export function isReviewConfigurationWriteConflictError(
  error: unknown,
): error is ReviewConfigurationWriteConflictError {
  return (
    error instanceof ReviewConfigurationWriteConflictError ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "review_configuration_write_conflict")
  );
}

export interface ReviewConfigurationRepositoryPort {
  findLatest(
    target: ReviewConfigurationTarget,
  ): Promise<PersistedReviewConfiguration | null>;

  saveNextVersion(input: {
    readonly target: ReviewConfigurationTarget;
    readonly config: ReviewConfiguration;
    /**
     * Omitted disables CAS, null expects no version, and a number expects that
     * exact latest version. Implementations throw a write conflict on mismatch.
     */
    readonly expectedVersion?: number | null;
  }): Promise<PersistedReviewConfiguration>;

  deleteTarget(target: ReviewConfigurationTarget): Promise<boolean>;
}
