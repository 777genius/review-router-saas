import type { PrismaClient } from "@prisma/client";
import {
  cloneReviewMutationAuthority,
  type ReviewMutationAuthority,
} from "../../domain/review-mutation-authority";
import {
  ReviewMutationLaneKind,
  ReviewMutationMode,
  canonicalJson,
} from "../../domain/review-run-control-types";
import type {
  ReviewMutationAuthorityCommandPort,
  ReviewMutationAuthorityQueryPort,
} from "../../application/ports/review-mutation-authority-ports";
import { ReviewMutationAuthorityWriteStatus } from "../../application/ports/review-mutation-authority-ports";
import { reviewMutationAuthorityToDomain } from "./prisma-review-run-control-mappers";
import { lockReviewRunControlKey } from "./prisma-review-run-control-utils";

export class PrismaReviewMutationAuthorityRepository
  implements
    ReviewMutationAuthorityQueryPort,
    ReviewMutationAuthorityCommandPort
{
  constructor(private readonly prisma: PrismaClient) {}

  async findReviewMutationAuthority(input: {
    readonly scmRepositoryIdentityId: string;
    readonly laneKind: ReviewMutationLaneKind;
  }): Promise<ReviewMutationAuthority | null> {
    const row = await this.prisma.reviewMutationAuthority.findUnique({
      where: {
        scmRepositoryIdentityId_laneKind: {
          scmRepositoryIdentityId: input.scmRepositoryIdentityId,
          laneKind: laneKindToPersistence(input.laneKind),
        },
      },
    });
    return row ? reviewMutationAuthorityToDomain(row) : null;
  }

  async initializeReviewMutationAuthority(authority: ReviewMutationAuthority) {
    const key = authorityKey(authority);
    return this.prisma.$transaction(async (transaction) => {
      await lockReviewRunControlKey(transaction, "mutation-authority", key);
      const existingRow = await transaction.reviewMutationAuthority.findUnique({
        where: {
          scmRepositoryIdentityId_laneKind: {
            scmRepositoryIdentityId: authority.scmRepositoryIdentityId,
            laneKind: laneKindToPersistence(authority.laneKind),
          },
        },
      });
      if (existingRow) {
        const existing = reviewMutationAuthorityToDomain(existingRow);
        const compatible =
          existing.mode === authority.mode &&
          existing.epoch === authority.epoch &&
          existing.managedWorkflowInventoryHash ===
            authority.managedWorkflowInventoryHash &&
          existing.activationSafetyDecisionHash ===
            authority.activationSafetyDecisionHash;
        return {
          status: compatible
            ? ReviewMutationAuthorityWriteStatus.Restored
            : ReviewMutationAuthorityWriteStatus.Conflict,
          authority: existing,
        } as const;
      }
      const created = await transaction.reviewMutationAuthority.create({
        data: authorityCreateData(authority),
      });
      return {
        status: ReviewMutationAuthorityWriteStatus.Created,
        authority: reviewMutationAuthorityToDomain(created),
      } as const;
    });
  }

  async compareAndSetReviewMutationAuthority(input: {
    readonly expectedVersion: number;
    readonly authority: ReviewMutationAuthority;
  }) {
    const key = authorityKey(input.authority);
    return this.prisma.$transaction(async (transaction) => {
      await lockReviewRunControlKey(transaction, "mutation-authority", key);
      const currentRow = await transaction.reviewMutationAuthority.findUnique({
        where: {
          scmRepositoryIdentityId_laneKind: {
            scmRepositoryIdentityId: input.authority.scmRepositoryIdentityId,
            laneKind: laneKindToPersistence(input.authority.laneKind),
          },
        },
      });
      if (!currentRow) {
        return { status: ReviewMutationAuthorityWriteStatus.Missing } as const;
      }
      const current = reviewMutationAuthorityToDomain(currentRow);
      if (
        current.version === input.authority.version &&
        canonicalJson(current) === canonicalJson(input.authority)
      ) {
        return {
          status: ReviewMutationAuthorityWriteStatus.Restored,
          authority: cloneReviewMutationAuthority(current),
        } as const;
      }
      if (
        current.version !== input.expectedVersion ||
        input.authority.version !== input.expectedVersion + 1
      ) {
        return { status: ReviewMutationAuthorityWriteStatus.Conflict } as const;
      }
      const updated = await transaction.reviewMutationAuthority.updateMany({
        where: {
          scmRepositoryIdentityId: input.authority.scmRepositoryIdentityId,
          laneKind: laneKindToPersistence(input.authority.laneKind),
          version: input.expectedVersion,
        },
        data: authorityUpdateData(input.authority),
      });
      if (updated.count !== 1) {
        return { status: ReviewMutationAuthorityWriteStatus.Conflict } as const;
      }
      return {
        status: ReviewMutationAuthorityWriteStatus.Updated,
        authority: cloneReviewMutationAuthority(input.authority),
      } as const;
    });
  }
}

function authorityKey(
  authority: Pick<
    ReviewMutationAuthority,
    "scmRepositoryIdentityId" | "laneKind"
  >,
): string {
  return `${authority.scmRepositoryIdentityId}:${authority.laneKind}`;
}

function authorityCreateData(authority: ReviewMutationAuthority) {
  return {
    ...authorityUpdateData(authority),
    scmRepositoryIdentityId: authority.scmRepositoryIdentityId,
    laneKind: laneKindToPersistence(authority.laneKind),
  };
}

function authorityUpdateData(authority: ReviewMutationAuthority) {
  return {
    version: authority.version,
    epoch: authority.epoch,
    mode: mutationModeToPersistence(authority.mode),
    drainPolicyVersion: authority.drainPolicyVersion,
    drainStartedAt: authority.drainStartedAt,
    v1AdmissionClosedAt: authority.v1AdmissionClosedAt,
    drainNotBefore: authority.drainNotBefore,
    managedWorkflowInventoryHash: authority.managedWorkflowInventoryHash,
    activationSafetyDecisionHash: authority.activationSafetyDecisionHash,
    initializedAt: authority.initializedAt,
    activatedAt: authority.activatedAt,
    pausedAt: authority.pausedAt,
  };
}

function laneKindToPersistence(
  laneKind: ReviewMutationLaneKind,
): "hosted_reviewrouter_app" {
  switch (laneKind) {
    case ReviewMutationLaneKind.HostedReviewRouterApp:
      return "hosted_reviewrouter_app";
  }
}

function mutationModeToPersistence(
  mode: ReviewMutationMode,
): "v1_open" | "v1_draining" | "v2_active" | "paused" {
  switch (mode) {
    case ReviewMutationMode.V1Open:
      return "v1_open";
    case ReviewMutationMode.V1Draining:
      return "v1_draining";
    case ReviewMutationMode.V2Active:
      return "v2_active";
    case ReviewMutationMode.Paused:
      return "paused";
  }
}
