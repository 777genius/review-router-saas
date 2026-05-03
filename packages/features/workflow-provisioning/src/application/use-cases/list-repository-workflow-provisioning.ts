import type {
  RepositoryWorkflowProvisioningSummary,
  WorkflowProvisioningQueryPort,
} from "../ports/workflow-provisioning-query-port";

export async function listRepositoryWorkflowProvisioning(
  input: {
    readonly workspaceId: string;
    readonly repositoryIds: readonly string[];
  },
  dependencies: {
    readonly provisioning: WorkflowProvisioningQueryPort;
  },
): Promise<readonly RepositoryWorkflowProvisioningSummary[]> {
  if (input.repositoryIds.length === 0) {
    return [];
  }

  return dependencies.provisioning.listLatestForRepositories({
    workspaceId: input.workspaceId,
    repositoryIds: [...new Set(input.repositoryIds)],
  });
}
