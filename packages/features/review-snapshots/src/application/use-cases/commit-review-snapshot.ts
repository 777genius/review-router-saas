import {
  prepareReviewSnapshotRecord,
  type ReviewSnapshotCandidate,
} from "../../domain/review-snapshot";
import type { ReviewSnapshotRepositoryPort } from "../ports/review-snapshot-repository-port";

export async function commitReviewSnapshot(
  input: {
    readonly expectedVersion: number;
    readonly candidate: ReviewSnapshotCandidate;
  },
  dependencies: {
    readonly snapshots: ReviewSnapshotRepositoryPort;
    readonly now: Date;
  },
) {
  if (
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 0
  ) {
    throw new Error("review_snapshot_expected_version_invalid");
  }
  const record = prepareReviewSnapshotRecord(input.candidate, {
    now: dependencies.now,
    version: input.expectedVersion + 1,
  });
  return dependencies.snapshots.commit({
    expectedVersion: input.expectedVersion,
    record,
  });
}
