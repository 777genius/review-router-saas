import {
  assertReviewExecutionCheckpointScope,
  decideReviewExecutionCheckpointRestore,
} from "../../domain/review-execution-checkpoint";
import type { ReviewExecutionCheckpointRepositoryPort } from "../ports/review-execution-checkpoint-repository-port";

export async function restoreReviewExecutionCheckpoint(
  input: {
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly pullRequestNumber: number;
    readonly baseSha: string;
    readonly headSha: string;
    readonly compatibilityKey: string;
    readonly planHash: string;
  },
  dependencies: {
    readonly checkpoints: ReviewExecutionCheckpointRepositoryPort;
    readonly now: Date;
  },
) {
  assertReviewExecutionCheckpointScope(input);
  const aggregate = await dependencies.checkpoints.find({
    workspaceId: input.workspaceId,
    repositoryId: input.repositoryId,
    pullRequestNumber: input.pullRequestNumber,
  });
  return decideReviewExecutionCheckpointRestore(aggregate, {
    baseSha: input.baseSha,
    headSha: input.headSha,
    compatibilityKey: input.compatibilityKey,
    planHash: input.planHash,
    now: dependencies.now,
  });
}
