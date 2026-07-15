import {
  decideReviewSnapshotRestore,
  type ReviewSnapshotRecord,
  type ReviewSnapshotRestoreStatus,
} from "../../domain/review-snapshot";
import type { ReviewSnapshotRepositoryPort } from "../ports/review-snapshot-repository-port";

export async function restoreReviewSnapshot(
  input: {
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly pullRequestNumber: number;
    readonly baseSha: string;
  },
  dependencies: {
    readonly snapshots: ReviewSnapshotRepositoryPort;
    readonly now: Date;
  },
): Promise<
  | {
      readonly status: ReviewSnapshotRestoreStatus.Found;
      readonly expectedVersion: number;
      readonly snapshot: ReviewSnapshotRecord;
    }
  | {
      readonly status: Exclude<
        ReviewSnapshotRestoreStatus,
        ReviewSnapshotRestoreStatus.Found
      >;
      readonly expectedVersion: number;
    }
> {
  const record = await dependencies.snapshots.find({
    workspaceId: input.workspaceId,
    repositoryId: input.repositoryId,
    pullRequestNumber: input.pullRequestNumber,
  });
  return decideReviewSnapshotRestore(record, {
    baseSha: input.baseSha,
    now: dependencies.now,
  });
}
