import {
  restoreReviewSnapshot,
  type ReviewSnapshotRepositoryPort,
} from "@reviewrouter/features-review-snapshots";
import type { Clock } from "@reviewrouter/shared";
import type { CodexRotatingReviewSnapshotAccessPort } from "../ports/codex-rotating-review-snapshot-access-port.js";

export type RestoreCodexRotatingReviewSnapshotDependencies = {
  readonly codexRotatingReviewSnapshotAccess: CodexRotatingReviewSnapshotAccessPort;
  readonly reviewSnapshots: ReviewSnapshotRepositoryPort;
  readonly clock: Clock;
};

export async function restoreCodexRotatingReviewSnapshot(
  input: {
    readonly leaseId: string;
    readonly providerInstanceId: string;
    readonly pullRequestNumber: number;
    readonly baseSha: string;
  },
  dependencies: RestoreCodexRotatingReviewSnapshotDependencies,
) {
  const now = dependencies.clock.now();
  const access =
    await dependencies.codexRotatingReviewSnapshotAccess.authorizeReviewSnapshotAccess(
      {
        leaseId: input.leaseId,
        providerInstanceId: input.providerInstanceId,
        pullRequestNumber: input.pullRequestNumber,
        now,
      },
    );
  if (access.status !== "ready") {
    throw new Error(`codex_rotating_${access.status}`);
  }

  return restoreReviewSnapshot(
    {
      workspaceId: access.scope.workspaceId,
      repositoryId: access.scope.repositoryId,
      pullRequestNumber: input.pullRequestNumber,
      baseSha: input.baseSha,
    },
    { snapshots: dependencies.reviewSnapshots, now },
  );
}
