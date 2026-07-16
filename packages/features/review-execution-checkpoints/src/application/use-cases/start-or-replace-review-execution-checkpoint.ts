import {
  assertExpectedReviewExecutionCheckpointVersion,
  prepareReviewExecutionCheckpointRoot,
  type ReviewExecutionCheckpointCandidate,
} from "../../domain/review-execution-checkpoint";
import type { ReviewExecutionCheckpointRepositoryPort } from "../ports/review-execution-checkpoint-repository-port";

export async function startOrReplaceReviewExecutionCheckpoint(
  input: {
    readonly expectedVersion: number;
    readonly candidate: ReviewExecutionCheckpointCandidate;
  },
  dependencies: {
    readonly checkpoints: ReviewExecutionCheckpointRepositoryPort;
    readonly now: Date;
  },
) {
  assertExpectedReviewExecutionCheckpointVersion(input.expectedVersion);
  const checkpoint = prepareReviewExecutionCheckpointRoot(input.candidate, {
    version: input.expectedVersion + 1,
    now: dependencies.now,
  });
  return dependencies.checkpoints.startOrReplace({
    expectedVersion: input.expectedVersion,
    checkpoint,
  });
}
