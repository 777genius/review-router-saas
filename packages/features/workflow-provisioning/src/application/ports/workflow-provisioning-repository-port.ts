import type { WorkflowProvisioningStatus } from "../../domain/workflow-provisioning";
import type { ReviewRouterWorkflowStyle } from "../../domain/workflow-template";

export type WorkflowProvisioningScope = {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly installationId: string;
};

export type WorkflowProvisioningAttempt = WorkflowProvisioningScope & {
  readonly attemptId: string;
  readonly revision: number;
};

export type WorkflowProvisioningRecord = WorkflowProvisioningScope & {
  readonly status: WorkflowProvisioningStatus;
  readonly branch: string;
  readonly workflowPath: string;
  readonly workflowStyle: ReviewRouterWorkflowStyle;
  readonly actionVersion: string;
  readonly pullRequestUrl?: string | null;
  readonly errorMessage?: string | null;
};

export interface WorkflowProvisioningRepositoryPort {
  beginAttempt(
    record: WorkflowProvisioningRecord,
  ): Promise<WorkflowProvisioningAttempt>;
  markSetupPullRequestOpen(
    record: WorkflowProvisioningRecord & WorkflowProvisioningAttempt,
  ): Promise<void>;
  markFailed(
    record: WorkflowProvisioningRecord & WorkflowProvisioningAttempt,
  ): Promise<void>;
}
