import { memoryError } from "../../domain/memory-errors";
import type { MemoryUseCaseDependencies } from "./memory-use-case-types";

const DEFAULT_TERMINAL_MEMORY_ITEM_PRUNE_BATCH_LIMIT = 100;
const MAX_TERMINAL_MEMORY_ITEM_PRUNE_BATCH_LIMIT = 500;
const DEFAULT_TERMINAL_MEMORY_ITEM_WORKSPACE_BATCH_LIMIT = 50;
const MAX_TERMINAL_MEMORY_ITEM_WORKSPACE_BATCH_LIMIT = 500;

export type PruneTerminalMemoryItemsInput = {
  readonly workspaceId: string;
  readonly updatedBefore: Date;
  readonly limit?: number;
};

export type PruneTerminalMemoryItemsResult = {
  readonly status: "pruned" | "noop";
  readonly deletedCount: number;
};

export type PruneTerminalMemoryItemsAcrossWorkspacesInput = {
  readonly updatedBefore: Date;
  readonly workspaceLimit?: number;
  readonly perWorkspaceLimit?: number;
};

export type PruneTerminalMemoryItemsAcrossWorkspacesResult = {
  readonly status: "pruned" | "noop";
  readonly workspaceCount: number;
  readonly deletedCount: number;
};

export async function pruneTerminalMemoryItems(
  input: PruneTerminalMemoryItemsInput,
  dependencies: Pick<
    MemoryUseCaseDependencies,
    "memoryItems" | "memoryTransaction"
  >,
): Promise<PruneTerminalMemoryItemsResult> {
  assertValidWorkspaceId(input.workspaceId);
  assertValidCutoff(input.updatedBefore);
  const limit = normalizeItemBatchLimit(input.limit);

  const candidates = await dependencies.memoryItems.listPrunableTerminal({
    workspaceId: input.workspaceId,
    updatedBefore: input.updatedBefore,
    limit,
  });
  if (candidates.length === 0) {
    return { status: "noop", deletedCount: 0 };
  }

  const result = await dependencies.memoryTransaction.run(async (tx) => {
    const pruned = await tx.memoryItems.pruneTerminal({
      workspaceId: input.workspaceId,
      itemIds: candidates.map((candidate) => candidate.id),
      updatedBefore: input.updatedBefore,
    });
    if (pruned.deletedCount === 0) {
      return pruned;
    }

    await tx.memoryAudit.record({
      workspaceId: input.workspaceId,
      actor: "system:memory-retention",
      action: "memory.item.pruned",
      targetType: "memory_retention",
      targetId: `terminal-memory:${input.workspaceId}`,
      metadata: {
        candidateCount: candidates.length,
        deletedCount: pruned.deletedCount,
        deletedIds: pruned.deletedIds,
        updatedBefore: input.updatedBefore.toISOString(),
      },
    });
    return pruned;
  });

  return result.deletedCount === 0
    ? { status: "noop", deletedCount: 0 }
    : { status: "pruned", deletedCount: result.deletedCount };
}

export async function pruneTerminalMemoryItemsAcrossWorkspaces(
  input: PruneTerminalMemoryItemsAcrossWorkspacesInput,
  dependencies: Pick<
    MemoryUseCaseDependencies,
    "memoryItems" | "memoryTransaction"
  >,
): Promise<PruneTerminalMemoryItemsAcrossWorkspacesResult> {
  assertValidCutoff(input.updatedBefore);
  const workspaceIds =
    await dependencies.memoryItems.listWorkspaceIdsWithPrunableTerminal({
      updatedBefore: input.updatedBefore,
      limit: normalizeWorkspaceBatchLimit(input.workspaceLimit),
    });
  if (workspaceIds.length === 0) {
    return { status: "noop", workspaceCount: 0, deletedCount: 0 };
  }

  let deletedCount = 0;
  for (const workspaceId of workspaceIds) {
    const result = await pruneTerminalMemoryItems(
      {
        workspaceId,
        updatedBefore: input.updatedBefore,
        limit: normalizeItemBatchLimit(input.perWorkspaceLimit),
      },
      dependencies,
    );
    deletedCount += result.deletedCount;
  }

  return deletedCount === 0
    ? { status: "noop", workspaceCount: workspaceIds.length, deletedCount: 0 }
    : { status: "pruned", workspaceCount: workspaceIds.length, deletedCount };
}

function assertValidWorkspaceId(value: string): void {
  if (value.trim().length > 0) return;
  throw memoryError("memory_input_invalid");
}

function assertValidCutoff(value: Date): void {
  if (value instanceof Date && Number.isFinite(value.getTime())) return;
  throw memoryError("memory_input_invalid");
}

function normalizeItemBatchLimit(value: number | undefined): number {
  if (value === undefined)
    return DEFAULT_TERMINAL_MEMORY_ITEM_PRUNE_BATCH_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw memoryError("memory_input_invalid");
  }
  return Math.min(value, MAX_TERMINAL_MEMORY_ITEM_PRUNE_BATCH_LIMIT);
}

function normalizeWorkspaceBatchLimit(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_TERMINAL_MEMORY_ITEM_WORKSPACE_BATCH_LIMIT;
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    throw memoryError("memory_input_invalid");
  }
  return Math.min(value, MAX_TERMINAL_MEMORY_ITEM_WORKSPACE_BATCH_LIMIT);
}
