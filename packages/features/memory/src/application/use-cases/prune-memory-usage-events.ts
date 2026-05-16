import { memoryError } from "../../domain/memory-errors";
import type {
  MemoryUsageEventRetentionPort,
  MemoryUsageEventRetentionScope,
} from "../ports/memory-usage-event-retention-port";

const DEFAULT_MEMORY_USAGE_RETENTION_BATCH_LIMIT = 1000;
const MAX_MEMORY_USAGE_RETENTION_BATCH_LIMIT = 5000;

export type PruneMemoryUsageEventsInput = {
  readonly scope: MemoryUsageEventRetentionScope;
  readonly occurredBefore: Date;
  readonly limit?: number;
};

export type PruneMemoryUsageEventsResult = {
  readonly status: "pruned" | "noop";
  readonly deletedCount: number;
};

export async function pruneMemoryUsageEvents(
  input: PruneMemoryUsageEventsInput,
  dependencies: {
    readonly memoryUsageEventRetention: MemoryUsageEventRetentionPort;
  },
): Promise<PruneMemoryUsageEventsResult> {
  assertValidRetentionScope(input.scope);
  assertValidCutoff(input.occurredBefore);

  const result = await dependencies.memoryUsageEventRetention.pruneBefore({
    scope: input.scope,
    occurredBefore: input.occurredBefore,
    limit: normalizeRetentionBatchLimit(input.limit),
  });

  return result.deletedCount === 0
    ? { status: "noop", deletedCount: 0 }
    : { status: "pruned", deletedCount: result.deletedCount };
}

function assertValidRetentionScope(
  scope: MemoryUsageEventRetentionScope,
): void {
  if (scope.kind === "all_workspaces") return;
  if (scope.workspaceId.trim().length > 0) return;
  throw memoryError("memory_input_invalid");
}

function assertValidCutoff(value: Date): void {
  if (value instanceof Date && Number.isFinite(value.getTime())) return;
  throw memoryError("memory_input_invalid");
}

function normalizeRetentionBatchLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MEMORY_USAGE_RETENTION_BATCH_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw memoryError("memory_input_invalid");
  }
  return Math.min(value, MAX_MEMORY_USAGE_RETENTION_BATCH_LIMIT);
}
