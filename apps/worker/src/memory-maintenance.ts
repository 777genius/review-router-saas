import {
  pruneMemoryUsageEvents,
  type MemoryUsageEventRetentionPort,
} from "@reviewrouter/features-memory";
import type { DistributedLock } from "@reviewrouter/platform-locks";
import type { Logger } from "@reviewrouter/platform-logger";
import type { Clock } from "@reviewrouter/shared";
import { safeWorkerErrorSummary } from "./outbox-worker-loop";

export const memoryUsageTelemetryRetentionLockKey =
  "memory:usage-events:retention";

export type MemoryUsageTelemetryMaintenanceConfig = {
  readonly intervalMs: number;
  readonly retentionDays: number;
  readonly limit: number;
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
  assertPositiveInteger(config.intervalMs, "memory_maintenance_interval_invalid");
  assertPositiveInteger(
    config.retentionDays,
    "memory_maintenance_retention_days_invalid",
  );
  assertPositiveInteger(config.limit, "memory_maintenance_limit_invalid");
  assertPositiveInteger(config.lockTtlMs, "memory_maintenance_lock_ttl_invalid");

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

function assertPositiveInteger(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(code);
  }
}
