import {
  recordAuditEvent,
  type AuditLogRepositoryPort,
} from "@reviewrouter/features-audit-log";
import { createProvisionWorkflowPlan } from "../../domain/workflow-provisioning";
import { renderCanonicalHostedPoolWorkflowV5 } from "../../domain/hosted-pool-workflow-template";
import {
  defaultCodexRotatingWorkflowPath,
  defaultInteractionWorkflowPath,
  defaultWorkflowPath,
  getLegacyReviewRouterInteractionWorkflowDeletionMarkerGroups,
  getLegacyReviewRouterWorkflowDeletionMarkerGroups,
} from "../../domain/workflow-template";
import type { WorkflowProvisioningRepositoryPort } from "../ports/workflow-provisioning-repository-port";
import type { WorkflowSetupGatewayPort } from "../ports/workflow-setup-gateway-port";
import type { WorkflowProvisioningTargetPort } from "../ports/workflow-provisioning-target-port";

export async function provisionHostedPoolRepositoryWorkflow(
  input: {
    readonly repositoryId: string;
    readonly actionRef: string;
    readonly apiUrl: string;
    readonly providerInstanceId: string;
    readonly bindingId: string;
    readonly bindingRevision: number;
    readonly actor?: string;
  },
  dependencies: {
    readonly targets: WorkflowProvisioningTargetPort;
    readonly setupGateway: WorkflowSetupGatewayPort;
    readonly provisioning: WorkflowProvisioningRepositoryPort;
    readonly auditLog?: AuditLogRepositoryPort;
    readonly enabled?: boolean;
    readonly auditMetadata?: Readonly<Record<string, unknown>>;
  },
) {
  const target = await dependencies.targets.findWorkflowProvisioningTarget(
    input.repositoryId,
  );
  if (!target) throw new Error("repository_not_found");
  if (!target.selected) throw new Error("repository_not_selected");
  if (target.archived) throw new Error("repository_archived");
  if (target.installationStatus !== "active")
    throw new Error("installation_not_active");

  const plan = createProvisionWorkflowPlan({
    workspaceId: target.workspaceId,
    repositoryId: target.repositoryId,
    owner: target.owner,
    name: target.name,
    defaultBranch: target.defaultBranch,
    actionRef: input.actionRef,
    apiUrl: input.apiUrl,
    runtimeConfigMode: "oidc",
    workflowPath: defaultCodexRotatingWorkflowPath,
  });
  const record = {
    workspaceId: plan.workspaceId,
    repositoryId: plan.repositoryId,
    branch: plan.setupBranch,
    workflowPath: plan.workflowPath,
    workflowStyle: "reusable" as const,
    actionVersion: plan.actionRef,
  };
  if (dependencies.enabled === false) {
    await dependencies.provisioning.markFailed({
      ...record,
      status: "failed",
      pullRequestUrl: null,
      errorMessage: "workflow_provisioning_disabled",
    });
    throw new Error("workflow_provisioning_disabled");
  }

  try {
    const pullRequest =
      await dependencies.setupGateway.createOrUpdateSetupPullRequest({
        owner: plan.owner,
        repo: plan.name,
        baseBranch: plan.defaultBranch,
        setupBranch: plan.setupBranch,
        workflowFiles: [
          {
            path: defaultCodexRotatingWorkflowPath,
            content: renderCanonicalHostedPoolWorkflowV5(input),
          },
          {
            path: defaultWorkflowPath,
            operation: "delete",
            markerGroups: getLegacyReviewRouterWorkflowDeletionMarkerGroups(),
          },
          {
            path: defaultInteractionWorkflowPath,
            operation: "delete",
            markerGroups:
              getLegacyReviewRouterInteractionWorkflowDeletionMarkerGroups(),
          },
        ],
      });
    await dependencies.provisioning.markSetupPullRequestOpen({
      ...record,
      status: "setup_pr_open",
      branch: pullRequest.branch,
      pullRequestUrl: pullRequest.url,
      errorMessage: null,
    });
    if (dependencies.auditLog) {
      await recordAuditEvent(
        {
          workspaceId: plan.workspaceId,
          actor: input.actor ?? "system:workflow-provisioning",
          action: "workflow.hosted_pool_setup_pr_opened",
          targetType: "repository",
          targetId: plan.repositoryId,
          metadata: {
            branch: pullRequest.branch,
            workflowPath: plan.workflowPath,
            actionVersion: plan.actionRef,
            bindingId: input.bindingId,
            bindingRevision: input.bindingRevision,
            ...(dependencies.auditMetadata ?? {}),
          },
        },
        { auditLog: dependencies.auditLog },
      );
    }
    return pullRequest;
  } catch (error) {
    await dependencies.provisioning.markFailed({
      ...record,
      status: "failed",
      pullRequestUrl: null,
      errorMessage: safeHostedProvisioningError(error),
    });
    throw error;
  }
}

function safeHostedProvisioningError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return [
    "workflow_provisioning_disabled",
    "hosted_binding_id_invalid",
    "hosted_binding_revision_invalid",
    "hosted_provider_instance_id_invalid",
    "hosted_workflow_action_ref_invalid",
    "hosted_workflow_action_ref_must_be_full_sha",
    "invalid_workflow_api_url",
  ].includes(message)
    ? message
    : "workflow_provisioning_failed";
}
