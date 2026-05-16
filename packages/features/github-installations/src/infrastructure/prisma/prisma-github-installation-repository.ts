import type { PrismaClient } from "@prisma/client";
import type { GitHubInstallationRepositoryPort } from "../../application/ports/github-installation-repository-port";
import type { GitHubInstallationSnapshot } from "../../domain/github-installation";

function workspaceSlugForInstallation(
  snapshot: GitHubInstallationSnapshot,
): string {
  return `gh-${snapshot.accountType.toLowerCase()}-${snapshot.accountLogin.toLowerCase()}`;
}

export class PrismaGitHubInstallationRepository implements GitHubInstallationRepositoryPort {
  constructor(private readonly prisma: PrismaClient) {}

  async upsertInstallation(
    snapshot: GitHubInstallationSnapshot,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const existingInstallation = await tx.gitHubInstallation.findUnique({
        where: { githubInstallationId: BigInt(snapshot.githubInstallationId) },
        select: { workspaceId: true },
      });
      const workspaceId = existingInstallation
        ? existingInstallation.workspaceId
        : (
            await tx.workspace.upsert({
              where: { slug: workspaceSlugForInstallation(snapshot) },
              update: { name: snapshot.accountLogin },
              create: {
                slug: workspaceSlugForInstallation(snapshot),
                name: snapshot.accountLogin,
              },
            })
          ).id;

      if (existingInstallation) {
        await tx.workspace.update({
          where: { id: workspaceId },
          data: { name: snapshot.accountLogin },
        });
      }

      await tx.gitHubInstallation.upsert({
        where: { githubInstallationId: BigInt(snapshot.githubInstallationId) },
        update: {
          workspaceId,
          accountLogin: snapshot.accountLogin,
          accountType: snapshot.accountType,
          accountAvatarUrl: snapshot.accountAvatarUrl ?? null,
          repositorySelection: snapshot.repositorySelection,
          status: snapshot.status,
        },
        create: {
          workspaceId,
          githubInstallationId: BigInt(snapshot.githubInstallationId),
          accountLogin: snapshot.accountLogin,
          accountType: snapshot.accountType,
          accountAvatarUrl: snapshot.accountAvatarUrl ?? null,
          repositorySelection: snapshot.repositorySelection,
          status: snapshot.status,
        },
      });

      await tx.repositoryPermissionCache.deleteMany({
        where: {
          githubInstallationId: BigInt(snapshot.githubInstallationId),
        },
      });
    });
  }

  async markInstallationRemoved(githubInstallationId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const installation = await tx.gitHubInstallation.findUnique({
        where: { githubInstallationId: BigInt(githubInstallationId) },
        select: { id: true },
      });
      if (!installation) {
        return;
      }

      await tx.gitHubInstallation.update({
        where: { id: installation.id },
        data: { status: "removed" },
      });
      await tx.repositoryConnection.updateMany({
        where: { installationId: installation.id },
        data: { selected: false },
      });
      await tx.repositoryPermissionCache.deleteMany({
        where: { githubInstallationId: BigInt(githubInstallationId) },
      });
    });
  }
}
