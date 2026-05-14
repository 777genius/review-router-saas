import {
  conflictReviewDispatchEventType,
  type ConflictReviewAttempt,
  type ConflictReviewRepository,
  type NewConflictReviewAttempt,
} from "../../domain/conflict-review";

export interface ConflictReviewRepositoryPort {
  findRepositoryByGitHubIdentity(input: {
    readonly githubRepositoryId: string;
    readonly githubInstallationId: string;
  }): Promise<ConflictReviewRepository | null>;

  tryCreateAttempt(
    attempt: NewConflictReviewAttempt,
  ): Promise<
    | { readonly created: true; readonly attempt: ConflictReviewAttempt }
    | { readonly created: false; readonly attempt: ConflictReviewAttempt }
  >;

  refreshAttemptDispatch(input: {
    readonly attemptId: string;
    readonly previousDispatchId: string;
    readonly dispatchId: string;
    readonly dispatchNonceHash: string;
    readonly dispatchEventType: typeof conflictReviewDispatchEventType;
    readonly refreshedAt: Date;
  }): Promise<ConflictReviewAttempt | null>;

  markAttemptDispatched(input: {
    readonly attemptId: string;
    readonly dispatchedAt: Date;
  }): Promise<void>;

  markAttemptSkipped(input: {
    readonly attemptId: string;
    readonly reason: string;
    readonly skippedAt: Date;
  }): Promise<void>;

  markAttemptFailed(input: {
    readonly attemptId: string;
    readonly errorCode: string;
    readonly safeErrorSummary: string;
    readonly failedAt: Date;
  }): Promise<void>;
}
