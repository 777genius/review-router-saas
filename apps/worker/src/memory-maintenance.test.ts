import { describe, expect, it } from "vitest";
import {
  createDashboardMemorySource,
  evaluateMemorySafety,
  MemoryItem,
  MemorySuggestion,
  type MemoryAuditPort,
  type MemoryItemRepositoryPort,
  type MemoryItemSnapshot,
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
  createMemoryItemExpiryMaintenance,
  createMemorySuggestionExpiryMaintenance,
  createMemoryTerminalItemPruneMaintenance,
  createMemoryUsageTelemetryMaintenance,
  memoryItemExpiryLockKey,
  memorySuggestionExpiryLockKey,
  memoryTerminalItemPruneLockKey,
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
  readonly inputs: Parameters<
    MemoryUsageEventRetentionPort["pruneBefore"]
  >[0][] = [];
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

  async countPendingForWorkspace(): Promise<number> {
    throw new Error("not_implemented");
  }

  async supersedePendingBySource(): Promise<
    readonly MemorySuggestionSnapshot[]
  > {
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

class CapturingItemRepository implements MemoryItemRepositoryPort {
  readonly saved: MemoryItemSnapshot[] = [];
  readonly workspaceListInputs: {
    readonly expiredAtOrBefore: Date;
    readonly limit: number;
  }[] = [];
  readonly expiredListInputs: {
    readonly workspaceId: string;
    readonly expiredAtOrBefore: Date;
    readonly limit: number;
  }[] = [];
  readonly prunableListInputs: {
    readonly workspaceId: string;
    readonly updatedBefore: Date;
    readonly limit: number;
  }[] = [];
  readonly pruneInputs: {
    readonly workspaceId: string;
    readonly itemIds: readonly string[];
    readonly updatedBefore: Date;
  }[] = [];
  workspaceIds: readonly string[] = [];
  prunableWorkspaceIds: readonly string[] = [];
  expiredByWorkspace = new Map<string, readonly MemoryItemSnapshot[]>();
  prunableByWorkspace = new Map<string, readonly MemoryItemSnapshot[]>();

  async save(item: MemoryItem): Promise<void> {
    this.saved.push(item.snapshot());
  }

  async findById(): Promise<MemoryItemSnapshot | null> {
    throw new Error("not_implemented");
  }

  async findActiveByBodyHash(): Promise<MemoryItemSnapshot | null> {
    throw new Error("not_implemented");
  }

  async countActiveForWorkspace(): Promise<number> {
    throw new Error("not_implemented");
  }

  async listActiveForBundle(): Promise<readonly MemoryItemSnapshot[]> {
    throw new Error("not_implemented");
  }

  async listActiveByIdsForBundle(): Promise<readonly MemoryItemSnapshot[]> {
    throw new Error("not_implemented");
  }

  async listForDashboard(): Promise<readonly MemoryItemSnapshot[]> {
    throw new Error("not_implemented");
  }

  async listForExport(): Promise<{
    readonly items: readonly MemoryItemSnapshot[];
    readonly totalMatchingCount: number;
    readonly excludedDeletedCount: number;
  }> {
    throw new Error("not_implemented");
  }

  async listExpiredActive(input: {
    readonly workspaceId: string;
    readonly expiredAtOrBefore: Date;
    readonly limit: number;
  }): Promise<readonly MemoryItemSnapshot[]> {
    this.expiredListInputs.push(input);
    return this.expiredByWorkspace.get(input.workspaceId) ?? [];
  }

  async listWorkspaceIdsWithExpiredActive(input: {
    readonly expiredAtOrBefore: Date;
    readonly limit: number;
  }): Promise<readonly string[]> {
    this.workspaceListInputs.push(input);
    return this.workspaceIds.slice(0, input.limit);
  }

  async listPrunableTerminal(input: {
    readonly workspaceId: string;
    readonly updatedBefore: Date;
    readonly limit: number;
  }) {
    this.prunableListInputs.push(input);
    return (this.prunableByWorkspace.get(input.workspaceId) ?? [])
      .slice(0, input.limit)
      .map((item) => ({
        id: item.id,
        workspaceId: item.workspaceId,
        repositoryId: item.repositoryId,
        status: item.status as "expired" | "deleted",
        updatedAt: item.updatedAt,
      }));
  }

  async listWorkspaceIdsWithPrunableTerminal(input: {
    readonly updatedBefore: Date;
    readonly limit: number;
  }): Promise<readonly string[]> {
    this.prunableListInputs.push({ workspaceId: "*", ...input });
    return this.prunableWorkspaceIds.slice(0, input.limit);
  }

  async pruneTerminal(input: {
    readonly workspaceId: string;
    readonly itemIds: readonly string[];
    readonly updatedBefore: Date;
  }): Promise<{
    readonly deletedCount: number;
    readonly deletedIds: string[];
  }> {
    this.pruneInputs.push(input);
    const deletedIds = input.itemIds.filter((id) =>
      (this.prunableByWorkspace.get(input.workspaceId) ?? []).some(
        (item) => item.id === id,
      ),
    );
    return { deletedCount: deletedIds.length, deletedIds };
  }

  async markActiveItemsUsed(): Promise<{ readonly updatedCount: number }> {
    throw new Error("not_implemented");
  }

  async markIndexingSucceeded(): Promise<{ readonly updatedCount: number }> {
    throw new Error("not_implemented");
  }

  async markIndexingDeleted(): Promise<{ readonly updatedCount: number }> {
    throw new Error("not_implemented");
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
  readonly outbox = new CapturingMemoryOutbox();

  constructor(
    private readonly ports: {
      readonly items?: MemoryItemRepositoryPort;
      readonly suggestions?: MemorySuggestionRepositoryPort;
    },
  ) {}

  async run<T>(
    work: (ports: MemoryTransactionalPorts) => Promise<T>,
  ): Promise<T> {
    return work({
      memoryItems:
        this.ports.items ?? ({} as MemoryTransactionalPorts["memoryItems"]),
      memorySuggestions:
        this.ports.suggestions ??
        ({} as MemoryTransactionalPorts["memorySuggestions"]),
      memoryAudit: this.audit,
      memoryOutbox: this.outbox,
    });
  }
}

class CapturingMemoryOutbox implements MemoryOutboxPort {
  readonly events: Parameters<MemoryOutboxPort["enqueue"]>[0][] = [];

  async enqueue(
    event: Parameters<MemoryOutboxPort["enqueue"]>[0],
  ): ReturnType<MemoryOutboxPort["enqueue"]> {
    this.events.push(event);
    return { created: true };
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
    const memoryTransaction = new CapturingMemoryTransaction({
      suggestions: memorySuggestions,
    });
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

  it("expires active memory items under a distributed lock", async () => {
    const clock = new MutableClock(new Date("2026-05-12T12:00:00.000Z"));
    const memoryItems = new CapturingItemRepository();
    memoryItems.workspaceIds = ["workspace_1"];
    memoryItems.expiredByWorkspace.set("workspace_1", [
      activeMemoryItem({
        id: "mem_1",
        workspaceId: "workspace_1",
        body: "Expire worker memory item.",
        expiresAt: new Date("2026-05-12T11:59:59.000Z"),
      }),
    ]);
    const memoryTransaction = new CapturingMemoryTransaction({
      items: memoryItems,
    });
    const lock = new CapturingLock();
    const logger = new CapturingLogger();
    const runMaintenance = createMemoryItemExpiryMaintenance(
      {
        intervalMs: 60_000,
        workspaceLimit: 25,
        perWorkspaceLimit: 10,
        lockTtlMs: 120_000,
      },
      { clock, memoryItems, memoryTransaction, lock, logger },
    );

    await runMaintenance();

    expect(lock.attempts).toEqual([
      { key: memoryItemExpiryLockKey, ttlMs: 120_000 },
    ]);
    expect(memoryItems.workspaceListInputs).toEqual([
      {
        expiredAtOrBefore: new Date("2026-05-12T12:00:00.000Z"),
        limit: 25,
      },
    ]);
    expect(memoryItems.expiredListInputs).toEqual([
      {
        workspaceId: "workspace_1",
        expiredAtOrBefore: new Date("2026-05-12T12:00:00.000Z"),
        limit: 10,
      },
    ]);
    expect(memoryItems.saved).toMatchObject([
      {
        id: "mem_1",
        status: "expired",
        indexState: "index_deleted",
        indexVersion: null,
      },
    ]);
    expect(memoryTransaction.audit.records).toMatchObject([
      {
        actor: "system:memory-retention",
        action: "memory.item.expired",
        targetType: "memory_item",
        targetId: "mem_1",
      },
    ]);
    expect(memoryTransaction.outbox.events.map((event) => event.type)).toEqual([
      "memory.item.expired",
      "memory.embedding.delete.requested",
    ]);
    expect(JSON.stringify(memoryTransaction.audit.records)).not.toContain(
      "Expire worker memory item.",
    );
    expect(JSON.stringify(memoryTransaction.outbox.events)).not.toContain(
      "Expire worker memory item.",
    );
    expect(logger.infoEvents).toHaveLength(1);
    expect(logger.warnEvents).toHaveLength(0);
  });

  it("treats memory item expiry lock contention as expected", async () => {
    const lock = new CapturingLock();
    lock.error = new Error(
      `distributed_lock_not_acquired:${memoryItemExpiryLockKey}`,
    );
    const logger = new CapturingLogger();
    const memoryItems = new CapturingItemRepository();
    const runMaintenance = createMemoryItemExpiryMaintenance(
      {
        intervalMs: 60_000,
        workspaceLimit: 25,
        perWorkspaceLimit: 10,
        lockTtlMs: 120_000,
      },
      {
        clock: new MutableClock(new Date("2026-05-12T12:00:00.000Z")),
        memoryItems,
        memoryTransaction: new CapturingMemoryTransaction({
          items: memoryItems,
        }),
        lock,
        logger,
      },
    );

    await runMaintenance();

    expect(logger.infoEvents).toHaveLength(0);
    expect(logger.warnEvents).toHaveLength(0);
  });

  it("prunes terminal memory items under a distributed lock", async () => {
    const clock = new MutableClock(new Date("2026-05-12T12:00:00.000Z"));
    const memoryItems = new CapturingItemRepository();
    memoryItems.prunableWorkspaceIds = ["workspace_1"];
    memoryItems.prunableByWorkspace.set("workspace_1", [
      {
        ...activeMemoryItem({
          id: "mem_1",
          workspaceId: "workspace_1",
          body: "Prune worker terminal memory item.",
          expiresAt: new Date("2026-04-01T12:00:00.000Z"),
        }),
        status: "expired",
        updatedAt: new Date("2026-04-11T11:59:59.000Z"),
        indexState: "index_deleted",
        indexVersion: null,
      },
    ]);
    const memoryTransaction = new CapturingMemoryTransaction({
      items: memoryItems,
    });
    const lock = new CapturingLock();
    const logger = new CapturingLogger();
    const runMaintenance = createMemoryTerminalItemPruneMaintenance(
      {
        intervalMs: 60_000,
        retentionDays: 30,
        workspaceLimit: 25,
        perWorkspaceLimit: 10,
        lockTtlMs: 120_000,
      },
      { clock, memoryItems, memoryTransaction, lock, logger },
    );

    await runMaintenance();

    expect(lock.attempts).toEqual([
      { key: memoryTerminalItemPruneLockKey, ttlMs: 120_000 },
    ]);
    expect(memoryItems.prunableListInputs).toEqual([
      {
        workspaceId: "*",
        updatedBefore: new Date("2026-04-12T12:00:00.000Z"),
        limit: 25,
      },
      {
        workspaceId: "workspace_1",
        updatedBefore: new Date("2026-04-12T12:00:00.000Z"),
        limit: 10,
      },
    ]);
    expect(memoryItems.pruneInputs).toEqual([
      {
        workspaceId: "workspace_1",
        itemIds: ["mem_1"],
        updatedBefore: new Date("2026-04-12T12:00:00.000Z"),
      },
    ]);
    expect(memoryTransaction.audit.records).toMatchObject([
      {
        actor: "system:memory-retention",
        action: "memory.item.pruned",
        targetType: "memory_retention",
        targetId: "terminal-memory:workspace_1",
        metadata: {
          candidateCount: 1,
          deletedCount: 1,
          deletedIds: ["mem_1"],
        },
      },
    ]);
    expect(JSON.stringify(memoryTransaction.audit.records)).not.toContain(
      "Prune worker terminal memory item.",
    );
    expect(logger.infoEvents).toHaveLength(1);
    expect(logger.warnEvents).toHaveLength(0);
  });

  it("treats terminal memory prune lock contention as expected", async () => {
    const lock = new CapturingLock();
    lock.error = new Error(
      `distributed_lock_not_acquired:${memoryTerminalItemPruneLockKey}`,
    );
    const logger = new CapturingLogger();
    const memoryItems = new CapturingItemRepository();
    const runMaintenance = createMemoryTerminalItemPruneMaintenance(
      {
        intervalMs: 60_000,
        retentionDays: 30,
        workspaceLimit: 25,
        perWorkspaceLimit: 10,
        lockTtlMs: 120_000,
      },
      {
        clock: new MutableClock(new Date("2026-05-12T12:00:00.000Z")),
        memoryItems,
        memoryTransaction: new CapturingMemoryTransaction({
          items: memoryItems,
        }),
        lock,
        logger,
      },
    );

    await runMaintenance();

    expect(logger.infoEvents).toHaveLength(0);
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
        memoryTransaction: new CapturingMemoryTransaction({
          suggestions: memorySuggestions,
        }),
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

function activeMemoryItem(input: {
  readonly id: string;
  readonly workspaceId: string;
  readonly body: string;
  readonly expiresAt: Date;
}): MemoryItemSnapshot {
  return {
    ...MemoryItem.create({
      id: input.id,
      workspaceId: input.workspaceId,
      repositoryId: "repo_1",
      userId: null,
      scope: "repository",
      body: input.body,
      riskLevel: "low",
      confidence: 1,
      source: createDashboardMemorySource({ actorLogin: "maintainer" }),
      policyVersion: 1,
      safetyPolicyVersion: 1,
      actor: {
        kind: "github_user",
        id: "user_1",
        githubUserId: "1001",
        login: "maintainer",
      },
      now: new Date("2026-05-11T12:00:00.000Z"),
    }).snapshot(),
    expiresAt: input.expiresAt,
  };
}
