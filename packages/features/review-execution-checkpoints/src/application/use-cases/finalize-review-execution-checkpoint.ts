import {
  assertExpectedReviewExecutionCheckpointVersion,
  assertReviewExecutionCheckpointHeadAndPlan,
  assertReviewExecutionCheckpointScope,
  reviewExecutionCheckpointTtlMs,
  type ReviewExecutionCheckpointScope,
} from "../../domain/review-execution-checkpoint";
import type { ReviewExecutionCheckpointRepositoryPort } from "../ports/review-execution-checkpoint-repository-port";

export async function finalizeReviewExecutionCheckpoint(
  input: {
    readonly scope: ReviewExecutionCheckpointScope;
    readonly expectedVersion: number;
    readonly headSha: string;
    readonly planHash: string;
  },
  dependencies: {
    readonly checkpoints: ReviewExecutionCheckpointRepositoryPort;
    readonly now: Date;
  },
) {
  assertReviewExecutionCheckpointScope(input.scope);
  assertExpectedReviewExecutionCheckpointVersion(input.expectedVersion);
  assertReviewExecutionCheckpointHeadAndPlan(input);
  return dependencies.checkpoints.finalize({
    ...input,
    finalizedAt: dependencies.now,
    expiresAt: new Date(
      dependencies.now.getTime() + reviewExecutionCheckpointTtlMs,
    ),
  });
}
