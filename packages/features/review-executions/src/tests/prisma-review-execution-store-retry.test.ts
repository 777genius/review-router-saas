import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  ReviewExecutionAdmissionStatus,
  ReviewExecutionAdmissionVerdict,
  ReviewExecutionPrepareStatus,
  ReviewInvocationLeaseAcquireStatus,
  ReviewObservationAttachmentStatus,
} from "../application/ports/review-execution-ports";
import { PrismaReviewExecutionStore } from "../infrastructure/prisma/prisma-review-execution-store";
import { isTransactionConflictError } from "../infrastructure/prisma/prisma-review-execution-utils";
import { ReviewInvocationLeasePurpose } from "../domain/review-execution";
import { ReviewExecutionState } from "../domain/review-execution";

describe("Prisma review execution transaction retries", () => {
  it.each([
    {
      activated: false,
      expectedIdentity: { providerVoteIdentityHash: "vote-identity" },
    },
    {
      activated: true,
      expectedIdentity: {
        ...scope,
        providerInvocationKey: "provider-invocation",
      },
    },
  ])(
    "selects the $activated production flight observation identity",
    async ({ activated, expectedIdentity }) => {
      const findMany = vi.fn().mockResolvedValue([]);
      const transaction = {
        $queryRaw: vi
          .fn()
          .mockResolvedValueOnce([{ epochMs: 1_775_203_200_000n }])
          .mockResolvedValueOnce([{ activated }]),
        reviewInvocationLeaseV2: { findMany },
      };
      const prisma = {
        $transaction: vi.fn(
          async (operation: (client: typeof transaction) => unknown) =>
            operation(transaction),
        ),
      };
      const store = new PrismaReviewExecutionStore(prisma as never);

      await expect(
        store.observeActiveInvocationFlight({
          scope,
          providerInvocationKey: "provider-invocation",
          providerVoteIdentityHash: "vote-identity",
          requestedAt: new Date("2026-04-02T00:00:00.000Z"),
        }),
      ).resolves.toMatchObject({ flight: null });

      expect(findMany).toHaveBeenCalledWith({
        where: {
          ...expectedIdentity,
          purpose: "provider_execution",
          state: "active",
        },
        orderBy: { leaseId: "asc" },
        take: 2,
      });
    },
  );

  it("uses read committed for scope-local preparation and admission but serializable for lease fencing", async () => {
    const prisma = {
      $transaction: vi
        .fn()
        .mockResolvedValueOnce({
          status: ReviewExecutionPrepareStatus.Prepared,
        })
        .mockResolvedValueOnce({
          status: ReviewExecutionAdmissionStatus.Admitted,
        })
        .mockResolvedValueOnce({
          status: ReviewInvocationLeaseAcquireStatus.Acquired,
        }),
    };
    const store = new PrismaReviewExecutionStore(prisma as never);

    await store.prepareExecution({ scope } as never);
    await store.confirmAdmission({ scope } as never);
    await store.acquireLease({ scope } as never);

    expect(prisma.$transaction.mock.calls.map((call) => call[1])).toEqual([
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ]);
  });

  it("retries admission transaction write conflicts with a fresh transaction", async () => {
    const prisma = {
      $transaction: vi
        .fn()
        .mockRejectedValueOnce(driverAdapterWriteConflict())
        .mockResolvedValueOnce({
          status: ReviewExecutionAdmissionStatus.Admitted,
        }),
    };
    const store = new PrismaReviewExecutionStore(prisma as never);

    await expect(store.confirmAdmission({ scope } as never)).resolves.toEqual({
      status: ReviewExecutionAdmissionStatus.Admitted,
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it("reconciles an exact admission after bounded conflicts are exhausted", async () => {
    const prisma = {
      $transaction: vi.fn().mockRejectedValue(serializationConflict()),
    };
    const store = new PrismaReviewExecutionStore(prisma as never);
    const snapshot = {
      execution: {
        ...scope,
        executionId: "execution-1",
        authorizationId: "authorization-1",
        mutationEpoch: 1n,
        revision,
        state: ReviewExecutionState.Running,
      },
      stream: { activeExecutionId: "execution-1" },
    };
    vi.spyOn(store, "findExecution").mockResolvedValue(snapshot as never);

    await expect(store.confirmAdmission(admissionCommand())).resolves.toEqual({
      status: ReviewExecutionAdmissionStatus.Restored,
      snapshot,
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(5);
    expectIsolationCalls(
      prisma.$transaction.mock.calls,
      Prisma.TransactionIsolationLevel.ReadCommitted,
      5,
    );
  });

  it("fails admission closed when exhausted conflicts cannot be reconciled", async () => {
    const prisma = {
      $transaction: vi.fn().mockRejectedValue(driverAdapterWriteConflict()),
    };
    const store = new PrismaReviewExecutionStore(prisma as never);
    vi.spyOn(store, "findExecution").mockResolvedValue(null);

    await expect(store.confirmAdmission(admissionCommand())).resolves.toEqual({
      status: ReviewExecutionAdmissionStatus.ConcurrencyConflict,
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(5);
    expectIsolationCalls(
      prisma.$transaction.mock.calls,
      Prisma.TransactionIsolationLevel.ReadCommitted,
      5,
    );
  });

  it("propagates non-serialization admission failures without retrying", async () => {
    const failure = new Error("database unavailable");
    const prisma = {
      $transaction: vi.fn().mockRejectedValue(failure),
    };
    const store = new PrismaReviewExecutionStore(prisma as never);

    await expect(store.confirmAdmission({} as never)).rejects.toBe(failure);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("retries prepare serialization conflicts with a fresh transaction", async () => {
    const scheduledDelays: number[] = [];
    const timeout = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: () => void,
      delay?: number,
    ) => {
      scheduledDelays.push(delay ?? 0);
      callback();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const prisma = {
      $transaction: vi
        .fn()
        .mockRejectedValueOnce(serializationConflict())
        .mockRejectedValueOnce(serializationConflict())
        .mockResolvedValueOnce({
          status: ReviewExecutionPrepareStatus.Prepared,
        }),
    };
    const store = new PrismaReviewExecutionStore(prisma as never);

    await expect(store.prepareExecution({ scope } as never)).resolves.toEqual({
      status: ReviewExecutionPrepareStatus.Prepared,
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
    expect(scheduledDelays).toHaveLength(2);
    expect(scheduledDelays[0]).toBeGreaterThanOrEqual(16);
    expect(scheduledDelays[0]).toBeLessThan(32);
    expect(scheduledDelays[1]).toBeGreaterThanOrEqual(32);
    expect(scheduledDelays[1]).toBeLessThan(64);
    timeout.mockRestore();
  });

  it("reconciles prepare after bounded serialization retries are exhausted", async () => {
    const prisma = {
      $transaction: vi
        .fn()
        .mockRejectedValueOnce(serializationConflict())
        .mockRejectedValueOnce(serializationConflict())
        .mockRejectedValueOnce(serializationConflict())
        .mockRejectedValueOnce(serializationConflict())
        .mockRejectedValueOnce(serializationConflict())
        .mockResolvedValueOnce(null),
    };
    const store = new PrismaReviewExecutionStore(prisma as never);

    await expect(store.prepareExecution({ scope } as never)).resolves.toEqual({
      status: ReviewExecutionPrepareStatus.ConcurrencyConflict,
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(6);
    expectIsolationCalls(
      prisma.$transaction.mock.calls,
      Prisma.TransactionIsolationLevel.ReadCommitted,
      5,
    );
    expect(prisma.$transaction.mock.calls[5]?.[1]).toBeUndefined();
  });

  it("retries acquire serialization conflicts before returning the result", async () => {
    const prisma = {
      $transaction: vi
        .fn()
        .mockRejectedValueOnce(serializationConflict())
        .mockRejectedValueOnce(serializationConflict())
        .mockResolvedValueOnce({
          status: ReviewInvocationLeaseAcquireStatus.Acquired,
        }),
    };
    const store = new PrismaReviewExecutionStore(prisma as never);

    await expect(store.acquireLease({ scope } as never)).resolves.toEqual({
      status: ReviewInvocationLeaseAcquireStatus.Acquired,
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
  });

  it("retries the Prisma adapter transaction write conflict shape", async () => {
    const prisma = {
      $transaction: vi
        .fn()
        .mockRejectedValueOnce(driverAdapterWriteConflict())
        .mockResolvedValueOnce({
          status: ReviewInvocationLeaseAcquireStatus.Acquired,
        }),
    };
    const store = new PrismaReviewExecutionStore(prisma as never);

    await expect(store.acquireLease({ scope } as never)).resolves.toEqual({
      status: ReviewInvocationLeaseAcquireStatus.Acquired,
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it("reconciles acquire after bounded serialization retries are exhausted", async () => {
    const scheduledDelays: number[] = [];
    const timeout = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: () => void,
      delay?: number,
    ) => {
      scheduledDelays.push(delay ?? 0);
      callback();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const prisma = {
      $transaction: vi.fn().mockRejectedValue(serializationConflict()),
      reviewInvocationLeaseV2: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    };
    const store = new PrismaReviewExecutionStore(prisma as never);
    vi.spyOn(store, "findExecution").mockResolvedValue({
      execution: { generation: 1n },
    } as never);

    await expect(
      store.acquireLease({
        scope,
        purpose: ReviewInvocationLeasePurpose.ProviderExecution,
      } as never),
    ).resolves.toEqual({ status: ReviewInvocationLeaseAcquireStatus.Busy });
    expect(prisma.$transaction).toHaveBeenCalledTimes(10);
    expectIsolationCalls(
      prisma.$transaction.mock.calls,
      Prisma.TransactionIsolationLevel.Serializable,
      10,
    );
    expect(scheduledDelays).toHaveLength(9);
    expect(scheduledDelays.every((delay) => delay <= 512)).toBe(true);
    expect(
      scheduledDelays.reduce((total, delay) => total + delay, 0),
    ).toBeLessThanOrEqual(3_035);
    timeout.mockRestore();
  });

  it("propagates non-serialization acquire failures without retrying", async () => {
    const failure = new Error("database unavailable");
    const prisma = {
      $transaction: vi.fn().mockRejectedValue(failure),
    };
    const store = new PrismaReviewExecutionStore(prisma as never);

    await expect(store.acquireLease({ scope } as never)).rejects.toBe(failure);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("retries serialization conflicts before returning the attachment result", async () => {
    const prisma = {
      $transaction: vi
        .fn()
        .mockRejectedValueOnce(serializationConflict())
        .mockRejectedValueOnce(serializationConflict())
        .mockResolvedValueOnce({
          status: ReviewObservationAttachmentStatus.Attached,
        }),
    };
    const store = new PrismaReviewExecutionStore(prisma as never);

    await expect(store.attachObservation({} as never)).resolves.toEqual({
      status: ReviewObservationAttachmentStatus.Attached,
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
  });

  it("does not misreport an exhausted serialization conflict as a domain conflict", async () => {
    const conflict = serializationConflict();
    const prisma = {
      $transaction: vi.fn().mockRejectedValue(conflict),
    };
    const store = new PrismaReviewExecutionStore(prisma as never);

    await expect(store.attachObservation({} as never)).rejects.toBe(conflict);
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
  });

  it("throws after exhausting Prisma adapter transaction write conflict retries", async () => {
    const conflict = driverAdapterWriteConflict();
    const prisma = {
      $transaction: vi.fn().mockRejectedValue(conflict),
    };
    const store = new PrismaReviewExecutionStore(prisma as never);

    await expect(store.attachObservation({} as never)).rejects.toBe(conflict);
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
  });

  it("accepts only the known Prisma adapter transaction conflict structure", () => {
    expect(isTransactionConflictError(driverAdapterWriteConflict())).toBe(true);
    expect(isTransactionConflictError(serializationConflict())).toBe(true);
    expect(
      isTransactionConflictError(
        Object.assign(new Error("TransactionWriteConflict"), {
          name: "DriverAdapterError",
          cause: { kind: "ConnectionError" },
        }),
      ),
    ).toBe(false);
    expect(
      isTransactionConflictError(
        Object.assign(new Error("TransactionWriteConflict"), {
          cause: { kind: "TransactionWriteConflict" },
        }),
      ),
    ).toBe(false);
    expect(
      isTransactionConflictError({
        name: "DriverAdapterError",
        cause: { kind: "TransactionWriteConflict" },
      }),
    ).toBe(false);
    expect(
      isTransactionConflictError(
        Object.assign(new Error("TransactionWriteConflict"), {
          name: "DriverAdapterError",
          cause: "TransactionWriteConflict",
        }),
      ),
    ).toBe(false);
  });

  it("maps the retired vote-lane index P2002 to busy during rolling migration", async () => {
    const prisma = {
      $transaction: vi.fn().mockRejectedValue(legacyProviderLaneConflict()),
    };
    const store = new PrismaReviewExecutionStore(prisma as never);

    await expect(
      store.acquireLease({
        purpose: ReviewInvocationLeasePurpose.ProviderExecution,
      } as never),
    ).resolves.toEqual({ status: ReviewInvocationLeaseAcquireStatus.Busy });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("does not map an unverified single-column P2002 directly to legacy busy", async () => {
    const prisma = {
      $transaction: vi
        .fn()
        .mockRejectedValueOnce(unverifiedUniqueConflict())
        .mockResolvedValueOnce(null),
    };
    const store = new PrismaReviewExecutionStore(prisma as never);

    await expect(
      store.acquireLease({
        purpose: ReviewInvocationLeasePurpose.ProviderExecution,
      } as never),
    ).resolves.toEqual({ status: ReviewInvocationLeaseAcquireStatus.Missing });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });
});

function expectIsolationCalls(
  calls: readonly unknown[][],
  isolationLevel: Prisma.TransactionIsolationLevel,
  count: number,
) {
  expect(calls.slice(0, count).map((call) => call[1])).toEqual(
    Array.from({ length: count }, () => ({ isolationLevel })),
  );
}

function serializationConflict() {
  return new Prisma.PrismaClientKnownRequestError("serialization conflict", {
    code: "P2034",
    clientVersion: "test",
  });
}

function driverAdapterWriteConflict() {
  return Object.assign(new Error("TransactionWriteConflict"), {
    name: "DriverAdapterError",
    cause: { kind: "TransactionWriteConflict" },
  });
}

function legacyProviderLaneConflict() {
  return new Prisma.PrismaClientKnownRequestError("legacy lane conflict", {
    code: "P2002",
    clientVersion: "test",
    meta: {
      target: "ReviewInvocationLeaseV2_one_active_provider_vote_lane",
    },
  });
}

function unverifiedUniqueConflict() {
  return new Prisma.PrismaClientKnownRequestError("some unique conflict", {
    code: "P2002",
    clientVersion: "test",
    meta: { target: ["providerVoteIdentityHash"] },
  });
}

const scope = {
  workspaceId: "workspace-1",
  repositoryConnectionId: "repository-connection-1",
  scmRepositoryIdentityId: "repository-1",
  pullRequestNumber: 1,
};

const revision = {
  baseSha: "base",
  mergeBaseSha: "merge-base",
  headSha: "head",
  reviewRevisionHash: "revision",
};

function admissionCommand() {
  return {
    scope,
    executionId: "execution-1",
    expectedStreamVersion: 1n,
    authorizationId: "authorization-1",
    mutationEpoch: 1n,
    requestedRevision: revision,
    observedRevision: revision,
    verdict: ReviewExecutionAdmissionVerdict.Current,
    checkedAt: new Date(),
  };
}
