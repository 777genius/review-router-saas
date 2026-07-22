import {
  decideReviewSnapshotV2Restore,
  type ReviewSnapshotV2RestoreMode,
  type ReviewSnapshotV2RestoreResult,
  type ReviewSnapshotV2Scope,
} from "../../domain/review-snapshot-v2";
import type { ReviewSnapshotV2QueryPort } from "../ports/review-snapshot-v2-port";

export async function restoreReviewSnapshotV2(
  input: {
    readonly scope: ReviewSnapshotV2Scope;
    readonly now: Date;
    readonly trustedRepositoryBinding: boolean;
    readonly reviewRevisionHash: string;
    readonly mode: ReviewSnapshotV2RestoreMode;
  },
  dependencies: { readonly snapshots: ReviewSnapshotV2QueryPort },
): Promise<ReviewSnapshotV2RestoreResult> {
  const record = await dependencies.snapshots.findCurrent(input.scope);
  return decideReviewSnapshotV2Restore(record, input);
}
