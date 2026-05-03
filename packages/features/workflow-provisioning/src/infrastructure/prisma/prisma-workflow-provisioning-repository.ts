import type { PrismaClient } from "@prisma/client";
import type {
  WorkflowProvisioningRecord,
  WorkflowProvisioningRepositoryPort,
} from "../../application/ports/workflow-provisioning-repository-port";

export class PrismaWorkflowProvisioningRepository implements WorkflowProvisioningRepositoryPort {
  constructor(private readonly prisma: PrismaClient) {}

  async markSetupPullRequestOpen(
    record: WorkflowProvisioningRecord,
  ): Promise<void> {
    await this.upsert(record);
    await this.prisma.repositoryConnection.update({
      where: { id: record.repositoryId },
      data: { setupStatus: "setup_pr_open" },
    });
  }

  async markFailed(record: WorkflowProvisioningRecord): Promise<void> {
    await this.upsert(record);
    await this.prisma.repositoryConnection.update({
      where: { id: record.repositoryId },
      data: { setupStatus: "needs_attention" },
    });
  }

  private async upsert(record: WorkflowProvisioningRecord): Promise<void> {
    await this.prisma.workflowProvisioning.upsert({
      where: {
        repositoryId_branch: {
          repositoryId: record.repositoryId,
          branch: record.branch,
        },
      },
      update: {
        status: record.status,
        workflowPath: record.workflowPath,
        actionVersion: record.actionVersion,
        pullRequestUrl: record.pullRequestUrl ?? null,
        errorMessage: record.errorMessage ?? null,
      },
      create: {
        workspaceId: record.workspaceId,
        repositoryId: record.repositoryId,
        status: record.status,
        branch: record.branch,
        workflowPath: record.workflowPath,
        actionVersion: record.actionVersion,
        pullRequestUrl: record.pullRequestUrl ?? null,
        errorMessage: record.errorMessage ?? null,
      },
    });
  }
}
