import type {
  ClearReviewExecutionCheckpointResult,
  CommitReviewExecutionBatchResult,
  FinalizeReviewExecutionCheckpointResult,
  ReviewExecutionCheckpointRepositoryPort,
  StartOrReplaceReviewExecutionCheckpointResult,
} from "../../application/ports/review-execution-checkpoint-repository-port";
import {
  ReviewExecutionBatchCommitStatus,
  ReviewExecutionCheckpointClearStatus,
  ReviewExecutionCheckpointFinalizeStatus,
  ReviewExecutionCheckpointStartStatus,
  ReviewExecutionCheckpointState,
  assertReviewExecutionBatchResult,
  assertReviewExecutionCheckpointAggregate,
  isReviewExecutionCheckpointStartIdempotent,
  orderReviewExecutionBatchResults,
  reviewExecutionCheckpointMaxAggregateBytes,
  reviewExecutionCheckpointMaxFindings,
  type ReviewExecutionBatchResult,
  type ReviewExecutionCheckpointAggregate,
  type ReviewExecutionCheckpointRoot,
  type ReviewExecutionCheckpointScope,
} from "../../domain/review-execution-checkpoint";

export class InMemoryReviewExecutionCheckpointRepository implements ReviewExecutionCheckpointRepositoryPort {
  private readonly aggregates = new Map<
    string,
    ReviewExecutionCheckpointAggregate
  >();

  constructor(initial: readonly ReviewExecutionCheckpointAggregate[] = []) {
    for (const aggregate of initial) {
      assertReviewExecutionCheckpointAggregate(aggregate);
      this.aggregates.set(
        scopeKey(aggregate.checkpoint),
        cloneAggregate(aggregate),
      );
    }
  }

  async find(
    scope: ReviewExecutionCheckpointScope,
  ): Promise<ReviewExecutionCheckpointAggregate | null> {
    const aggregate = this.aggregates.get(scopeKey(scope));
    return aggregate ? cloneAggregate(aggregate) : null;
  }

  async startOrReplace(input: {
    readonly expectedVersion: number;
    readonly checkpoint: ReviewExecutionCheckpointRoot;
  }): Promise<StartOrReplaceReviewExecutionCheckpointResult> {
    assertReviewExecutionCheckpointAggregate({
      checkpoint: input.checkpoint,
      batchResults: [],
    });
    const key = scopeKey(input.checkpoint);
    const current = this.aggregates.get(key);
    const currentExpired =
      current !== undefined &&
      current.checkpoint.expiresAt <= input.checkpoint.updatedAt;
    if (
      current &&
      !currentExpired &&
      isReviewExecutionCheckpointStartIdempotent(
        current.checkpoint,
        input.checkpoint,
      )
    ) {
      return {
        status: ReviewExecutionCheckpointStartStatus.Idempotent,
        checkpoint: cloneRoot(current.checkpoint),
      };
    }
    if (
      !currentExpired &&
      current?.checkpoint.state === ReviewExecutionCheckpointState.Finalized
    ) {
      return {
        status: ReviewExecutionCheckpointStartStatus.Finalized,
        checkpoint: cloneRoot(current.checkpoint),
      };
    }
    if ((current?.checkpoint.version ?? 0) !== input.expectedVersion) {
      return startConflict(current?.checkpoint);
    }
    const aggregate: ReviewExecutionCheckpointAggregate = {
      checkpoint: cloneRoot(input.checkpoint),
      batchResults: [],
    };
    assertReviewExecutionCheckpointAggregate(aggregate);
    this.aggregates.set(key, aggregate);
    return {
      status: current
        ? ReviewExecutionCheckpointStartStatus.Replaced
        : ReviewExecutionCheckpointStartStatus.Started,
      checkpoint: cloneRoot(aggregate.checkpoint),
    };
  }

  async commitBatchResult(input: {
    readonly scope: ReviewExecutionCheckpointScope;
    readonly expectedVersion: number;
    readonly headSha: string;
    readonly planHash: string;
    readonly batchResult: ReviewExecutionBatchResult;
    readonly updatedAt: Date;
    readonly expiresAt: Date;
  }): Promise<CommitReviewExecutionBatchResult> {
    assertReviewExecutionBatchResult(input.batchResult);
    const key = scopeKey(input.scope);
    const aggregate = this.aggregates.get(key);
    if (!aggregate) {
      return {
        status: ReviewExecutionBatchCommitStatus.Missing,
        currentVersion: 0,
      };
    }
    if (
      aggregate.checkpoint.headSha !== input.headSha ||
      aggregate.checkpoint.planHash !== input.planHash ||
      aggregate.checkpoint.expiresAt <= input.updatedAt
    ) {
      return {
        status: ReviewExecutionBatchCommitStatus.Conflict,
        ...checkpointConflict(aggregate.checkpoint),
      };
    }
    const existing = aggregate.batchResults.find(
      (result) => result.workKey === input.batchResult.workKey,
    );
    if (existing) {
      if (existing.payloadHash === input.batchResult.payloadHash) {
        return {
          status: ReviewExecutionBatchCommitStatus.Idempotent,
          checkpoint: cloneRoot(aggregate.checkpoint),
          batchResult: cloneBatchResult(existing),
        };
      }
      return {
        status: ReviewExecutionBatchCommitStatus.Conflict,
        ...checkpointConflict(aggregate.checkpoint),
        currentPayloadHash: existing.payloadHash,
      };
    }
    if (
      aggregate.checkpoint.state === ReviewExecutionCheckpointState.Finalized
    ) {
      return {
        status: ReviewExecutionBatchCommitStatus.Finalized,
        checkpoint: cloneRoot(aggregate.checkpoint),
      };
    }
    if (aggregate.checkpoint.version !== input.expectedVersion) {
      return {
        status: ReviewExecutionBatchCommitStatus.Conflict,
        ...checkpointConflict(aggregate.checkpoint),
      };
    }
    const plannedIndex = aggregate.checkpoint.plannedWorkKeys.indexOf(
      input.batchResult.workKey,
    );
    if (plannedIndex < 0 || plannedIndex !== input.batchResult.batchIndex) {
      return {
        status: ReviewExecutionBatchCommitStatus.UnplannedWork,
        checkpoint: cloneRoot(aggregate.checkpoint),
      };
    }
    const acceptedFindings = countFindings(aggregate.batchResults);
    const nextAcceptedBytes =
      aggregate.checkpoint.acceptedBytes + input.batchResult.byteCount;
    const nextAcceptedFindings =
      acceptedFindings + input.batchResult.payload.findings.length;
    if (
      nextAcceptedBytes > reviewExecutionCheckpointMaxAggregateBytes ||
      nextAcceptedFindings > reviewExecutionCheckpointMaxFindings
    ) {
      return {
        status: ReviewExecutionBatchCommitStatus.BudgetExceeded,
        checkpoint: cloneRoot(aggregate.checkpoint),
        acceptedBytes: aggregate.checkpoint.acceptedBytes,
        acceptedFindings,
      };
    }
    const checkpoint: ReviewExecutionCheckpointRoot = {
      ...aggregate.checkpoint,
      version: aggregate.checkpoint.version + 1,
      acceptedBytes: nextAcceptedBytes,
      updatedAt: input.updatedAt,
      expiresAt: input.expiresAt,
    };
    const next: ReviewExecutionCheckpointAggregate = {
      checkpoint,
      batchResults: orderReviewExecutionBatchResults(
        checkpoint.plannedWorkKeys,
        [...aggregate.batchResults, cloneBatchResult(input.batchResult)],
      ),
    };
    try {
      assertReviewExecutionCheckpointAggregate(next);
    } catch {
      return {
        status: ReviewExecutionBatchCommitStatus.Corrupted,
        currentVersion: aggregate.checkpoint.version,
      };
    }
    this.aggregates.set(key, next);
    return {
      status: ReviewExecutionBatchCommitStatus.Committed,
      checkpoint: cloneRoot(checkpoint),
      batchResult: cloneBatchResult(input.batchResult),
    };
  }

  async finalize(input: {
    readonly scope: ReviewExecutionCheckpointScope;
    readonly expectedVersion: number;
    readonly headSha: string;
    readonly planHash: string;
    readonly finalizedAt: Date;
    readonly expiresAt: Date;
  }): Promise<FinalizeReviewExecutionCheckpointResult> {
    const key = scopeKey(input.scope);
    const aggregate = this.aggregates.get(key);
    if (!aggregate) {
      return {
        status: ReviewExecutionCheckpointFinalizeStatus.Missing,
        currentVersion: 0,
      };
    }
    if (aggregate.checkpoint.expiresAt <= input.finalizedAt) {
      return {
        status: ReviewExecutionCheckpointFinalizeStatus.Conflict,
        ...checkpointConflict(aggregate.checkpoint),
      };
    }
    if (
      aggregate.checkpoint.headSha !== input.headSha ||
      aggregate.checkpoint.planHash !== input.planHash
    ) {
      return {
        status: ReviewExecutionCheckpointFinalizeStatus.Conflict,
        ...checkpointConflict(aggregate.checkpoint),
      };
    }
    if (
      aggregate.checkpoint.state === ReviewExecutionCheckpointState.Finalized
    ) {
      return {
        status: ReviewExecutionCheckpointFinalizeStatus.Idempotent,
        checkpoint: cloneRoot(aggregate.checkpoint),
      };
    }
    if (aggregate.checkpoint.version !== input.expectedVersion) {
      return {
        status: ReviewExecutionCheckpointFinalizeStatus.Conflict,
        ...checkpointConflict(aggregate.checkpoint),
      };
    }
    try {
      assertReviewExecutionCheckpointAggregate(aggregate);
    } catch {
      return {
        status: ReviewExecutionCheckpointFinalizeStatus.Corrupted,
        currentVersion: aggregate.checkpoint.version,
      };
    }
    const accepted = new Set(
      aggregate.batchResults.map((result) => result.workKey),
    );
    const missingWorkKeys = aggregate.checkpoint.plannedWorkKeys.filter(
      (workKey) => !accepted.has(workKey),
    );
    if (missingWorkKeys.length > 0) {
      return {
        status: ReviewExecutionCheckpointFinalizeStatus.Incomplete,
        checkpoint: cloneRoot(aggregate.checkpoint),
        missingWorkKeys,
      };
    }
    const checkpoint: ReviewExecutionCheckpointRoot = {
      ...aggregate.checkpoint,
      version: aggregate.checkpoint.version + 1,
      state: ReviewExecutionCheckpointState.Finalized,
      updatedAt: input.finalizedAt,
      expiresAt: input.expiresAt,
      finalizedAt: input.finalizedAt,
    };
    this.aggregates.set(key, { ...aggregate, checkpoint });
    return {
      status: ReviewExecutionCheckpointFinalizeStatus.Finalized,
      checkpoint: cloneRoot(checkpoint),
    };
  }

  async clear(input: {
    readonly scope: ReviewExecutionCheckpointScope;
    readonly expectedVersion: number;
    readonly headSha: string;
    readonly planHash: string;
  }): Promise<ClearReviewExecutionCheckpointResult> {
    const key = scopeKey(input.scope);
    const aggregate = this.aggregates.get(key);
    if (!aggregate) {
      return { status: ReviewExecutionCheckpointClearStatus.Missing };
    }
    if (
      aggregate.checkpoint.state !== ReviewExecutionCheckpointState.Finalized ||
      aggregate.checkpoint.version !== input.expectedVersion ||
      aggregate.checkpoint.headSha !== input.headSha ||
      aggregate.checkpoint.planHash !== input.planHash
    ) {
      return {
        status: ReviewExecutionCheckpointClearStatus.Conflict,
        ...checkpointConflict(aggregate.checkpoint),
      };
    }
    this.aggregates.delete(key);
    return { status: ReviewExecutionCheckpointClearStatus.Cleared };
  }

  async pruneExpired(input: {
    readonly expiredBefore: Date;
    readonly limit: number;
  }): Promise<number> {
    const expired = [...this.aggregates.entries()]
      .filter(
        ([, aggregate]) =>
          aggregate.checkpoint.expiresAt <= input.expiredBefore,
      )
      .sort((left, right) => {
        const byExpiry =
          left[1].checkpoint.expiresAt.getTime() -
          right[1].checkpoint.expiresAt.getTime();
        return byExpiry || left[0].localeCompare(right[0]);
      })
      .slice(0, input.limit);
    for (const [key] of expired) this.aggregates.delete(key);
    return expired.length;
  }
}

function startConflict(
  checkpoint: ReviewExecutionCheckpointRoot | undefined,
): StartOrReplaceReviewExecutionCheckpointResult {
  return {
    status: ReviewExecutionCheckpointStartStatus.Conflict,
    ...checkpointConflict(checkpoint),
  };
}

function checkpointConflict(
  checkpoint: ReviewExecutionCheckpointRoot | undefined,
) {
  return checkpoint
    ? {
        currentVersion: checkpoint.version,
        currentState: checkpoint.state,
        currentHeadSha: checkpoint.headSha,
        currentPlanHash: checkpoint.planHash,
      }
    : { currentVersion: 0 };
}

function countFindings(results: readonly ReviewExecutionBatchResult[]): number {
  return results.reduce(
    (total, result) => total + result.payload.findings.length,
    0,
  );
}

function scopeKey(scope: ReviewExecutionCheckpointScope): string {
  return `${scope.workspaceId}\u0000${scope.repositoryId}\u0000${scope.pullRequestNumber}`;
}

function cloneAggregate(
  aggregate: ReviewExecutionCheckpointAggregate,
): ReviewExecutionCheckpointAggregate {
  return {
    checkpoint: cloneRoot(aggregate.checkpoint),
    batchResults: aggregate.batchResults.map(cloneBatchResult),
  };
}

function cloneRoot(
  checkpoint: ReviewExecutionCheckpointRoot,
): ReviewExecutionCheckpointRoot {
  return {
    ...checkpoint,
    plannedWorkKeys: [...checkpoint.plannedWorkKeys],
    updatedAt: new Date(checkpoint.updatedAt),
    expiresAt: new Date(checkpoint.expiresAt),
    ...(checkpoint.finalizedAt
      ? { finalizedAt: new Date(checkpoint.finalizedAt) }
      : {}),
  };
}

function cloneBatchResult(
  result: ReviewExecutionBatchResult,
): ReviewExecutionBatchResult {
  return {
    ...result,
    payload: structuredClone(result.payload),
    completedAt: new Date(result.completedAt),
  };
}
