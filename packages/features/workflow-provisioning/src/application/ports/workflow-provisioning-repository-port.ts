import type { WorkflowProvisioningStatus } from "../../domain/workflow-provisioning";
import type { ReviewRouterWorkflowStyle } from "../../domain/workflow-template";

export type WorkflowProvisioningRecord = {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly status: WorkflowProvisioningStatus;
  readonly branch: string;
  readonly workflowPath: string;
  readonly workflowStyle: ReviewRouterWorkflowStyle;
  readonly actionVersion: string;
  readonly pullRequestUrl?: string | null;
  readonly errorMessage?: string | null;
};

export interface WorkflowProvisioningRepositoryPort {
  markSetupPullRequestOpen(record: WorkflowProvisioningRecord): Promise<void>;
  markFailed(record: WorkflowProvisioningRecord): Promise<void>;
}
