import { Prisma, type PrismaClient } from "@prisma/client";
import type { ReviewSnapshotRepositoryPort } from "../../application/ports/review-snapshot-repository-port";
import {
  decodeReviewSnapshotPayload,
  type ReviewSnapshotPayload,
  type ReviewSnapshotRecord,
} from "../../domain/review-snapshot";

export class PrismaReviewSnapshotRepository implements ReviewSnapshotRepositoryPort {
  constructor(private readonly prisma: PrismaClient) {}

  async find(input: {
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly pullRequestNumber: number;
  }): Promise<ReviewSnapshotRecord | null> {
    const record = await this.prisma.reviewSnapshot.findUnique({
      where: {
        workspaceId_repositoryId_pullRequestNumber: {
          workspaceId: input.workspaceId,
          repositoryId: input.repositoryId,
          pullRequestNumber: input.pullRequestNumber,
        },
      },
    });
    return record ? toDomain(record) : null;
  }

  async commit(input: {
    readonly expectedVersion: number;
    readonly record: ReviewSnapshotRecord;
  }): Promise<
    | {
        readonly status: "committed" | "idempotent";
        readonly snapshot: ReviewSnapshotRecord;
      }
    | {
        readonly status: "conflict";
        readonly currentVersion: number;
        readonly currentHeadSha: string;
      }
  > {
    const current = await this.find({
      workspaceId: input.record.workspaceId,
      repositoryId: input.record.repositoryId,
      pullRequestNumber: input.record.pullRequestNumber,
    });
    if (current && isIdempotent(current, input.record)) {
      return { status: "idempotent", snapshot: current };
    }
    if (!current) {
      try {
        const created = await this.prisma.reviewSnapshot.create({
          data: toCreateInput(input.record),
        });
        return { status: "committed", snapshot: toDomainOrThrow(created) };
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
        return this.conflictAfterRace(input.record);
      }
    }
    if (current.version !== input.expectedVersion) {
      return {
        status: "conflict",
        currentVersion: current.version,
        currentHeadSha: current.reviewedHeadSha,
      };
    }

    const updated = await this.prisma.reviewSnapshot.updateMany({
      where: {
        workspaceId: input.record.workspaceId,
        repositoryId: input.record.repositoryId,
        pullRequestNumber: input.record.pullRequestNumber,
        version: input.expectedVersion,
      },
      data: toUpdateInput(input.record),
    });
    if (updated.count !== 1) {
      return this.resolveAfterWriteRace(input.record, true);
    }
    const committed = await this.find({
      workspaceId: input.record.workspaceId,
      repositoryId: input.record.repositoryId,
      pullRequestNumber: input.record.pullRequestNumber,
    });
    if (!committed)
      throw new Error("review_snapshot_commit_missing_after_update");
    return { status: "committed", snapshot: committed };
  }

  async pruneExpired(input: {
    readonly expiredBefore: Date;
    readonly limit: number;
  }): Promise<number> {
    const expired = await this.prisma.reviewSnapshot.findMany({
      where: { expiresAt: { lte: input.expiredBefore } },
      orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
      take: input.limit,
      select: { id: true },
    });
    if (expired.length === 0) return 0;
    const deleted = await this.prisma.reviewSnapshot.deleteMany({
      where: {
        id: { in: expired.map((record) => record.id) },
        expiresAt: { lte: input.expiredBefore },
      },
    });
    return deleted.count;
  }

  private async conflictAfterRace(
    record: ReviewSnapshotRecord,
  ): Promise<ReviewSnapshotCommitResult> {
    return this.resolveAfterWriteRace(record, false);
  }

  private async resolveAfterWriteRace(
    record: ReviewSnapshotRecord,
    allowCreateIfMissing: boolean,
  ): Promise<ReviewSnapshotCommitResult> {
    const current = await this.find({
      workspaceId: record.workspaceId,
      repositoryId: record.repositoryId,
      pullRequestNumber: record.pullRequestNumber,
    });
    if (!current && allowCreateIfMissing) {
      try {
        const created = await this.prisma.reviewSnapshot.create({
          data: toCreateInput(record),
        });
        return {
          status: "committed" as const,
          snapshot: toDomainOrThrow(created),
        };
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
        return this.resolveAfterWriteRace(record, false);
      }
    }
    if (!current) throw new Error("review_snapshot_commit_race_missing");
    if (isIdempotent(current, record)) {
      return { status: "idempotent" as const, snapshot: current };
    }
    return {
      status: "conflict" as const,
      currentVersion: current.version,
      currentHeadSha: current.reviewedHeadSha,
    };
  }
}

type ReviewSnapshotCommitResult = Awaited<
  ReturnType<ReviewSnapshotRepositoryPort["commit"]>
>;

type PrismaReviewSnapshot = Awaited<
  ReturnType<PrismaClient["reviewSnapshot"]["findUnique"]>
>;

function toDomain(
  record: NonNullable<PrismaReviewSnapshot>,
): ReviewSnapshotRecord | null {
  const payload = decodeReviewSnapshotPayload(record.payload);
  return payload ? mapToDomain(record, payload) : null;
}

function toDomainOrThrow(
  record: NonNullable<PrismaReviewSnapshot>,
): ReviewSnapshotRecord {
  return mapToDomain(record, requireReviewSnapshotPayload(record.payload));
}

function mapToDomain(
  record: NonNullable<PrismaReviewSnapshot>,
  payload: ReviewSnapshotPayload,
): ReviewSnapshotRecord {
  return {
    workspaceId: record.workspaceId,
    repositoryId: record.repositoryId,
    pullRequestNumber: record.pullRequestNumber,
    version: record.version,
    schemaVersion: record.schemaVersion,
    reviewedHeadSha: record.reviewedHeadSha,
    baseSha: record.baseSha,
    compatibilityKey: record.compatibilityKey,
    payload,
    payloadHash: record.payloadHash,
    sourceRunId: record.sourceRunId,
    sourceRunAttempt: record.sourceRunAttempt,
    reviewedAt: record.reviewedAt,
    expiresAt: record.expiresAt,
  };
}

function toCreateInput(
  record: ReviewSnapshotRecord,
): Prisma.ReviewSnapshotUncheckedCreateInput {
  return {
    workspaceId: record.workspaceId,
    repositoryId: record.repositoryId,
    pullRequestNumber: record.pullRequestNumber,
    version: record.version,
    schemaVersion: record.schemaVersion,
    reviewedHeadSha: record.reviewedHeadSha,
    baseSha: record.baseSha,
    compatibilityKey: record.compatibilityKey,
    payload: toPrismaPayload(record.payload),
    payloadHash: record.payloadHash,
    sourceRunId: record.sourceRunId,
    sourceRunAttempt: record.sourceRunAttempt,
    reviewedAt: record.reviewedAt,
    expiresAt: record.expiresAt,
  };
}

function toUpdateInput(
  record: ReviewSnapshotRecord,
): Prisma.ReviewSnapshotUpdateManyMutationInput {
  return {
    version: record.version,
    schemaVersion: record.schemaVersion,
    reviewedHeadSha: record.reviewedHeadSha,
    baseSha: record.baseSha,
    compatibilityKey: record.compatibilityKey,
    payload: toPrismaPayload(record.payload),
    payloadHash: record.payloadHash,
    sourceRunId: record.sourceRunId,
    sourceRunAttempt: record.sourceRunAttempt,
    reviewedAt: record.reviewedAt,
    expiresAt: record.expiresAt,
  };
}

function requireReviewSnapshotPayload(payload: unknown): ReviewSnapshotPayload {
  const decoded = decodeReviewSnapshotPayload(payload);
  if (!decoded) throw new Error("review_snapshot_payload_invalid");
  return decoded;
}

function toPrismaPayload(payload: unknown): Prisma.InputJsonValue {
  return requireReviewSnapshotPayload(payload) as Prisma.InputJsonValue;
}

function isIdempotent(
  current: ReviewSnapshotRecord,
  candidate: ReviewSnapshotRecord,
): boolean {
  return (
    current.reviewedHeadSha === candidate.reviewedHeadSha &&
    current.baseSha === candidate.baseSha &&
    current.compatibilityKey === candidate.compatibilityKey &&
    current.payloadHash === candidate.payloadHash
  );
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}
