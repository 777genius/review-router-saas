import {
  commitReviewSnapshot,
  type ReviewSnapshotCandidate,
  type ReviewSnapshotRepositoryPort,
} from "@reviewrouter/features-review-snapshots";
import type { Clock } from "@reviewrouter/shared";
import type { CodexRotatingReviewSnapshotAccessPort } from "../ports/codex-rotating-review-snapshot-access-port.js";

export type CommitCodexRotatingReviewSnapshotInput = {
  readonly leaseId: string;
  readonly providerInstanceId: string;
  readonly expectedVersion: number;
  readonly candidate: Omit<
    ReviewSnapshotCandidate,
    "workspaceId" | "repositoryId" | "sourceRunId" | "sourceRunAttempt"
  >;
};

export type CommitCodexRotatingReviewSnapshotDependencies = {
  readonly codexRotatingReviewSnapshotAccess: CodexRotatingReviewSnapshotAccessPort;
  readonly reviewSnapshots: ReviewSnapshotRepositoryPort;
  readonly clock: Clock;
};

export async function commitCodexRotatingReviewSnapshot(
  input: CommitCodexRotatingReviewSnapshotInput,
  dependencies: CommitCodexRotatingReviewSnapshotDependencies,
) {
  const now = dependencies.clock.now();
  const access =
    await dependencies.codexRotatingReviewSnapshotAccess.authorizeReviewSnapshotAccess(
      {
        leaseId: input.leaseId,
        providerInstanceId: input.providerInstanceId,
        pullRequestNumber: input.candidate.pullRequestNumber,
        now,
      },
    );
  if (access.status !== "ready") {
    throw new Error(`codex_rotating_${access.status}`);
  }

  return commitReviewSnapshot(
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
    { snapshots: dependencies.reviewSnapshots, now },
  );
}
