import type { PrismaClient } from "@prisma/client";
import type { RepositoryHealthRepositoryPort } from "../../application/ports/repository-health-repository-port";
import type { RepositoryHealthInput } from "../../domain/repository-health";

export class PrismaRepositoryHealthRepository implements RepositoryHealthRepositoryPort {
  constructor(private readonly prisma: PrismaClient) {}

  async listWorkspaceHealthInputs(
    workspaceId: string,
  ): Promise<readonly RepositoryHealthInput[]> {
    const repositories = await this.prisma.repositoryConnection.findMany({
      where: { workspaceId, provider: "github" },
      orderBy: { fullName: "asc" },
      select: {
        id: true,
        owner: true,
        name: true,
        fullName: true,
        defaultBranch: true,
        setupStatus: true,
        installation: {
          select: { githubInstallationId: true },
        },
        actionHealth: {
          orderBy: { receivedAt: "desc" },
          take: 1,
          select: {
            providerHealth: true,
            providerSetupState: true,
            configSource: true,
            findingCriticalCount: true,
            findingMajorCount: true,
            findingMinorCount: true,
            findingInfoCount: true,
            inlineCommentCount: true,
            summaryCommentCount: true,
            skippedReasonCategory: true,
            receivedAt: true,
          },
        },
      },
    });

    return repositories.flatMap((repository) => {
      if (!repository.installation) return [];
      const latestHealth = repository.actionHealth[0];
      return [
        {
          repositoryId: repository.id,
          fullName: repository.fullName,
          owner: repository.owner,
          name: repository.name,
          defaultBranch: repository.defaultBranch,
          githubInstallationId:
            repository.installation.githubInstallationId.toString(),
          setupStatus: repository.setupStatus,
          expectedActionRef: "",
          latestProviderHealth: latestHealth?.providerHealth ?? null,
          latestProviderSetupState: latestHealth?.providerSetupState ?? null,
          latestActionHealthReceivedAt: latestHealth?.receivedAt ?? null,
          latestActionHealthTelemetry: latestHealth
            ? {
                configSource: latestHealth.configSource,
                findingCounts: {
                  critical: latestHealth.findingCriticalCount,
                  major: latestHealth.findingMajorCount,
                  minor: latestHealth.findingMinorCount,
                  info: latestHealth.findingInfoCount,
                },
                commentCounts: {
                  inline: latestHealth.inlineCommentCount,
                  summary: latestHealth.summaryCommentCount,
                },
                skippedReasonCategory: latestHealth.skippedReasonCategory,
              }
            : null,
        },
      ];
    });
  }
}
