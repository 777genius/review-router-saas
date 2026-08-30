import {
  defaultCodexRotatingWorkflowPath,
  defaultSetupBranch,
  defaultWorkflowPath,
  type ReviewRouterDiscussionMode,
  type ReviewRouterWorkflowStyle,
} from "./workflow-template";
import type {
  CodexRotatingReviewActionV2Mode,
  CodexRotatingT0WorkflowSchemaVersion,
  VersionedProviderSecretNamespace,
} from "@reviewrouter/features-codex-oauth-rotating";

export type WorkflowProvisioningStatus =
  | "not_started"
  | "setup_pr_open"
  | "configured"
  | "failed";

export type ProjectedRepositorySetupStatus =
  | "not_configured"
  | "setup_pr_open"
  | "configured"
  | "needs_attention";

export function projectRepositorySetupStatus(input: {
  readonly workflowProvisioningStatus: WorkflowProvisioningStatus | null;
  readonly legacySetupStatus: ProjectedRepositorySetupStatus;
}): ProjectedRepositorySetupStatus {
  switch (input.workflowProvisioningStatus) {
    case "not_started":
      return "not_configured";
    case "setup_pr_open":
      return "setup_pr_open";
    case "configured":
      return "configured";
    case "failed":
      return "needs_attention";
    case null:
      return input.legacySetupStatus;
  }
}

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
  readonly discussionMode?: ReviewRouterDiscussionMode;
  readonly conflictReviewFallbackEnabled?: boolean;
  readonly forkAgenticSandboxEnabled?: boolean;
  readonly codexRotatingProviderInstanceId?: string;
  readonly codexRotatingReviewActionV2Mode?: CodexRotatingReviewActionV2Mode;
  readonly codexRotatingWorkflowSchemaVersion?: CodexRotatingT0WorkflowSchemaVersion;
  readonly codexRotatingWorkflowSecretNamespace?: VersionedProviderSecretNamespace;
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
