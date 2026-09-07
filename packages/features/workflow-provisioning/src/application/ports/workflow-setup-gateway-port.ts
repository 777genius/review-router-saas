export type WorkflowSetupPullRequest = {
  readonly url: string;
  readonly number: number;
  readonly headSha: string;
  readonly branch: string;
  readonly baseBranch?: string;
};

export type WorkflowSetupFile = {
  readonly path: string;
} & (
  | {
      readonly operation?: "upsert";
      readonly content: string;
    }
  | {
      readonly operation: "delete";
      readonly markerGroups: readonly (readonly string[])[];
    }
);

export type WorkflowSetupGatewayInput = {
  readonly owner: string;
  readonly repo: string;
  readonly baseBranch: string;
  readonly setupBranch: string;
  readonly setupMode?: "repository_owned" | "hosted_pool";
  readonly workflowFiles: readonly WorkflowSetupFile[];
};

export interface WorkflowSetupGatewayPort {
  createOrUpdateSetupPullRequest(
    input: WorkflowSetupGatewayInput,
  ): Promise<WorkflowSetupPullRequest>;
}
