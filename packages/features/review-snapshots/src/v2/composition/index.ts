import { commitReviewSnapshotV2 } from "../application/use-cases/commit-review-snapshot-v2";
import { restoreReviewSnapshotV2 } from "../application/use-cases/restore-review-snapshot-v2";
import type {
  ReviewSnapshotV2CommandPort,
  ReviewSnapshotCommitEligibilityPort,
  ReviewSnapshotV2QueryPort,
} from "../application/ports/review-snapshot-v2-port";

export { PrismaReviewSnapshotV2Repository } from "../infrastructure/prisma/prisma-review-snapshot-v2-repository";

export function createReviewSnapshotV2Application(dependencies: {
  readonly commands: ReviewSnapshotV2CommandPort;
  readonly eligibility: ReviewSnapshotCommitEligibilityPort;
  readonly queries: ReviewSnapshotV2QueryPort;
}) {
  return {
    commit: (command: Parameters<typeof commitReviewSnapshotV2>[0]) =>
      commitReviewSnapshotV2(command, {
        commands: dependencies.commands,
        eligibility: dependencies.eligibility,
      }),
    restore: (input: Parameters<typeof restoreReviewSnapshotV2>[0]) =>
      restoreReviewSnapshotV2(input, { snapshots: dependencies.queries }),
  };
}
