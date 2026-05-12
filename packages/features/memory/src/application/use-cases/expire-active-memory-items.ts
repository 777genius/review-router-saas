import { MemoryError } from "../../domain/memory-errors";
import { MemoryItem, type MemoryItemSnapshot } from "../../domain/memory-item";
import type { MemoryTransactionalPorts } from "../ports/memory-transaction-port";
import type { MemoryUseCaseDependencies } from "./memory-use-case-types";

export type ExpireActiveMemoryItemsInput = {
  readonly workspaceId: string;
  readonly limit?: number;
};

export type ExpireActiveMemoryItemsResult = {
  readonly status: "expired" | "noop";
  readonly expiredCount: number;
};

export type ExpireActiveMemoryItemsAcrossWorkspacesInput = {
  readonly workspaceLimit?: number;
  readonly perWorkspaceLimit?: number;
};

export type ExpireActiveMemoryItemsAcrossWorkspacesResult = {
  readonly status: "expired" | "noop";
  readonly workspaceCount: number;
  readonly expiredCount: number;
};

export async function expireActiveMemoryItems(
  input: ExpireActiveMemoryItemsInput,
  dependencies: Pick<
    MemoryUseCaseDependencies,
    "clock" | "memoryItems" | "memoryTransaction"
  >,
): Promise<ExpireActiveMemoryItemsResult> {
  const now = dependencies.clock.now();
  const expired = await dependencies.memoryItems.listExpiredActive({
    workspaceId: input.workspaceId,
    expiredAtOrBefore: now,
    limit: normalizeRetentionBatchLimit(input.limit),
  });
  if (expired.length === 0) {
    return { status: "noop", expiredCount: 0 };
  }

  let expiredCount = 0;
  await dependencies.memoryTransaction.run(async (tx) => {
    for (const snapshot of expired) {
      try {
        await saveExpiredMemoryItem(
          {
            workspaceId: input.workspaceId,
            previous: snapshot,
            item: MemoryItem.fromSnapshot(snapshot).expire({ now }),
            now,
          },
          tx,
        );
        expiredCount += 1;
      } catch (error) {
        if (
          error instanceof MemoryError &&
          error.code === "memory_version_conflict"
        ) {
          continue;
        }
        throw error;
      }
    }
  });

  return expiredCount === 0
    ? { status: "noop", expiredCount: 0 }
    : { status: "expired", expiredCount };
}

export async function expireActiveMemoryItemsAcrossWorkspaces(
  input: ExpireActiveMemoryItemsAcrossWorkspacesInput,
  dependencies: Pick<
    MemoryUseCaseDependencies,
    "clock" | "memoryItems" | "memoryTransaction"
  >,
): Promise<ExpireActiveMemoryItemsAcrossWorkspacesResult> {
  const now = dependencies.clock.now();
  const workspaceIds =
    await dependencies.memoryItems.listWorkspaceIdsWithExpiredActive({
      expiredAtOrBefore: now,
      limit: normalizeWorkspaceBatchLimit(input.workspaceLimit),
    });
  if (workspaceIds.length === 0) {
    return { status: "noop", workspaceCount: 0, expiredCount: 0 };
  }

  const stableTimeDependencies = {
    ...dependencies,
    clock: { now: () => now },
  };
  let expiredCount = 0;
  for (const workspaceId of workspaceIds) {
    const result = await expireActiveMemoryItems(
      {
        workspaceId,
        limit: normalizeRetentionBatchLimit(input.perWorkspaceLimit),
      },
      stableTimeDependencies,
    );
    expiredCount += result.expiredCount;
  }

  return expiredCount === 0
    ? { status: "noop", workspaceCount: workspaceIds.length, expiredCount: 0 }
    : {
        status: "expired",
        workspaceCount: workspaceIds.length,
        expiredCount,
      };
}

async function saveExpiredMemoryItem(
  input: {
    readonly workspaceId: string;
    readonly previous: MemoryItemSnapshot;
    readonly item: MemoryItem;
    readonly now: Date;
  },
  tx: MemoryTransactionalPorts,
): Promise<void> {
  const next = input.item.snapshot();
  await tx.memoryItems.save(input.item, {
    expectedVersion: input.previous.version,
  });
  await tx.memoryAudit.record({
    workspaceId: input.workspaceId,
    actor: "system:memory-retention",
    action: "memory.item.expired",
    targetType: "memory_item",
    targetId: input.previous.id,
    metadata: {
      scope: input.previous.scope,
      bodyHash: input.previous.bodyHash,
      bodyVersion: input.previous.bodyVersion,
      previousVersion: input.previous.version,
      version: next.version,
      expiresAt: input.previous.expiresAt?.toISOString() ?? null,
    },
  });
  await tx.memoryOutbox.enqueue({
    type: "memory.item.expired",
    version: 1,
    idempotencyKey: `memory.item.expired:${next.workspaceId}:${next.id}:${next.version}`,
    workspaceId: input.workspaceId,
    repositoryId: next.repositoryId,
    aggregateId: next.id,
    payload: {
      bodyHash: input.previous.bodyHash,
      bodyVersion: input.previous.bodyVersion,
      scope: next.scope,
      expiresAt: input.previous.expiresAt?.toISOString() ?? null,
    },
    occurredAt: input.now,
  });
  await tx.memoryOutbox.enqueue({
    type: "memory.embedding.delete.requested",
    version: 1,
    idempotencyKey: `memory.embedding.delete:${next.workspaceId}:${next.id}:${next.version}`,
    workspaceId: input.workspaceId,
    repositoryId: next.repositoryId,
    aggregateId: next.id,
    payload: {
      indexState: next.indexState,
      scope: next.scope,
    },
    occurredAt: input.now,
  });
}

function normalizeRetentionBatchLimit(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value)) return 100;
  return Math.min(500, Math.max(1, value));
}

function normalizeWorkspaceBatchLimit(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value)) return 50;
  return Math.min(500, Math.max(1, value));
}
