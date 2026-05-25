import {
  defaultCodexRotatingWorkflowPath,
  defaultSetupBranch,
  defaultWorkflowPath,
  type ReviewRouterWorkflowStyle,
} from "./workflow-template";

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
  readonly workflowStyle?: ReviewRouterWorkflowStyle;
  readonly conflictReviewFallbackEnabled?: boolean;
  readonly codexRotatingProviderInstanceId?: string;
  readonly setupBranch?: string;
  readonly workflowPath?: string;
};

export type ProvisionWorkflowPlan = Required<
  Pick<ProvisionWorkflowInput, "setupBranch" | "workflowPath" | "workflowStyle">
> &
  ProvisionWorkflowInput;

export function createProvisionWorkflowPlan(
  input: ProvisionWorkflowInput,
): ProvisionWorkflowPlan {
  return {
    ...input,
    workflowStyle: input.workflowStyle ?? "reusable",
    setupBranch: input.setupBranch ?? defaultSetupBranch,
    workflowPath:
      input.workflowPath ??
      (input.codexRotatingProviderInstanceId
        ? defaultCodexRotatingWorkflowPath
        : defaultWorkflowPath),
  };
}
