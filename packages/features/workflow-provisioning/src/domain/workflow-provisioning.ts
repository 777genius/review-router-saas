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
import {
  parseReviewConfigurationStrict,
  type ReviewConfiguration,
} from "@reviewrouter/features-review-config";
import {
  codexWorkflowPathForRepository,
  isolatedQualityWorkflowRepositoryId,
  isCodexWorkflowRepositoryIdentityAdmitted,
} from "@reviewrouter/features-codex-oauth-rotating";

export function isAccountGatewayConfiguration(
  config: ReviewConfiguration,
): boolean {
  const selected =
    config.provider.authMode === "codex_account_gateway" ||
    config.providers.some(
      (provider) => provider.authMode === "codex_account_gateway",
    );
  if (!selected) return false;
  const parsed = parseReviewConfigurationStrict(config);
  if (
    parsed.providers.length !== 1 ||
    parsed.provider.authMode !== "codex_account_gateway" ||
    config.provider.authMode !== "codex_account_gateway" ||
    config.provider.gatewayBindingId !== parsed.provider.gatewayBindingId ||
    config.provider.gatewayProfileRef !== parsed.provider.gatewayProfileRef ||
    config.provider.model !== parsed.provider.model ||
    config.provider.reasoningEffort !== parsed.provider.reasoningEffort ||
    config.provider.fastMode !== parsed.provider.fastMode
  ) {
    throw new Error("account_gateway_single_provider_required");
  }
  return true;
}

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

export function preferredSetupBaseBranches(
  defaultBranch: string,
): readonly string[] {
  return [defaultBranch];
}

export type ProvisionWorkflowInput = {
  readonly installationId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly githubRepositoryId?: string;
  readonly repositoryFullName?: string;
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch: string;
  readonly actionRef: string;
  readonly apiUrl: string;
  readonly runtimeConfigMode: "oidc" | "static";
  readonly codexSessionMode?: "account-gateway";
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
  const rotatingRepositoryId = input.codexRotatingProviderInstanceId?.match(
    /^codex-rotating:([1-9][0-9]*)$/u,
  )?.[1];
  if (
    rotatingRepositoryId &&
    input.githubRepositoryId &&
    rotatingRepositoryId !== input.githubRepositoryId
  ) {
    throw new Error("codex_workflow_repository_identity_mismatch");
  }
  if (
    rotatingRepositoryId === isolatedQualityWorkflowRepositoryId &&
    (!input.githubRepositoryId || !input.repositoryFullName)
  ) {
    throw new Error("isolated_workflow_repository_identity_required");
  }
  if (
    rotatingRepositoryId === isolatedQualityWorkflowRepositoryId &&
    input.defaultBranch !== "main"
  ) {
    throw new Error("isolated_workflow_default_branch_must_be_main");
  }
  const repositoryWorkflowPath =
    input.codexRotatingProviderInstanceId &&
    input.githubRepositoryId &&
    input.repositoryFullName
      ? codexWorkflowPathForRepository({
          repositoryId: input.githubRepositoryId,
          repositoryFullName: input.repositoryFullName,
        })
      : undefined;
  if (
    input.githubRepositoryId &&
    input.repositoryFullName &&
    !isCodexWorkflowRepositoryIdentityAdmitted({
      repositoryId: input.githubRepositoryId,
      repositoryFullName: input.repositoryFullName,
    })
  ) {
    throw new Error("codex_workflow_repository_identity_mismatch");
  }
  if (
    input.workflowPath &&
    repositoryWorkflowPath &&
    input.workflowPath !== repositoryWorkflowPath
  ) {
    throw new Error("codex_workflow_repository_path_mismatch");
  }
  return {
    ...input,
    workflowStyle: input.workflowStyle ?? "reusable",
    setupBranch: input.setupBranch ?? defaultSetupBranch,
    workflowPath:
      input.workflowPath ??
      (input.codexRotatingProviderInstanceId
        ? (repositoryWorkflowPath ?? defaultCodexRotatingWorkflowPath)
        : defaultWorkflowPath),
  };
}
