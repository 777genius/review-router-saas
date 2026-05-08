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

  async syncInstallationRepositories(input: {
    githubInstallationId: string;
    repositories: readonly GitHubRepositorySnapshot[];
    syncedAt: Date;
  }): Promise<RepositorySyncResult> {
    const installation = await this.prisma.gitHubInstallation.findUnique({
      where: { githubInstallationId: BigInt(input.githubInstallationId) },
      select: { id: true, workspaceId: true },
    });

    if (!installation) {
      throw new Error(
        `GitHub installation not found: ${input.githubInstallationId}`,
      );
    }

    for (const repository of input.repositories) {
      await this.prisma.repositoryConnection.upsert({
        where: { githubRepositoryId: BigInt(repository.githubRepositoryId) },
        update: {
          workspaceId: installation.workspaceId,
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
        },
        create: {
          workspaceId: installation.workspaceId,
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
        },
      });
    }

    const seenRepositoryIds = input.repositories.map((repository) =>
      BigInt(repository.githubRepositoryId),
    );
    const unselected = await this.prisma.repositoryConnection.updateMany({
      where: {
        installationId: installation.id,
        ...(seenRepositoryIds.length > 0
          ? { githubRepositoryId: { notIn: seenRepositoryIds } }
          : {}),
      },
      data: { selected: false, lastSyncedAt: input.syncedAt },
    });

    return {
      installationId: input.githubInstallationId,
      seen: input.repositories.length,
      upserted: input.repositories.length,
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
      githubRepositoryId: repository.githubRepositoryId.toString(),
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
