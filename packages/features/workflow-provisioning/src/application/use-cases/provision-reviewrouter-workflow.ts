import {
  mapConfigToRuntimeEnv,
  safeDefaultReviewConfiguration,
} from "@reviewrouter/features-review-config";
import {
  recordAuditEvent,
  type AuditLogRepositoryPort,
} from "@reviewrouter/features-audit-log";
import { renderReviewRouterWorkflowFiles } from "../../domain/workflow-template";
import {
  createProvisionWorkflowPlan,
  type ProvisionWorkflowInput,
} from "../../domain/workflow-provisioning";
import type { WorkflowProvisioningRepositoryPort } from "../ports/workflow-provisioning-repository-port";
import type { WorkflowSetupGatewayPort } from "../ports/workflow-setup-gateway-port";

export type ProvisionReviewRouterWorkflowDependencies = {
  readonly setupGateway: WorkflowSetupGatewayPort;
  readonly provisioning: WorkflowProvisioningRepositoryPort;
  readonly auditLog?: AuditLogRepositoryPort;
  readonly enabled?: boolean;
  readonly actor?: string;
  readonly auditMetadata?: Readonly<Record<string, unknown>>;
};

export async function provisionReviewRouterWorkflow(
  input: ProvisionWorkflowInput,
  dependencies: ProvisionReviewRouterWorkflowDependencies,
) {
  const plan = createProvisionWorkflowPlan(input);
  if (dependencies.enabled === false) {
    await dependencies.provisioning.markFailed({
      workspaceId: plan.workspaceId,
      repositoryId: plan.repositoryId,
      status: "failed",
      branch: plan.setupBranch,
      workflowPath: plan.workflowPath,
      workflowStyle: plan.workflowStyle,
      actionVersion: plan.actionRef,
      pullRequestUrl: null,
      errorMessage: "workflow_provisioning_disabled",
    });
    if (dependencies.auditLog) {
      await recordAuditEvent(
        {
          workspaceId: plan.workspaceId,
          actor: dependencies.actor ?? "system:workflow-provisioning",
          action: "workflow.setup_pr_blocked",
          targetType: "repository",
          targetId: plan.repositoryId,
          metadata: {
            reason: "workflow_provisioning_disabled",
            ...(dependencies.auditMetadata ?? {}),
          },
        },
        { auditLog: dependencies.auditLog },
      );
    }
    throw new Error("workflow_provisioning_disabled");
  }

  const workflowFiles = renderReviewRouterWorkflowFiles({
    actionRef: plan.actionRef,
    apiUrl: plan.apiUrl,
    runtimeConfigMode: plan.runtimeConfigMode,
    workflowStyle: plan.workflowStyle,
    conflictReviewFallbackEnabled: plan.conflictReviewFallbackEnabled === true,
    staticRuntimeEnv:
      plan.staticRuntimeEnv ??
      mapConfigToRuntimeEnv(safeDefaultReviewConfiguration),
  });

  try {
    const pullRequest =
      await dependencies.setupGateway.createOrUpdateSetupPullRequest({
        owner: plan.owner,
        repo: plan.name,
        baseBranch: plan.defaultBranch,
        setupBranch: plan.setupBranch,
        workflowFiles,
      });

    await dependencies.provisioning.markSetupPullRequestOpen({
      workspaceId: plan.workspaceId,
      repositoryId: plan.repositoryId,
      status: "setup_pr_open",
      branch: pullRequest.branch,
      workflowPath: plan.workflowPath,
      workflowStyle: plan.workflowStyle,
      actionVersion: plan.actionRef,
      pullRequestUrl: pullRequest.url,
      errorMessage: null,
    });
    if (dependencies.auditLog) {
      await recordAuditEvent(
        {
          workspaceId: plan.workspaceId,
          actor: dependencies.actor ?? "system:workflow-provisioning",
          action: "workflow.setup_pr_opened",
          targetType: "repository",
          targetId: plan.repositoryId,
          metadata: {
            branch: pullRequest.branch,
            workflowPath: plan.workflowPath,
            workflowStyle: plan.workflowStyle,
            actionVersion: plan.actionRef,
            pullRequestUrl: pullRequest.url,
            ...(dependencies.auditMetadata ?? {}),
          },
        },
        { auditLog: dependencies.auditLog },
      );
    }

    return pullRequest;
  } catch (error: unknown) {
    const message = safeWorkflowProvisioningErrorSummary(error);
    await dependencies.provisioning.markFailed({
      workspaceId: plan.workspaceId,
      repositoryId: plan.repositoryId,
      status: "failed",
      branch: plan.setupBranch,
      workflowPath: plan.workflowPath,
      workflowStyle: plan.workflowStyle,
      actionVersion: plan.actionRef,
      pullRequestUrl: null,
      errorMessage: message,
    });
    if (dependencies.auditLog) {
      await recordAuditEvent(
        {
          workspaceId: plan.workspaceId,
          actor: dependencies.actor ?? "system:workflow-provisioning",
          action: "workflow.setup_pr_failed",
          targetType: "repository",
          targetId: plan.repositoryId,
          metadata: {
            branch: plan.setupBranch,
            workflowPath: plan.workflowPath,
            workflowStyle: plan.workflowStyle,
            actionVersion: plan.actionRef,
            errorSummary: message.slice(0, 500),
            ...(dependencies.auditMetadata ?? {}),
          },
        },
        { auditLog: dependencies.auditLog },
      );
    }
    throw error;
  }
}

function safeWorkflowProvisioningErrorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (
    [
      "invalid_workflow_action_ref",
      "invalid_reusable_workflow_action_ref",
      "invalid_reusable_workflow_runtime_ref",
      "invalid_conflict_review_reusable_workflow_runtime_ref",
      "invalid_workflow_api_url",
      "invalid_workflow_env_key",
      "invalid_workflow_env_value",
      "workflow_provisioning_disabled",
      "conflict_review_explicit_workflow_unsupported",
    ].includes(message)
  ) {
    return message;
  }

  const status = getHttpStatus(error);
  if (status >= 400 && status <= 599) {
    return `github_api_error:${status}`;
  }

  return "workflow_provisioning_failed";
}

function getHttpStatus(error: unknown): number {
  return typeof error === "object" && error !== null && "status" in error
    ? Number(error.status)
    : 0;
}
