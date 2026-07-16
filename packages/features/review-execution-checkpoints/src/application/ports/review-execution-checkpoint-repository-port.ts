import type {
  ReviewExecutionBatchResult,
  ReviewExecutionBatchCommitStatus,
  ReviewExecutionCheckpointAggregate,
  ReviewExecutionCheckpointClearStatus,
  ReviewExecutionCheckpointFinalizeStatus,
  ReviewExecutionCheckpointRoot,
  ReviewExecutionCheckpointScope,
  ReviewExecutionCheckpointStartStatus,
} from "../../domain/review-execution-checkpoint";

export type ReviewExecutionCheckpointConflict = {
  readonly currentVersion: number;
  readonly currentState?: ReviewExecutionCheckpointRoot["state"] | undefined;
  readonly currentHeadSha?: string | undefined;
  readonly currentPlanHash?: string | undefined;
};

export type StartOrReplaceReviewExecutionCheckpointResult =
  | {
      readonly status:
        | ReviewExecutionCheckpointStartStatus.Started
        | ReviewExecutionCheckpointStartStatus.Replaced
        | ReviewExecutionCheckpointStartStatus.Idempotent;
      readonly checkpoint: ReviewExecutionCheckpointRoot;
    }
  | ({
      readonly status: ReviewExecutionCheckpointStartStatus.Conflict;
    } & ReviewExecutionCheckpointConflict)
  | {
      readonly status: ReviewExecutionCheckpointStartStatus.Finalized;
      readonly checkpoint: ReviewExecutionCheckpointRoot;
    };

export type CommitReviewExecutionBatchResult =
  | {
      readonly status: ReviewExecutionBatchCommitStatus.Committed;
      readonly checkpoint: ReviewExecutionCheckpointRoot;
      readonly batchResult: ReviewExecutionBatchResult;
    }
  | {
      readonly status: ReviewExecutionBatchCommitStatus.Idempotent;
      readonly checkpoint: ReviewExecutionCheckpointRoot;
      readonly batchResult: ReviewExecutionBatchResult;
    }
  | ({
      readonly status: ReviewExecutionBatchCommitStatus.Conflict;
      readonly currentPayloadHash?: string | undefined;
    } & ReviewExecutionCheckpointConflict)
  | {
      readonly status: ReviewExecutionBatchCommitStatus.Missing;
      readonly currentVersion: 0;
    }
  | {
      readonly status: ReviewExecutionBatchCommitStatus.Finalized;
      readonly checkpoint: ReviewExecutionCheckpointRoot;
    }
  | {
      readonly status: ReviewExecutionBatchCommitStatus.UnplannedWork;
      readonly checkpoint: ReviewExecutionCheckpointRoot;
    }
  | {
      readonly status: ReviewExecutionBatchCommitStatus.BudgetExceeded;
      readonly checkpoint: ReviewExecutionCheckpointRoot;
      readonly acceptedBytes: number;
      readonly acceptedFindings: number;
    }
  | {
      readonly status: ReviewExecutionBatchCommitStatus.Corrupted;
      readonly currentVersion: number;
    };

export type FinalizeReviewExecutionCheckpointResult =
  | {
      readonly status:
        | ReviewExecutionCheckpointFinalizeStatus.Finalized
        | ReviewExecutionCheckpointFinalizeStatus.Idempotent;
      readonly checkpoint: ReviewExecutionCheckpointRoot;
    }
  | ({
      readonly status: ReviewExecutionCheckpointFinalizeStatus.Conflict;
    } & ReviewExecutionCheckpointConflict)
  | {
      readonly status: ReviewExecutionCheckpointFinalizeStatus.Missing;
      readonly currentVersion: 0;
    }
  | {
      readonly status: ReviewExecutionCheckpointFinalizeStatus.Incomplete;
      readonly checkpoint: ReviewExecutionCheckpointRoot;
      readonly missingWorkKeys: readonly string[];
    }
  | {
      readonly status: ReviewExecutionCheckpointFinalizeStatus.Corrupted;
      readonly currentVersion: number;
    };

export type ClearReviewExecutionCheckpointResult =
  | { readonly status: ReviewExecutionCheckpointClearStatus.Cleared }
  | { readonly status: ReviewExecutionCheckpointClearStatus.Missing }
  | ({
      readonly status: ReviewExecutionCheckpointClearStatus.Conflict;
    } & ReviewExecutionCheckpointConflict);

export interface ReviewExecutionCheckpointRepositoryPort {
  find(
    scope: ReviewExecutionCheckpointScope,
  ): Promise<ReviewExecutionCheckpointAggregate | null>;

  startOrReplace(input: {
    readonly expectedVersion: number;
    readonly checkpoint: ReviewExecutionCheckpointRoot;
  }): Promise<StartOrReplaceReviewExecutionCheckpointResult>;

  commitBatchResult(input: {
    readonly scope: ReviewExecutionCheckpointScope;
    readonly expectedVersion: number;
    readonly headSha: string;
    readonly planHash: string;
    readonly batchResult: ReviewExecutionBatchResult;
    readonly updatedAt: Date;
    readonly expiresAt: Date;
  }): Promise<CommitReviewExecutionBatchResult>;

  finalize(input: {
    readonly scope: ReviewExecutionCheckpointScope;
    readonly expectedVersion: number;
    readonly headSha: string;
    readonly planHash: string;
    readonly finalizedAt: Date;
    readonly expiresAt: Date;
  }): Promise<FinalizeReviewExecutionCheckpointResult>;

  clear(input: {
    readonly scope: ReviewExecutionCheckpointScope;
    readonly expectedVersion: number;
    readonly headSha: string;
    readonly planHash: string;
  }): Promise<ClearReviewExecutionCheckpointResult>;

  pruneExpired(input: {
    readonly expiredBefore: Date;
    readonly limit: number;
  }): Promise<number>;
}
