import type { PrismaClient } from "@prisma/client";
import type { AuthenticatedPrincipal } from "../../domain/authenticated-principal";
import type { GitHubExternalIdentity } from "../../domain/github-external-identity";
import type { UserRepositoryPort } from "../../application/ports/user-repository-port";

export class PrismaUserRepository implements UserRepositoryPort {
  constructor(private readonly prisma: PrismaClient) {}

  async upsertGitHubUser(
    identity: GitHubExternalIdentity,
  ): Promise<AuthenticatedPrincipal> {
    const user = await this.prisma.user.upsert({
      where: { githubUserId: BigInt(identity.githubUserId) },
      update: {
        githubLogin: identity.githubLogin,
        primaryEmail: identity.primaryEmail ?? null,
        avatarUrl: identity.avatarUrl ?? null,
      },
      create: {
        githubUserId: BigInt(identity.githubUserId),
        githubLogin: identity.githubLogin,
        primaryEmail: identity.primaryEmail ?? null,
        avatarUrl: identity.avatarUrl ?? null,
      },
    });

    return {
      userId: user.id,
      githubUserId: user.githubUserId.toString(),
      githubLogin: user.githubLogin,
      primaryEmail: user.primaryEmail,
      avatarUrl: user.avatarUrl,
    };
  }
}
