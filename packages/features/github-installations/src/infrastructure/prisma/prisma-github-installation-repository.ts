import type { PrismaClient } from "@prisma/client";
import type { GitHubInstallationRepositoryPort } from "../../application/ports/github-installation-repository-port.js";
import type { GitHubInstallationSnapshot } from "../../domain/github-installation.js";

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
    await this.prisma.gitHubInstallation.updateMany({
      where: { githubInstallationId: BigInt(githubInstallationId) },
      data: { status: "removed" },
    });
  }
}
