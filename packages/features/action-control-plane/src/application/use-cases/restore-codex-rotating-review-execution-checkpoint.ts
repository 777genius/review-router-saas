import {
  restoreReviewExecutionCheckpoint,
  type ReviewExecutionCheckpointRepositoryPort,
} from "@reviewrouter/features-review-execution-checkpoints";
import type { Clock } from "@reviewrouter/shared";
import type { CodexRotatingReviewExecutionCheckpointAccessPort } from "../ports/codex-rotating-review-execution-checkpoint-access-port.js";

export type RestoreCodexRotatingReviewExecutionCheckpointDependencies = {
  readonly codexRotatingReviewExecutionCheckpointAccess: CodexRotatingReviewExecutionCheckpointAccessPort;
  readonly reviewExecutionCheckpoints: ReviewExecutionCheckpointRepositoryPort;
  readonly clock: Clock;
};

export async function restoreCodexRotatingReviewExecutionCheckpoint(
  input: {
    readonly leaseId: string;
    readonly providerInstanceId: string;
    readonly pullRequestNumber: number;
    readonly baseSha: string;
    readonly headSha: string;
    readonly compatibilityKey: string;
    readonly planHash: string;
  },
  dependencies: RestoreCodexRotatingReviewExecutionCheckpointDependencies,
) {
  const now = dependencies.clock.now();
  const access =
    await dependencies.codexRotatingReviewExecutionCheckpointAccess.authorizeReviewExecutionCheckpointAccess(
      {
        leaseId: input.leaseId,
        providerInstanceId: input.providerInstanceId,
        pullRequestNumber: input.pullRequestNumber,
        now,
      },
    );
  if (access.status !== "ready") {
    throw new Error("codex_rotating_lease_not_active");
  }

  return restoreReviewExecutionCheckpoint(
    {
      workspaceId: access.scope.workspaceId,
      repositoryId: access.scope.repositoryId,
      pullRequestNumber: input.pullRequestNumber,
      baseSha: input.baseSha,
      headSha: input.headSha,
      compatibilityKey: input.compatibilityKey,
      planHash: input.planHash,
    },
    { checkpoints: dependencies.reviewExecutionCheckpoints, now },
  );
}
