import type { PrismaClient } from "@prisma/client";
import type { RepositoryHealthRepositoryPort } from "../../application/ports/repository-health-repository-port";
import type { RepositoryHealthInput } from "../../domain/repository-health";

export class PrismaRepositoryHealthRepository implements RepositoryHealthRepositoryPort {
  constructor(private readonly prisma: PrismaClient) {}

  async listWorkspaceHealthInputs(
    workspaceId: string,
  ): Promise<readonly RepositoryHealthInput[]> {
    const repositories = await this.prisma.repositoryConnection.findMany({
      where: { workspaceId },
      orderBy: { fullName: "asc" },
      select: {
        id: true,
        fullName: true,
        setupStatus: true,
        actionHealth: {
          orderBy: { receivedAt: "desc" },
          take: 1,
          select: {
            providerHealth: true,
            providerSetupState: true,
          },
        },
      },
    });

    return repositories.map((repository) => {
      const latestHealth = repository.actionHealth[0];
      return {
        repositoryId: repository.id,
        fullName: repository.fullName,
        setupStatus: repository.setupStatus,
        expectedActionRef: "",
        latestProviderHealth: latestHealth?.providerHealth ?? null,
        latestProviderSetupState: latestHealth?.providerSetupState ?? null,
      };
    });
  }
}
