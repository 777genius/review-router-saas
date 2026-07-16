export type CodexRotatingReviewExecutionCheckpointScope = {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly sourceRunId: string;
  readonly sourceRunAttempt: string;
  readonly pullRequestNumber: number;
};

export interface CodexRotatingReviewExecutionCheckpointAccessPort {
  authorizeReviewExecutionCheckpointAccess(input: {
    readonly leaseId: string;
    readonly providerInstanceId: string;
    readonly pullRequestNumber: number;
    readonly now: Date;
  }): Promise<
    | {
        readonly status: "ready";
        readonly scope: CodexRotatingReviewExecutionCheckpointScope;
      }
    | {
        readonly status: "lease_not_completed" | "lease_not_active";
      }
  >;
}
