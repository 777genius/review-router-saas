import { describe, expect, it } from "vitest";
import type { MemoryUsageEventRetentionPort } from "@reviewrouter/features-memory";
import type { DistributedLock } from "@reviewrouter/platform-locks";
import type { Logger } from "@reviewrouter/platform-logger";
import type { Clock } from "@reviewrouter/shared";
import {
  createMemoryUsageTelemetryMaintenance,
  memoryUsageTelemetryRetentionLockKey,
} from "./memory-maintenance";

class MutableClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return this.current;
  }

  set(value: Date): void {
    this.current = value;
  }
}

class CapturingRetention implements MemoryUsageEventRetentionPort {
  readonly inputs: Parameters<MemoryUsageEventRetentionPort["pruneBefore"]>[0][] =
    [];
  deletedCount = 0;

  async pruneBefore(
    input: Parameters<MemoryUsageEventRetentionPort["pruneBefore"]>[0],
  ): Promise<{ readonly deletedCount: number }> {
    this.inputs.push(input);
    return { deletedCount: this.deletedCount };
  }
}

class CapturingLock implements DistributedLock {
  readonly attempts: { readonly key: string; readonly ttlMs: number }[] = [];
  error: Error | null = null;

  async withLock<T>(
    key: string,
    ttlMs: number,
    run: () => Promise<T>,
  ): Promise<T> {
    this.attempts.push({ key, ttlMs });
    if (this.error) {
      throw this.error;
    }
    return run();
  }
}

class CapturingLogger implements Pick<Logger, "info" | "warn"> {
  readonly infoEvents: unknown[] = [];
  readonly warnEvents: unknown[] = [];

  info(message: string, metadata?: unknown): void {
    this.infoEvents.push({ message, metadata });
  }

  warn(message: string, metadata?: unknown): void {
    this.warnEvents.push({ message, metadata });
  }
}

describe("memory maintenance", () => {
  it("prunes usage telemetry under a distributed lock", async () => {
    const clock = new MutableClock(new Date("2026-05-12T12:00:00.000Z"));
    const usageEvents = new CapturingRetention();
    usageEvents.deletedCount = 3;
    const lock = new CapturingLock();
    const logger = new CapturingLogger();
    const runMaintenance = createMemoryUsageTelemetryMaintenance(
      {
        intervalMs: 60_000,
        retentionDays: 180,
        limit: 500,
        lockTtlMs: 120_000,
      },
      { clock, usageEvents, lock, logger },
    );

    await runMaintenance();

    expect(lock.attempts).toEqual([
      { key: memoryUsageTelemetryRetentionLockKey, ttlMs: 120_000 },
    ]);
    expect(usageEvents.inputs).toEqual([
      {
        scope: { kind: "all_workspaces" },
        occurredBefore: new Date("2025-11-13T12:00:00.000Z"),
        limit: 500,
      },
    ]);
    expect(logger.infoEvents).toHaveLength(1);
    expect(logger.warnEvents).toHaveLength(0);
  });

  it("honors maintenance interval to avoid hot-loop pruning", async () => {
    const clock = new MutableClock(new Date("2026-05-12T12:00:00.000Z"));
    const usageEvents = new CapturingRetention();
    const runMaintenance = createMemoryUsageTelemetryMaintenance(
      {
        intervalMs: 60_000,
        retentionDays: 180,
        limit: 500,
        lockTtlMs: 120_000,
      },
      {
        clock,
        usageEvents,
        lock: new CapturingLock(),
        logger: new CapturingLogger(),
      },
    );

    await runMaintenance();
    clock.set(new Date("2026-05-12T12:00:30.000Z"));
    await runMaintenance();
    clock.set(new Date("2026-05-12T12:01:00.000Z"));
    await runMaintenance();

    expect(usageEvents.inputs).toHaveLength(2);
  });

  it("treats distributed lock contention as expected", async () => {
    const lock = new CapturingLock();
    lock.error = new Error(
      `distributed_lock_not_acquired:${memoryUsageTelemetryRetentionLockKey}`,
    );
    const logger = new CapturingLogger();
    const runMaintenance = createMemoryUsageTelemetryMaintenance(
      {
        intervalMs: 60_000,
        retentionDays: 180,
        limit: 500,
        lockTtlMs: 120_000,
      },
      {
        clock: new MutableClock(new Date("2026-05-12T12:00:00.000Z")),
        usageEvents: new CapturingRetention(),
        lock,
        logger,
      },
    );

    await runMaintenance();

    expect(logger.infoEvents).toHaveLength(0);
    expect(logger.warnEvents).toHaveLength(0);
  });
});
