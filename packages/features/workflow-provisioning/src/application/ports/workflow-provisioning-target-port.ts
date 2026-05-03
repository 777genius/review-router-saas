export type WorkflowProvisioningTarget = {
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
    repositoryId: string,
  ): Promise<WorkflowProvisioningTarget | null>;
}
