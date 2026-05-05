export type WorkflowSetupPullRequest = {
  readonly url: string;
  readonly number: number;
  readonly branch: string;
};

export type WorkflowSetupFile = {
  readonly path: string;
  readonly content: string;
};

export type WorkflowSetupGatewayInput = {
  readonly owner: string;
  readonly repo: string;
  readonly baseBranch: string;
  readonly setupBranch: string;
  readonly workflowFiles: readonly WorkflowSetupFile[];
};

export interface WorkflowSetupGatewayPort {
  createOrUpdateSetupPullRequest(
    input: WorkflowSetupGatewayInput,
  ): Promise<WorkflowSetupPullRequest>;
}
