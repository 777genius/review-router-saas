import {
  startOrReplaceReviewExecutionCheckpoint,
  type ReviewExecutionCheckpointCandidate,
  type ReviewExecutionCheckpointRepositoryPort,
} from "@reviewrouter/features-review-execution-checkpoints";
import type { Clock } from "@reviewrouter/shared";
import type { CodexRotatingReviewExecutionCheckpointAccessPort } from "../ports/codex-rotating-review-execution-checkpoint-access-port.js";

export type StartCodexRotatingReviewExecutionCheckpointInput = {
  readonly leaseId: string;
  readonly providerInstanceId: string;
  readonly expectedVersion: number;
  readonly candidate: Omit<
    ReviewExecutionCheckpointCandidate,
    "workspaceId" | "repositoryId" | "sourceRunId" | "sourceRunAttempt"
  >;
};

export type StartCodexRotatingReviewExecutionCheckpointDependencies = {
  readonly codexRotatingReviewExecutionCheckpointAccess: CodexRotatingReviewExecutionCheckpointAccessPort;
  readonly reviewExecutionCheckpoints: ReviewExecutionCheckpointRepositoryPort;
  readonly clock: Clock;
};

export async function startCodexRotatingReviewExecutionCheckpoint(
  input: StartCodexRotatingReviewExecutionCheckpointInput,
  dependencies: StartCodexRotatingReviewExecutionCheckpointDependencies,
) {
  const now = dependencies.clock.now();
  const access =
    await dependencies.codexRotatingReviewExecutionCheckpointAccess.authorizeReviewExecutionCheckpointAccess(
      {
        leaseId: input.leaseId,
        providerInstanceId: input.providerInstanceId,
        pullRequestNumber: input.candidate.pullRequestNumber,
        now,
      },
    );
  if (access.status !== "ready") {
    throw new Error("codex_rotating_lease_not_active");
  }

  return startOrReplaceReviewExecutionCheckpoint(
    {
      expectedVersion: input.expectedVersion,
      candidate: {
        ...input.candidate,
        workspaceId: access.scope.workspaceId,
        repositoryId: access.scope.repositoryId,
        sourceRunId: access.scope.sourceRunId,
        sourceRunAttempt: access.scope.sourceRunAttempt,
      },
    },
    { checkpoints: dependencies.reviewExecutionCheckpoints, now },
  );
}
