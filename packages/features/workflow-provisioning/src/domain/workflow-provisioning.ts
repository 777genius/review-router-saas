import { defaultSetupBranch, defaultWorkflowPath } from "./workflow-template";

export type WorkflowProvisioningStatus =
  | "not_started"
  | "setup_pr_open"
  | "configured"
  | "failed";

export type ProvisionWorkflowInput = {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch: string;
  readonly actionRef: string;
  readonly apiUrl: string;
  readonly runtimeConfigMode: "oidc" | "static";
  readonly staticRuntimeEnv?: Readonly<Record<string, string>>;
  readonly setupBranch?: string;
  readonly workflowPath?: string;
};

export type ProvisionWorkflowPlan = Required<
  Pick<ProvisionWorkflowInput, "setupBranch" | "workflowPath">
> &
  ProvisionWorkflowInput;

export function createProvisionWorkflowPlan(
  input: ProvisionWorkflowInput,
): ProvisionWorkflowPlan {
  return {
    ...input,
    setupBranch: input.setupBranch ?? defaultSetupBranch,
    workflowPath: input.workflowPath ?? defaultWorkflowPath,
  };
}
