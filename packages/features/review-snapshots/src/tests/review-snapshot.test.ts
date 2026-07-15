import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { ReviewSnapshotRepositoryPort } from "../application/ports/review-snapshot-repository-port";
import { commitReviewSnapshot } from "../application/use-cases/commit-review-snapshot";
import { restoreReviewSnapshot } from "../application/use-cases/restore-review-snapshot";
import { pruneExpiredReviewSnapshots } from "../application/use-cases/prune-expired-review-snapshots";
import {
  ReviewSnapshotRestoreStatus,
  ReviewSnapshotSeverity,
  prepareReviewSnapshotRecord,
  reviewSnapshotSchemaVersion,
  type ReviewSnapshotCandidate,
  type ReviewSnapshotRecord,
} from "../domain/review-snapshot";
import { PrismaReviewSnapshotRepository } from "../infrastructure/prisma/prisma-review-snapshot-repository";

const now = new Date("2026-07-16T00:00:00.000Z");
const repositoryId = "repo_1";
const pullRequestNumber = 240;
const baseSha = "b".repeat(40);
const headSha = "a".repeat(40);

describe("review snapshot", () => {
  it("restores a compatible, unexpired snapshot", async () => {
    const snapshots = new InMemoryReviewSnapshotRepository(
      prepareReviewSnapshotRecord(candidate(), { now, version: 3 }),
    );

    const restored = await restoreReviewSnapshot(
      { workspaceId: "workspace_1", repositoryId, pullRequestNumber, baseSha },
      { snapshots, now: new Date(now.getTime() + 1_000) },
    );

    expect(restored).toMatchObject({
      status: ReviewSnapshotRestoreStatus.Found,
      expectedVersion: 3,
      snapshot: { reviewedHeadSha: headSha, baseSha },
    });
  });

  it("returns replacement versions for expired and base-changed snapshots", async () => {
    const expired = prepareReviewSnapshotRecord(candidate(), {
      now: new Date("2026-07-01T00:00:00.000Z"),
      version: 4,
    });
    const snapshots = new InMemoryReviewSnapshotRepository(expired);

    await expect(
      restoreReviewSnapshot(
        {
          workspaceId: "workspace_1",
          repositoryId,
          pullRequestNumber,
          baseSha,
        },
        { snapshots, now },
      ),
    ).resolves.toEqual({
      status: ReviewSnapshotRestoreStatus.Expired,
      expectedVersion: 4,
    });

    snapshots.record = prepareReviewSnapshotRecord(candidate(), {
      now,
      version: 5,
    });
    await expect(
      restoreReviewSnapshot(
        {
          repositoryId,
          workspaceId: "workspace_1",
          pullRequestNumber,
          baseSha: "c".repeat(40),
        },
        { snapshots, now },
      ),
    ).resolves.toEqual({
      status: ReviewSnapshotRestoreStatus.BaseChanged,
      expectedVersion: 5,
    });
  });

  it("does not restore a snapshot owned by another workspace", async () => {
    const snapshots = new InMemoryReviewSnapshotRepository(
      prepareReviewSnapshotRecord(candidate(), { now, version: 3 }),
    );

    await expect(
      restoreReviewSnapshot(
        {
          workspaceId: "workspace_2",
          repositoryId,
          pullRequestNumber,
          baseSha,
        },
        { snapshots, now },
      ),
    ).resolves.toEqual({
      status: ReviewSnapshotRestoreStatus.Missing,
      expectedVersion: 0,
    });
  });

  it("commits with compare-and-swap and treats identical retries as idempotent", async () => {
    const snapshots = new InMemoryReviewSnapshotRepository();
    const input = { expectedVersion: 0, candidate: candidate() };

    await expect(
      commitReviewSnapshot(input, { snapshots, now }),
    ).resolves.toMatchObject({ status: "committed", snapshot: { version: 1 } });
    await expect(
      commitReviewSnapshot(input, { snapshots, now }),
    ).resolves.toMatchObject({
      status: "idempotent",
      snapshot: { version: 1 },
    });

    await expect(
      commitReviewSnapshot(
        {
          expectedVersion: 0,
          candidate: { ...candidate(), reviewedHeadSha: "d".repeat(40) },
        },
        { snapshots, now },
      ),
    ).resolves.toEqual({
      status: "conflict",
      currentVersion: 1,
      currentHeadSha: headSha,
    });
  });

  it("rejects malformed or oversized durable payloads", async () => {
    const snapshots = new InMemoryReviewSnapshotRepository();
    await expect(
      commitReviewSnapshot(
        {
          expectedVersion: 0,
          candidate: {
            ...candidate(),
            payload: {
              reviewSummary: "summary",
              findings: [
                {
                  file: "src/index.ts",
                  line: 0,
                  severity: ReviewSnapshotSeverity.Major,
                  title: "Invalid line",
                  message: "Line zero is not valid",
                },
              ],
            },
          },
        },
        { snapshots, now },
      ),
    ).rejects.toThrow("review_snapshot_finding_line_invalid");
  });

  it("redacts secrets before hashing and persisting review prose", async () => {
    const snapshots = new InMemoryReviewSnapshotRepository();
    await commitReviewSnapshot(
      {
        expectedVersion: 0,
        candidate: {
          ...candidate(),
          payload: {
            reviewSummary: `Token sk-${"a".repeat(32)}`,
            findings: [
              {
                file: "src/index.ts",
                line: 12,
                severity: ReviewSnapshotSeverity.Major,
                title: `Leaked github_pat_${"b".repeat(32)}`,
                message: `refresh_token=${"c".repeat(32)}`,
              },
            ],
          },
        },
      },
      { snapshots, now },
    );

    expect(JSON.stringify(snapshots.record?.payload)).toBe(
      JSON.stringify({
        reviewSummary: "Token sk-***",
        findings: [
          {
            file: "src/index.ts",
            line: 12,
            severity: ReviewSnapshotSeverity.Major,
            title: "Leaked github_pat_***",
            message: "refresh_token=***",
          },
        ],
      }),
    );
  });

  it("keeps provider-neutral informational findings", () => {
    const record = prepareReviewSnapshotRecord(
      {
        ...candidate(),
        payload: {
          reviewSummary: "Informational review",
          findings: [
            {
              file: "src/index.ts",
              line: 12,
              severity: ReviewSnapshotSeverity.Info,
              title: "Optional cleanup",
              message: "This does not block publication.",
            },
          ],
        },
      },
      { now, version: 1 },
    );

    expect(record.payload.findings[0]?.severity).toBe(
      ReviewSnapshotSeverity.Info,
    );
  });

  it("prunes expired snapshots through a bounded maintenance use case", async () => {
    const snapshots = new InMemoryReviewSnapshotRepository(
      prepareReviewSnapshotRecord(candidate(), {
        now: new Date("2026-07-01T00:00:00.000Z"),
        version: 1,
      }),
    );

    await expect(
      pruneExpiredReviewSnapshots(
        { expiredBefore: now, limit: 100 },
        { snapshots },
      ),
    ).resolves.toEqual({ deleted: 1 });
    expect(snapshots.record).toBeNull();
    await expect(
      pruneExpiredReviewSnapshots(
        { expiredBefore: now, limit: 0 },
        { snapshots },
      ),
    ).rejects.toThrow("review_snapshot_prune_limit_invalid");
  });

  it("uses the workspace-scoped Prisma identity", async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const repository = new PrismaReviewSnapshotRepository({
      reviewSnapshot: { findUnique },
    } as unknown as PrismaClient);

    await repository.find({
      workspaceId: "workspace_2",
      repositoryId,
      pullRequestNumber,
    });

    expect(findUnique).toHaveBeenCalledWith({
      where: {
        workspaceId_repositoryId_pullRequestNumber: {
          workspaceId: "workspace_2",
          repositoryId,
          pullRequestNumber,
        },
      },
    });
  });

  it("recreates a snapshot if bounded pruning deletes it during CAS", async () => {
    const current = prepareReviewSnapshotRecord(candidate(), {
      now,
      version: 4,
    });
    const replacement = prepareReviewSnapshotRecord(
      { ...candidate(), reviewedHeadSha: "d".repeat(40) },
      { now: new Date(now.getTime() + 1_000), version: 5 },
    );
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce(toPrismaSnapshot(current))
      .mockResolvedValueOnce(null);
    const create = vi.fn().mockResolvedValue(toPrismaSnapshot(replacement));
    const repository = new PrismaReviewSnapshotRepository({
      reviewSnapshot: {
        findUnique,
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        create,
      },
    } as unknown as PrismaClient);

    await expect(
      repository.commit({ expectedVersion: 4, record: replacement }),
    ).resolves.toMatchObject({
      status: "committed",
      snapshot: { version: 5, reviewedHeadSha: "d".repeat(40) },
    });
    expect(create).toHaveBeenCalledOnce();
  });
});

function candidate(): ReviewSnapshotCandidate {
  return {
    workspaceId: "workspace_1",
    repositoryId,
    pullRequestNumber,
    schemaVersion: reviewSnapshotSchemaVersion,
    reviewedHeadSha: headSha,
    baseSha,
    compatibilityKey: "f".repeat(64),
    sourceRunId: "run_100",
    sourceRunAttempt: "1",
    payload: {
      reviewSummary: "Review complete",
      findings: [
        {
          file: "src/index.ts",
          line: 12,
          severity: ReviewSnapshotSeverity.Major,
          title: "State is not persisted",
          message: "Persist the state before returning.",
          confidence: 0.9,
        },
      ],
    },
  };
}

function toPrismaSnapshot(record: ReviewSnapshotRecord) {
  return {
    id: "snapshot_1",
    ...record,
    createdAt: record.reviewedAt,
    updatedAt: record.reviewedAt,
  };
}

class InMemoryReviewSnapshotRepository implements ReviewSnapshotRepositoryPort {
  constructor(public record: ReviewSnapshotRecord | null = null) {}

  async find(input: {
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly pullRequestNumber: number;
  }): Promise<ReviewSnapshotRecord | null> {
    if (
      this.record?.workspaceId !== input.workspaceId ||
      this.record.repositoryId !== input.repositoryId ||
      this.record.pullRequestNumber !== input.pullRequestNumber
    ) {
      return null;
    }
    return this.record;
  }

  async commit(input: {
    readonly expectedVersion: number;
    readonly record: ReviewSnapshotRecord;
  }) {
    if (
      this.record &&
      this.record.reviewedHeadSha === input.record.reviewedHeadSha &&
      this.record.compatibilityKey === input.record.compatibilityKey &&
      this.record.payloadHash === input.record.payloadHash
    ) {
      return { status: "idempotent" as const, snapshot: this.record };
    }
    if ((this.record?.version ?? 0) !== input.expectedVersion) {
      return {
        status: "conflict" as const,
        currentVersion: this.record?.version ?? 0,
        currentHeadSha:
          this.record?.reviewedHeadSha ?? input.record.reviewedHeadSha,
      };
    }
    this.record = input.record;
    return { status: "committed" as const, snapshot: input.record };
  }

  async pruneExpired(input: {
    readonly expiredBefore: Date;
    readonly limit: number;
  }): Promise<number> {
    if (
      input.limit > 0 &&
      this.record &&
      this.record.expiresAt <= input.expiredBefore
    ) {
      this.record = null;
      return 1;
    }
    return 0;
  }
}
