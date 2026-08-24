import { describe, expect, it, vi } from "vitest";
import { PrismaInvestigationStore } from "../infrastructure/prisma/prisma-investigation-store";

const cutoff = new Date("2026-08-03T12:00:00.000Z");

describe("PrismaInvestigationStore retention pruning", () => {
  it("fails the private-material batch on an infrastructure transaction error", async () => {
    const infrastructureError = new Error("database_connection_lost");
    const selectionTransaction = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ epochMs: BigInt(cutoff.getTime() + 1_000) }])
        .mockResolvedValueOnce([
          {
            privateMaterialId: "private-inv-1",
            investigationId: "inv-1",
            obligationId: null,
            expiresAt: cutoff,
            investigationState: "open",
          },
        ]),
    };
    const prisma = {
      $transaction: vi
        .fn()
        .mockImplementationOnce(
          async (callback: (value: typeof selectionTransaction) => unknown) =>
            callback(selectionTransaction),
        )
        .mockRejectedValueOnce(infrastructureError),
    };
    const store = new PrismaInvestigationStore(prisma as never);

    await expect(
      store.reconcileExpiredPrivateMaterial({
        expiresAtOrBefore: cutoff.toISOString(),
        limit: 1,
      }),
    ).rejects.toBe(infrastructureError);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it("selects a bounded multi-row expired-turn batch with skip locked", async () => {
    const transaction = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ epochMs: BigInt(cutoff.getTime() + 1_000) }])
        .mockResolvedValueOnce([
          { investigationId: "inv-1" },
          { investigationId: "inv-2" },
        ]),
    };
    const store = new PrismaInvestigationStore({
      $transaction: async (
        callback: (value: typeof transaction) => Promise<readonly string[]>,
      ) => callback(transaction),
    } as never);

    await expect(
      store.findExpiredActiveTurnIds({
        expiresAtOrBefore: cutoff.toISOString(),
        limit: 2,
      }),
    ).resolves.toEqual(["inv-1", "inv-2"]);
    const query = transaction.$queryRaw.mock.calls[1]![0] as {
      readonly sql: string;
      readonly values: readonly unknown[];
    };
    expect(query.sql).toContain('turn."expiresAt" <=');
    expect(query.sql).toContain("FOR UPDATE OF investigation SKIP LOCKED");
    expect(query.values).toContain(2);
  });

  it("locks a bounded terminal set and deletes an expired graph in dependency order", async () => {
    const transaction = retentionTransaction([{ investigationId: "inv-1" }]);
    const prisma = {
      $transaction: vi.fn(
        async (callback: (value: typeof transaction) => Promise<number>) =>
          callback(transaction),
      ),
    };
    const store = new PrismaInvestigationStore(prisma as never);

    await expect(
      store.pruneRetainedInvestigations({
        retainUntilOrBefore: cutoff.toISOString(),
        limit: 25,
      }),
    ).resolves.toBe(1);

    const query = transaction.$queryRaw.mock.calls[0]![0] as {
      readonly sql: string;
      readonly values: readonly unknown[];
    };
    expect(query.sql).toContain("'concluded'");
    expect(query.sql).toContain('receipt."retainUntil" >');
    expect(query.sql).toContain('certificate."expiresAt" >');
    expect(query.sql).toContain('checkpoint."expiresAt" >');
    expect(query.sql).toContain('material."expiresAt" >');
    expect(query.sql).toContain('turn."retainUntil" >');
    expect(query.sql).toContain('lease."retainUntil" >');
    expect(query.sql).toContain('command."retainUntil" >');
    expect(query.sql).toContain("FOR UPDATE OF investigation SKIP LOCKED");
    expect(query.values).toContain(25);

    expect(transaction.reviewInvestigation.updateMany).toHaveBeenCalledWith({
      where: { investigationId: { in: ["inv-1"] } },
      data: {
        activeTurnId: null,
        certificateId: null,
        replayEvidenceCheckpointId: null,
      },
    });
    expect(
      transaction.reviewInvestigationObligation.updateMany,
    ).toHaveBeenCalledWith({
      where: { investigationId: { in: ["inv-1"] } },
      data: { state: "open", receiptId: null, unresolvableReason: null },
    });
    expect(
      transaction.reviewInvestigationReceipt.deleteMany.mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      transaction.reviewInvestigationTurn.deleteMany.mock
        .invocationCallOrder[0]!,
    );
    expect(
      transaction.reviewInvestigationCertificate.deleteMany.mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      transaction.reviewInvestigation.deleteMany.mock.invocationCallOrder[0]!,
    );
    expect(
      transaction.reviewInvestigationReplayEvidenceCheckpoint.deleteMany.mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      transaction.reviewInvestigation.deleteMany.mock.invocationCallOrder[0]!,
    );
    expect(
      transaction.reviewInvestigationLease.deleteMany.mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      transaction.reviewInvestigationTurn.deleteMany.mock
        .invocationCallOrder[0]!,
    );
    expect(transaction.reviewInvestigation.deleteMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        investigationId: { in: ["inv-1"] },
        retainUntil: { lte: cutoff },
        state: {
          in: expect.arrayContaining([
            "concluded",
            "inconclusive",
            "superseded",
            "expired",
          ]),
        },
      }),
    });
  });

  it("rolls the batch back when the final aggregate fence no longer matches", async () => {
    const transaction = retentionTransaction([{ investigationId: "inv-1" }]);
    transaction.reviewInvestigation.deleteMany.mockResolvedValueOnce({
      count: 0,
    });
    const store = new PrismaInvestigationStore({
      $transaction: async (
        callback: (value: typeof transaction) => Promise<number>,
      ) => callback(transaction),
    } as never);

    await expect(
      store.pruneRetainedInvestigations({
        retainUntilOrBefore: cutoff.toISOString(),
        limit: 1,
      }),
    ).rejects.toThrow("investigation_prune_fence_changed");
  });

  it("does no dependent writes when no terminal row is eligible", async () => {
    const transaction = retentionTransaction([]);
    const store = new PrismaInvestigationStore({
      $transaction: async (
        callback: (value: typeof transaction) => Promise<number>,
      ) => callback(transaction),
    } as never);

    await expect(
      store.pruneRetainedInvestigations({
        retainUntilOrBefore: cutoff.toISOString(),
        limit: 10,
      }),
    ).resolves.toBe(0);
    expect(transaction.reviewInvestigation.updateMany).not.toHaveBeenCalled();
    expect(transaction.reviewInvestigation.deleteMany).not.toHaveBeenCalled();
  });
});

function retentionTransaction(
  candidates: readonly Readonly<{ investigationId: string }>[],
) {
  return {
    $queryRaw: vi.fn().mockResolvedValue(candidates),
    reviewInvestigation: {
      updateMany: vi.fn().mockResolvedValue({ count: candidates.length }),
      deleteMany: vi.fn().mockResolvedValue({ count: candidates.length }),
    },
    reviewInvestigationObligation: {
      updateMany: vi.fn().mockResolvedValue({ count: candidates.length }),
      deleteMany: vi.fn().mockResolvedValue({ count: candidates.length }),
    },
    reviewInvestigationReceipt: {
      deleteMany: vi.fn().mockResolvedValue({ count: candidates.length }),
    },
    reviewInvestigationCertificate: {
      deleteMany: vi.fn().mockResolvedValue({ count: candidates.length }),
    },
    reviewInvestigationReplayEvidenceCheckpoint: {
      deleteMany: vi.fn().mockResolvedValue({ count: candidates.length }),
    },
    reviewInvestigationCommandReceipt: {
      deleteMany: vi.fn().mockResolvedValue({ count: candidates.length }),
    },
    reviewInvestigationPrivateMaterial: {
      deleteMany: vi.fn().mockResolvedValue({ count: candidates.length }),
    },
    reviewInvestigationLease: {
      deleteMany: vi.fn().mockResolvedValue({ count: candidates.length }),
    },
    reviewInvestigationTurn: {
      deleteMany: vi.fn().mockResolvedValue({ count: candidates.length }),
    },
  };
}
