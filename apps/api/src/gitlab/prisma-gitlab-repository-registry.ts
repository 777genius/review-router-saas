import type { PrismaClient } from "@reviewrouter/platform-db";
import type {
  GitLabRepositoryContext,
  GitLabRepositoryPort,
} from "@reviewrouter/features-gitlab-integration";

export class PrismaGitLabRepositoryRegistry implements GitLabRepositoryPort {
  constructor(private readonly prisma: PrismaClient) {}

  async findSelectedRepositoryByGitLabProjectId(
    gitlabProjectId: string,
  ): Promise<GitLabRepositoryContext | null> {
    const repository = await this.prisma.repositoryConnection.findFirst({
      where: {
        provider: "gitlab",
        externalRepositoryId: gitlabProjectId,
        selected: true,
      },
      select: {
        id: true,
        workspaceId: true,
        externalRepositoryId: true,
        fullName: true,
        owner: true,
        selected: true,
        gitlabInstallation: { select: { status: true } },
      },
    });
    if (!repository) return null;

    return {
      workspaceId: repository.workspaceId,
      repositoryId: repository.id,
      gitlabProjectId: repository.externalRepositoryId,
      fullName: repository.fullName,
      owner: repository.owner,
      selected: repository.selected,
      installationStatus: repository.gitlabInstallation?.status ?? "removed",
    };
  }
}
