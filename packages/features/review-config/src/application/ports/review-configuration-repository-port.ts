import type { ReviewConfiguration } from "../../domain/review-configuration";
import type { ReviewConfigurationTarget } from "../../domain/review-configuration-target";

export type PersistedReviewConfiguration = {
  readonly version: number;
  readonly config: ReviewConfiguration;
  readonly revisionToken?: string;
};

export type ReviewConfigurationOperationInput = Readonly<{
  target: ReviewConfigurationTarget;
  config: ReviewConfiguration;
  expectedVersion: number | null;
  operationId: string;
}>;

/** Callers must authorize the target against live membership on EVERY call.
 * A receipt records a historical write; it never authorizes selection/execution.
 */
export interface ReviewConfigurationOperationRepositoryPort {
  saveNextVersionWithOperation(
    input: ReviewConfigurationOperationInput,
  ): Promise<PersistedReviewConfiguration>;

  findOperation(input: {
    readonly target: ReviewConfigurationTarget;
    readonly operationId: string;
    /** Original CAS intent, independent of the retained result version. */
    readonly expectedVersion: number | null;
  }): Promise<PersistedReviewConfiguration | null>;
}

export type RepositoryReviewConfiguration = Readonly<{
  repositoryId: string;
  config: PersistedReviewConfiguration;
}>;

/**
 * Read-only batch boundary kept separate from the mutable repository port so
 * existing single-target consumers and adapters do not need the dashboard's
 * broader query capability.
 */
export interface ReviewConfigurationBatchReaderPort {
  findLatestForRepositories(input: {
    readonly workspaceId: string;
    readonly repositoryIds: readonly string[];
  }): Promise<readonly RepositoryReviewConfiguration[]>;
}

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
