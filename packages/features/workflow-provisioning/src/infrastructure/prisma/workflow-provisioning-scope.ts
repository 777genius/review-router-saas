import type { Prisma } from "@prisma/client";
import type { WorkflowProvisioningScope } from "../../application/ports/workflow-provisioning-repository-port";

export function provisioningScopeWhere(scope: WorkflowProvisioningScope) {
  return {
    repositoryId: scope.repositoryId,
    workspaceId: scope.workspaceId,
    installationId: scope.installationId,
    repository: {
      workspaceId: scope.workspaceId,
      installationId: scope.installationId,
    },
  };
}

export function findProvisioningRepository(
  tx: Prisma.TransactionClient,
  scope: WorkflowProvisioningScope,
) {
  return tx.repositoryConnection.findFirst({
    where: {
      id: scope.repositoryId,
      workspaceId: scope.workspaceId,
      installationId: scope.installationId,
      provider: "github",
      selected: true,
      archived: false,
      installation: { status: "active" },
    },
    select: { defaultBranch: true },
  });
}
