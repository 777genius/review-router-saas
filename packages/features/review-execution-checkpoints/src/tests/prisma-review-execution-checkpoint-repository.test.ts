import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  ReviewExecutionBatchCommitStatus,
  ReviewExecutionCheckpointClearStatus,
  ReviewExecutionCheckpointFinalizeStatus,
  ReviewExecutionCheckpointStartStatus,
  ReviewExecutionCheckpointState,
  ReviewExecutionFindingSeverity,
  ReviewExecutionProviderResultStatus,
  prepareReviewExecutionBatchResult,
  prepareReviewExecutionCheckpointRoot,
  reviewExecutionCheckpointSchemaVersion,
  type ReviewExecutionBatchResult,
  type ReviewExecutionCheckpointRoot,
  type ReviewExecutionCheckpointScope,
} from "../domain/review-execution-checkpoint";
import { PrismaReviewExecutionCheckpointRepository } from "../infrastructure/prisma/prisma-review-execution-checkpoint-repository";

const now = new Date("2026-07-16T10:00:00.000Z");
const scope: ReviewExecutionCheckpointScope = {
  workspaceId: "workspace_1",
  repositoryId: "repository_1",
  pullRequestNumber: 240,
};
const workKeys = ["1".repeat(64), "2".repeat(64)];
const headSha = "a".repeat(40);
const planHash = "e".repeat(64);

describe("PrismaReviewExecutionCheckpointRepository", () => {
  it("uses the tenant-scoped identity and returns ordered normalized children", async () => {
    const second = batchResult(1);
    const first = batchResult(0);
    const checkpoint = root({
      version: 3,
      acceptedBytes: first.byteCount + second.byteCount,
      acceptedFindings: 2,
    });
    const mock = prismaMock();
    mock.txCheckpoint.findUnique.mockResolvedValue(
      prismaRoot(checkpoint, [prismaBatch(first), prismaBatch(second)]),
    );
    const repository = new PrismaReviewExecutionCheckpointRepository(
      mock.prisma as unknown as PrismaClient,
    );

    const found = await repository.find(scope);

    expect(mock.txCheckpoint.findUnique).toHaveBeenCalledWith({
      where: {
        workspaceId_repositoryId_pullRequestNumber: scope,
      },
      include: { batchResults: { orderBy: { batchIndex: "asc" } } },
    });
    expect(found?.batchResults.map((result) => result.batchIndex)).toEqual([
      0, 1,
    ]);
  });

  it("treats malformed or hash-corrupted child payloads as unavailable", async () => {
    const result = batchResult(0);
    const checkpoint = root({
      version: 2,
      acceptedBytes: result.byteCount,
      acceptedFindings: 1,
    });
    const mock = prismaMock();
    mock.txCheckpoint.findUnique.mockResolvedValue(
      prismaRoot(checkpoint, [
        {
          ...prismaBatch(result),
          payload: {
            rawContent: "not-allowed",
          } as unknown as ReviewExecutionBatchResult["payload"],
        },
      ]),
    );
    const repository = new PrismaReviewExecutionCheckpointRepository(
      mock.prisma as unknown as PrismaClient,
    );

    await expect(repository.find(scope)).resolves.toBeNull();

    mock.txCheckpoint.findUnique.mockResolvedValue(
      prismaRoot(checkpoint, [
        { ...prismaBatch(result), payloadHash: "f".repeat(64) },
      ]),
    );
    await expect(repository.find(scope)).resolves.toBeNull();
  });

  it("replaces an active root and cascades its logical child reset in one transaction", async () => {
    const currentBatch = batchResult(0);
    const current = root({
      version: 2,
      acceptedBytes: currentBatch.byteCount,
      acceptedFindings: 1,
    });
    const replacement = root({
      version: 3,
      headSha: "d".repeat(40),
      planHash: "9".repeat(64),
      plannedWorkKeys: ["3".repeat(64)],
    });
    const mock = prismaMock();
    mock.txCheckpoint.findUnique.mockResolvedValue(
      prismaRoot(current, [prismaBatch(currentBatch)]),
    );
    mock.txCheckpoint.updateMany.mockResolvedValue({ count: 1 });
    mock.txBatch.deleteMany.mockResolvedValue({ count: 1 });
    const repository = new PrismaReviewExecutionCheckpointRepository(
      mock.prisma as unknown as PrismaClient,
    );

    await expect(
      repository.startOrReplace({
        expectedVersion: 2,
        checkpoint: replacement,
      }),
    ).resolves.toMatchObject({
      status: ReviewExecutionCheckpointStartStatus.Replaced,
      checkpoint: { version: 3, acceptedBytes: 0 },
    });
    expect(mock.txCheckpoint.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "checkpoint_1",
          version: 2,
        }),
      }),
    );
    expect(mock.txBatch.deleteMany).toHaveBeenCalledWith({
      where: { checkpointId: "checkpoint_1" },
    });
    expect(
      mock.txCheckpoint.updateMany.mock.invocationCallOrder[0],
    ).toBeLessThan(mock.txBatch.deleteMany.mock.invocationCallOrder[0]!);
  });

  it("replaces a finalized checkpoint when a newer review plan arrives", async () => {
    const first = batchResult(0);
    const second = batchResult(1);
    const finalized = root({
      version: 4,
      state: ReviewExecutionCheckpointState.Finalized,
      finalizedAt: now,
      acceptedBytes: first.byteCount + second.byteCount,
      acceptedFindings: 2,
    });
    const replacement = root({
      version: 5,
      headSha: "d".repeat(40),
      planHash: "9".repeat(64),
      plannedWorkKeys: ["3".repeat(64)],
    });
    const mock = prismaMock();
    mock.txCheckpoint.findUnique.mockResolvedValue(
      prismaRoot(finalized, [prismaBatch(first), prismaBatch(second)]),
    );
    mock.txCheckpoint.updateMany.mockResolvedValue({ count: 1 });
    mock.txBatch.deleteMany.mockResolvedValue({ count: 0 });
    const repository = new PrismaReviewExecutionCheckpointRepository(
      mock.prisma as unknown as PrismaClient,
    );

    await expect(
      repository.startOrReplace({
        expectedVersion: finalized.version,
        checkpoint: replacement,
      }),
    ).resolves.toMatchObject({
      status: ReviewExecutionCheckpointStartStatus.Replaced,
      checkpoint: { headSha: replacement.headSha, version: 5 },
    });
    expect(mock.txCheckpoint.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "checkpoint_1", version: finalized.version },
      }),
    );
  });

  it("increments root CAS and accepted bytes before inserting an immutable child", async () => {
    const checkpoint = root();
    const result = batchResult(0);
    const mock = prismaMock();
    mock.txCheckpoint.findUnique.mockResolvedValue(prismaRoot(checkpoint));
    mock.txCheckpoint.updateMany.mockResolvedValue({ count: 1 });
    mock.txBatch.create.mockResolvedValue(prismaBatch(result));
    const repository = new PrismaReviewExecutionCheckpointRepository(
      mock.prisma as unknown as PrismaClient,
    );

    await expect(
      repository.commitBatchResult({
        scope,
        expectedVersion: 1,
        headSha: checkpoint.headSha,
        planHash: checkpoint.planHash,
        batchResult: result,
        updatedAt: new Date(now.getTime() + 1_000),
        expiresAt: new Date(now.getTime() + 2_000),
      }),
    ).resolves.toMatchObject({
      status: ReviewExecutionBatchCommitStatus.Committed,
      checkpoint: {
        version: 2,
        acceptedBytes: result.byteCount,
        acceptedFindings: 1,
      },
    });
    expect(mock.txCheckpoint.findUnique).toHaveBeenCalledWith({
      where: { workspaceId_repositoryId_pullRequestNumber: scope },
    });
    expect(mock.txBatch.findUnique).toHaveBeenCalledWith({
      where: {
        checkpointId_workKey: {
          checkpointId: "checkpoint_1",
          workKey: result.workKey,
        },
      },
    });
    expect(mock.txCheckpoint.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "checkpoint_1",
          version: 1,
          state: "active",
          acceptedBytes: 0,
          acceptedFindings: 0,
        }),
        data: expect.objectContaining({
          version: 2,
          acceptedBytes: result.byteCount,
          acceptedFindings: 1,
        }),
      }),
    );
    expect(mock.txBatch.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        checkpointId: "checkpoint_1",
        workKey: result.workKey,
        payloadHash: result.payloadHash,
        byteCount: result.byteCount,
      }),
    });
    expect(
      mock.txCheckpoint.updateMany.mock.invocationCallOrder[0],
    ).toBeLessThan(mock.txBatch.create.mock.invocationCallOrder[0]!);
  });

  it("resolves duplicate work by hash without another root write", async () => {
    const existing = batchResult(0);
    const checkpoint = root({
      version: 2,
      acceptedBytes: existing.byteCount,
      acceptedFindings: 1,
    });
    const mock = prismaMock();
    mock.txCheckpoint.findUnique.mockResolvedValue(prismaRoot(checkpoint));
    mock.txBatch.findUnique.mockResolvedValue(prismaBatch(existing));
    const repository = new PrismaReviewExecutionCheckpointRepository(
      mock.prisma as unknown as PrismaClient,
    );

    await expect(
      repository.commitBatchResult({
        scope,
        expectedVersion: 1,
        headSha: checkpoint.headSha,
        planHash: checkpoint.planHash,
        batchResult: existing,
        updatedAt: now,
        expiresAt: now,
      }),
    ).resolves.toMatchObject({
      status: ReviewExecutionBatchCommitStatus.Idempotent,
      checkpoint: { version: 2 },
    });
    expect(mock.txCheckpoint.updateMany).not.toHaveBeenCalled();
    expect(mock.txBatch.create).not.toHaveBeenCalled();

    const changed = batchResult(0, "changed");
    await expect(
      repository.commitBatchResult({
        scope,
        expectedVersion: 2,
        headSha: checkpoint.headSha,
        planHash: checkpoint.planHash,
        batchResult: changed,
        updatedAt: now,
        expiresAt: now,
      }),
    ).resolves.toMatchObject({
      status: ReviewExecutionBatchCommitStatus.Conflict,
      currentPayloadHash: existing.payloadHash,
    });
  });

  it("finalizes only when every planned work key has an accepted child", async () => {
    const first = batchResult(0);
    const incomplete = root({
      version: 2,
      acceptedBytes: first.byteCount,
      acceptedFindings: 1,
    });
    const mock = prismaMock();
    mock.txCheckpoint.findUnique.mockResolvedValueOnce(
      prismaRoot(incomplete, [prismaBatch(first)]),
    );
    const repository = new PrismaReviewExecutionCheckpointRepository(
      mock.prisma as unknown as PrismaClient,
    );

    await expect(
      repository.finalize({
        scope,
        expectedVersion: 2,
        headSha,
        planHash,
        finalizedAt: now,
        expiresAt: now,
      }),
    ).resolves.toEqual({
      status: ReviewExecutionCheckpointFinalizeStatus.Incomplete,
      checkpoint: incomplete,
      missingWorkKeys: [workKeys[1]],
    });
    expect(mock.txCheckpoint.updateMany).not.toHaveBeenCalled();

    const second = batchResult(1);
    const complete = root({
      version: 3,
      acceptedBytes: first.byteCount + second.byteCount,
      acceptedFindings: 2,
    });
    mock.txCheckpoint.findUnique.mockResolvedValueOnce(
      prismaRoot(complete, [prismaBatch(first), prismaBatch(second)]),
    );
    mock.txCheckpoint.updateMany.mockResolvedValue({ count: 1 });
    await expect(
      repository.finalize({
        scope,
        expectedVersion: 3,
        headSha,
        planHash,
        finalizedAt: now,
        expiresAt: new Date(now.getTime() + 1_000),
      }),
    ).resolves.toMatchObject({
      status: ReviewExecutionCheckpointFinalizeStatus.Finalized,
      checkpoint: {
        version: 4,
        state: ReviewExecutionCheckpointState.Finalized,
      },
    });
    expect(mock.txCheckpoint.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          version: 3,
          state: "active",
          headSha,
          planHash,
        }),
        data: expect.objectContaining({
          version: 4,
          state: "finalized",
          finalizedAt: now,
        }),
      }),
    );
  });

  it("clears exact finalized roots and prunes expiry ids with a repeated predicate", async () => {
    const mock = prismaMock();
    mock.topCheckpoint.deleteMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 2 });
    mock.topCheckpoint.findMany.mockResolvedValue([
      { id: "checkpoint_1" },
      { id: "checkpoint_2" },
    ]);
    const repository = new PrismaReviewExecutionCheckpointRepository(
      mock.prisma as unknown as PrismaClient,
    );

    await expect(
      repository.clear({
        scope,
        expectedVersion: 4,
        headSha,
        planHash,
      }),
    ).resolves.toEqual({
      status: ReviewExecutionCheckpointClearStatus.Cleared,
    });
    expect(mock.topCheckpoint.deleteMany).toHaveBeenNthCalledWith(1, {
      where: {
        ...scope,
        version: 4,
        state: "finalized",
        headSha,
        planHash,
      },
    });

    await expect(
      repository.pruneExpired({ expiredBefore: now, limit: 2 }),
    ).resolves.toBe(2);
    expect(mock.topCheckpoint.findMany).toHaveBeenCalledWith({
      where: { expiresAt: { lte: now } },
      orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
      take: 2,
      select: { id: true },
    });
    expect(mock.topCheckpoint.deleteMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: { in: ["checkpoint_1", "checkpoint_2"] },
        expiresAt: { lte: now },
      },
    });
  });
});

function root(
  overrides: Partial<ReviewExecutionCheckpointRoot> = {},
): ReviewExecutionCheckpointRoot {
  const prepared = prepareReviewExecutionCheckpointRoot(
    {
      ...scope,
      schemaVersion: reviewExecutionCheckpointSchemaVersion,
      baseSha: "b".repeat(40),
      headSha,
      compatibilityKey: "c".repeat(64),
      planHash,
      plannedWorkKeys: workKeys,
      sourceRunId: "run_100",
      sourceRunAttempt: "1",
    },
    { version: overrides.version ?? 1, now },
  );
  return { ...prepared, ...overrides };
}

function batchResult(index: number, title = `finding-${index}`) {
  return prepareReviewExecutionBatchResult(
    {
      workKey: workKeys[index]!,
      batchId: `${index + 3}`.repeat(64),
      batchIndex: index,
      payload: {
        filePaths: [`src/file-${index}.ts`],
        findings: [
          {
            file: `src/file-${index}.ts`,
            line: index + 1,
            severity: ReviewExecutionFindingSeverity.Major,
            title,
            message: "Persist the state.",
          },
        ],
        providerResults: [
          {
            name: "codex",
            status: ReviewExecutionProviderResultStatus.Success,
            durationSeconds: 0.01,
            lifecycleAssignedTargetIds: [],
            lifecycleRevalidations: [],
          },
        ],
      },
      sourceRunId: "run_100",
      sourceRunAttempt: "1",
    },
    { completedAt: now },
  );
}

function prismaRoot(
  checkpoint: ReviewExecutionCheckpointRoot,
  batchResults: readonly ReturnType<typeof prismaBatch>[] = [],
) {
  return {
    id: "checkpoint_1",
    ...checkpoint,
    finalizedAt: checkpoint.finalizedAt ?? null,
    createdAt: now,
    batchResults,
  };
}

function prismaBatch(result: ReviewExecutionBatchResult) {
  return {
    id: `batch_${result.batchIndex}`,
    checkpointId: "checkpoint_1",
    ...result,
  };
}

function prismaMock() {
  const txCheckpoint = {
    findUnique: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
  };
  const txBatch = {
    create: vi.fn(),
    deleteMany: vi.fn(),
    findUnique: vi.fn(),
  };
  const topCheckpoint = {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    deleteMany: vi.fn(),
  };
  const transaction = vi.fn(
    async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        reviewExecutionCheckpoint: txCheckpoint,
        reviewExecutionBatchResult: txBatch,
      }),
  );
  return {
    txCheckpoint,
    txBatch,
    topCheckpoint,
    prisma: {
      $transaction: transaction,
      reviewExecutionCheckpoint: topCheckpoint,
    },
  };
}
