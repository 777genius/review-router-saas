import {
  expireActiveMemoryItemsAcrossWorkspaces,
  expirePendingMemorySuggestionsAcrossWorkspaces,
  type MemoryItemRepositoryPort,
  type MemorySuggestionRepositoryPort,
  type MemoryTransactionPort,
  pruneMemoryUsageEvents,
  pruneTerminalMemoryItemsAcrossWorkspaces,
  type MemoryUsageEventRetentionPort,
} from "@reviewrouter/features-memory";
import type { DistributedLock } from "@reviewrouter/platform-locks";
import type { Logger } from "@reviewrouter/platform-logger";
import type { Clock } from "@reviewrouter/shared";
import { safeWorkerErrorSummary } from "./outbox-worker-loop";

export const memoryUsageTelemetryRetentionLockKey =
  "memory:usage-events:retention";
export const memorySuggestionExpiryLockKey = "memory:suggestions:expire";
export const memoryItemExpiryLockKey = "memory:items:expire";
export const memoryTerminalItemPruneLockKey = "memory:items:terminal-prune";

export type MemoryUsageTelemetryMaintenanceConfig = {
  readonly intervalMs: number;
  readonly retentionDays: number;
  readonly limit: number;
  readonly lockTtlMs: number;
};

export type MemorySuggestionExpiryMaintenanceConfig = {
  readonly intervalMs: number;
  readonly workspaceLimit: number;
  readonly perWorkspaceLimit: number;
  readonly lockTtlMs: number;
};

export type MemoryItemExpiryMaintenanceConfig = {
  readonly intervalMs: number;
  readonly workspaceLimit: number;
  readonly perWorkspaceLimit: number;
  readonly lockTtlMs: number;
};

export type MemoryTerminalItemPruneMaintenanceConfig = {
  readonly intervalMs: number;
  readonly retentionDays: number;
  readonly workspaceLimit: number;
  readonly perWorkspaceLimit: number;
  readonly lockTtlMs: number;
};

export function createMemoryUsageTelemetryMaintenance(
  config: MemoryUsageTelemetryMaintenanceConfig,
  dependencies: {
    readonly clock: Clock;
    readonly usageEvents: MemoryUsageEventRetentionPort;
    readonly lock: DistributedLock;
    readonly logger: Pick<Logger, "info" | "warn">;
  },
): () => Promise<void> {
  assertPositiveInteger(
    config.intervalMs,
    "memory_maintenance_interval_invalid",
  );
  assertPositiveInteger(
    config.retentionDays,
    "memory_maintenance_retention_days_invalid",
  );
  assertPositiveInteger(config.limit, "memory_maintenance_limit_invalid");
  assertPositiveInteger(
    config.lockTtlMs,
    "memory_maintenance_lock_ttl_invalid",
  );

  let lastAttemptAtMs = 0;

  return async () => {
    const now = dependencies.clock.now();
    if (now.getTime() - lastAttemptAtMs < config.intervalMs) {
      return;
    }
    lastAttemptAtMs = now.getTime();

    try {
      await dependencies.lock.withLock(
        memoryUsageTelemetryRetentionLockKey,
        config.lockTtlMs,
        async () => {
          const result = await pruneMemoryUsageEvents(
            {
              scope: { kind: "all_workspaces" },
              occurredBefore: new Date(
                now.getTime() - config.retentionDays * 24 * 60 * 60 * 1000,
              ),
              limit: config.limit,
            },
            { memoryUsageEventRetention: dependencies.usageEvents },
          );
          if (result.deletedCount > 0) {
            dependencies.logger.info(
              "ReviewRouter pruned memory usage telemetry",
              {
                deletedCount: result.deletedCount,
                retentionDays: config.retentionDays,
              },
            );
          }
        },
      );
    } catch (error: unknown) {
      if (isMemoryUsageTelemetryRetentionLockContention(error)) {
        return;
      }
      dependencies.logger.warn(
        "ReviewRouter memory usage telemetry maintenance failed",
        {
          safeErrorSummary: safeWorkerErrorSummary(error),
        },
      );
    }
  };
}

export function isMemoryUsageTelemetryRetentionLockContention(
  error: unknown,
): boolean {
  return (
    error instanceof Error &&
    error.message ===
      `distributed_lock_not_acquired:${memoryUsageTelemetryRetentionLockKey}`
  );
}

export function createMemorySuggestionExpiryMaintenance(
  config: MemorySuggestionExpiryMaintenanceConfig,
  dependencies: {
    readonly clock: Clock;
    readonly memorySuggestions: MemorySuggestionRepositoryPort;
    readonly memoryTransaction: MemoryTransactionPort;
    readonly lock: DistributedLock;
    readonly logger: Pick<Logger, "info" | "warn">;
  },
): () => Promise<void> {
  assertPositiveInteger(
    config.intervalMs,
    "memory_suggestion_expiry_interval_invalid",
  );
  assertPositiveInteger(
    config.workspaceLimit,
    "memory_suggestion_expiry_workspace_limit_invalid",
  );
  assertPositiveInteger(
    config.perWorkspaceLimit,
    "memory_suggestion_expiry_per_workspace_limit_invalid",
  );
  assertPositiveInteger(
    config.lockTtlMs,
    "memory_suggestion_expiry_lock_ttl_invalid",
  );

  let lastAttemptAtMs = 0;

  return async () => {
    const now = dependencies.clock.now();
    if (now.getTime() - lastAttemptAtMs < config.intervalMs) {
      return;
    }
    lastAttemptAtMs = now.getTime();

    try {
      await dependencies.lock.withLock(
        memorySuggestionExpiryLockKey,
        config.lockTtlMs,
        async () => {
          const result = await expirePendingMemorySuggestionsAcrossWorkspaces(
            {
              workspaceLimit: config.workspaceLimit,
              perWorkspaceLimit: config.perWorkspaceLimit,
            },
            {
              clock: dependencies.clock,
              memorySuggestions: dependencies.memorySuggestions,
              memoryTransaction: dependencies.memoryTransaction,
            },
          );
          if (result.expiredCount > 0) {
            dependencies.logger.info(
              "ReviewRouter expired pending memory suggestions",
              {
                workspaceCount: result.workspaceCount,
                expiredCount: result.expiredCount,
              },
            );
          }
        },
      );
    } catch (error: unknown) {
      if (isMemorySuggestionExpiryLockContention(error)) {
        return;
      }
      dependencies.logger.warn(
        "ReviewRouter memory suggestion expiry maintenance failed",
        {
          safeErrorSummary: safeWorkerErrorSummary(error),
        },
      );
    }
  };
}

export function isMemorySuggestionExpiryLockContention(
  error: unknown,
): boolean {
  return (
    error instanceof Error &&
    error.message ===
      `distributed_lock_not_acquired:${memorySuggestionExpiryLockKey}`
  );
}

export function createMemoryItemExpiryMaintenance(
  config: MemoryItemExpiryMaintenanceConfig,
  dependencies: {
    readonly clock: Clock;
    readonly memoryItems: MemoryItemRepositoryPort;
    readonly memoryTransaction: MemoryTransactionPort;
    readonly lock: DistributedLock;
    readonly logger: Pick<Logger, "info" | "warn">;
  },
): () => Promise<void> {
  assertPositiveInteger(
    config.intervalMs,
    "memory_item_expiry_interval_invalid",
  );
  assertPositiveInteger(
    config.workspaceLimit,
    "memory_item_expiry_workspace_limit_invalid",
  );
  assertPositiveInteger(
    config.perWorkspaceLimit,
    "memory_item_expiry_per_workspace_limit_invalid",
  );
  assertPositiveInteger(
    config.lockTtlMs,
    "memory_item_expiry_lock_ttl_invalid",
  );

  let lastAttemptAtMs = 0;

  return async () => {
    const now = dependencies.clock.now();
    if (now.getTime() - lastAttemptAtMs < config.intervalMs) {
      return;
    }
    lastAttemptAtMs = now.getTime();

    try {
      await dependencies.lock.withLock(
        memoryItemExpiryLockKey,
        config.lockTtlMs,
        async () => {
          const result = await expireActiveMemoryItemsAcrossWorkspaces(
            {
              workspaceLimit: config.workspaceLimit,
              perWorkspaceLimit: config.perWorkspaceLimit,
            },
            {
              clock: dependencies.clock,
              memoryItems: dependencies.memoryItems,
              memoryTransaction: dependencies.memoryTransaction,
            },
          );
          if (result.expiredCount > 0) {
            dependencies.logger.info(
              "ReviewRouter expired active memory items",
              {
                workspaceCount: result.workspaceCount,
                expiredCount: result.expiredCount,
              },
            );
          }
        },
      );
    } catch (error: unknown) {
      if (isMemoryItemExpiryLockContention(error)) {
        return;
      }
      dependencies.logger.warn("ReviewRouter memory item expiry failed", {
        safeErrorSummary: safeWorkerErrorSummary(error),
      });
    }
  };
}

export function isMemoryItemExpiryLockContention(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message === `distributed_lock_not_acquired:${memoryItemExpiryLockKey}`
  );
}

export function createMemoryTerminalItemPruneMaintenance(
  config: MemoryTerminalItemPruneMaintenanceConfig,
  dependencies: {
    readonly clock: Clock;
    readonly memoryItems: MemoryItemRepositoryPort;
    readonly memoryTransaction: MemoryTransactionPort;
    readonly lock: DistributedLock;
    readonly logger: Pick<Logger, "info" | "warn">;
  },
): () => Promise<void> {
  assertPositiveInteger(
    config.intervalMs,
    "memory_terminal_item_prune_interval_invalid",
  );
  assertPositiveInteger(
    config.retentionDays,
    "memory_terminal_item_prune_retention_days_invalid",
  );
  assertPositiveInteger(
    config.workspaceLimit,
    "memory_terminal_item_prune_workspace_limit_invalid",
  );
  assertPositiveInteger(
    config.perWorkspaceLimit,
    "memory_terminal_item_prune_per_workspace_limit_invalid",
  );
  assertPositiveInteger(
    config.lockTtlMs,
    "memory_terminal_item_prune_lock_ttl_invalid",
  );

  let lastAttemptAtMs = 0;

  return async () => {
    const now = dependencies.clock.now();
    if (now.getTime() - lastAttemptAtMs < config.intervalMs) {
      return;
    }
    lastAttemptAtMs = now.getTime();

    try {
      await dependencies.lock.withLock(
        memoryTerminalItemPruneLockKey,
        config.lockTtlMs,
        async () => {
          const result = await pruneTerminalMemoryItemsAcrossWorkspaces(
            {
              updatedBefore: new Date(
                now.getTime() - config.retentionDays * 24 * 60 * 60 * 1000,
              ),
              workspaceLimit: config.workspaceLimit,
              perWorkspaceLimit: config.perWorkspaceLimit,
            },
            {
              memoryItems: dependencies.memoryItems,
              memoryTransaction: dependencies.memoryTransaction,
            },
          );
          if (result.deletedCount > 0) {
            dependencies.logger.info(
              "ReviewRouter pruned terminal memory items",
              {
                workspaceCount: result.workspaceCount,
                deletedCount: result.deletedCount,
                retentionDays: config.retentionDays,
              },
            );
          }
        },
      );
    } catch (error: unknown) {
      if (isMemoryTerminalItemPruneLockContention(error)) {
        return;
      }
      dependencies.logger.warn("ReviewRouter terminal memory prune failed", {
        safeErrorSummary: safeWorkerErrorSummary(error),
      });
    }
  };
}

export function isMemoryTerminalItemPruneLockContention(
  error: unknown,
): boolean {
  return (
    error instanceof Error &&
    error.message ===
      `distributed_lock_not_acquired:${memoryTerminalItemPruneLockKey}`
  );
}

function assertPositiveInteger(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(code);
  }
}
