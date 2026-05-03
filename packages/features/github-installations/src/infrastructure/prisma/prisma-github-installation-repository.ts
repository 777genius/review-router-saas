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
    const workspace = await this.prisma.workspace.upsert({
      where: { slug: workspaceSlugForInstallation(snapshot) },
      update: { name: snapshot.accountLogin },
      create: {
        slug: workspaceSlugForInstallation(snapshot),
        name: snapshot.accountLogin,
      },
    });

    await this.prisma.gitHubInstallation.upsert({
      where: { githubInstallationId: BigInt(snapshot.githubInstallationId) },
      update: {
        workspaceId: workspace.id,
        accountLogin: snapshot.accountLogin,
        accountType: snapshot.accountType,
        repositorySelection: snapshot.repositorySelection,
        status: snapshot.status,
      },
      create: {
        workspaceId: workspace.id,
        githubInstallationId: BigInt(snapshot.githubInstallationId),
        accountLogin: snapshot.accountLogin,
        accountType: snapshot.accountType,
        repositorySelection: snapshot.repositorySelection,
        status: snapshot.status,
      },
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
    });
  }
}
