export type RepositoryWorkflowProvisioningSummary = {
  readonly repositoryId: string;
  readonly status: "not_started" | "setup_pr_open" | "configured" | "failed";
  readonly branch: string;
  readonly workflowPath: string;
  readonly actionVersion: string;
  readonly pullRequestUrl: string | null;
  readonly errorMessage: string | null;
  readonly updatedAt: Date;
};

export interface WorkflowProvisioningQueryPort {
  listLatestForRepositories(input: {
    readonly workspaceId: string;
    readonly repositoryIds: readonly string[];
  }): Promise<readonly RepositoryWorkflowProvisioningSummary[]>;
}
