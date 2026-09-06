import { randomUUID } from "node:crypto";
import { workflowProvisioningTransaction } from "@reviewrouter/features-workflow-provisioning";
import type { PrismaClient } from "@prisma/client";
import type {
  GitHubRepositorySnapshot,
  RepositoryConnectionSummary,
  RepositorySyncResult,
} from "../../domain/repository-connection";
import type { RepositoryConnectionRepositoryPort } from "../../application/ports/repository-connection-repository-port";

function toVisibility(value: GitHubRepositorySnapshot["visibility"]) {
  return value;
}

export class PrismaRepositoryConnectionRepository implements RepositoryConnectionRepositoryPort {
  constructor(private readonly prisma: PrismaClient) {}

  async beginInstallationInventory(): Promise<bigint> {
    const [row] = await this.prisma.$queryRaw<Array<{ generation: bigint }>>`
      SELECT nextval('"RepositoryInventoryGeneration"') AS generation
    `;
    if (!row) throw new Error("repository_inventory_generation_missing");
    return row.generation;
  }

  async syncInstallationRepositories(input: {
    githubInstallationId: string;
    repositories: readonly GitHubRepositorySnapshot[];
    syncedAt: Date;
    inventoryGeneration: bigint;
  }): Promise<RepositorySyncResult> {
    if (input.inventoryGeneration <= 0n)
      throw new Error("repository_inventory_generation_invalid");
    const installation = await this.prisma.gitHubInstallation.findUnique({
      where: { githubInstallationId: BigInt(input.githubInstallationId) },
      select: { id: true, workspaceId: true },
    });

    if (!installation) {
      throw new Error(
        `GitHub installation not found: ${input.githubInstallationId}`,
      );
    }

    let upserted = 0;
    for (const repository of input.repositories) {
      const applied = await workflowProvisioningTransaction(
        this.prisma,
        async (tx) => {
          const previous = await tx.repositoryConnection.findUnique({
            where: {
              githubRepositoryId: BigInt(repository.githubRepositoryId),
            },
            select: {
              id: true,
              workspaceId: true,
              installationId: true,
              inventoryGeneration: true,
            },
          });
          // Serializable retries re-read ownership and its monotonic inventory fence.
          if (
            previous &&
            previous.inventoryGeneration >= input.inventoryGeneration
          )
            return false;
          const saved = await tx.repositoryConnection.upsert({
            where: {
              githubRepositoryId: BigInt(repository.githubRepositoryId),
            },
            update: {
              workspaceId: installation.workspaceId,
              provider: "github",
              sourceBaseUrl: "https://github.com",
              externalRepositoryId: repository.githubRepositoryId,
              installationId: installation.id,
              owner: repository.owner,
              name: repository.name,
              fullName: repository.fullName,
              defaultBranch: repository.defaultBranch,
              visibility: toVisibility(repository.visibility),
              archived: repository.archived,
              stargazersCount: repository.stargazersCount,
              selected: true,
              lastSyncedAt: input.syncedAt,
              inventoryGeneration: input.inventoryGeneration,
            },
            create: {
              workspaceId: installation.workspaceId,
              provider: "github",
              sourceBaseUrl: "https://github.com",
              externalRepositoryId: repository.githubRepositoryId,
              installationId: installation.id,
              githubRepositoryId: BigInt(repository.githubRepositoryId),
              owner: repository.owner,
              name: repository.name,
              fullName: repository.fullName,
              defaultBranch: repository.defaultBranch,
              visibility: toVisibility(repository.visibility),
              archived: repository.archived,
              stargazersCount: repository.stargazersCount,
              selected: true,
              lastSyncedAt: input.syncedAt,
              inventoryGeneration: input.inventoryGeneration,
            },
          });
          if (
            previous &&
            (previous.workspaceId !== installation.workspaceId ||
              previous.installationId !== installation.id)
          ) {
            // Transfer invalidates setup evidence and all in-flight attempt tokens.
            // Retain a row so legacy RepositoryConnection status cannot resurface.
            const current = await tx.workflowProvisioning.findUnique({
              where: { repositoryId: saved.id },
            });
            if (current) {
              const invalidated = await tx.workflowProvisioning.updateMany({
                where: {
                  id: current.id,
                  attemptId: current.attemptId,
                  revision: current.revision,
                  workspaceId: current.workspaceId,
                  installationId: current.installationId,
                  status: current.status,
                },
                data: {
                  workspaceId: installation.workspaceId,
                  installationId: installation.id,
                  attemptId: randomUUID(),
                  revision: { increment: 1 },
                  status: "not_started",
                  pullRequestUrl: null,
                  pullRequestHeadSha: null,
                  errorMessage: null,
                },
              });
              if (invalidated.count !== 1)
                throw new Error("workflow_provisioning_concurrent_transition");
            } else {
              await tx.workflowProvisioning.create({
                data: {
                  workspaceId: installation.workspaceId,
                  repositoryId: saved.id,
                  installationId: installation.id,
                  status: "not_started",
                  branch: "reviewrouter/setup",
                  workflowPath: ".github/workflows/reviewrouter-codex.yml",
                  actionVersion: "",
                },
              });
            }
          }
          return true;
        },
      );
      if (applied) upserted++;
    }

    const seenRepositoryIds = input.repositories.map((repository) =>
      BigInt(repository.githubRepositoryId),
    );
    const unselected = await this.prisma.repositoryConnection.updateMany({
      where: {
        installationId: installation.id,
        inventoryGeneration: { lt: input.inventoryGeneration },
        ...(seenRepositoryIds.length > 0
          ? { githubRepositoryId: { notIn: seenRepositoryIds } }
          : {}),
      },
      data: {
        selected: false,
        lastSyncedAt: input.syncedAt,
        inventoryGeneration: input.inventoryGeneration,
      },
    });

    return {
      installationId: input.githubInstallationId,
      seen: input.repositories.length,
      upserted,
      unselected: unselected.count,
      skippedDueToLimit: 0,
    };
  }

  async listWorkspaceRepositories(
    workspaceId: string,
  ): Promise<readonly RepositoryConnectionSummary[]> {
    const repositories = await this.prisma.repositoryConnection.findMany({
      where: { workspaceId },
      orderBy: [{ selected: "desc" }, { fullName: "asc" }],
    });

    return repositories.map((repository) => ({
      id: repository.id,
      workspaceId: repository.workspaceId,
      provider: repository.provider,
      externalRepositoryId: repository.externalRepositoryId,
      sourceBaseUrl: repository.sourceBaseUrl,
      githubRepositoryId:
        repository.githubRepositoryId?.toString() ??
        repository.externalRepositoryId,
      owner: repository.owner,
      name: repository.name,
      fullName: repository.fullName,
      defaultBranch: repository.defaultBranch,
      visibility: repository.visibility,
      archived: repository.archived,
      stargazersCount: repository.stargazersCount,
      selected: repository.selected,
      setupStatus: repository.setupStatus,
      lastSyncedAt: repository.lastSyncedAt,
    }));
  }
}
