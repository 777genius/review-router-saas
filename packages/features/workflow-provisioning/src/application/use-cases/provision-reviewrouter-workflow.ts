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
};

export async function provisionReviewRouterWorkflow(
  input: ProvisionWorkflowInput,
  dependencies: ProvisionReviewRouterWorkflowDependencies,
) {
  const plan = createProvisionWorkflowPlan(input);
  const workflowYaml = renderReviewRouterWorkflow({
    actionRef: plan.actionRef,
    apiUrl: plan.apiUrl,
    runtimeConfigMode: plan.runtimeConfigMode,
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
    throw error;
  }
}
