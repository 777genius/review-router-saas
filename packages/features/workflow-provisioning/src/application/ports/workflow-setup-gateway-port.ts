export type WorkflowSetupPullRequest = {
  readonly url: string;
  readonly number: number;
  readonly branch: string;
  readonly baseBranch?: string;
  readonly headSha?: string;
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
  readonly expectedBaseSha?: string;
  readonly resetSetupBranch?: boolean;
  readonly setupMode?: "repository_owned" | "hosted_pool";
  readonly workflowFiles: readonly WorkflowSetupFile[];
};

export interface WorkflowSetupGatewayPort {
  createOrUpdateSetupPullRequest(
    input: WorkflowSetupGatewayInput,
  ): Promise<WorkflowSetupPullRequest>;
}
