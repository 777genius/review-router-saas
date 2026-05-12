import { MemoryError } from "../../domain/memory-errors";
import {
  MemorySuggestion,
  type MemorySuggestionSnapshot,
} from "../../domain/memory-suggestion";
import type { MemoryTransactionalPorts } from "../ports/memory-transaction-port";
import type { MemoryUseCaseDependencies } from "./memory-use-case-types";

export type ExpirePendingMemorySuggestionsInput = {
  readonly workspaceId: string;
  readonly limit?: number;
};

export type ExpirePendingMemorySuggestionsResult = {
  readonly status: "expired" | "noop";
  readonly expiredCount: number;
};

export type ExpirePendingMemorySuggestionsAcrossWorkspacesInput = {
  readonly workspaceLimit?: number;
  readonly perWorkspaceLimit?: number;
};

export type ExpirePendingMemorySuggestionsAcrossWorkspacesResult = {
  readonly status: "expired" | "noop";
  readonly workspaceCount: number;
  readonly expiredCount: number;
};

export type ExpirePendingMemorySuggestionIfExpiredInput = {
  readonly workspaceId: string;
  readonly suggestion: MemorySuggestionSnapshot;
  readonly now: Date;
};

export async function expirePendingMemorySuggestions(
  input: ExpirePendingMemorySuggestionsInput,
  dependencies: Pick<
    MemoryUseCaseDependencies,
    "clock" | "memorySuggestions" | "memoryTransaction"
  >,
): Promise<ExpirePendingMemorySuggestionsResult> {
  const now = dependencies.clock.now();
  const expired = await dependencies.memorySuggestions.listExpiredPending({
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
        await saveExpiredSuggestion(
          {
            workspaceId: input.workspaceId,
            previous: snapshot,
            suggestion: expireSuggestionSnapshot({ snapshot, now }),
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

export async function expirePendingMemorySuggestionsAcrossWorkspaces(
  input: ExpirePendingMemorySuggestionsAcrossWorkspacesInput,
  dependencies: Pick<
    MemoryUseCaseDependencies,
    "clock" | "memorySuggestions" | "memoryTransaction"
  >,
): Promise<ExpirePendingMemorySuggestionsAcrossWorkspacesResult> {
  const now = dependencies.clock.now();
  const workspaceIds =
    await dependencies.memorySuggestions.listWorkspaceIdsWithExpiredPending({
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
    const result = await expirePendingMemorySuggestions(
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

export async function expirePendingMemorySuggestionIfExpired(
  input: ExpirePendingMemorySuggestionIfExpiredInput,
  dependencies: Pick<MemoryUseCaseDependencies, "memoryTransaction">,
): Promise<boolean> {
  if (
    input.suggestion.status !== "pending" ||
    input.suggestion.expiresAt > input.now
  ) {
    return false;
  }

  try {
    await dependencies.memoryTransaction.run(async (tx) => {
      await saveExpiredSuggestion(
        {
          workspaceId: input.workspaceId,
          previous: input.suggestion,
          suggestion: expireSuggestionSnapshot({
            snapshot: input.suggestion,
            now: input.now,
          }),
        },
        tx,
      );
    });
    return true;
  } catch (error) {
    if (
      error instanceof MemoryError &&
      error.code === "memory_version_conflict"
    ) {
      return true;
    }
    throw error;
  }
}

function expireSuggestionSnapshot(input: {
  readonly snapshot: MemorySuggestionSnapshot;
  readonly now: Date;
}): MemorySuggestion {
  return MemorySuggestion.fromSnapshot(input.snapshot).expire({
    now: input.now,
  });
}

async function saveExpiredSuggestion(
  input: {
    readonly workspaceId: string;
    readonly previous: MemorySuggestionSnapshot;
    readonly suggestion: MemorySuggestion;
  },
  tx: MemoryTransactionalPorts,
): Promise<void> {
  const next = input.suggestion.snapshot();
  await tx.memorySuggestions.save(input.suggestion);
  await tx.memoryAudit.record({
    workspaceId: input.workspaceId,
    actor: "system:memory-retention",
    action: "memory.suggestion.expired",
    targetType: "memory_suggestion",
    targetId: input.previous.id,
    metadata: {
      scope: input.previous.suggestedScope,
      suggestedBodyHash: input.previous.suggestedBodyHash,
      previousVersion: input.previous.version,
      version: next.version,
    },
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
