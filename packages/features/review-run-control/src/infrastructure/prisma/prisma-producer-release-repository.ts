import type { PrismaClient } from "@prisma/client";
import type {
  ProducerRelease,
  ReviewOperationalSloProfileV2,
  ReviewProtocolLimitsV2,
} from "../../domain/producer-release";
import {
  producerReleaseImmutableKey,
  revokeProducerRelease,
} from "../../domain/producer-release";
import {
  ProducerDistributionKind,
  ProducerReleaseState,
  canonicalJson,
} from "../../domain/review-run-control-types";
import type {
  ProducerReleaseCommandPort,
  ProducerReleaseQueryPort,
  ReviewOperationalSloProfileCommandPort,
  ReviewOperationalSloProfileQueryPort,
  ReviewProtocolLimitsProfileCommandPort,
  ReviewProtocolLimitsProfileQueryPort,
} from "../../application/ports/producer-release-ports";
import {
  ImmutableRegistryWriteStatus,
  ProducerReleaseRevocationStatus,
  type ImmutableRegistryWriteResult,
} from "../../application/ports/producer-release-ports";
import {
  operationalSloToDomain,
  producerReleaseToDomain,
  protocolLimitsToDomain,
} from "./prisma-review-run-control-mappers";
import { lockReviewRunControlKeys } from "./prisma-review-run-control-utils";

export class PrismaProducerReleaseRepository
  implements
    ReviewProtocolLimitsProfileQueryPort,
    ReviewProtocolLimitsProfileCommandPort,
    ReviewOperationalSloProfileQueryPort,
    ReviewOperationalSloProfileCommandPort,
    ProducerReleaseQueryPort,
    ProducerReleaseCommandPort
{
  constructor(private readonly prisma: PrismaClient) {}

  async findProtocolLimitsProfileById(
    protocolLimitsProfileId: string,
  ): Promise<ReviewProtocolLimitsV2 | null> {
    const row = await this.prisma.reviewProtocolLimitsV2.findUnique({
      where: { protocolLimitsProfileId },
    });
    return row ? protocolLimitsToDomain(row) : null;
  }

  async registerProtocolLimitsProfile(
    profile: ReviewProtocolLimitsV2,
  ): Promise<ImmutableRegistryWriteResult<ReviewProtocolLimitsV2>> {
    return this.prisma.$transaction(async (transaction) => {
      await lockReviewRunControlKeys(transaction, "review-limits", [
        `id:${profile.protocolLimitsProfileId}`,
        `digest:${profile.limitsDigest}`,
      ]);
      const [existingById, existingByDigest] = await Promise.all([
        transaction.reviewProtocolLimitsV2.findUnique({
          where: { protocolLimitsProfileId: profile.protocolLimitsProfileId },
        }),
        transaction.reviewProtocolLimitsV2.findUnique({
          where: { limitsDigest: profile.limitsDigest },
        }),
      ]);
      if (existingById) {
        const existing = protocolLimitsToDomain(existingById);
        return limitsComparable(existing) === limitsComparable(profile)
          ? {
              status: ImmutableRegistryWriteStatus.Restored,
              value: existing,
            }
          : {
              status: ImmutableRegistryWriteStatus.Conflict,
              existingId: existing.protocolLimitsProfileId,
            };
      }
      if (existingByDigest) {
        return {
          status: ImmutableRegistryWriteStatus.Conflict,
          existingId: existingByDigest.protocolLimitsProfileId,
        };
      }
      const created = await transaction.reviewProtocolLimitsV2.create({
        data: profile,
      });
      return {
        status: ImmutableRegistryWriteStatus.Created,
        value: protocolLimitsToDomain(created),
      };
    });
  }

  async findOperationalSloProfileById(
    operationalSloProfileId: string,
  ): Promise<ReviewOperationalSloProfileV2 | null> {
    const row = await this.prisma.reviewOperationalSloProfileV2.findUnique({
      where: { operationalSloProfileId },
    });
    return row ? operationalSloToDomain(row) : null;
  }

  async registerOperationalSloProfile(
    profile: ReviewOperationalSloProfileV2,
  ): Promise<ImmutableRegistryWriteResult<ReviewOperationalSloProfileV2>> {
    return this.prisma.$transaction(async (transaction) => {
      await lockReviewRunControlKeys(transaction, "review-slo", [
        `id:${profile.operationalSloProfileId}`,
        `digest:${profile.sloDigest}`,
      ]);
      const [existingById, existingByDigest] = await Promise.all([
        transaction.reviewOperationalSloProfileV2.findUnique({
          where: {
            operationalSloProfileId: profile.operationalSloProfileId,
          },
        }),
        transaction.reviewOperationalSloProfileV2.findUnique({
          where: { sloDigest: profile.sloDigest },
        }),
      ]);
      if (existingById) {
        const existing = operationalSloToDomain(existingById);
        return sloComparable(existing) === sloComparable(profile)
          ? {
              status: ImmutableRegistryWriteStatus.Restored,
              value: existing,
            }
          : {
              status: ImmutableRegistryWriteStatus.Conflict,
              existingId: existing.operationalSloProfileId,
            };
      }
      if (existingByDigest) {
        return {
          status: ImmutableRegistryWriteStatus.Conflict,
          existingId: existingByDigest.operationalSloProfileId,
        };
      }
      const created = await transaction.reviewOperationalSloProfileV2.create({
        data: {
          ...profile,
          ownerRefs: [...profile.ownerRefs],
          runbookRefs: [...profile.runbookRefs],
        },
      });
      return {
        status: ImmutableRegistryWriteStatus.Created,
        value: operationalSloToDomain(created),
      };
    });
  }

  async findProducerReleaseById(
    producerReleaseId: string,
  ): Promise<ProducerRelease | null> {
    const row = await this.prisma.producerRelease.findUnique({
      where: { producerReleaseId },
    });
    return row ? producerReleaseToDomain(row) : null;
  }

  async registerProducerRelease(
    release: ProducerRelease,
  ): Promise<ImmutableRegistryWriteResult<ProducerRelease>> {
    const tuple = producerReleaseImmutableKey(release);
    return this.prisma.$transaction(async (transaction) => {
      await lockReviewRunControlKeys(transaction, "producer-release", [
        `id:${release.producerReleaseId}`,
        `tuple:${tuple}`,
      ]);
      const existingById = await transaction.producerRelease.findUnique({
        where: { producerReleaseId: release.producerReleaseId },
      });
      if (existingById) {
        const existing = producerReleaseToDomain(existingById);
        return producerReleaseImmutableKey(existing) === tuple
          ? {
              status: ImmutableRegistryWriteStatus.Restored,
              value: existing,
            }
          : {
              status: ImmutableRegistryWriteStatus.Conflict,
              existingId: existing.producerReleaseId,
            };
      }
      const tupleOwner = await transaction.producerRelease.findFirst({
        where: producerReleaseTupleWhere(release),
      });
      if (tupleOwner) {
        return {
          status: ImmutableRegistryWriteStatus.Conflict,
          existingId: tupleOwner.producerReleaseId,
        };
      }
      const created = await transaction.producerRelease.create({
        data: {
          ...release,
          distributionKind: distributionKindToPersistence(
            release.distributionKind,
          ),
          state: producerStateToPersistence(release.state),
        },
      });
      return {
        status: ImmutableRegistryWriteStatus.Created,
        value: producerReleaseToDomain(created),
      };
    });
  }

  async revokeProducerRelease(input: {
    readonly producerReleaseId: string;
    readonly revokedAt: Date;
  }) {
    return this.prisma.$transaction(async (transaction) => {
      await lockReviewRunControlKeys(transaction, "producer-release", [
        `id:${input.producerReleaseId}`,
      ]);
      const row = await transaction.producerRelease.findUnique({
        where: { producerReleaseId: input.producerReleaseId },
      });
      if (!row) {
        return { status: ProducerReleaseRevocationStatus.Missing } as const;
      }
      const current = producerReleaseToDomain(row);
      if (current.state === ProducerReleaseState.Revoked) {
        return {
          status: ProducerReleaseRevocationStatus.Restored,
          release: current,
        } as const;
      }
      const revoked = revokeProducerRelease(current, input.revokedAt);
      const updated = await transaction.producerRelease.updateMany({
        where: {
          producerReleaseId: revoked.producerReleaseId,
          state: "registered",
        },
        data: { state: "revoked", revokedAt: revoked.revokedAt },
      });
      if (updated.count !== 1) {
        throw new Error("producer_release_revocation_cas_failed");
      }
      return {
        status: ProducerReleaseRevocationStatus.Revoked,
        release: revoked,
      } as const;
    });
  }
}

function limitsComparable(profile: ReviewProtocolLimitsV2): string {
  return canonicalJson(
    Object.fromEntries(
      Object.entries(profile).filter(([key]) => key !== "registeredAt"),
    ),
  );
}

function sloComparable(profile: ReviewOperationalSloProfileV2): string {
  return canonicalJson(
    Object.fromEntries(
      Object.entries(profile).filter(([key]) => key !== "registeredAt"),
    ),
  );
}

function producerReleaseTupleWhere(release: ProducerRelease) {
  return {
    distributionKind: distributionKindToPersistence(release.distributionKind),
    actionCommitSha: release.actionCommitSha,
    runtimeCommitSha: release.runtimeCommitSha,
    wrapperEntrypointDigest: release.wrapperEntrypointDigest,
    runtimeEntrypointDigest: release.runtimeEntrypointDigest,
    contextGatewayPolicyVersion: release.contextGatewayPolicyVersion,
    contextGatewayEntrypointDigest: release.contextGatewayEntrypointDigest,
    schemaDigest: release.schemaDigest,
    capabilityProfile: release.capabilityProfile,
    protocolLimitsProfileId: release.protocolLimitsProfileId,
    operationalSloProfileId: release.operationalSloProfileId,
  } as const;
}

function distributionKindToPersistence(
  value: ProducerDistributionKind,
): "hosted_composite" | "public_reusable" {
  switch (value) {
    case ProducerDistributionKind.HostedComposite:
      return "hosted_composite";
    case ProducerDistributionKind.PublicReusable:
      return "public_reusable";
  }
}

function producerStateToPersistence(
  value: ProducerReleaseState,
): "registered" | "revoked" {
  switch (value) {
    case ProducerReleaseState.Registered:
      return "registered";
    case ProducerReleaseState.Revoked:
      return "revoked";
  }
}
