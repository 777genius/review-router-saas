import { reviewExecutionCheckpointMaxPruneLimit } from "../../domain/review-execution-checkpoint";
import type { ReviewExecutionCheckpointRepositoryPort } from "../ports/review-execution-checkpoint-repository-port";

export async function pruneExpiredReviewExecutionCheckpoints(
  input: { readonly expiredBefore: Date; readonly limit: number },
  dependencies: {
    readonly checkpoints: ReviewExecutionCheckpointRepositoryPort;
  },
): Promise<{ readonly deleted: number }> {
  if (!Number.isFinite(input.expiredBefore.getTime())) {
    throw new Error("review_execution_checkpoint_prune_date_invalid");
  }
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit <= 0 ||
    input.limit > reviewExecutionCheckpointMaxPruneLimit
  ) {
    throw new Error("review_execution_checkpoint_prune_limit_invalid");
  }
  return {
    deleted: await dependencies.checkpoints.pruneExpired(input),
  };
}
