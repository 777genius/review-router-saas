import type { PrismaClient } from "@prisma/client";
import type {
  WorkflowProvisioningTarget,
  WorkflowProvisioningTargetPort,
} from "../../application/ports/workflow-provisioning-target-port";

export class PrismaWorkflowProvisioningTarget implements WorkflowProvisioningTargetPort {
  constructor(private readonly prisma: PrismaClient) {}

  async findWorkflowProvisioningTarget(
    repositoryId: string,
  ): Promise<WorkflowProvisioningTarget | null> {
    const repository = await this.prisma.repositoryConnection.findUnique({
      where: { id: repositoryId },
      select: {
        id: true,
        workspaceId: true,
        owner: true,
        name: true,
        fullName: true,
        defaultBranch: true,
        selected: true,
        archived: true,
        installation: { select: { status: true } },
      },
    });

    if (!repository) {
      return null;
    }

    return {
      workspaceId: repository.workspaceId,
      repositoryId: repository.id,
      owner: repository.owner,
      name: repository.name,
      fullName: repository.fullName,
      defaultBranch: repository.defaultBranch,
      selected: repository.selected,
      archived: repository.archived,
      installationStatus: repository.installation.status,
    };
  }
}
