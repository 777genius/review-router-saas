import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type {
  GitHubRepositorySnapshot,
  RepositoryIdentitySynchronizationPort,
} from "@reviewrouter/features-repositories";
import {
  ManageScmRepositoryIdentities,
  ScmProvider,
  ScmRepositoryIdentityBindingStatus,
} from "@reviewrouter/features-review-run-control";
import { createPrismaReviewRunControlRepositories } from "@reviewrouter/features-review-run-control/composition";
import type { SystemClock } from "@reviewrouter/shared";

export class PrismaRepositoryIdentitySynchronizer implements RepositoryIdentitySynchronizationPort {
  private readonly identities: ManageScmRepositoryIdentities;

  constructor(
    private readonly prisma: PrismaClient,
    clock: SystemClock,
  ) {
    const repositories = createPrismaReviewRunControlRepositories(prisma);
    this.identities = new ManageScmRepositoryIdentities({
      clock,
      identifiers: {
        nextId: (prefix) => `${prefix}:${randomUUID()}`,
      },
      identityQueries: repositories.repositoryIdentities,
      identityCommands: repositories.repositoryIdentities,
      authorityQueries: repositories.mutationAuthorities,
    });
  }

  async synchronizeRepositoryIdentities(input: {
    readonly githubInstallationId: string;
    readonly repositories: readonly GitHubRepositorySnapshot[];
    readonly syncedAt: Date;
  }): Promise<void> {
    if (input.repositories.length === 0) return;

    const connections = await this.prisma.repositoryConnection.findMany({
      where: {
        githubRepositoryId: {
          in: input.repositories.map((repository) =>
            BigInt(repository.githubRepositoryId),
          ),
        },
        installation: {
          githubInstallationId: BigInt(input.githubInstallationId),
        },
      },
      select: {
        id: true,
        workspaceId: true,
        externalRepositoryId: true,
        sourceBaseUrl: true,
      },
    });
    const connectionsByExternalId = new Map(
      connections.map((connection) => [
        connection.externalRepositoryId,
        connection,
      ]),
    );

    for (const repository of input.repositories) {
      const connection = connectionsByExternalId.get(
        repository.githubRepositoryId,
      );
      if (!connection) {
        throw new Error("repository_identity_sync_connection_missing");
      }
      const resolved =
        await this.identities.resolveOrRegisterScmRepositoryIdentity({
          provider: ScmProvider.GitHub,
          sourceBaseUrl: connection.sourceBaseUrl,
          externalRepositoryId: connection.externalRepositoryId,
        });
      const binding = await this.identities.bindScmRepositoryIdentity({
        scmRepositoryIdentityId: resolved.identity.scmRepositoryIdentityId,
        expectedVersion: resolved.identity.version,
        workspaceId: connection.workspaceId,
        repositoryConnectionId: connection.id,
      });
      if (
        binding.status !== ScmRepositoryIdentityBindingStatus.Bound &&
        binding.status !== ScmRepositoryIdentityBindingStatus.Restored
      ) {
        throw new Error(`repository_identity_sync_${binding.status}`);
      }
    }
  }
}
