import { describe, expect, it } from "vitest";
import {
  createDashboardMemorySource,
  evaluateMemorySafety,
  MemorySuggestion,
  type MemoryAuditPort,
  type MemoryOutboxPort,
  type MemorySuggestionRepositoryPort,
  type MemorySuggestionSnapshot,
  type MemoryTransactionPort,
  type MemoryTransactionalPorts,
  type MemoryUsageEventRetentionPort,
} from "@reviewrouter/features-memory";
import type { DistributedLock } from "@reviewrouter/platform-locks";
import type { Logger } from "@reviewrouter/platform-logger";
import type { Clock } from "@reviewrouter/shared";
import {
  createMemorySuggestionExpiryMaintenance,
  createMemoryUsageTelemetryMaintenance,
  memorySuggestionExpiryLockKey,
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

class CapturingSuggestionRepository implements MemorySuggestionRepositoryPort {
  readonly saved: MemorySuggestionSnapshot[] = [];
  readonly workspaceListInputs: {
    readonly expiredAtOrBefore: Date;
    readonly limit: number;
  }[] = [];
  readonly expiredListInputs: {
    readonly workspaceId: string;
    readonly expiredAtOrBefore: Date;
    readonly limit: number;
  }[] = [];
  workspaceIds: readonly string[] = [];
  expiredByWorkspace = new Map<string, readonly MemorySuggestionSnapshot[]>();

  async save(suggestion: MemorySuggestion): Promise<void> {
    this.saved.push(suggestion.snapshot());
  }

  async findById(): Promise<MemorySuggestionSnapshot | null> {
    throw new Error("not_implemented");
  }

  async findPendingByDedupeKey(): Promise<MemorySuggestionSnapshot | null> {
    throw new Error("not_implemented");
  }

  async listForDashboard(): Promise<readonly MemorySuggestionSnapshot[]> {
    throw new Error("not_implemented");
  }

  async listExpiredPending(input: {
    readonly workspaceId: string;
    readonly expiredAtOrBefore: Date;
    readonly limit: number;
  }): Promise<readonly MemorySuggestionSnapshot[]> {
    this.expiredListInputs.push(input);
    return this.expiredByWorkspace.get(input.workspaceId) ?? [];
  }

  async listWorkspaceIdsWithExpiredPending(input: {
    readonly expiredAtOrBefore: Date;
    readonly limit: number;
  }): Promise<readonly string[]> {
    this.workspaceListInputs.push(input);
    return this.workspaceIds.slice(0, input.limit);
  }
}

class CapturingMemoryAudit implements MemoryAuditPort {
  readonly records: Parameters<MemoryAuditPort["record"]>[0][] = [];

  async record(input: Parameters<MemoryAuditPort["record"]>[0]): Promise<void> {
    this.records.push(input);
  }
}

class CapturingMemoryTransaction implements MemoryTransactionPort {
  readonly audit = new CapturingMemoryAudit();

  constructor(private readonly suggestions: MemorySuggestionRepositoryPort) {}

  async run<T>(
    work: (ports: MemoryTransactionalPorts) => Promise<T>,
  ): Promise<T> {
    return work({
      memoryItems: {} as MemoryTransactionalPorts["memoryItems"],
      memorySuggestions: this.suggestions,
      memoryAudit: this.audit,
      memoryOutbox: {} as MemoryOutboxPort,
    });
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

  it("expires pending suggestions under a distributed lock", async () => {
    const clock = new MutableClock(new Date("2026-05-12T12:00:00.000Z"));
    const memorySuggestions = new CapturingSuggestionRepository();
    memorySuggestions.workspaceIds = ["workspace_1"];
    memorySuggestions.expiredByWorkspace.set("workspace_1", [
      pendingSuggestion({
        id: "mem_suggestion_1",
        workspaceId: "workspace_1",
        expiresAt: new Date("2026-05-12T11:59:59.000Z"),
      }),
    ]);
    const memoryTransaction = new CapturingMemoryTransaction(memorySuggestions);
    const lock = new CapturingLock();
    const logger = new CapturingLogger();
    const runMaintenance = createMemorySuggestionExpiryMaintenance(
      {
        intervalMs: 60_000,
        workspaceLimit: 25,
        perWorkspaceLimit: 10,
        lockTtlMs: 120_000,
      },
      { clock, memorySuggestions, memoryTransaction, lock, logger },
    );

    await runMaintenance();

    expect(lock.attempts).toEqual([
      { key: memorySuggestionExpiryLockKey, ttlMs: 120_000 },
    ]);
    expect(memorySuggestions.workspaceListInputs).toEqual([
      {
        expiredAtOrBefore: new Date("2026-05-12T12:00:00.000Z"),
        limit: 25,
      },
    ]);
    expect(memorySuggestions.expiredListInputs).toEqual([
      {
        workspaceId: "workspace_1",
        expiredAtOrBefore: new Date("2026-05-12T12:00:00.000Z"),
        limit: 10,
      },
    ]);
    expect(memorySuggestions.saved).toMatchObject([
      {
        id: "mem_suggestion_1",
        status: "expired",
        resolvedBy: "system:memory-retention",
      },
    ]);
    expect(memoryTransaction.audit.records).toHaveLength(1);
    expect(logger.infoEvents).toHaveLength(1);
    expect(logger.warnEvents).toHaveLength(0);
  });

  it("treats suggestion expiry lock contention as expected", async () => {
    const lock = new CapturingLock();
    lock.error = new Error(
      `distributed_lock_not_acquired:${memorySuggestionExpiryLockKey}`,
    );
    const logger = new CapturingLogger();
    const memorySuggestions = new CapturingSuggestionRepository();
    const runMaintenance = createMemorySuggestionExpiryMaintenance(
      {
        intervalMs: 60_000,
        workspaceLimit: 25,
        perWorkspaceLimit: 10,
        lockTtlMs: 120_000,
      },
      {
        clock: new MutableClock(new Date("2026-05-12T12:00:00.000Z")),
        memorySuggestions,
        memoryTransaction: new CapturingMemoryTransaction(memorySuggestions),
        lock,
        logger,
      },
    );

    await runMaintenance();

    expect(logger.infoEvents).toHaveLength(0);
    expect(logger.warnEvents).toHaveLength(0);
  });
});

function pendingSuggestion(input: {
  readonly id: string;
  readonly workspaceId: string;
  readonly expiresAt: Date;
}): MemorySuggestionSnapshot {
  return MemorySuggestion.createPending({
    id: input.id,
    workspaceId: input.workspaceId,
    repositoryId: "repo_1",
    userId: "user_1",
    suggestedScope: "repository",
    suggestedBody: "Expire worker suggestion.",
    reason: "explicit_natural_language",
    source: createDashboardMemorySource({ actorLogin: "maintainer" }),
    safetyReport: evaluateMemorySafety({
      body: "Expire worker suggestion.",
      scope: "repository",
    }),
    policyVersion: 1,
    safetyPolicyVersion: 1,
    actor: {
      kind: "github_user",
      id: "user_1",
      githubUserId: "1001",
      login: "maintainer",
    },
    expiresAt: input.expiresAt,
    dedupeKey: `dedupe:${input.id}`,
    now: new Date("2026-05-11T12:00:00.000Z"),
  }).snapshot();
}
