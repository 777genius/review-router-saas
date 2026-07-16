import {
  assertReviewExecutionCheckpointHeadAndPlan,
  commitReviewExecutionBatchResult,
  type ReviewExecutionBatchResultCandidate,
  type ReviewExecutionCheckpointRepositoryPort,
} from "@reviewrouter/features-review-execution-checkpoints";
import type { Clock } from "@reviewrouter/shared";
import type { CodexRotatingReviewExecutionCheckpointAccessPort } from "../ports/codex-rotating-review-execution-checkpoint-access-port.js";

export type CommitCodexRotatingReviewExecutionBatchResultInput = {
  readonly leaseId: string;
  readonly providerInstanceId: string;
  readonly pullRequestNumber: number;
  readonly expectedVersion: number;
  readonly headSha: string;
  readonly planHash: string;
  readonly candidate: Omit<
    ReviewExecutionBatchResultCandidate,
    "sourceRunId" | "sourceRunAttempt"
  >;
};

export type CommitCodexRotatingReviewExecutionBatchResultDependencies = {
  readonly codexRotatingReviewExecutionCheckpointAccess: CodexRotatingReviewExecutionCheckpointAccessPort;
  readonly reviewExecutionCheckpoints: ReviewExecutionCheckpointRepositoryPort;
  readonly clock: Clock;
};

export async function commitCodexRotatingReviewExecutionBatchResult(
  input: CommitCodexRotatingReviewExecutionBatchResultInput,
  dependencies: CommitCodexRotatingReviewExecutionBatchResultDependencies,
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

  assertReviewExecutionCheckpointHeadAndPlan(input);
  const scope = {
    workspaceId: access.scope.workspaceId,
    repositoryId: access.scope.repositoryId,
    pullRequestNumber: input.pullRequestNumber,
  };
  return commitReviewExecutionBatchResult(
    {
      scope,
      expectedVersion: input.expectedVersion,
      headSha: input.headSha,
      planHash: input.planHash,
      candidate: {
        ...input.candidate,
        sourceRunId: access.scope.sourceRunId,
        sourceRunAttempt: access.scope.sourceRunAttempt,
      },
    },
    { checkpoints: dependencies.reviewExecutionCheckpoints, now },
  );
}
