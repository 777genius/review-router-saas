import type { WorkflowProvisioningScope } from "./workflow-provisioning-repository-port";

export type WorkflowProvisioningTarget = {
  readonly installationId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly selected: boolean;
  readonly archived: boolean;
  readonly installationStatus: string;
};

export interface WorkflowProvisioningTargetPort {
  findWorkflowProvisioningTarget(
    scope: WorkflowProvisioningScope,
  ): Promise<WorkflowProvisioningTarget | null>;
}
