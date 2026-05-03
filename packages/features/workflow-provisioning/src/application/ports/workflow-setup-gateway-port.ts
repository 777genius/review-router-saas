export type WorkflowSetupPullRequest = {
  readonly url: string;
  readonly number: number;
  readonly branch: string;
};

export type WorkflowSetupGatewayInput = {
  readonly owner: string;
  readonly repo: string;
  readonly baseBranch: string;
  readonly setupBranch: string;
  readonly workflowPath: string;
  readonly workflowYaml: string;
};

export interface WorkflowSetupGatewayPort {
  createOrUpdateSetupPullRequest(
    input: WorkflowSetupGatewayInput,
  ): Promise<WorkflowSetupPullRequest>;
}
