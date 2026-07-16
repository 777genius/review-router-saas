import {
  assertExpectedReviewExecutionCheckpointVersion,
  assertReviewExecutionCheckpointScope,
  prepareReviewExecutionBatchResult,
  reviewExecutionCheckpointTtlMs,
  type ReviewExecutionBatchResultCandidate,
  type ReviewExecutionCheckpointScope,
} from "../../domain/review-execution-checkpoint";
import type { ReviewExecutionCheckpointRepositoryPort } from "../ports/review-execution-checkpoint-repository-port";

export async function commitReviewExecutionBatchResult(
  input: {
    readonly scope: ReviewExecutionCheckpointScope;
    readonly expectedVersion: number;
    readonly headSha: string;
    readonly planHash: string;
    readonly candidate: ReviewExecutionBatchResultCandidate;
  },
  dependencies: {
    readonly checkpoints: ReviewExecutionCheckpointRepositoryPort;
    readonly now: Date;
  },
) {
  assertReviewExecutionCheckpointScope(input.scope);
  assertExpectedReviewExecutionCheckpointVersion(input.expectedVersion);
  const batchResult = prepareReviewExecutionBatchResult(input.candidate, {
    completedAt: dependencies.now,
  });
  return dependencies.checkpoints.commitBatchResult({
    scope: input.scope,
    expectedVersion: input.expectedVersion,
    headSha: input.headSha,
    planHash: input.planHash,
    batchResult,
    updatedAt: dependencies.now,
    expiresAt: new Date(
      dependencies.now.getTime() + reviewExecutionCheckpointTtlMs,
    ),
  });
}
