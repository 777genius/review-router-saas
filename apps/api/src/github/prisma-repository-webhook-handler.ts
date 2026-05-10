import type { GitHubRepositoryWebhookEnvelope } from "@reviewrouter/features-github-installations";
import type { PrismaClient } from "@reviewrouter/platform-db";

type RepositoryVisibility = "public" | "private" | "internal";

export class PrismaRepositoryWebhookHandler {
  constructor(private readonly prisma: PrismaClient) {}

  async handleGitHubRepositoryWebhook(
    envelope: GitHubRepositoryWebhookEnvelope,
  ): Promise<Record<string, unknown>> {
    const payload = envelope.payload;
    const repository = payload.repository;
    const existing = await this.prisma.repositoryConnection.findFirst({
      where: {
        githubRepositoryId: BigInt(repository.id),
        installation: {
          githubInstallationId: BigInt(payload.installation.id),
        },
      },
      select: {
        id: true,
        defaultBranch: true,
        fullName: true,
      },
    });

    if (!existing) {
      return {
        processed: false,
        ignored: true,
        reason: "repository_not_synced",
        repository: repository.full_name,
      };
    }

    if (payload.action === "deleted") {
      await this.prisma.repositoryConnection.update({
        where: { id: existing.id },
        data: {
          selected: false,
          lastSyncedAt: new Date(),
        },
      });
      return {
        processed: true,
        repository: existing.fullName,
        status: "unselected",
      };
    }

    await this.prisma.repositoryConnection.update({
      where: { id: existing.id },
      data: {
        owner: repository.owner.login,
        name: repository.name,
        fullName: repository.full_name,
        defaultBranch: repository.default_branch ?? existing.defaultBranch,
        visibility: normalizeRepositoryVisibility(repository),
        archived: repository.archived,
        stargazersCount:
          repository.stargazers_count ?? repository.watchers_count ?? 0,
        lastSyncedAt: new Date(),
      },
    });

    return {
      processed: true,
      repository: repository.full_name,
      status: "synced",
    };
  }
}

function normalizeRepositoryVisibility(repository: {
  readonly visibility?: string | undefined;
  readonly private?: boolean | undefined;
}): RepositoryVisibility {
  if (repository.visibility === "internal") return "internal";
  if (repository.private) return "private";
  return "public";
}
