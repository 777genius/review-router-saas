import type { ReviewSnapshotRecord } from "../../domain/review-snapshot";

export interface ReviewSnapshotRepositoryPort {
  find(input: {
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly pullRequestNumber: number;
  }): Promise<ReviewSnapshotRecord | null>;

  commit(input: {
    readonly expectedVersion: number;
    readonly record: ReviewSnapshotRecord;
  }): Promise<
    | {
        readonly status: "committed" | "idempotent";
        readonly snapshot: ReviewSnapshotRecord;
      }
    | {
        readonly status: "conflict";
        readonly currentVersion: number;
        readonly currentHeadSha: string;
      }
  >;

  pruneExpired(input: {
    readonly expiredBefore: Date;
    readonly limit: number;
  }): Promise<number>;
}
