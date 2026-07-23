import type { PrismaClient } from "@prisma/client";
import {
  bindScmRepositoryIdentity,
  normalizeScmSourceBaseUrl,
  scmRepositoryExternalIdentityKey,
  unbindScmRepositoryIdentity,
  type ScmRepositoryExternalIdentity,
  type ScmRepositoryIdentity,
} from "../../domain/scm-repository-identity";
import {
  ReviewMutationLaneKind,
  ReviewRunControlDomainError,
  ReviewRunControlErrorCode,
  ScmProvider,
} from "../../domain/review-run-control-types";
import type {
  ScmRepositoryIdentityCommandPort,
  ScmRepositoryIdentityQueryPort,
} from "../../application/ports/scm-repository-identity-ports";
import {
  ScmRepositoryIdentityBindingStatus,
  ScmRepositoryIdentityResolveStatus,
} from "../../application/ports/scm-repository-identity-ports";
import { scmRepositoryIdentityToDomain } from "./prisma-review-run-control-mappers";
import { lockReviewRunControlKey } from "./prisma-review-run-control-utils";

export class PrismaScmRepositoryIdentityRepository
  implements ScmRepositoryIdentityQueryPort, ScmRepositoryIdentityCommandPort
{
  constructor(private readonly prisma: PrismaClient) {}

  async findScmRepositoryIdentityById(
    scmRepositoryIdentityId: string,
  ): Promise<ScmRepositoryIdentity | null> {
    const row = await this.prisma.scmRepositoryIdentity.findUnique({
      where: { scmRepositoryIdentityId },
    });
    return row ? scmRepositoryIdentityToDomain(row) : null;
  }

  async findScmRepositoryIdentityByExternalIdentity(
    identity: ScmRepositoryExternalIdentity,
  ): Promise<ScmRepositoryIdentity | null> {
    const row = await this.prisma.scmRepositoryIdentity.findUnique({
      where: {
        provider_normalizedSourceBaseUrl_externalRepositoryId: {
          provider: scmProviderToPersistence(identity.provider),
          normalizedSourceBaseUrl: identity.normalizedSourceBaseUrl,
          externalRepositoryId: identity.externalRepositoryId,
        },
      },
    });
    return row ? scmRepositoryIdentityToDomain(row) : null;
  }

  async resolveOrRegisterScmRepositoryIdentity(input: {
    readonly identity: ScmRepositoryIdentity;
  }) {
    const externalKey = scmRepositoryExternalIdentityKey(input.identity);
    return this.prisma.$transaction(async (transaction) => {
      await lockReviewRunControlKey(
        transaction,
        "scm-external-identity",
        externalKey,
      );
      const existing = await transaction.scmRepositoryIdentity.findUnique({
        where: {
          provider_normalizedSourceBaseUrl_externalRepositoryId: {
            provider: scmProviderToPersistence(input.identity.provider),
            normalizedSourceBaseUrl: input.identity.normalizedSourceBaseUrl,
            externalRepositoryId: input.identity.externalRepositoryId,
          },
        },
      });
      if (existing) {
        return {
          status: ScmRepositoryIdentityResolveStatus.Restored,
          identity: scmRepositoryIdentityToDomain(existing),
        } as const;
      }
      const idCollision = await transaction.scmRepositoryIdentity.findUnique({
        where: {
          scmRepositoryIdentityId: input.identity.scmRepositoryIdentityId,
        },
      });
      if (idCollision) {
        throw new ReviewRunControlDomainError(
          ReviewRunControlErrorCode.ImmutableConflict,
          "scm_repository_identity_id_conflict",
        );
      }
      const created = await transaction.scmRepositoryIdentity.create({
        data: {
          ...input.identity,
          provider: scmProviderToPersistence(input.identity.provider),
        },
      });
      return {
        status: ScmRepositoryIdentityResolveStatus.Created,
        identity: scmRepositoryIdentityToDomain(created),
      } as const;
    });
  }

  async bindScmRepositoryIdentity(input: {
    readonly scmRepositoryIdentityId: string;
    readonly expectedVersion: number;
    readonly workspaceId: string;
    readonly repositoryConnectionId: string;
    readonly boundAt: Date;
  }) {
    return this.prisma.$transaction(async (transaction) => {
      await lockReviewRunControlKey(
        transaction,
        "scm-identity",
        input.scmRepositoryIdentityId,
      );
      await lockReviewRunControlKey(
        transaction,
        "repository-binding",
        input.repositoryConnectionId,
      );
      const identityRow = await transaction.scmRepositoryIdentity.findUnique({
        where: { scmRepositoryIdentityId: input.scmRepositoryIdentityId },
      });
      if (!identityRow) {
        return { status: ScmRepositoryIdentityBindingStatus.Missing } as const;
      }
      const identity = scmRepositoryIdentityToDomain(identityRow);
      if (
        identity.currentWorkspaceId === input.workspaceId &&
        identity.currentRepositoryConnectionId === input.repositoryConnectionId
      ) {
        const repository = await transaction.repositoryConnection.findUnique({
          where: { id: input.repositoryConnectionId },
          select: { scmRepositoryIdentityId: true },
        });
        if (
          repository?.scmRepositoryIdentityId !== input.scmRepositoryIdentityId
        ) {
          throw new Error("scm_repository_binding_corrupt");
        }
        return {
          status: ScmRepositoryIdentityBindingStatus.Restored,
          identity,
        } as const;
      }
      if (
        identity.version !== input.expectedVersion ||
        identity.currentRepositoryConnectionId !== null ||
        identity.currentWorkspaceId !== null
      ) {
        return { status: ScmRepositoryIdentityBindingStatus.Conflict } as const;
      }
      const repository = await transaction.repositoryConnection.findUnique({
        where: { id: input.repositoryConnectionId },
        select: {
          id: true,
          workspaceId: true,
          provider: true,
          sourceBaseUrl: true,
          externalRepositoryId: true,
          scmRepositoryIdentityId: true,
        },
      });
      if (
        !repository ||
        repository.workspaceId !== input.workspaceId ||
        repository.provider !== scmProviderToPersistence(identity.provider) ||
        normalizeScmSourceBaseUrl(repository.sourceBaseUrl) !==
          identity.normalizedSourceBaseUrl ||
        repository.externalRepositoryId !== identity.externalRepositoryId ||
        (repository.scmRepositoryIdentityId !== null &&
          repository.scmRepositoryIdentityId !== input.scmRepositoryIdentityId)
      ) {
        return { status: ScmRepositoryIdentityBindingStatus.Conflict } as const;
      }
      const owner = await transaction.scmRepositoryIdentity.findFirst({
        where: {
          currentRepositoryConnectionId: input.repositoryConnectionId,
          NOT: { scmRepositoryIdentityId: input.scmRepositoryIdentityId },
        },
        select: { scmRepositoryIdentityId: true },
      });
      if (owner) {
        return { status: ScmRepositoryIdentityBindingStatus.Conflict } as const;
      }
      const bound = bindScmRepositoryIdentity(identity, input);
      const identityWrite = await transaction.scmRepositoryIdentity.updateMany({
        where: {
          scmRepositoryIdentityId: input.scmRepositoryIdentityId,
          version: input.expectedVersion,
          currentWorkspaceId: null,
          currentRepositoryConnectionId: null,
        },
        data: {
          version: bound.version,
          currentWorkspaceId: bound.currentWorkspaceId,
          currentRepositoryConnectionId: bound.currentRepositoryConnectionId,
          boundAt: bound.boundAt,
          unboundAt: null,
        },
      });
      const repositoryWrite = await transaction.repositoryConnection.updateMany(
        {
          where: {
            id: input.repositoryConnectionId,
            workspaceId: input.workspaceId,
            OR: [
              { scmRepositoryIdentityId: null },
              { scmRepositoryIdentityId: input.scmRepositoryIdentityId },
            ],
          },
          data: { scmRepositoryIdentityId: input.scmRepositoryIdentityId },
        },
      );
      if (identityWrite.count !== 1 || repositoryWrite.count !== 1) {
        throw new Error("scm_repository_bind_cas_failed");
      }
      return {
        status: ScmRepositoryIdentityBindingStatus.Bound,
        identity: bound,
      } as const;
    });
  }

  async unbindScmRepositoryIdentity(input: {
    readonly scmRepositoryIdentityId: string;
    readonly expectedVersion: number;
    readonly unboundAt: Date;
    readonly authority: {
      readonly laneKind: ReviewMutationLaneKind;
      readonly expectedVersion: number;
    };
  }) {
    return this.prisma.$transaction(async (transaction) => {
      await lockReviewRunControlKey(
        transaction,
        "scm-identity",
        input.scmRepositoryIdentityId,
      );
      const identityRow = await transaction.scmRepositoryIdentity.findUnique({
        where: { scmRepositoryIdentityId: input.scmRepositoryIdentityId },
      });
      if (!identityRow) {
        return { status: ScmRepositoryIdentityBindingStatus.Missing } as const;
      }
      const identity = scmRepositoryIdentityToDomain(identityRow);
      if (
        identity.currentWorkspaceId === null &&
        identity.currentRepositoryConnectionId === null
      ) {
        return {
          status: ScmRepositoryIdentityBindingStatus.Restored,
          identity,
        } as const;
      }
      await lockReviewRunControlKey(
        transaction,
        "mutation-authority",
        `${input.scmRepositoryIdentityId}:${input.authority.laneKind}`,
      );
      const authority = await transaction.reviewMutationAuthority.findUnique({
        where: {
          scmRepositoryIdentityId_laneKind: {
            scmRepositoryIdentityId: input.scmRepositoryIdentityId,
            laneKind: mutationLaneToPersistence(input.authority.laneKind),
          },
        },
      });
      if (
        !authority ||
        authority.mode !== "paused" ||
        authority.version !== input.authority.expectedVersion
      ) {
        return {
          status: ScmRepositoryIdentityBindingStatus.AuthorityNotPaused,
        } as const;
      }
      if (identity.version !== input.expectedVersion) {
        return { status: ScmRepositoryIdentityBindingStatus.Conflict } as const;
      }
      const repositoryConnectionId = identity.currentRepositoryConnectionId;
      if (!repositoryConnectionId) {
        throw new Error("scm_repository_partial_binding_corrupt");
      }
      await lockReviewRunControlKey(
        transaction,
        "repository-binding",
        repositoryConnectionId,
      );
      const unbound = unbindScmRepositoryIdentity(identity, input);
      const identityWrite = await transaction.scmRepositoryIdentity.updateMany({
        where: {
          scmRepositoryIdentityId: input.scmRepositoryIdentityId,
          version: input.expectedVersion,
          currentWorkspaceId: identity.currentWorkspaceId,
          currentRepositoryConnectionId: repositoryConnectionId,
        },
        data: {
          version: unbound.version,
          currentWorkspaceId: null,
          currentRepositoryConnectionId: null,
          boundAt: null,
          unboundAt: unbound.unboundAt,
        },
      });
      const repositoryWrite = await transaction.repositoryConnection.updateMany(
        {
          where: {
            id: repositoryConnectionId,
            scmRepositoryIdentityId: input.scmRepositoryIdentityId,
          },
          data: { scmRepositoryIdentityId: null },
        },
      );
      if (identityWrite.count !== 1 || repositoryWrite.count !== 1) {
        throw new Error("scm_repository_unbind_cas_failed");
      }
      return {
        status: ScmRepositoryIdentityBindingStatus.Unbound,
        identity: unbound,
      } as const;
    });
  }
}

function mutationLaneToPersistence(
  laneKind: ReviewMutationLaneKind,
): "hosted_reviewrouter_app" {
  switch (laneKind) {
    case ReviewMutationLaneKind.HostedReviewRouterApp:
      return "hosted_reviewrouter_app";
  }
}

function scmProviderToPersistence(provider: ScmProvider): "github" | "gitlab" {
  switch (provider) {
    case ScmProvider.GitHub:
      return "github";
    case ScmProvider.GitLab:
      return "gitlab";
  }
}
