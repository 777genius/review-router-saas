import { MemoryError } from "../../domain/memory-errors";
import { MemorySuggestion } from "../../domain/memory-suggestion";
import type { MemoryUseCaseDependencies } from "./memory-use-case-types";

export type ExpirePendingMemorySuggestionsInput = {
  readonly workspaceId: string;
  readonly limit?: number;
};

export type ExpirePendingMemorySuggestionsResult = {
  readonly status: "expired" | "noop";
  readonly expiredCount: number;
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
        const suggestion = MemorySuggestion.fromSnapshot(snapshot).expire({
          now,
        });
        const next = suggestion.snapshot();
        await tx.memorySuggestions.save(suggestion);
        await tx.memoryAudit.record({
          workspaceId: input.workspaceId,
          actor: "system:memory-retention",
          action: "memory.suggestion.expired",
          targetType: "memory_suggestion",
          targetId: snapshot.id,
          metadata: {
            scope: snapshot.suggestedScope,
            suggestedBodyHash: snapshot.suggestedBodyHash,
            previousVersion: snapshot.version,
            version: next.version,
          },
        });
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

function normalizeRetentionBatchLimit(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value)) return 100;
  return Math.min(500, Math.max(1, value));
}
