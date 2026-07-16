export type CodexRotatingReviewSnapshotScope = {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly sourceRunId: string;
  readonly sourceRunAttempt: string;
  readonly pullRequestNumber: number;
};

export interface CodexRotatingReviewSnapshotAccessPort {
  authorizeReviewSnapshotAccess(input: {
    readonly leaseId: string;
    readonly providerInstanceId: string;
    readonly pullRequestNumber: number;
    readonly now: Date;
  }): Promise<
    | {
        readonly status: "ready";
        readonly scope: CodexRotatingReviewSnapshotScope;
      }
    | {
        readonly status: "lease_not_completed" | "lease_not_active";
      }
  >;
}
