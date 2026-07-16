import {
  assertExpectedReviewExecutionCheckpointVersion,
  assertReviewExecutionCheckpointHeadAndPlan,
  assertReviewExecutionCheckpointScope,
  type ReviewExecutionCheckpointScope,
} from "../../domain/review-execution-checkpoint";
import type { ReviewExecutionCheckpointRepositoryPort } from "../ports/review-execution-checkpoint-repository-port";

export async function clearReviewExecutionCheckpoint(
  input: {
    readonly scope: ReviewExecutionCheckpointScope;
    readonly expectedVersion: number;
    readonly headSha: string;
    readonly planHash: string;
  },
  dependencies: {
    readonly checkpoints: ReviewExecutionCheckpointRepositoryPort;
  },
) {
  assertReviewExecutionCheckpointScope(input.scope);
  assertExpectedReviewExecutionCheckpointVersion(input.expectedVersion);
  assertReviewExecutionCheckpointHeadAndPlan(input);
  return dependencies.checkpoints.clear(input);
}
