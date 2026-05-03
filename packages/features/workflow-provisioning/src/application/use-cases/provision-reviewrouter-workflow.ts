import {
  mapConfigToRuntimeEnv,
  safeDefaultReviewConfiguration,
} from "@reviewrouter/features-review-config";
import {
  recordAuditEvent,
  type AuditLogRepositoryPort,
} from "@reviewrouter/features-audit-log";
import { renderReviewRouterWorkflow } from "../../domain/workflow-template";
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
          metadata: { reason: "workflow_provisioning_disabled" },
        },
        { auditLog: dependencies.auditLog },
      );
    }
    throw new Error("workflow_provisioning_disabled");
  }

  const workflowYaml = renderReviewRouterWorkflow({
    actionRef: plan.actionRef,
    apiUrl: plan.apiUrl,
    runtimeConfigMode: plan.runtimeConfigMode,
    staticRuntimeEnv: mapConfigToRuntimeEnv(safeDefaultReviewConfiguration),
  });

  try {
    const pullRequest =
      await dependencies.setupGateway.createOrUpdateSetupPullRequest({
        owner: plan.owner,
        repo: plan.name,
        baseBranch: plan.defaultBranch,
        setupBranch: plan.setupBranch,
        workflowPath: plan.workflowPath,
        workflowYaml,
      });

    await dependencies.provisioning.markSetupPullRequestOpen({
      workspaceId: plan.workspaceId,
      repositoryId: plan.repositoryId,
      status: "setup_pr_open",
      branch: pullRequest.branch,
      workflowPath: plan.workflowPath,
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
            actionVersion: plan.actionRef,
            pullRequestUrl: pullRequest.url,
          },
        },
        { auditLog: dependencies.auditLog },
      );
    }

    return pullRequest;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await dependencies.provisioning.markFailed({
      workspaceId: plan.workspaceId,
      repositoryId: plan.repositoryId,
      status: "failed",
      branch: plan.setupBranch,
      workflowPath: plan.workflowPath,
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
            actionVersion: plan.actionRef,
            errorSummary: message.slice(0, 500),
          },
        },
        { auditLog: dependencies.auditLog },
      );
    }
    throw error;
  }
}
