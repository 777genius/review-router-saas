import type { PrismaClient } from "@prisma/client";
import type { AuthenticatedPrincipal } from "../../domain/authenticated-principal";
import type { ExternalIdentity } from "../../domain/external-identity";
import type { GitHubExternalIdentity } from "../../domain/github-external-identity";
import { gitHubIdentityToExternalIdentity } from "../../domain/github-external-identity";
import type { UserRepositoryPort } from "../../application/ports/user-repository-port";

export class PrismaUserRepository implements UserRepositoryPort {
  constructor(private readonly prisma: PrismaClient) {}

  async upsertExternalIdentity(
    identity: ExternalIdentity,
  ): Promise<AuthenticatedPrincipal> {
    const existingIdentity = await this.prisma.userExternalIdentity.findUnique({
      where: {
        provider_externalUserId: {
          provider: identity.provider,
          externalUserId: identity.externalUserId,
        },
      },
      select: { userId: true },
    });

    const user = existingIdentity
      ? await this.prisma.user.update({
          where: { id: existingIdentity.userId },
          data: userUpdateForIdentity(identity),
        })
      : await this.prisma.user.create({
          data: userCreateForIdentity(identity),
        });

    await this.prisma.userExternalIdentity.upsert({
      where: {
        provider_externalUserId: {
          provider: identity.provider,
          externalUserId: identity.externalUserId,
        },
      },
      update: {
        login: identity.login,
        primaryEmail: identity.primaryEmail ?? null,
        avatarUrl: identity.avatarUrl ?? null,
      },
      create: {
        userId: user.id,
        provider: identity.provider,
        externalUserId: identity.externalUserId,
        login: identity.login,
        primaryEmail: identity.primaryEmail ?? null,
        avatarUrl: identity.avatarUrl ?? null,
      },
    });

    return principalFromIdentity(user, identity);
  }

  async upsertGitHubUser(
    identity: GitHubExternalIdentity,
  ): Promise<AuthenticatedPrincipal> {
    return this.upsertExternalIdentity(
      gitHubIdentityToExternalIdentity(identity),
    );
  }
}

function userCreateForIdentity(identity: ExternalIdentity) {
  if (identity.provider === "github") {
    return {
      githubUserId: BigInt(identity.externalUserId),
      githubLogin: identity.login,
      primaryEmail: identity.primaryEmail ?? null,
      avatarUrl: identity.avatarUrl ?? null,
    };
  }
  return {
    primaryEmail: identity.primaryEmail ?? null,
    avatarUrl: identity.avatarUrl ?? null,
  };
}

function userUpdateForIdentity(identity: ExternalIdentity) {
  if (identity.provider === "github") {
    return {
      githubUserId: BigInt(identity.externalUserId),
      githubLogin: identity.login,
      primaryEmail: identity.primaryEmail ?? null,
      avatarUrl: identity.avatarUrl ?? null,
    };
  }
  return {
    primaryEmail: identity.primaryEmail ?? null,
    avatarUrl: identity.avatarUrl ?? null,
  };
}

function principalFromIdentity(
  user: {
    readonly id: string;
    readonly githubUserId: bigint | null;
    readonly githubLogin: string | null;
    readonly primaryEmail: string | null;
    readonly avatarUrl: string | null;
  },
  identity: ExternalIdentity,
): AuthenticatedPrincipal {
  return {
    userId: user.id,
    provider: identity.provider,
    externalUserId: identity.externalUserId,
    login: identity.login,
    githubUserId: user.githubUserId?.toString() ?? null,
    githubLogin: user.githubLogin,
    primaryEmail: user.primaryEmail,
    avatarUrl: identity.avatarUrl ?? user.avatarUrl,
  };
}
