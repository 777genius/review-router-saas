import type { ReviewSnapshotRepositoryPort } from "../ports/review-snapshot-repository-port";

export async function pruneExpiredReviewSnapshots(
  input: { readonly expiredBefore: Date; readonly limit: number },
  dependencies: { readonly snapshots: ReviewSnapshotRepositoryPort },
): Promise<{ readonly deleted: number }> {
  if (!Number.isFinite(input.expiredBefore.getTime())) {
    throw new Error("review_snapshot_prune_date_invalid");
  }
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit <= 0 ||
    input.limit > 10_000
  ) {
    throw new Error("review_snapshot_prune_limit_invalid");
  }
  return {
    deleted: await dependencies.snapshots.pruneExpired(input),
  };
}
