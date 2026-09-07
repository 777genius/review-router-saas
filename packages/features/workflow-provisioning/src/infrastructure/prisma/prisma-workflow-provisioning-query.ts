import type { PrismaClient } from "@prisma/client";
import type {
  RepositoryWorkflowProvisioningSummary,
  WorkflowProvisioningQueryPort,
} from "../../application/ports/workflow-provisioning-query-port";

export class PrismaWorkflowProvisioningQuery implements WorkflowProvisioningQueryPort {
  constructor(private readonly prisma: PrismaClient) {}

  async listLatestForRepositories(input: {
    readonly workspaceId: string;
    readonly repositoryIds: readonly string[];
  }): Promise<readonly RepositoryWorkflowProvisioningSummary[]> {
    if (input.repositoryIds.length === 0) {
      return [];
    }

    const rows = await this.prisma.workflowProvisioning.findMany({
      where: {
        workspaceId: input.workspaceId,
        repository: { workspaceId: input.workspaceId },
        repositoryId: { in: [...input.repositoryIds] },
      },
      orderBy: [{ repositoryId: "asc" }, { updatedAt: "desc" }, { id: "desc" }],
    });

    const latestByRepository = new Map<
      string,
      RepositoryWorkflowProvisioningSummary
    >();
    for (const row of rows) {
      if (latestByRepository.has(row.repositoryId)) {
        continue;
      }
      latestByRepository.set(row.repositoryId, {
        repositoryId: row.repositoryId,
        status: row.status,
        branch: row.branch,
        workflowPath: row.workflowPath,
        workflowStyle:
          row.workflowStyle === "reusable" ? "reusable" : "explicit",
        actionVersion: row.actionVersion,
        pullRequestUrl: row.pullRequestUrl,
        errorMessage: row.errorMessage,
        updatedAt: row.updatedAt,
      });
    }

    return [...latestByRepository.values()];
  }
}
