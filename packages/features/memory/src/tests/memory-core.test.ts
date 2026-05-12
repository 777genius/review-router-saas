import { describe, expect, it } from "vitest";
import type { Clock } from "@reviewrouter/shared";
import { memoryActorRef, type MemoryActor } from "../domain/memory-actor";
import {
  createMemoryBodyHash,
  deletedMemoryBodyPlaceholder,
  normalizeMemoryBody,
} from "../domain/memory-body";
import type { MemoryCandidateEnvelope } from "../domain/memory-candidate";
import { MemoryError, memoryError } from "../domain/memory-errors";
import { parseMemoryIntent } from "../domain/memory-intent-policy";
import { MemoryItem, type MemoryItemSnapshot } from "../domain/memory-item";
import type { MemoryScope } from "../domain/memory-scope-policy";
import { createDashboardMemorySource } from "../domain/memory-source";
import {
  MemorySuggestion,
  type MemorySuggestionSnapshot,
  type MemorySuggestionStatus,
} from "../domain/memory-suggestion";
import type {
  MemoryAuditEvent,
  MemoryAuditPort,
} from "../application/ports/memory-audit-port";
import type { MemoryIdGeneratorPort } from "../application/ports/memory-id-generator-port";
import type {
  MarkActiveMemoryItemsUsedInput,
  MarkActiveMemoryItemsUsedResult,
  MemoryDashboardRepositoryCursor,
  MemoryItemRepositoryPort,
} from "../application/ports/memory-item-repository-port";
import type {
  MemoryOutboxEvent,
  MemoryOutboxPort,
} from "../application/ports/memory-outbox-port";
import type {
  MemoryPermissionDecision,
  MemoryPermissionPort,
} from "../application/ports/memory-permission-port";
import {
  StaticMemoryPolicyConfig,
  type MemoryPolicyConfigOverrides,
} from "../application/ports/memory-policy-config-port";
import type {
  MemoryQuotaPolicyPort,
  MemoryWorkspaceQuota,
} from "../application/ports/memory-quota-policy-port";
import type {
  MemoryIndexDocument,
  MemorySearchCapability,
  MemorySearchIndexInput,
  MemorySearchIndexPort,
  MemorySearchIndexResult,
} from "../application/ports/memory-search-index-port";
import type {
  MemorySuggestionDashboardRepositoryCursor,
  MemorySuggestionRepositoryPort,
} from "../application/ports/memory-suggestion-repository-port";
import type { MemoryTransactionPort } from "../application/ports/memory-transaction-port";
import type {
  MemoryUsageEventInput,
  MemoryUsageEventPort,
} from "../application/ports/memory-usage-event-port";
import type {
  MemoryUsageEventRetentionPruneInput,
  MemoryUsageEventRetentionPort,
} from "../application/ports/memory-usage-event-retention-port";
import { buildActionMemoryBundle } from "../application/use-cases/build-action-memory-bundle";
import { confirmMemorySuggestion } from "../application/use-cases/confirm-memory-suggestion";
import { deleteMemoryItem } from "../application/use-cases/delete-memory-item";
import { disableMemoryItem } from "../application/use-cases/disable-memory-item";
import { editMemoryItem } from "../application/use-cases/edit-memory-item";
import {
  exportMemoryItems,
  stringifyMemoryExport,
} from "../application/use-cases/export-memory-items";
import {
  expireActiveMemoryItems,
  expireActiveMemoryItemsAcrossWorkspaces,
} from "../application/use-cases/expire-active-memory-items";
import {
  expirePendingMemorySuggestions,
  expirePendingMemorySuggestionsAcrossWorkspaces,
} from "../application/use-cases/expire-pending-memory-suggestions";
import { listMemoryItemsForDashboard } from "../application/use-cases/list-memory-items-for-dashboard";
import { listMemorySuggestionsForDashboard } from "../application/use-cases/list-memory-suggestions-for-dashboard";
import { proposeMemoryFromInteraction } from "../application/use-cases/propose-memory-from-interaction";
import { pruneMemoryUsageEvents } from "../application/use-cases/prune-memory-usage-events";
import {
  pruneTerminalMemoryItems,
  pruneTerminalMemoryItemsAcrossWorkspaces,
} from "../application/use-cases/prune-terminal-memory-items";
import { recordActionMemoryBundleUsage } from "../application/use-cases/record-action-memory-bundle-usage";
import { rememberMemoryDirectly } from "../application/use-cases/remember-memory-directly";
import { rejectMemorySuggestion } from "../application/use-cases/reject-memory-suggestion";

const now = new Date("2026-05-12T12:00:00.000Z");
const clock: Clock = { now: () => now };

class IncrementingIds implements MemoryIdGeneratorPort {
  private next = 1;

  newId(prefix: "mem" | "mem_suggestion" | "mem_usage"): string {
    const id = `${prefix}_${this.next}`;
    this.next += 1;
    return id;
  }
}

class InMemoryItems implements MemoryItemRepositoryPort {
  readonly items = new Map<string, MemoryItemSnapshot>();

  async save(
    item: MemoryItem,
    options?: {
      readonly expectedVersion?: number;
    },
  ): Promise<void> {
    const snapshot = item.snapshot();
    if (options?.expectedVersion !== undefined) {
      const existing = this.items.get(snapshot.id);
      if (!existing || existing.version !== options.expectedVersion) {
        throw memoryError("memory_version_conflict", true);
      }
    }
    this.items.set(snapshot.id, snapshot);
  }

  async findById(input: {
    readonly workspaceId: string;
    readonly itemId: string;
  }): Promise<MemoryItemSnapshot | null> {
    const item = this.items.get(input.itemId);
    if (!item || item.workspaceId !== input.workspaceId) {
      return null;
    }
    return item;
  }

  async findActiveByBodyHash(input: {
    readonly workspaceId: string;
    readonly scope: MemoryScope;
    readonly repositoryId: string | null;
    readonly userId: string | null;
    readonly bodyHash: string;
  }): Promise<MemoryItemSnapshot | null> {
    return (
      [...this.items.values()].find(
        (item) =>
          item.workspaceId === input.workspaceId &&
          item.scope === input.scope &&
          item.repositoryId === input.repositoryId &&
          item.userId === input.userId &&
          item.bodyHash === input.bodyHash &&
          (item.status === "active" || item.status === "disabled"),
      ) ?? null
    );
  }

  async countActiveForWorkspace(input: {
    readonly workspaceId: string;
  }): Promise<number> {
    return [...this.items.values()].filter(
      (item) =>
        item.workspaceId === input.workspaceId && item.status === "active",
    ).length;
  }

  async listActiveForBundle(input: {
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly userId: string | null;
    readonly limit: number;
  }): Promise<readonly MemoryItemSnapshot[]> {
    return [...this.items.values()]
      .filter((item) => item.workspaceId === input.workspaceId)
      .filter((item) => item.status === "active")
      .filter(
        (item) =>
          item.scope === "workspace" ||
          (item.scope === "repository" &&
            item.repositoryId === input.repositoryId) ||
          (item.scope === "user_prefs" && item.userId === input.userId),
      )
      .slice(0, input.limit);
  }

  async listActiveByIdsForBundle(input: {
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly userId: string | null;
    readonly itemIds: readonly string[];
    readonly limit: number;
  }): Promise<readonly MemoryItemSnapshot[]> {
    const itemIds = new Set(input.itemIds);
    return [...this.items.values()]
      .filter((item) => itemIds.has(item.id))
      .filter((item) => item.workspaceId === input.workspaceId)
      .filter((item) => item.status === "active")
      .filter(
        (item) =>
          item.scope === "workspace" ||
          (item.scope === "repository" &&
            item.repositoryId === input.repositoryId) ||
          (item.scope === "user_prefs" && item.userId === input.userId),
      )
      .sort(
        (left, right) =>
          input.itemIds.indexOf(left.id) - input.itemIds.indexOf(right.id),
      )
      .slice(0, input.limit);
  }

  async listForDashboard(input: {
    readonly workspaceId: string;
    readonly repositoryId?: string | null;
    readonly scope?: MemoryScope;
    readonly statuses: readonly MemoryItemSnapshot["status"][];
    readonly limit: number;
    readonly cursor?: MemoryDashboardRepositoryCursor;
  }): Promise<readonly MemoryItemSnapshot[]> {
    return [...this.items.values()]
      .filter((item) => item.workspaceId === input.workspaceId)
      .filter((item) =>
        input.repositoryId === undefined
          ? true
          : item.repositoryId === input.repositoryId,
      )
      .filter((item) => (input.scope ? item.scope === input.scope : true))
      .filter((item) => input.statuses.includes(item.status))
      .sort(compareDashboardRecords)
      .filter((item) =>
        input.cursor ? isAfterDashboardCursor(item, input.cursor) : true,
      )
      .slice(0, input.limit);
  }

  async listForExport(input: {
    readonly workspaceId: string;
    readonly statuses: readonly Exclude<
      MemoryItemSnapshot["status"],
      "deleted"
    >[];
    readonly limit: number;
  }) {
    const exportable = [...this.items.values()]
      .filter((item) => item.workspaceId === input.workspaceId)
      .filter((item) =>
        (input.statuses as readonly MemoryItemSnapshot["status"][]).includes(
          item.status,
        ),
      )
      .sort((left, right) => {
        const createdAtDelta =
          left.createdAt.getTime() - right.createdAt.getTime();
        if (createdAtDelta !== 0) return createdAtDelta;
        return left.id.localeCompare(right.id);
      });
    return {
      items: exportable.slice(0, input.limit),
      totalMatchingCount: exportable.length,
      excludedDeletedCount: [...this.items.values()].filter(
        (item) =>
          item.workspaceId === input.workspaceId && item.status === "deleted",
      ).length,
    };
  }

  async listExpiredActive(input: {
    readonly workspaceId: string;
    readonly expiredAtOrBefore: Date;
    readonly limit: number;
  }): Promise<readonly MemoryItemSnapshot[]> {
    return [...this.items.values()]
      .filter((item) => item.workspaceId === input.workspaceId)
      .filter((item) => item.status === "active")
      .filter(
        (item) =>
          item.expiresAt !== null && item.expiresAt <= input.expiredAtOrBefore,
      )
      .sort((left, right) => {
        const expiresAtDelta =
          (left.expiresAt?.getTime() ?? 0) - (right.expiresAt?.getTime() ?? 0);
        if (expiresAtDelta !== 0) return expiresAtDelta;
        return left.id.localeCompare(right.id);
      })
      .slice(0, input.limit);
  }

  async listWorkspaceIdsWithExpiredActive(input: {
    readonly expiredAtOrBefore: Date;
    readonly limit: number;
  }): Promise<readonly string[]> {
    return [
      ...new Set(
        [...this.items.values()]
          .filter((item) => item.status === "active")
          .filter(
            (item) =>
              item.expiresAt !== null &&
              item.expiresAt <= input.expiredAtOrBefore,
          )
          .sort((left, right) => {
            const expiresAtDelta =
              (left.expiresAt?.getTime() ?? 0) -
              (right.expiresAt?.getTime() ?? 0);
            if (expiresAtDelta !== 0) return expiresAtDelta;
            return left.workspaceId.localeCompare(right.workspaceId);
          })
          .map((item) => item.workspaceId),
      ),
    ].slice(0, input.limit);
  }

  async listPrunableTerminal(input: {
    readonly workspaceId: string;
    readonly updatedBefore: Date;
    readonly limit: number;
  }) {
    return [...this.items.values()]
      .filter((item) => item.workspaceId === input.workspaceId)
      .filter((item) => item.status === "expired" || item.status === "deleted")
      .filter((item) => item.updatedAt < input.updatedBefore)
      .sort((left, right) => {
        const updatedAtDelta =
          left.updatedAt.getTime() - right.updatedAt.getTime();
        if (updatedAtDelta !== 0) return updatedAtDelta;
        return left.id.localeCompare(right.id);
      })
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
    return [
      ...new Set(
        [...this.items.values()]
          .filter(
            (item) => item.status === "expired" || item.status === "deleted",
          )
          .filter((item) => item.updatedAt < input.updatedBefore)
          .sort((left, right) =>
            left.workspaceId.localeCompare(right.workspaceId),
          )
          .map((item) => item.workspaceId),
      ),
    ].slice(0, input.limit);
  }

  async pruneTerminal(input: {
    readonly workspaceId: string;
    readonly itemIds: readonly string[];
    readonly updatedBefore: Date;
  }): Promise<{
    readonly deletedCount: number;
    readonly deletedIds: string[];
  }> {
    const itemIds = new Set(input.itemIds);
    const deletedIds: string[] = [];
    for (const [id, item] of this.items.entries()) {
      if (
        item.workspaceId !== input.workspaceId ||
        !itemIds.has(id) ||
        (item.status !== "expired" && item.status !== "deleted") ||
        item.updatedAt >= input.updatedBefore
      ) {
        continue;
      }
      this.items.delete(id);
      deletedIds.push(id);
    }
    return { deletedCount: deletedIds.length, deletedIds };
  }

  async markActiveItemsUsed(
    input: MarkActiveMemoryItemsUsedInput,
  ): Promise<MarkActiveMemoryItemsUsedResult> {
    const itemIds = new Set(input.itemIds);
    let updatedCount = 0;
    for (const [id, item] of this.items.entries()) {
      if (
        item.workspaceId !== input.workspaceId ||
        item.status !== "active" ||
        !itemIds.has(id)
      ) {
        continue;
      }
      this.items.set(id, { ...item, lastUsedAt: input.usedAt });
      updatedCount += 1;
    }
    return { updatedCount };
  }

  async markIndexingSucceeded(input: {
    readonly workspaceId: string;
    readonly itemId: string;
    readonly bodyHash: string;
    readonly bodyVersion: number;
  }): Promise<{ readonly updatedCount: number }> {
    const item = this.items.get(input.itemId);
    if (
      !item ||
      item.workspaceId !== input.workspaceId ||
      item.status !== "active" ||
      item.bodyHash !== input.bodyHash ||
      item.bodyVersion !== input.bodyVersion
    ) {
      return { updatedCount: 0 };
    }
    this.items.set(input.itemId, {
      ...item,
      indexState: "indexed",
      indexVersion: input.bodyVersion,
    });
    return { updatedCount: 1 };
  }

  async markIndexingDeleted(input: {
    readonly workspaceId: string;
    readonly itemId: string;
  }): Promise<{ readonly updatedCount: number }> {
    const item = this.items.get(input.itemId);
    if (
      !item ||
      item.workspaceId !== input.workspaceId ||
      item.status === "active"
    ) {
      return { updatedCount: 0 };
    }
    this.items.set(input.itemId, {
      ...item,
      indexState: "index_deleted",
      indexVersion: null,
    });
    return { updatedCount: 1 };
  }
}

class InMemorySuggestions implements MemorySuggestionRepositoryPort {
  readonly suggestions = new Map<string, MemorySuggestionSnapshot>();

  async save(suggestion: MemorySuggestion): Promise<void> {
    this.suggestions.set(suggestion.snapshot().id, suggestion.snapshot());
  }

  async findById(input: {
    readonly workspaceId: string;
    readonly suggestionId: string;
  }): Promise<MemorySuggestionSnapshot | null> {
    const suggestion = this.suggestions.get(input.suggestionId);
    if (!suggestion || suggestion.workspaceId !== input.workspaceId) {
      return null;
    }
    return suggestion;
  }

  async findPendingByDedupeKey(input: {
    readonly workspaceId: string;
    readonly dedupeKey: string;
  }): Promise<MemorySuggestionSnapshot | null> {
    return (
      [...this.suggestions.values()].find(
        (suggestion) =>
          suggestion.workspaceId === input.workspaceId &&
          suggestion.dedupeKey === input.dedupeKey &&
          suggestion.status === "pending",
      ) ?? null
    );
  }

  async countPendingForWorkspace(input: {
    readonly workspaceId: string;
    readonly notExpiredAt?: Date;
  }): Promise<number> {
    return [...this.suggestions.values()].filter(
      (suggestion) =>
        suggestion.workspaceId === input.workspaceId &&
        suggestion.status === "pending" &&
        (!input.notExpiredAt || suggestion.expiresAt > input.notExpiredAt),
    ).length;
  }

  async supersedePendingBySource(input: {
    readonly workspaceId: string;
    readonly repositoryId: string | null;
    readonly userId: string | null;
    readonly scope: MemoryScope;
    readonly sourceType: MemorySuggestionSnapshot["source"]["type"];
    readonly sourceId: string;
    readonly createdByActor: MemoryActor;
    readonly replacementSuggestionId: string;
    readonly excludeSuggestionId: string;
    readonly supersededAt: Date;
    readonly limit: number;
  }): Promise<readonly MemorySuggestionSnapshot[]> {
    const superseded: MemorySuggestionSnapshot[] = [];
    for (const suggestion of [...this.suggestions.values()]
      .filter(
        (candidate) =>
          candidate.workspaceId === input.workspaceId &&
          candidate.repositoryId === input.repositoryId &&
          candidate.userId === input.userId &&
          candidate.suggestedScope === input.scope &&
          candidate.source.type === input.sourceType &&
          candidate.source.sourceId === input.sourceId &&
          candidate.createdByActor === memoryActorRef(input.createdByActor) &&
          candidate.status === "pending" &&
          candidate.id !== input.excludeSuggestionId,
      )
      .sort(compareDashboardRecords)
      .slice(0, input.limit)) {
      const next = MemorySuggestion.fromSnapshot(suggestion)
        .supersede({
          actor: input.createdByActor,
          replacementSuggestionId: input.replacementSuggestionId,
          now: input.supersededAt,
        })
        .snapshot();
      this.suggestions.set(next.id, next);
      superseded.push(next);
    }
    return superseded;
  }

  async listForDashboard(input: {
    readonly workspaceId: string;
    readonly repositoryId?: string | null;
    readonly scope?: MemoryScope;
    readonly statuses: readonly MemorySuggestionStatus[];
    readonly limit: number;
    readonly cursor?: MemorySuggestionDashboardRepositoryCursor;
    readonly notExpiredAt?: Date;
  }): Promise<readonly MemorySuggestionSnapshot[]> {
    return [...this.suggestions.values()]
      .filter((suggestion) => suggestion.workspaceId === input.workspaceId)
      .filter((suggestion) =>
        input.repositoryId === undefined
          ? true
          : suggestion.repositoryId === input.repositoryId,
      )
      .filter((suggestion) =>
        input.scope ? suggestion.suggestedScope === input.scope : true,
      )
      .filter((suggestion) => input.statuses.includes(suggestion.status))
      .filter((suggestion) =>
        input.notExpiredAt ? suggestion.expiresAt > input.notExpiredAt : true,
      )
      .sort(compareDashboardRecords)
      .filter((suggestion) =>
        input.cursor ? isAfterDashboardCursor(suggestion, input.cursor) : true,
      )
      .slice(0, input.limit);
  }

  async listExpiredPending(input: {
    readonly workspaceId: string;
    readonly expiredAtOrBefore: Date;
    readonly limit: number;
  }): Promise<readonly MemorySuggestionSnapshot[]> {
    return [...this.suggestions.values()]
      .filter((suggestion) => suggestion.workspaceId === input.workspaceId)
      .filter((suggestion) => suggestion.status === "pending")
      .filter((suggestion) => suggestion.expiresAt <= input.expiredAtOrBefore)
      .sort((left, right) => {
        const expiresAtDelta =
          left.expiresAt.getTime() - right.expiresAt.getTime();
        if (expiresAtDelta !== 0) return expiresAtDelta;
        return left.id.localeCompare(right.id);
      })
      .slice(0, input.limit);
  }

  async listWorkspaceIdsWithExpiredPending(input: {
    readonly expiredAtOrBefore: Date;
    readonly limit: number;
  }): Promise<readonly string[]> {
    const workspaceIds = new Set<string>();
    for (const suggestion of [...this.suggestions.values()].sort(
      (left, right) => left.workspaceId.localeCompare(right.workspaceId),
    )) {
      if (
        suggestion.status === "pending" &&
        suggestion.expiresAt <= input.expiredAtOrBefore
      ) {
        workspaceIds.add(suggestion.workspaceId);
      }
      if (workspaceIds.size >= input.limit) break;
    }
    return [...workspaceIds];
  }
}

type DashboardSortableRecord = {
  readonly id: string;
  readonly updatedAt: Date;
};

function compareDashboardRecords(
  left: DashboardSortableRecord,
  right: DashboardSortableRecord,
): number {
  const updatedAtDelta = right.updatedAt.getTime() - left.updatedAt.getTime();
  if (updatedAtDelta !== 0) return updatedAtDelta;
  return left.id.localeCompare(right.id);
}

function isAfterDashboardCursor(
  record: DashboardSortableRecord,
  cursor:
    | MemoryDashboardRepositoryCursor
    | MemorySuggestionDashboardRepositoryCursor,
): boolean {
  const recordTime = record.updatedAt.getTime();
  const cursorTime = cursor.updatedAt.getTime();
  return (
    recordTime < cursorTime ||
    (recordTime === cursorTime && record.id > cursor.id)
  );
}

class StaticPermissions implements MemoryPermissionPort {
  constructor(
    private readonly decisions: Record<string, MemoryPermissionDecision>,
  ) {}

  async canConfirmMemory(input: {
    readonly workspaceId: string;
    readonly repositoryId: string | null;
    readonly userId: string | null;
    readonly scope: MemoryScope;
    readonly actor: MemoryActor;
  }): Promise<MemoryPermissionDecision> {
    return (
      this.decisions[`${input.actor.id}:${input.scope}`] ??
      ({
        allowed: false,
        reason:
          input.scope === "workspace"
            ? "not_workspace_admin"
            : "not_repository_maintainer",
        retryable: false,
      } satisfies MemoryPermissionDecision)
    );
  }
}

class StaticMemoryQuotaPolicy implements MemoryQuotaPolicyPort {
  constructor(private readonly quota: MemoryWorkspaceQuota) {}

  async getWorkspaceQuota(): Promise<MemoryWorkspaceQuota> {
    return this.quota;
  }
}

class CapturingAudit implements MemoryAuditPort {
  readonly events: MemoryAuditEvent[] = [];

  async record(event: MemoryAuditEvent): Promise<void> {
    this.events.push(event);
  }
}

class CapturingOutbox implements MemoryOutboxPort {
  readonly events: MemoryOutboxEvent[] = [];

  async enqueue(
    event: MemoryOutboxEvent,
  ): Promise<{ readonly created: boolean }> {
    if (
      this.events.some((item) => item.idempotencyKey === event.idempotencyKey)
    ) {
      return { created: false };
    }
    this.events.push(event);
    return { created: true };
  }
}

class CapturingUsageEvents
  implements MemoryUsageEventPort, MemoryUsageEventRetentionPort
{
  readonly events: MemoryUsageEventInput[] = [];
  private readonly dedupeKeys = new Set<string>();

  async recordMany(
    events: readonly MemoryUsageEventInput[],
  ): ReturnType<MemoryUsageEventPort["recordMany"]> {
    let recordedCount = 0;
    let duplicateCount = 0;
    for (const event of events) {
      if (event.dedupeKey && this.dedupeKeys.has(event.dedupeKey)) {
        duplicateCount += 1;
        continue;
      }
      if (event.dedupeKey) {
        this.dedupeKeys.add(event.dedupeKey);
      }
      this.events.push(event);
      recordedCount += 1;
    }
    return { recordedCount, duplicateCount };
  }

  async pruneBefore(
    input: MemoryUsageEventRetentionPruneInput,
  ): ReturnType<MemoryUsageEventRetentionPort["pruneBefore"]> {
    const expiredIds = new Set(
      this.events
        .filter((event) => event.occurredAt < input.occurredBefore)
        .filter((event) =>
          input.scope.kind === "workspace"
            ? event.workspaceId === input.scope.workspaceId
            : true,
        )
        .sort((left, right) => {
          const occurredAtDelta =
            left.occurredAt.getTime() - right.occurredAt.getTime();
          if (occurredAtDelta !== 0) return occurredAtDelta;
          return left.id.localeCompare(right.id);
        })
        .slice(0, input.limit)
        .map((event) => event.id),
    );

    let deletedCount = 0;
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      const event = this.events[index];
      if (!event || !expiredIds.has(event.id)) continue;
      this.events.splice(index, 1);
      if (event.dedupeKey) {
        this.dedupeKeys.delete(event.dedupeKey);
      }
      deletedCount += 1;
    }

    return { deletedCount };
  }
}

class StubSearchIndex implements MemorySearchIndexPort {
  readonly inputs: MemorySearchIndexInput[] = [];

  constructor(
    private readonly hits: readonly MemorySearchIndexResult[],
    private readonly options: {
      readonly capabilities?: readonly MemorySearchCapability[];
      readonly fail?: boolean;
    } = {},
  ) {}

  async supports(): ReturnType<MemorySearchIndexPort["supports"]> {
    return { capabilities: this.options.capabilities ?? ["lexical"] };
  }

  async search(
    input: MemorySearchIndexInput,
  ): ReturnType<MemorySearchIndexPort["search"]> {
    this.inputs.push(input);
    if (this.options.fail) {
      throw new Error("search_index_unavailable");
    }
    return this.hits;
  }

  async upsertDocument(input: MemoryIndexDocument): Promise<void> {
    void input;
    return undefined;
  }

  async deleteDocument(input: {
    readonly workspaceId: string;
    readonly memoryItemId: string;
  }): Promise<void> {
    void input;
    return undefined;
  }
}

class SameObjectTransaction implements MemoryTransactionPort {
  constructor(
    private readonly ports: {
      readonly memoryItems: InMemoryItems;
      readonly memorySuggestions: InMemorySuggestions;
      readonly memoryAudit: CapturingAudit;
      readonly memoryOutbox: CapturingOutbox;
    },
  ) {}

  async run<T>(work: Parameters<MemoryTransactionPort["run"]>[0]): Promise<T> {
    return work(this.ports) as Promise<T>;
  }
}

function createHarness(
  decisions: Record<string, MemoryPermissionDecision>,
  options: {
    readonly policy?: MemoryPolicyConfigOverrides;
    readonly quota?: MemoryWorkspaceQuota;
  } = {},
) {
  const memoryItems = new InMemoryItems();
  const memorySuggestions = new InMemorySuggestions();
  const memoryAudit = new CapturingAudit();
  const memoryOutbox = new CapturingOutbox();
  const memoryUsageEvents = new CapturingUsageEvents();
  return {
    memoryItems,
    memorySuggestions,
    memoryAudit,
    memoryOutbox,
    memoryUsageEvents,
    memoryPermissions: new StaticPermissions(decisions),
    memoryPolicyConfig: new StaticMemoryPolicyConfig(options.policy),
    ...(options.quota
      ? { memoryQuotaPolicy: new StaticMemoryQuotaPolicy(options.quota) }
      : {}),
    memoryIds: new IncrementingIds(),
    memoryTransaction: new SameObjectTransaction({
      memoryItems,
      memorySuggestions,
      memoryAudit,
      memoryOutbox,
    }),
    clock,
  };
}

const maintainer: MemoryActor = {
  kind: "github_user",
  id: "user_maintainer",
  githubUserId: "100",
  login: "maintainer",
};

const prAuthor: MemoryActor = {
  kind: "github_user",
  id: "user_author",
  githubUserId: "200",
  login: "author",
};

describe("memory core", () => {
  it("directly saves explicit repository commands for maintainers only", async () => {
    const deps = createHarness({
      "user_maintainer:repository": { allowed: true },
    });
    const source = createDashboardMemorySource({ actorLogin: "maintainer" });

    const allowed = await rememberMemoryDirectly(
      {
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
        userId: null,
        scope: "repository",
        body: "Prefer guard clauses in service layer methods.",
        source,
        actor: maintainer,
      },
      deps,
    );

    expect(allowed.status).toBe("created");
    expect(deps.memoryItems.items).toHaveLength(1);
    expect(deps.memoryAudit.events[0]?.metadata).toMatchObject({
      scope: "repository",
      sourceType: "dashboard",
    });
    expect(deps.memoryOutbox.events.map((event) => event.type)).toEqual([
      "memory.item.created",
      "memory.embedding.reindex.requested",
    ]);
    expect(JSON.stringify(deps.memoryOutbox.events)).not.toContain(
      "guard clauses",
    );

    const denied = await rememberMemoryDirectly(
      {
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
        userId: null,
        scope: "repository",
        body: "Use Result objects instead of thrown exceptions.",
        source,
        actor: prAuthor,
      },
      deps,
    );

    expect(denied).toEqual({
      status: "rejected",
      reason: "not_repository_maintainer",
      retryable: false,
    });
  });

  it("rejects new direct memory when active item quota is reached", async () => {
    const deps = createHarness(
      {
        "user_maintainer:repository": { allowed: true },
      },
      {
        quota: {
          activeItems: { limit: 1 },
          pendingSuggestions: { limit: null },
        },
      },
    );
    const source = createDashboardMemorySource({ actorLogin: "maintainer" });

    const created = await rememberMemoryDirectly(
      {
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
        userId: null,
        scope: "repository",
        body: "Prefer one service per domain workflow.",
        source,
        actor: maintainer,
      },
      deps,
    );
    const rejected = await rememberMemoryDirectly(
      {
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
        userId: null,
        scope: "repository",
        body: "Prefer explicit transaction boundaries.",
        source,
        actor: maintainer,
      },
      deps,
    );

    expect(created.status).toBe("created");
    expect(rejected).toEqual({
      status: "rejected",
      reason: "memory_active_item_quota_exceeded",
      retryable: false,
    });
    expect(deps.memoryItems.items).toHaveLength(1);
    expect(deps.memoryOutbox.events.map((event) => event.type)).toEqual([
      "memory.item.created",
      "memory.embedding.reindex.requested",
    ]);
  });

  it("uses policy config versions for direct memory defaults", async () => {
    const deps = createHarness(
      {
        "user_maintainer:repository": { allowed: true },
      },
      {
        policy: { policyVersion: 7, safetyPolicyVersion: 11 },
      },
    );

    const result = await rememberMemoryDirectly(
      memoryInput("repository", "Policy versions come from config."),
      deps,
    );

    expect(result.status).toBe("created");
    const item = [...deps.memoryItems.items.values()][0];
    expect(item?.policyVersion).toBe(7);
    expect(item?.safetyPolicyVersion).toBe(11);
  });

  it("rejects new memory when policy disables memory", async () => {
    const deps = createHarness(
      {
        "user_maintainer:repository": { allowed: true },
      },
      {
        policy: { memoryEnabled: false },
      },
    );

    const result = await rememberMemoryDirectly(
      memoryInput("repository", "Disabled memory must not persist."),
      deps,
    );

    expect(result).toEqual({
      status: "rejected",
      reason: "memory_disabled",
      retryable: false,
    });
    expect(deps.memoryItems.items).toHaveLength(0);
    expect(deps.memoryAudit.events).toHaveLength(0);
  });

  it("keeps model-suggested memory pending even when actor can confirm", async () => {
    const deps = createHarness({
      "user_maintainer:repository": { allowed: true },
    });

    const result = await proposeMemoryFromInteraction(
      {
        envelope: candidateEnvelope({
          intent: "model_suggested_candidate",
          extractionMethod: "model_suggested_candidate",
          body: "Prefer small cohesive pull requests.",
          actor: maintainer,
        }),
      },
      deps,
    );

    expect(result.status).toBe("created");
    expect(deps.memoryItems.items).toHaveLength(0);
    expect([...deps.memorySuggestions.suggestions.values()][0]?.status).toBe(
      "pending",
    );
  });

  it("uses policy config versions and ttl for pending suggestions", async () => {
    const deps = createHarness(
      {},
      {
        policy: {
          policyVersion: 5,
          safetyPolicyVersion: 8,
          suggestionTtlDays: { repository: 3 },
        },
      },
    );

    const result = await proposeMemoryFromInteraction(
      {
        envelope: candidateEnvelope({
          intent: "explicit_natural_language",
          extractionMethod: "explicit_natural_language",
          body: "Suggestion TTL comes from policy config.",
          actor: maintainer,
        }),
      },
      deps,
    );

    expect(result.status).toBe("created");
    const suggestion = [...deps.memorySuggestions.suggestions.values()][0];
    expect(suggestion?.policyVersion).toBe(5);
    expect(suggestion?.safetyPolicyVersion).toBe(8);
    expect(suggestion?.expiresAt.toISOString()).toBe(
      "2026-05-15T12:00:00.000Z",
    );
  });

  it("rejects new suggestions when pending suggestion quota is reached", async () => {
    const deps = createHarness(
      {
        "user_maintainer:repository": { allowed: true },
      },
      {
        quota: {
          activeItems: { limit: null },
          pendingSuggestions: { limit: 1 },
        },
      },
    );

    const first = await proposeMemoryFromInteraction(
      {
        envelope: candidateEnvelope({
          intent: "model_suggested_candidate",
          extractionMethod: "model_suggested_candidate",
          body: "Prefer small cohesive pull requests.",
          actor: maintainer,
        }),
      },
      deps,
    );
    const second = await proposeMemoryFromInteraction(
      {
        envelope: candidateEnvelope({
          intent: "model_suggested_candidate",
          extractionMethod: "model_suggested_candidate",
          body: "Prefer migration notes in pull request descriptions.",
          actor: maintainer,
        }),
      },
      deps,
    );

    expect(first.status).toBe("created");
    expect(second).toEqual({
      status: "rejected",
      reason: "memory_pending_suggestion_quota_exceeded",
      retryable: false,
    });
    expect(deps.memorySuggestions.suggestions).toHaveLength(1);
    expect(deps.memoryAudit.events).toHaveLength(1);
    expect(deps.memoryOutbox.events).toHaveLength(1);
  });

  it("does not count expired pending suggestions against suggestion quota", async () => {
    const deps = createHarness(
      {
        "user_maintainer:repository": { allowed: true },
      },
      {
        quota: {
          activeItems: { limit: null },
          pendingSuggestions: { limit: 1 },
        },
      },
    );

    const expired = await proposeMemoryFromInteraction(
      {
        envelope: candidateEnvelope({
          intent: "model_suggested_candidate",
          extractionMethod: "model_suggested_candidate",
          body: "Expired pending quota slot should be ignored.",
          actor: maintainer,
        }),
      },
      deps,
    );
    if (expired.status !== "created") throw new Error("missing_suggestion");
    const expiredSnapshot = deps.memorySuggestions.suggestions.get(expired.id);
    if (!expiredSnapshot) throw new Error("missing_suggestion");
    deps.memorySuggestions.suggestions.set(expired.id, {
      ...expiredSnapshot,
      expiresAt: new Date(now.getTime() - 1),
    });

    const replacement = await proposeMemoryFromInteraction(
      {
        envelope: candidateEnvelope({
          intent: "model_suggested_candidate",
          extractionMethod: "model_suggested_candidate",
          body: "Fresh suggestion can use the freed quota slot.",
          actor: maintainer,
        }),
      },
      deps,
    );

    expect(replacement.status).toBe("created");
    expect(deps.memorySuggestions.suggestions).toHaveLength(2);
  });

  it("supersedes stale pending suggestions from the same edited source", async () => {
    const deps = createHarness({
      "user_maintainer:repository": { allowed: true },
    });

    const first = await proposeMemoryFromInteraction(
      {
        envelope: candidateEnvelope({
          intent: "explicit_natural_language",
          extractionMethod: "explicit_natural_language",
          body: "Prefer old migration notes.",
          actor: maintainer,
          sourceId: "github-comment-42",
        }),
      },
      deps,
    );
    if (first.status !== "created") throw new Error("missing_first");

    const second = await proposeMemoryFromInteraction(
      {
        envelope: candidateEnvelope({
          intent: "explicit_natural_language",
          extractionMethod: "explicit_natural_language",
          body: "Prefer reviewed Prisma migrations for schema changes.",
          actor: maintainer,
          sourceId: "github-comment-42",
        }),
      },
      deps,
    );
    if (second.status !== "created") throw new Error("missing_second");

    expect(deps.memorySuggestions.suggestions.get(first.id)).toMatchObject({
      status: "superseded",
      relatedSuggestionId: second.id,
      resolvedBy: memoryActorRef(maintainer),
      resolutionReason: "superseded",
    });
    expect(deps.memorySuggestions.suggestions.get(second.id)).toMatchObject({
      status: "pending",
    });
    expect(deps.memoryAudit.events.at(-1)).toMatchObject({
      action: "memory.suggestion.superseded",
      targetId: first.id,
      metadata: {
        replacementSuggestionId: second.id,
      },
    });
    expect(JSON.stringify(deps.memoryAudit.events.at(-1))).not.toContain(
      "Prefer old migration notes.",
    );
  });

  it("does not persist ambiguous discussion references", async () => {
    const intent = parseMemoryIntent("запомни то что мы выше обсудили");
    const deps = createHarness({
      "user_maintainer:repository": { allowed: true },
    });

    const result = await proposeMemoryFromInteraction(
      {
        envelope: candidateEnvelope({
          intent: intent.kind,
          extractionMethod: "explicit_natural_language",
          body: "то что выше",
          actor: maintainer,
        }),
      },
      deps,
    );

    expect(result).toEqual({ status: "noop", reason: "no_memory_intent" });
    expect(deps.memoryItems.items).toHaveLength(0);
    expect(deps.memorySuggestions.suggestions).toHaveLength(0);
  });

  it("blocks secret-like or code-like memory before persistence", async () => {
    const deps = createHarness({
      "user_maintainer:repository": { allowed: true },
    });

    const result = await rememberMemoryDirectly(
      {
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
        userId: null,
        scope: "repository",
        body: "OPENAI_API_KEY=sk-secretsecretsecretsecret",
        source: createDashboardMemorySource({ actorLogin: "maintainer" }),
        actor: maintainer,
      },
      deps,
    );

    expect(result).toEqual({
      status: "rejected",
      reason: "contains_secret_like_text",
    });
    expect(deps.memoryItems.items).toHaveLength(0);
    expect(deps.memoryOutbox.events).toHaveLength(0);
  });

  it("confirms pending suggestions only after permission and duplicate checks", async () => {
    const deps = createHarness({
      "user_maintainer:repository": { allowed: true },
    });
    const proposed = await proposeMemoryFromInteraction(
      {
        envelope: candidateEnvelope({
          intent: "explicit_natural_language",
          extractionMethod: "explicit_natural_language",
          body: "Prefer Prisma migrations over manual schema edits.",
          actor: prAuthor,
        }),
      },
      deps,
    );
    expect(proposed.status).toBe("created");
    const suggestionId = proposed.status === "created" ? proposed.id : "";

    const denied = await confirmMemorySuggestion(
      {
        workspaceId: "workspace_1",
        suggestionId,
        actor: prAuthor,
      },
      deps,
    );
    expect(denied).toEqual({
      status: "rejected",
      reason: "not_repository_maintainer",
      retryable: false,
    });

    const confirmed = await confirmMemorySuggestion(
      {
        workspaceId: "workspace_1",
        suggestionId,
        actor: maintainer,
      },
      deps,
    );
    expect(confirmed.status).toBe("created");
    expect(deps.memoryItems.items).toHaveLength(1);
    expect(deps.memorySuggestions.suggestions.get(suggestionId)?.status).toBe(
      "confirmed",
    );

    const repeated = await confirmMemorySuggestion(
      {
        workspaceId: "workspace_1",
        suggestionId,
        actor: maintainer,
      },
      deps,
    );
    expect(repeated).toEqual({ status: "noop", reason: "confirmed" });
  });

  it("keeps pending suggestion unchanged when confirmation would exceed active quota", async () => {
    const deps = createHarness(
      {
        "user_maintainer:repository": { allowed: true },
      },
      {
        quota: {
          activeItems: { limit: 0 },
          pendingSuggestions: { limit: null },
        },
      },
    );
    const proposed = await proposeMemoryFromInteraction(
      {
        envelope: candidateEnvelope({
          intent: "explicit_natural_language",
          extractionMethod: "explicit_natural_language",
          body: "Prefer Prisma migrations over manual schema edits.",
          actor: maintainer,
        }),
      },
      deps,
    );
    if (proposed.status !== "created") throw new Error("missing_suggestion");

    const confirmed = await confirmMemorySuggestion(
      {
        workspaceId: "workspace_1",
        suggestionId: proposed.id,
        actor: maintainer,
      },
      deps,
    );

    expect(confirmed).toEqual({
      status: "rejected",
      reason: "memory_active_item_quota_exceeded",
      retryable: false,
    });
    expect(deps.memoryItems.items).toHaveLength(0);
    expect(deps.memorySuggestions.suggestions.get(proposed.id)?.status).toBe(
      "pending",
    );
  });

  it("rejects pending suggestions only for maintainers", async () => {
    const deps = createHarness({
      "user_maintainer:repository": { allowed: true },
    });
    const proposed = await proposeMemoryFromInteraction(
      {
        envelope: candidateEnvelope({
          intent: "explicit_natural_language",
          extractionMethod: "explicit_natural_language",
          body: "Prefer explicit adapters over SDK imports in use cases.",
          actor: prAuthor,
        }),
      },
      deps,
    );
    if (proposed.status !== "created") throw new Error("missing_suggestion");

    const denied = await rejectMemorySuggestion(
      {
        workspaceId: "workspace_1",
        suggestionId: proposed.id,
        actor: prAuthor,
      },
      deps,
    );
    expect(denied).toEqual({
      status: "rejected",
      reason: "not_repository_maintainer",
      retryable: false,
    });

    const rejected = await rejectMemorySuggestion(
      {
        workspaceId: "workspace_1",
        suggestionId: proposed.id,
        actor: maintainer,
        reason: "too_project_specific",
      },
      deps,
    );
    expect(rejected).toMatchObject({ status: "updated", id: proposed.id });
    expect(deps.memorySuggestions.suggestions.get(proposed.id)?.status).toBe(
      "rejected",
    );
    expect(deps.memoryAudit.events.at(-1)?.action).toBe(
      "memory.suggestion.rejected",
    );

    const repeated = await rejectMemorySuggestion(
      {
        workspaceId: "workspace_1",
        suggestionId: proposed.id,
        actor: maintainer,
      },
      deps,
    );
    expect(repeated).toEqual({
      status: "noop",
      reason: "rejected",
      id: proposed.id,
    });
  });

  it("deduplicates active-ish memory by normalized body hash", async () => {
    const deps = createHarness({
      "user_maintainer:repository": { allowed: true },
    });
    const first = await rememberMemoryDirectly(
      {
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
        userId: null,
        scope: "repository",
        body: "Prefer guard clauses in service layer methods.",
        source: createDashboardMemorySource({ actorLogin: "maintainer" }),
        actor: maintainer,
      },
      deps,
    );
    const second = await rememberMemoryDirectly(
      {
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
        userId: null,
        scope: "repository",
        body: "  Prefer   guard clauses in service layer methods. ",
        source: createDashboardMemorySource({ actorLogin: "maintainer" }),
        actor: maintainer,
      },
      deps,
    );

    expect(first.status).toBe("created");
    expect(second.status).toBe("noop");
    if (second.status !== "noop") throw new Error("expected_noop");
    expect(second.reason).toBe("memory_duplicate");
    expect(deps.memoryItems.items).toHaveLength(1);
  });

  it("maps storage duplicate races to safe noop results", async () => {
    const deps = createHarness({
      "user_maintainer:repository": { allowed: true },
    });
    deps.memoryItems.save = async () => {
      throw new MemoryError("memory_duplicate");
    };

    const result = await rememberMemoryDirectly(
      {
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
        userId: null,
        scope: "repository",
        body: "Prefer guard clauses in service layer methods.",
        source: createDashboardMemorySource({ actorLogin: "maintainer" }),
        actor: maintainer,
      },
      deps,
    );

    expect(result).toEqual({ status: "noop", reason: "memory_duplicate" });
  });

  it("disables and deletes memory items only after permission checks", async () => {
    const deps = createHarness({
      "user_maintainer:repository": { allowed: true },
    });
    const created = await rememberMemoryDirectly(
      {
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
        userId: null,
        scope: "repository",
        body: "Prefer small domain methods.",
        source: createDashboardMemorySource({ actorLogin: "maintainer" }),
        actor: maintainer,
      },
      deps,
    );
    if (created.status !== "created") throw new Error("missing_memory_item");

    const denied = await disableMemoryItem(
      { workspaceId: "workspace_1", itemId: created.id, actor: prAuthor },
      deps,
    );
    expect(denied).toEqual({
      status: "rejected",
      reason: "not_repository_maintainer",
      retryable: false,
    });

    const disabled = await disableMemoryItem(
      { workspaceId: "workspace_1", itemId: created.id, actor: maintainer },
      deps,
    );
    expect(disabled).toMatchObject({ status: "updated", id: created.id });
    expect(deps.memoryItems.items.get(created.id)?.status).toBe("disabled");
    expect(deps.memoryItems.items.get(created.id)?.indexState).toBe(
      "index_deleted",
    );
    expect(deps.memoryItems.items.get(created.id)?.indexVersion).toBeNull();

    const deleted = await deleteMemoryItem(
      { workspaceId: "workspace_1", itemId: created.id, actor: maintainer },
      deps,
    );
    expect(deleted).toMatchObject({ status: "updated", id: created.id });
    expect(deps.memoryItems.items.get(created.id)?.status).toBe("deleted");
    expect(deps.memoryItems.items.get(created.id)?.body).toBe(
      deletedMemoryBodyPlaceholder,
    );
    expect(deps.memoryItems.items.get(created.id)?.indexState).toBe(
      "index_deleted",
    );
    expect(deps.memoryItems.items.get(created.id)?.indexVersion).toBeNull();
    expect(deps.memoryItems.items.get(created.id)?.source).toMatchObject({
      type: "system_migration",
      sourceId: "deleted",
      redactedExcerpt: null,
      sourceHash: null,
    });

    const repeatedDelete = await deleteMemoryItem(
      { workspaceId: "workspace_1", itemId: created.id, actor: maintainer },
      deps,
    );
    expect(repeatedDelete).toEqual({
      status: "noop",
      reason: "deleted",
      id: created.id,
    });
  });

  it("redacts confirmed suggestion body when deleting its memory item", async () => {
    const deps = createHarness({
      "user_maintainer:repository": { allowed: true },
    });
    const proposed = await proposeMemoryFromInteraction(
      {
        envelope: candidateEnvelope({
          intent: "explicit_natural_language",
          extractionMethod: "explicit_natural_language",
          body: "Delete should redact confirmed suggestion source.",
          actor: prAuthor,
        }),
      },
      deps,
    );
    if (proposed.status !== "created") throw new Error("missing_suggestion");
    const confirmed = await confirmMemorySuggestion(
      {
        workspaceId: "workspace_1",
        suggestionId: proposed.id,
        actor: maintainer,
      },
      deps,
    );
    if (confirmed.status !== "created") throw new Error("missing_memory_item");

    const deleted = await deleteMemoryItem(
      { workspaceId: "workspace_1", itemId: confirmed.id, actor: maintainer },
      deps,
    );

    expect(deleted).toMatchObject({ status: "updated", id: confirmed.id });
    expect(deps.memoryItems.items.get(confirmed.id)).toMatchObject({
      body: deletedMemoryBodyPlaceholder,
      source: { type: "system_migration", sourceId: "deleted" },
    });
    expect(deps.memorySuggestions.suggestions.get(proposed.id)).toMatchObject({
      suggestedBody: deletedMemoryBodyPlaceholder,
      source: { type: "system_migration", sourceId: "deleted" },
      safetyReport: {
        redactedBody: deletedMemoryBodyPlaceholder,
        redactedSourceExcerpt: null,
        mayEmbed: false,
        mayUseInRuntimeBundle: false,
      },
    });
    expect(JSON.stringify(deps.memorySuggestions.suggestions)).not.toContain(
      "Delete should redact confirmed suggestion source.",
    );
    expect(deps.memoryAudit.events.at(-1)?.metadata).toMatchObject({
      bodyRedacted: true,
      originSuggestionRedacted: true,
    });
  });

  it("rejects stale memory lifecycle mutations with optimistic concurrency", async () => {
    const deps = createHarness({
      "user_maintainer:repository": { allowed: true },
    });
    const created = await rememberMemoryDirectly(
      {
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
        userId: null,
        scope: "repository",
        body: "Prefer explicit policy ownership.",
        source: createDashboardMemorySource({ actorLogin: "maintainer" }),
        actor: maintainer,
      },
      deps,
    );
    if (created.status !== "created") throw new Error("missing_memory_item");

    const deniedStaleDisable = await disableMemoryItem(
      {
        workspaceId: "workspace_1",
        itemId: created.id,
        expectedVersion: created.version + 1,
        actor: prAuthor,
      },
      deps,
    );

    expect(deniedStaleDisable).toEqual({
      status: "rejected",
      reason: "not_repository_maintainer",
      retryable: false,
    });

    const staleDisable = await disableMemoryItem(
      {
        workspaceId: "workspace_1",
        itemId: created.id,
        expectedVersion: created.version + 1,
        actor: maintainer,
      },
      deps,
    );

    expect(staleDisable).toEqual({
      status: "rejected",
      reason: "memory_version_conflict",
      retryable: true,
    });
    expect(deps.memoryItems.items.get(created.id)?.status).toBe("active");
    expect(deps.memoryAudit.events).toHaveLength(1);
    expect(deps.memoryOutbox.events).toHaveLength(2);

    const disabled = await disableMemoryItem(
      {
        workspaceId: "workspace_1",
        itemId: created.id,
        expectedVersion: created.version,
        actor: maintainer,
      },
      deps,
    );

    expect(disabled).toMatchObject({
      status: "updated",
      id: created.id,
      version: 2,
    });

    const staleDelete = await deleteMemoryItem(
      {
        workspaceId: "workspace_1",
        itemId: created.id,
        expectedVersion: created.version,
        actor: maintainer,
      },
      deps,
    );

    expect(staleDelete).toEqual({
      status: "rejected",
      reason: "memory_version_conflict",
      retryable: true,
    });
    expect(deps.memoryItems.items.get(created.id)?.status).toBe("disabled");
  });

  it("edits memory items with safety, dedupe, audit-safe metadata and reindex outbox", async () => {
    const deps = createHarness({
      "user_maintainer:repository": { allowed: true },
    });
    const created = await rememberMemoryDirectly(
      {
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
        userId: null,
        scope: "repository",
        body: "Prefer small domain methods.",
        source: createDashboardMemorySource({ actorLogin: "maintainer" }),
        actor: maintainer,
      },
      deps,
    );
    if (created.status !== "created") throw new Error("missing_memory_item");

    const denied = await editMemoryItem(
      {
        workspaceId: "workspace_1",
        itemId: created.id,
        expectedVersion: created.version + 1,
        body: "Prefer small service methods.",
        actor: prAuthor,
      },
      deps,
    );

    expect(denied).toEqual({
      status: "rejected",
      reason: "not_repository_maintainer",
      retryable: false,
    });

    const stale = await editMemoryItem(
      {
        workspaceId: "workspace_1",
        itemId: created.id,
        expectedVersion: created.version + 1,
        body: "Prefer small service methods.",
        actor: maintainer,
      },
      deps,
    );

    expect(stale).toEqual({
      status: "rejected",
      reason: "memory_version_conflict",
      retryable: true,
    });

    const edited = await editMemoryItem(
      {
        workspaceId: "workspace_1",
        itemId: created.id,
        expectedVersion: created.version,
        body: "Prefer small service methods.",
        actor: maintainer,
      },
      deps,
    );

    expect(edited).toMatchObject({
      status: "updated",
      id: created.id,
      version: 2,
    });
    expect(deps.memoryItems.items.get(created.id)).toMatchObject({
      body: "Prefer small service methods.",
      bodyVersion: 2,
      version: 2,
      indexState: "index_pending",
      indexVersion: null,
    });
    expect(deps.memoryAudit.events.at(-1)).toMatchObject({
      action: "memory.item.edited",
      targetType: "memory_item",
      targetId: created.id,
      metadata: {
        scope: "repository",
        previousBodyVersion: 1,
        bodyVersion: 2,
        previousVersion: 1,
        version: 2,
        bodyChanged: true,
      },
    });
    expect(JSON.stringify(deps.memoryAudit.events.at(-1))).not.toContain(
      "small service methods",
    );
    expect(deps.memoryOutbox.events.map((event) => event.type)).toEqual([
      "memory.item.created",
      "memory.embedding.reindex.requested",
      "memory.item.edited",
      "memory.embedding.reindex.requested",
    ]);
  });

  it("rejects memory edits that would duplicate another active item", async () => {
    const deps = createHarness({
      "user_maintainer:repository": { allowed: true },
    });
    const first = await rememberMemoryDirectly(
      {
        ...memoryInput("repository", "Prefer small domain methods."),
        actor: maintainer,
      },
      deps,
    );
    const second = await rememberMemoryDirectly(
      {
        ...memoryInput("repository", "Prefer explicit policy ownership."),
        actor: maintainer,
      },
      deps,
    );
    if (first.status !== "created" || second.status !== "created") {
      throw new Error("missing_memory_items");
    }

    const duplicate = await editMemoryItem(
      {
        workspaceId: "workspace_1",
        itemId: second.id,
        expectedVersion: second.version,
        body: "  Prefer small   domain methods. ",
        actor: maintainer,
      },
      deps,
    );

    expect(duplicate).toEqual({
      status: "noop",
      reason: "memory_duplicate",
      id: first.id,
    });
    expect(deps.memoryItems.items.get(second.id)?.body).toBe(
      "Prefer explicit policy ownership.",
    );
  });

  it("lists dashboard memory with tenant-safe filters and stable cursors", async () => {
    const deps = createHarness({
      "user_maintainer:repository": { allowed: true },
    });
    await rememberMemoryDirectly(
      {
        ...memoryInput("repository", "Keep service methods small."),
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
      },
      deps,
    );
    await rememberMemoryDirectly(
      {
        ...memoryInput("repository", "Prefer explicit domain policies."),
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
      },
      deps,
    );
    await rememberMemoryDirectly(
      {
        ...memoryInput("repository", "Other workspace memory."),
        workspaceId: "workspace_2",
        repositoryId: "repo_2",
      },
      deps,
    );

    const firstPage = await listMemoryItemsForDashboard(
      { workspaceId: "workspace_1", repositoryId: "repo_1", limit: 1 },
      deps,
    );
    expect(firstPage.items.map((item) => item.body)).toEqual([
      "Keep service methods small.",
    ]);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = await listMemoryItemsForDashboard(
      {
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
        limit: 1,
        cursor: firstPage.nextCursor,
      },
      deps,
    );
    expect(secondPage.items.map((item) => item.body)).toEqual([
      "Prefer explicit domain policies.",
    ]);
    expect(secondPage.nextCursor).toBeNull();

    const firstItem = [...deps.memoryItems.items.values()].find(
      (item) => item.body === "Keep service methods small.",
    );
    if (!firstItem) throw new Error("missing_item");
    await deps.memoryItems.save(
      MemoryItem.fromSnapshot(firstItem).delete({
        actor: maintainer,
        now: new Date(now.getTime() + 1_000),
      }),
    );

    const activeItems = await listMemoryItemsForDashboard(
      { workspaceId: "workspace_1", repositoryId: "repo_1" },
      deps,
    );
    expect(activeItems.items.map((item) => item.body)).toEqual([
      "Prefer explicit domain policies.",
    ]);

    const deletedItems = await listMemoryItemsForDashboard(
      {
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
        statuses: ["deleted"],
      },
      deps,
    );
    expect(deletedItems.items.map((item) => item.body)).toEqual([
      deletedMemoryBodyPlaceholder,
    ]);
  });

  it("lists dashboard suggestions without leaking tenants or expired pending rows", async () => {
    const deps = createHarness({});
    const active = await proposeMemoryFromInteraction(
      {
        envelope: candidateEnvelope({
          intent: "explicit_natural_language",
          extractionMethod: "explicit_natural_language",
          body: "Use adapter ports for external systems.",
          actor: prAuthor,
          workspaceId: "workspace_1",
          repositoryId: "repo_1",
        }),
      },
      deps,
    );
    const expired = await proposeMemoryFromInteraction(
      {
        envelope: candidateEnvelope({
          intent: "explicit_natural_language",
          extractionMethod: "explicit_natural_language",
          body: "Keep dashboard queries paginated.",
          actor: prAuthor,
          workspaceId: "workspace_1",
          repositoryId: "repo_1",
        }),
      },
      deps,
    );
    await proposeMemoryFromInteraction(
      {
        envelope: candidateEnvelope({
          intent: "explicit_natural_language",
          extractionMethod: "explicit_natural_language",
          body: "Other workspace suggestion.",
          actor: prAuthor,
          workspaceId: "workspace_2",
          repositoryId: "repo_2",
        }),
      },
      deps,
    );
    if (active.status !== "created" || expired.status !== "created") {
      throw new Error("expected_created_suggestions");
    }
    const expiredSuggestion = deps.memorySuggestions.suggestions.get(
      expired.id,
    );
    if (!expiredSuggestion) throw new Error("missing_suggestion");
    deps.memorySuggestions.suggestions.set(expired.id, {
      ...expiredSuggestion,
      expiresAt: new Date(now.getTime() - 1_000),
    });

    const defaultList = await listMemorySuggestionsForDashboard(
      { workspaceId: "workspace_1", repositoryId: "repo_1" },
      deps,
    );
    expect(defaultList.suggestions.map((item) => item.suggestedBody)).toEqual([
      "Use adapter ports for external systems.",
    ]);

    const withExpired = await listMemorySuggestionsForDashboard(
      {
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
        includeExpiredPending: true,
      },
      deps,
    );
    expect(withExpired.suggestions.map((item) => item.suggestedBody)).toEqual([
      "Use adapter ports for external systems.",
      "Keep dashboard queries paginated.",
    ]);
    expect(withExpired.suggestions[1]?.isExpired).toBe(true);
  });

  it("expires pending memory suggestions through retention use case", async () => {
    const deps = createHarness({
      "user_maintainer:repository": { allowed: true },
    });
    const current = await proposeMemoryFromInteraction(
      {
        envelope: candidateEnvelope({
          intent: "explicit_natural_language",
          extractionMethod: "explicit_natural_language",
          body: "Keep current suggestion pending.",
          actor: maintainer,
        }),
      },
      deps,
    );
    const expired = await proposeMemoryFromInteraction(
      {
        envelope: candidateEnvelope({
          intent: "explicit_natural_language",
          extractionMethod: "explicit_natural_language",
          body: "Expire old suggestion.",
          actor: maintainer,
        }),
      },
      deps,
    );
    if (current.status !== "created" || expired.status !== "created") {
      throw new Error("expected_created_suggestions");
    }
    const expiredSnapshot = deps.memorySuggestions.suggestions.get(expired.id);
    if (!expiredSnapshot) throw new Error("missing_suggestion");
    deps.memorySuggestions.suggestions.set(expired.id, {
      ...expiredSnapshot,
      expiresAt: new Date(now.getTime() - 1_000),
    });

    const result = await expirePendingMemorySuggestions(
      { workspaceId: "workspace_1", limit: 10 },
      deps,
    );

    expect(result).toEqual({ status: "expired", expiredCount: 1 });
    expect(deps.memorySuggestions.suggestions.get(current.id)?.status).toBe(
      "pending",
    );
    expect(deps.memorySuggestions.suggestions.get(expired.id)).toMatchObject({
      status: "expired",
      resolvedBy: "system:memory-retention",
      resolutionReason: "expired",
      version: 2,
    });
    expect(deps.memoryAudit.events.at(-1)).toMatchObject({
      actor: "system:memory-retention",
      action: "memory.suggestion.expired",
      targetType: "memory_suggestion",
      targetId: expired.id,
      metadata: {
        scope: "repository",
        suggestedBodyHash: expiredSnapshot.suggestedBodyHash,
        previousVersion: 1,
        version: 2,
      },
    });
    expect(JSON.stringify(deps.memoryAudit.events.at(-1))).not.toContain(
      "Expire old suggestion",
    );
  });

  it("expires pending memory suggestions across workspaces in bounded batches", async () => {
    const deps = createHarness({
      "user_maintainer:repository": { allowed: true },
    });
    const current = await proposeMemoryFromInteraction(
      {
        envelope: candidateEnvelope({
          intent: "explicit_natural_language",
          extractionMethod: "explicit_natural_language",
          body: "Keep active suggestion pending.",
          actor: maintainer,
        }),
      },
      deps,
    );
    const expiredPrimary = await proposeMemoryFromInteraction(
      {
        envelope: candidateEnvelope({
          intent: "explicit_natural_language",
          extractionMethod: "explicit_natural_language",
          body: "Expire primary workspace suggestion.",
          actor: maintainer,
        }),
      },
      deps,
    );
    const expiredOther = await proposeMemoryFromInteraction(
      {
        envelope: candidateEnvelope({
          intent: "explicit_natural_language",
          extractionMethod: "explicit_natural_language",
          body: "Expire other workspace suggestion.",
          actor: maintainer,
          workspaceId: "workspace_2",
          repositoryId: "repo_2",
        }),
      },
      deps,
    );
    if (
      current.status !== "created" ||
      expiredPrimary.status !== "created" ||
      expiredOther.status !== "created"
    ) {
      throw new Error("expected_created_suggestions");
    }
    for (const id of [expiredPrimary.id, expiredOther.id]) {
      const snapshot = deps.memorySuggestions.suggestions.get(id);
      if (!snapshot) throw new Error("missing_suggestion");
      deps.memorySuggestions.suggestions.set(id, {
        ...snapshot,
        expiresAt: new Date(now.getTime() - 1_000),
      });
    }

    const result = await expirePendingMemorySuggestionsAcrossWorkspaces(
      { workspaceLimit: 10, perWorkspaceLimit: 1 },
      deps,
    );

    expect(result).toEqual({
      status: "expired",
      workspaceCount: 2,
      expiredCount: 2,
    });
    expect(deps.memorySuggestions.suggestions.get(current.id)?.status).toBe(
      "pending",
    );
    expect(
      deps.memorySuggestions.suggestions.get(expiredPrimary.id)?.status,
    ).toBe("expired");
    expect(
      deps.memorySuggestions.suggestions.get(expiredOther.id)?.status,
    ).toBe("expired");
    const expiredAuditEvents = deps.memoryAudit.events.filter(
      (event) => event.action === "memory.suggestion.expired",
    );
    expect(expiredAuditEvents.map((event) => event.workspaceId).sort()).toEqual(
      ["workspace_1", "workspace_2"],
    );
    expect(JSON.stringify(expiredAuditEvents)).not.toContain(
      "Expire primary workspace suggestion",
    );
    expect(JSON.stringify(expiredAuditEvents)).not.toContain(
      "Expire other workspace suggestion",
    );
  });

  it("expires active memory items through retention use case", async () => {
    const deps = createHarness({
      "user_maintainer:repository": { allowed: true },
    });
    const current = await rememberMemoryDirectly(
      memoryInput("repository", "Keep current memory active."),
      deps,
    );
    const expired = await rememberMemoryDirectly(
      memoryInput("repository", "Expire old active memory."),
      deps,
    );
    const disabled = await rememberMemoryDirectly(
      memoryInput("repository", "Disabled expired memory stays disabled."),
      deps,
    );
    if (
      current.status !== "created" ||
      expired.status !== "created" ||
      disabled.status !== "created"
    ) {
      throw new Error("expected_created_memory_items");
    }
    setMemoryItemExpiresAt(deps, current.id, new Date(now.getTime() + 60_000));
    setMemoryItemExpiresAt(deps, expired.id, new Date(now.getTime() - 1_000));
    setMemoryItemExpiresAt(deps, disabled.id, new Date(now.getTime() - 1_000));
    await disableMemoryItem(
      { workspaceId: "workspace_1", itemId: disabled.id, actor: maintainer },
      deps,
    );

    const result = await expireActiveMemoryItems(
      { workspaceId: "workspace_1", limit: 10 },
      deps,
    );

    expect(result).toEqual({ status: "expired", expiredCount: 1 });
    expect(deps.memoryItems.items.get(current.id)?.status).toBe("active");
    expect(deps.memoryItems.items.get(disabled.id)?.status).toBe("disabled");
    expect(deps.memoryItems.items.get(expired.id)).toMatchObject({
      status: "expired",
      version: 2,
      indexState: "index_deleted",
      indexVersion: null,
    });
    expect(deps.memoryAudit.events.at(-1)).toMatchObject({
      actor: "system:memory-retention",
      action: "memory.item.expired",
      targetType: "memory_item",
      targetId: expired.id,
      metadata: {
        scope: "repository",
        bodyHash: deps.memoryItems.items.get(expired.id)?.bodyHash,
        bodyVersion: 1,
        previousVersion: 1,
        version: 2,
      },
    });
    expect(JSON.stringify(deps.memoryAudit.events.at(-1))).not.toContain(
      "Expire old active memory",
    );
    expect(
      deps.memoryOutbox.events
        .filter((event) => event.aggregateId === expired.id)
        .map((event) => event.type),
    ).toEqual([
      "memory.item.created",
      "memory.embedding.reindex.requested",
      "memory.item.expired",
      "memory.embedding.delete.requested",
    ]);
    expect(
      JSON.stringify(
        deps.memoryOutbox.events.filter(
          (event) => event.aggregateId === expired.id,
        ),
      ),
    ).not.toContain("Expire old active memory");

    const bundle = await buildActionMemoryBundle(
      {
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
        userId: null,
      },
      deps,
    );
    expect(bundle.items.map((item) => item.body)).toEqual([
      "Keep current memory active.",
    ]);
  });

  it("expires active memory items across workspaces in bounded batches", async () => {
    const deps = createHarness({
      "user_maintainer:repository": { allowed: true },
    });
    const current = await rememberMemoryDirectly(
      memoryInput("repository", "Keep active workspace memory."),
      deps,
    );
    const expiredPrimary = await rememberMemoryDirectly(
      memoryInput("repository", "Expire primary workspace memory."),
      deps,
    );
    const expiredOther = await rememberMemoryDirectly(
      {
        ...memoryInput("repository", "Expire other workspace memory."),
        workspaceId: "workspace_2",
        repositoryId: "repo_2",
      },
      deps,
    );
    if (
      current.status !== "created" ||
      expiredPrimary.status !== "created" ||
      expiredOther.status !== "created"
    ) {
      throw new Error("expected_created_memory_items");
    }
    setMemoryItemExpiresAt(deps, current.id, new Date(now.getTime() + 60_000));
    setMemoryItemExpiresAt(
      deps,
      expiredPrimary.id,
      new Date(now.getTime() - 1_000),
    );
    setMemoryItemExpiresAt(
      deps,
      expiredOther.id,
      new Date(now.getTime() - 1_000),
    );

    const result = await expireActiveMemoryItemsAcrossWorkspaces(
      { workspaceLimit: 10, perWorkspaceLimit: 1 },
      deps,
    );

    expect(result).toEqual({
      status: "expired",
      workspaceCount: 2,
      expiredCount: 2,
    });
    expect(deps.memoryItems.items.get(current.id)?.status).toBe("active");
    expect(deps.memoryItems.items.get(expiredPrimary.id)?.status).toBe(
      "expired",
    );
    expect(deps.memoryItems.items.get(expiredOther.id)?.status).toBe("expired");
    const expiredAuditEvents = deps.memoryAudit.events.filter(
      (event) => event.action === "memory.item.expired",
    );
    expect(expiredAuditEvents.map((event) => event.workspaceId).sort()).toEqual(
      ["workspace_1", "workspace_2"],
    );
    expect(JSON.stringify(expiredAuditEvents)).not.toContain(
      "Expire primary workspace memory",
    );
    expect(JSON.stringify(expiredAuditEvents)).not.toContain(
      "Expire other workspace memory",
    );
  });

  it("prunes only terminal memory items past retention cutoff", async () => {
    const deps = createHarness({
      "user_maintainer:repository": { allowed: true },
    });
    const active = await rememberMemoryDirectly(
      memoryInput("repository", "Active old memory must survive prune."),
      deps,
    );
    const disabled = await rememberMemoryDirectly(
      memoryInput("repository", "Disabled old memory must survive prune."),
      deps,
    );
    const expired = await rememberMemoryDirectly(
      memoryInput("repository", "Expired terminal memory should be pruned."),
      deps,
    );
    const deleted = await rememberMemoryDirectly(
      memoryInput("repository", "Deleted terminal memory should be pruned."),
      deps,
    );
    const boundary = await rememberMemoryDirectly(
      memoryInput("repository", "Boundary terminal memory must survive."),
      deps,
    );
    if (
      active.status !== "created" ||
      disabled.status !== "created" ||
      expired.status !== "created" ||
      deleted.status !== "created" ||
      boundary.status !== "created"
    ) {
      throw new Error("expected_created_memory_items");
    }

    const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const oldUpdatedAt = new Date(cutoff.getTime() - 1_000);
    setMemoryItemSnapshot(deps, active.id, { updatedAt: oldUpdatedAt });
    await disableMemoryItem(
      { workspaceId: "workspace_1", itemId: disabled.id, actor: maintainer },
      deps,
    );
    setMemoryItemSnapshot(deps, disabled.id, { updatedAt: oldUpdatedAt });
    setMemoryItemSnapshot(deps, expired.id, {
      status: "expired",
      updatedAt: oldUpdatedAt,
      indexState: "index_deleted",
      indexVersion: null,
    });
    await deleteMemoryItem(
      { workspaceId: "workspace_1", itemId: deleted.id, actor: maintainer },
      deps,
    );
    setMemoryItemSnapshot(deps, deleted.id, { updatedAt: oldUpdatedAt });
    setMemoryItemSnapshot(deps, boundary.id, {
      status: "expired",
      updatedAt: cutoff,
      indexState: "index_deleted",
      indexVersion: null,
    });

    const result = await pruneTerminalMemoryItems(
      { workspaceId: "workspace_1", updatedBefore: cutoff, limit: 10 },
      deps,
    );

    expect(result).toEqual({ status: "pruned", deletedCount: 2 });
    expect(deps.memoryItems.items.has(active.id)).toBe(true);
    expect(deps.memoryItems.items.has(disabled.id)).toBe(true);
    expect(deps.memoryItems.items.has(boundary.id)).toBe(true);
    expect(deps.memoryItems.items.has(expired.id)).toBe(false);
    expect(deps.memoryItems.items.has(deleted.id)).toBe(false);
    const pruneAudit = deps.memoryAudit.events.at(-1);
    expect(pruneAudit).toMatchObject({
      actor: "system:memory-retention",
      action: "memory.item.pruned",
      targetType: "memory_retention",
      targetId: "terminal-memory:workspace_1",
      metadata: {
        candidateCount: 2,
        deletedCount: 2,
        deletedIds: expect.arrayContaining([expired.id, deleted.id]),
        updatedBefore: cutoff.toISOString(),
      },
    });
    expect(JSON.stringify(pruneAudit)).not.toContain(
      "Expired terminal memory should be pruned",
    );
    expect(JSON.stringify(pruneAudit)).not.toContain(
      "Deleted terminal memory should be pruned",
    );
  });

  it("prunes terminal memory items across workspaces in bounded batches", async () => {
    const deps = createHarness({
      "user_maintainer:repository": { allowed: true },
    });
    const primary = await rememberMemoryDirectly(
      memoryInput("repository", "Primary workspace terminal memory."),
      deps,
    );
    const other = await rememberMemoryDirectly(
      {
        ...memoryInput("repository", "Other workspace terminal memory."),
        workspaceId: "workspace_2",
        repositoryId: "repo_2",
      },
      deps,
    );
    if (primary.status !== "created" || other.status !== "created") {
      throw new Error("expected_created_memory_items");
    }
    const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const oldUpdatedAt = new Date(cutoff.getTime() - 1_000);
    setMemoryItemSnapshot(deps, primary.id, {
      status: "expired",
      updatedAt: oldUpdatedAt,
      indexState: "index_deleted",
      indexVersion: null,
    });
    setMemoryItemSnapshot(deps, other.id, {
      status: "deleted",
      updatedAt: oldUpdatedAt,
      indexState: "index_deleted",
      indexVersion: null,
    });

    const result = await pruneTerminalMemoryItemsAcrossWorkspaces(
      { updatedBefore: cutoff, workspaceLimit: 10, perWorkspaceLimit: 1 },
      deps,
    );

    expect(result).toEqual({
      status: "pruned",
      workspaceCount: 2,
      deletedCount: 2,
    });
    expect(deps.memoryItems.items.has(primary.id)).toBe(false);
    expect(deps.memoryItems.items.has(other.id)).toBe(false);
    const pruneAuditEvents = deps.memoryAudit.events.filter(
      (event) => event.action === "memory.item.pruned",
    );
    expect(pruneAuditEvents.map((event) => event.workspaceId).sort()).toEqual([
      "workspace_1",
      "workspace_2",
    ]);
    expect(JSON.stringify(pruneAuditEvents)).not.toContain(
      "Primary workspace terminal memory",
    );
    expect(JSON.stringify(pruneAuditEvents)).not.toContain(
      "Other workspace terminal memory",
    );
  });

  it("exports workspace memory without deleted rows or raw source excerpts", async () => {
    const deps = createHarness({
      "user_maintainer:repository": { allowed: true },
      "user_maintainer:workspace": { allowed: true },
    });
    const privateSourceBody = "Private source excerpt must not be exported.";
    const active = await rememberMemoryDirectly(
      {
        ...memoryInput("repository", "Export active memory body."),
        source: privatePrCommentSource({
          sourceId: "private-comment-1",
          body: privateSourceBody,
        }),
      },
      deps,
    );
    const disabled = await rememberMemoryDirectly(
      memoryInput("repository", "Export disabled memory body."),
      deps,
    );
    const expired = await rememberMemoryDirectly(
      memoryInput("repository", "Export expired memory body."),
      deps,
    );
    const deleted = await rememberMemoryDirectly(
      memoryInput("repository", "Deleted export body must not appear."),
      deps,
    );
    if (
      active.status !== "created" ||
      disabled.status !== "created" ||
      expired.status !== "created" ||
      deleted.status !== "created"
    ) {
      throw new Error("expected_created_memory_items");
    }
    await disableMemoryItem(
      { workspaceId: "workspace_1", itemId: disabled.id, actor: maintainer },
      deps,
    );
    setMemoryItemSnapshot(deps, expired.id, {
      status: "expired",
      indexState: "index_deleted",
      indexVersion: null,
    });
    await deleteMemoryItem(
      { workspaceId: "workspace_1", itemId: deleted.id, actor: maintainer },
      deps,
    );

    const result = await exportMemoryItems(
      { workspaceId: "workspace_1", actor: maintainer },
      deps,
    );

    expect(result.status).toBe("exported");
    if (result.status !== "exported") throw new Error("expected_export");
    expect(result.export.manifest).toMatchObject({
      schemaVersion: 1,
      workspaceId: "workspace_1",
      createdBy: "github_user:user_maintainer",
      itemCount: 3,
      excludedDeletedCount: 1,
      truncatedCount: 0,
      format: "json",
    });
    expect(result.export.items.map((item) => item.body)).toEqual([
      "Export active memory body.",
      "Export disabled memory body.",
      "Export expired memory body.",
    ]);
    expect(result.export.items[0]?.source).toMatchObject({
      sourceId: "private-comment-1",
      url: null,
      sourceVisibility: "private",
    });
    const serializedExport = JSON.stringify(result.export);
    expect(serializedExport).not.toContain(privateSourceBody);
    expect(serializedExport).not.toContain(
      "Deleted export body must not appear",
    );
    expect(serializedExport).not.toContain("redactedExcerpt");
    expect(serializedExport).not.toContain("sourceHash");
    const exportAudit = deps.memoryAudit.events.at(-1);
    expect(exportAudit).toMatchObject({
      actor: "github_user:user_maintainer",
      action: "memory.export.created",
      targetType: "memory_export",
      metadata: {
        itemCount: 3,
        excludedDeletedCount: 1,
        truncatedCount: 0,
        checksumSha256: result.export.manifest.checksumSha256,
        format: "json",
      },
    });
    expect(JSON.stringify(exportAudit)).not.toContain(
      "Export active memory body",
    );
    expect(stringifyMemoryExport(result.export)).toContain('"format": "json"');
  });

  it("requires workspace admin authority for memory export", async () => {
    const deps = createHarness({
      "user_author:repository": { allowed: true },
    });

    const result = await exportMemoryItems(
      { workspaceId: "workspace_1", actor: prAuthor },
      deps,
    );

    expect(result).toEqual({
      status: "rejected",
      reason: "not_workspace_admin",
      retryable: false,
    });
    expect(deps.memoryAudit.events).toHaveLength(0);
  });

  it("fails closed instead of returning partial oversized memory exports", async () => {
    const deps = createHarness({
      "user_maintainer:repository": { allowed: true },
      "user_maintainer:workspace": { allowed: true },
    });
    await rememberMemoryDirectly(
      memoryInput("workspace", "First memory export budget item."),
      deps,
    );
    await rememberMemoryDirectly(
      memoryInput("workspace", "Second memory export budget item."),
      deps,
    );
    const auditCountBeforeExport = deps.memoryAudit.events.length;

    const rowLimited = await exportMemoryItems(
      { workspaceId: "workspace_1", actor: maintainer, limit: 1 },
      deps,
    );
    const byteLimited = await exportMemoryItems(
      { workspaceId: "workspace_1", actor: maintainer, maxBytes: 128 },
      deps,
    );

    expect(rowLimited).toEqual({
      status: "rejected",
      reason: "memory_export_too_large",
      retryable: false,
    });
    expect(byteLimited).toEqual({
      status: "rejected",
      reason: "memory_export_too_large",
      retryable: false,
    });
    expect(deps.memoryAudit.events).toHaveLength(auditCountBeforeExport);
  });

  it("applies policy export caps before serializing memory export", async () => {
    const deps = createHarness(
      {
        "user_maintainer:workspace": { allowed: true },
      },
      {
        policy: {
          export: {
            defaultItemLimit: 1,
            maxItemLimit: 1,
          },
        },
      },
    );
    await rememberMemoryDirectly(
      memoryInput("workspace", "First policy-capped export item."),
      deps,
    );
    await rememberMemoryDirectly(
      memoryInput("workspace", "Second policy-capped export item."),
      deps,
    );
    const auditCountBeforeExport = deps.memoryAudit.events.length;

    const result = await exportMemoryItems(
      { workspaceId: "workspace_1", actor: maintainer },
      deps,
    );

    expect(result).toEqual({
      status: "rejected",
      reason: "memory_export_too_large",
      retryable: false,
    });
    expect(deps.memoryAudit.events).toHaveLength(auditCountBeforeExport);
  });

  it("treats expired pending suggestions as noop on confirm before worker runs", async () => {
    const deps = createHarness({});
    const proposed = await proposeMemoryFromInteraction(
      {
        envelope: candidateEnvelope({
          intent: "explicit_natural_language",
          extractionMethod: "explicit_natural_language",
          body: "Expired confirm must not create memory.",
          actor: maintainer,
        }),
      },
      deps,
    );
    if (proposed.status !== "created") throw new Error("missing_suggestion");
    const snapshot = deps.memorySuggestions.suggestions.get(proposed.id);
    if (!snapshot) throw new Error("missing_suggestion");
    deps.memorySuggestions.suggestions.set(proposed.id, {
      ...snapshot,
      expiresAt: new Date(now.getTime() - 1_000),
    });

    const result = await confirmMemorySuggestion(
      {
        workspaceId: "workspace_1",
        suggestionId: proposed.id,
        actor: prAuthor,
      },
      deps,
    );

    expect(result).toEqual({
      status: "noop",
      reason: "expired",
      id: proposed.id,
    });
    expect(deps.memorySuggestions.suggestions.get(proposed.id)).toMatchObject({
      status: "expired",
      resolvedBy: "system:memory-retention",
      resolutionReason: "expired",
    });
    expect(deps.memoryItems.items).toHaveLength(0);
    expect(deps.memoryAudit.events.at(-1)).toMatchObject({
      action: "memory.suggestion.expired",
      targetId: proposed.id,
    });
    expect(JSON.stringify(deps.memoryAudit.events.at(-1))).not.toContain(
      "Expired confirm must not create memory",
    );
  });

  it("treats expired pending suggestions as noop on reject before worker runs", async () => {
    const deps = createHarness({});
    const proposed = await proposeMemoryFromInteraction(
      {
        envelope: candidateEnvelope({
          intent: "explicit_natural_language",
          extractionMethod: "explicit_natural_language",
          body: "Expired reject must not require permission.",
          actor: maintainer,
        }),
      },
      deps,
    );
    if (proposed.status !== "created") throw new Error("missing_suggestion");
    const snapshot = deps.memorySuggestions.suggestions.get(proposed.id);
    if (!snapshot) throw new Error("missing_suggestion");
    deps.memorySuggestions.suggestions.set(proposed.id, {
      ...snapshot,
      expiresAt: new Date(now.getTime() - 1_000),
    });

    const result = await rejectMemorySuggestion(
      {
        workspaceId: "workspace_1",
        suggestionId: proposed.id,
        actor: prAuthor,
        reason: "manual_reject",
      },
      deps,
    );

    expect(result).toEqual({
      status: "noop",
      reason: "expired",
      id: proposed.id,
    });
    expect(deps.memorySuggestions.suggestions.get(proposed.id)).toMatchObject({
      status: "expired",
      resolvedBy: "system:memory-retention",
      resolutionReason: "expired",
    });
    expect(deps.memoryAudit.events.at(-1)).toMatchObject({
      action: "memory.suggestion.expired",
      targetId: proposed.id,
    });
    expect(JSON.stringify(deps.memoryAudit.events.at(-1))).not.toContain(
      "Expired reject must not require permission",
    );
  });

  it("builds bundles from canonical active items and respects runtime policy", async () => {
    const deps = createHarness({
      "user_maintainer:repository": { allowed: true },
      "user_maintainer:workspace": { allowed: true },
      "user_maintainer:user_prefs": { allowed: true },
    });
    await rememberMemoryDirectly(
      memoryInput("repository", "Repo memory should rank first."),
      deps,
    );
    await rememberMemoryDirectly(
      memoryInput("workspace", "Workspace memory should rank second."),
      deps,
    );
    await rememberMemoryDirectly(
      memoryInput("user_prefs", "Answer in Russian."),
      deps,
    );

    const firstItem = [...deps.memoryItems.items.values()][0];
    if (!firstItem) throw new Error("missing_item");
    await deps.memoryItems.save(
      MemoryItem.fromSnapshot(firstItem).disable({ actor: maintainer, now }),
    );

    const bundle = await buildActionMemoryBundle(
      {
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
        userId: "user_maintainer",
        policy: { includeUserPrefs: false },
      },
      deps,
    );

    expect(bundle.items.map((item) => item.body)).toEqual([
      "Workspace memory should rank second.",
    ]);
  });

  it("applies policy runtime bundle caps before action retrieval", async () => {
    const deps = createHarness(
      {
        "user_maintainer:repository": { allowed: true },
        "user_maintainer:workspace": { allowed: true },
      },
      {
        policy: {
          runtimeBundle: {
            maxItems: 1,
            maxCharacters: 10_000,
            includeUserPrefs: false,
          },
        },
      },
    );
    await rememberMemoryDirectly(
      memoryInput("repository", "First runtime policy memory."),
      deps,
    );
    await rememberMemoryDirectly(
      memoryInput("workspace", "Second runtime policy memory."),
      deps,
    );

    const bundle = await buildActionMemoryBundle(
      {
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
        userId: null,
      },
      deps,
    );

    expect(bundle.items.map((item) => item.body)).toEqual([
      "First runtime policy memory.",
    ]);
  });

  it("filters runtime bundles by policy allowed scopes after canonical retrieval", async () => {
    const deps = createHarness({
      "user_maintainer:repository": { allowed: true },
      "user_maintainer:workspace": { allowed: true },
    });
    await rememberMemoryDirectly(
      memoryInput("repository", "Allowed repository runtime memory."),
      deps,
    );
    await rememberMemoryDirectly(
      memoryInput("workspace", "Disabled workspace runtime memory."),
      deps,
    );

    const bundle = await buildActionMemoryBundle(
      {
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
        userId: null,
      },
      {
        ...deps,
        memoryPolicyConfig: new StaticMemoryPolicyConfig({
          allowedScopes: { workspace: false },
        }),
      },
    );

    expect(bundle.items.map((item) => item.body)).toEqual([
      "Allowed repository runtime memory.",
    ]);
  });

  it("uses search index hits only after canonical scope recheck", async () => {
    const deps = createHarness({
      "user_maintainer:repository": { allowed: true },
      "user_maintainer:user_prefs": { allowed: true },
    });
    const active = await rememberMemoryDirectly(
      memoryInput(
        "repository",
        "Run dashboard memory changes through browser layout checks.",
      ),
      deps,
    );
    const wrongRepository = await rememberMemoryDirectly(
      {
        ...memoryInput(
          "repository",
          "Other repository layout memory must not leak.",
        ),
        repositoryId: "repo_2",
      },
      deps,
    );
    const wrongWorkspace = await rememberMemoryDirectly(
      {
        ...memoryInput(
          "repository",
          "Other workspace layout memory must not leak.",
        ),
        workspaceId: "workspace_2",
      },
      deps,
    );
    const wrongUserPrefs = await rememberMemoryDirectly(
      {
        ...memoryInput(
          "user_prefs",
          "Other user layout preference must not leak.",
        ),
        userId: "user_other",
      },
      deps,
    );
    const disabled = await rememberMemoryDirectly(
      memoryInput("repository", "Disabled layout memory must not return."),
      deps,
    );
    const deleted = await rememberMemoryDirectly(
      memoryInput("repository", "Deleted layout memory must not return."),
      deps,
    );
    if (
      active.status !== "created" ||
      wrongRepository.status !== "created" ||
      wrongWorkspace.status !== "created" ||
      wrongUserPrefs.status !== "created" ||
      disabled.status !== "created" ||
      deleted.status !== "created"
    ) {
      throw new Error("missing_memory_items");
    }
    const disabledSnapshot = deps.memoryItems.items.get(disabled.id);
    if (!disabledSnapshot) throw new Error("missing_disabled_item");
    await deps.memoryItems.save(
      MemoryItem.fromSnapshot(disabledSnapshot).disable({
        actor: maintainer,
        now,
      }),
    );
    const deletedSnapshot = deps.memoryItems.items.get(deleted.id);
    if (!deletedSnapshot) throw new Error("missing_deleted_item");
    await deps.memoryItems.save(
      MemoryItem.fromSnapshot(deletedSnapshot).delete({
        actor: maintainer,
        now,
      }),
    );

    const searchIndex = new StubSearchIndex(
      [
        searchHit(wrongWorkspace.id, "repository", 30),
        searchHit(wrongRepository.id, "repository", 25),
        searchHit(wrongUserPrefs.id, "user_prefs", 22),
        searchHit(disabled.id, "repository", 20),
        searchHit(deleted.id, "repository", 15),
        searchHit(active.id, "repository", 10),
        searchHit("missing_from_canonical_store", "repository", 5),
      ],
      { capabilities: ["semantic_vector"] },
    );
    const bundle = await buildActionMemoryBundle(
      {
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
        userId: "user_maintainer",
        safeRetrievalQuery: "layout checks",
        policy: { includeUserPrefs: true },
      },
      { ...deps, memorySearchIndex: searchIndex },
    );

    expect(searchIndex.inputs[0]).toMatchObject({
      workspaceId: "workspace_1",
      repositoryId: "repo_1",
      userId: "user_maintainer",
      safeQuery: "layout checks",
      includeUserPrefs: true,
    });
    expect(bundle.degraded).toBe(false);
    expect(bundle.items.map((item) => item.body)).toEqual([
      "Run dashboard memory changes through browser layout checks.",
    ]);
  });

  it("falls back to canonical bundle when search index is unavailable or stale", async () => {
    const deps = createHarness({
      "user_maintainer:repository": { allowed: true },
      "user_maintainer:workspace": { allowed: true },
    });
    await rememberMemoryDirectly(
      memoryInput("repository", "Repository runtime fallback guidance."),
      deps,
    );
    await rememberMemoryDirectly(
      memoryInput("workspace", "Workspace runtime fallback guidance."),
      deps,
    );

    const unavailable = await buildActionMemoryBundle(
      {
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
        userId: null,
        safeRetrievalQuery: "fallback",
      },
      {
        ...deps,
        memorySearchIndex: new StubSearchIndex([], { fail: true }),
      },
    );
    expect(unavailable.degraded).toBe(true);
    expect(unavailable.reason).toBe("memory_search_index_unavailable");
    expect(unavailable.items.map((item) => item.body)).toEqual([
      "Repository runtime fallback guidance.",
      "Workspace runtime fallback guidance.",
    ]);

    const stale = await buildActionMemoryBundle(
      {
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
        userId: null,
        safeRetrievalQuery: "fallback",
      },
      {
        ...deps,
        memorySearchIndex: new StubSearchIndex([
          searchHit("missing_from_canonical_store", "repository", 99),
        ]),
      },
    );
    expect(stale.degraded).toBe(true);
    expect(stale.reason).toBe("memory_search_index_stale");
    expect(stale.items).toHaveLength(2);

    const unsupportedIndex = new StubSearchIndex([], { capabilities: [] });
    const unsupported = await buildActionMemoryBundle(
      {
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
        userId: null,
        safeRetrievalQuery: "fallback",
      },
      {
        ...deps,
        memorySearchIndex: unsupportedIndex,
      },
    );
    expect(unsupported.degraded).toBe(true);
    expect(unsupported.reason).toBe("memory_search_index_unavailable");
    expect(unsupportedIndex.inputs).toHaveLength(0);
    expect(unsupported.items).toHaveLength(2);
  });

  it("records action bundle usage with safe metadata only", async () => {
    const deps = createHarness({
      "user_maintainer:repository": { allowed: true },
      "user_maintainer:workspace": { allowed: true },
    });
    await rememberMemoryDirectly(
      memoryInput("repository", "Repository runtime guidance."),
      deps,
    );
    await rememberMemoryDirectly(
      memoryInput("workspace", "Workspace runtime guidance."),
      deps,
    );
    const bundle = await buildActionMemoryBundle(
      {
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
        userId: null,
      },
      deps,
    );

    const result = await recordActionMemoryBundleUsage(
      {
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
        runtimeContext: {
          githubRunId: "1001",
          githubRunAttempt: "1",
          eventName: "pull_request",
        },
        bundleVersion: bundle.memoryVersion,
        items: [
          ...bundle.items.map((item) => ({ id: item.id, scope: item.scope })),
          { id: bundle.items[0]?.id ?? "missing", scope: "repository" },
        ],
      },
      deps,
    );

    expect(result).toEqual({
      status: "recorded",
      exposedItemCount: 2,
      usageEventRecordedCount: 2,
      duplicateUsageEventCount: 0,
      markedUsedCount: 2,
    });
    expect(deps.memoryUsageEvents.events).toHaveLength(2);
    expect(
      deps.memoryUsageEvents.events.map((event) => event.memoryItemId),
    ).toEqual(bundle.items.map((item) => item.id));
    expect(deps.memoryUsageEvents.events[0]).toMatchObject({
      id: "mem_usage_3",
      workspaceId: "workspace_1",
      repositoryId: "repo_1",
      eventType: "action_bundle_exposed",
      bundleVersion: 1,
      metadata: {
        scope: "repository",
        bundleItemCount: 2,
        githubRunId: "1001",
        githubRunAttempt: "1",
        eventName: "pull_request",
      },
      occurredAt: now,
    });
    expect(deps.memoryUsageEvents.events[0]?.dedupeKey).toMatch(
      /^mem_usage:[a-f0-9]{64}$/,
    );
    expect(JSON.stringify(deps.memoryUsageEvents.events)).not.toContain(
      "runtime guidance",
    );
    expect(
      bundle.items.map(
        (item) => deps.memoryItems.items.get(item.id)?.lastUsedAt,
      ),
    ).toEqual([now, now]);

    const duplicateResult = await recordActionMemoryBundleUsage(
      {
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
        runtimeContext: {
          githubRunId: "1001",
          githubRunAttempt: "1",
          eventName: "pull_request",
        },
        bundleVersion: bundle.memoryVersion,
        items: bundle.items.map((item) => ({
          id: item.id,
          scope: item.scope,
        })),
      },
      deps,
    );
    expect(duplicateResult).toEqual({
      status: "recorded",
      exposedItemCount: 2,
      usageEventRecordedCount: 0,
      duplicateUsageEventCount: 2,
      markedUsedCount: 2,
    });
    expect(deps.memoryUsageEvents.events).toHaveLength(2);
  });

  it("prunes usage telemetry by explicit retention scope and cutoff", async () => {
    const deps = createHarness({});
    deps.memoryUsageEvents.events.push(
      memoryUsageEvent({
        id: "old_workspace_1_a",
        workspaceId: "workspace_1",
        occurredAt: new Date("2026-05-01T00:00:00.000Z"),
      }),
      memoryUsageEvent({
        id: "old_workspace_1_b",
        workspaceId: "workspace_1",
        occurredAt: new Date("2026-05-02T00:00:00.000Z"),
      }),
      memoryUsageEvent({
        id: "new_workspace_1",
        workspaceId: "workspace_1",
        occurredAt: new Date("2026-05-12T13:00:00.000Z"),
      }),
      memoryUsageEvent({
        id: "old_workspace_2",
        workspaceId: "workspace_2",
        occurredAt: new Date("2026-05-01T00:00:00.000Z"),
      }),
    );

    const firstBatch = await pruneMemoryUsageEvents(
      {
        scope: { kind: "workspace", workspaceId: "workspace_1" },
        occurredBefore: now,
        limit: 1,
      },
      { memoryUsageEventRetention: deps.memoryUsageEvents },
    );

    expect(firstBatch).toEqual({ status: "pruned", deletedCount: 1 });
    expect(deps.memoryUsageEvents.events.map((event) => event.id)).toEqual([
      "old_workspace_1_b",
      "new_workspace_1",
      "old_workspace_2",
    ]);

    const secondBatch = await pruneMemoryUsageEvents(
      {
        scope: { kind: "workspace", workspaceId: "workspace_1" },
        occurredBefore: now,
      },
      { memoryUsageEventRetention: deps.memoryUsageEvents },
    );

    expect(secondBatch).toEqual({ status: "pruned", deletedCount: 1 });
    expect(deps.memoryUsageEvents.events.map((event) => event.id)).toEqual([
      "new_workspace_1",
      "old_workspace_2",
    ]);

    const globalBatch = await pruneMemoryUsageEvents(
      {
        scope: { kind: "all_workspaces" },
        occurredBefore: now,
      },
      { memoryUsageEventRetention: deps.memoryUsageEvents },
    );

    expect(globalBatch).toEqual({ status: "pruned", deletedCount: 1 });
    expect(deps.memoryUsageEvents.events.map((event) => event.id)).toEqual([
      "new_workspace_1",
    ]);
  });

  it("rejects unsafe usage telemetry retention inputs", async () => {
    const deps = createHarness({});

    await expect(
      pruneMemoryUsageEvents(
        {
          scope: { kind: "workspace", workspaceId: " " },
          occurredBefore: now,
        },
        { memoryUsageEventRetention: deps.memoryUsageEvents },
      ),
    ).rejects.toMatchObject({ code: "memory_input_invalid" });

    await expect(
      pruneMemoryUsageEvents(
        {
          scope: { kind: "workspace", workspaceId: "workspace_1" },
          occurredBefore: new Date(Number.NaN),
        },
        { memoryUsageEventRetention: deps.memoryUsageEvents },
      ),
    ).rejects.toMatchObject({ code: "memory_input_invalid" });

    await expect(
      pruneMemoryUsageEvents(
        {
          scope: { kind: "all_workspaces" },
          occurredBefore: now,
          limit: 0,
        },
        { memoryUsageEventRetention: deps.memoryUsageEvents },
      ),
    ).rejects.toMatchObject({ code: "memory_input_invalid" });
  });
});

function candidateEnvelope(input: {
  readonly intent: MemoryCandidateEnvelope["intent"];
  readonly extractionMethod: MemoryCandidateEnvelope["extractionMethod"];
  readonly body: string;
  readonly actor: MemoryActor;
  readonly workspaceId?: string;
  readonly repositoryId?: string;
  readonly sourceId?: string;
}): MemoryCandidateEnvelope {
  const body = normalizeMemoryBody(input.body);
  return {
    workspaceId: input.workspaceId ?? "workspace_1",
    repositoryId: input.repositoryId ?? "repo_1",
    userId: input.actor.id,
    source: input.sourceId
      ? {
          ...createDashboardMemorySource({
            actorLogin: input.actor.login,
            sourceId: input.sourceId,
          }),
          type: "pr_comment",
          githubCommentId: input.sourceId,
          sourceVisibility: "private",
        }
      : createDashboardMemorySource({ actorLogin: input.actor.login }),
    actor: input.actor,
    intent: input.intent,
    requestedScope: "repository",
    candidateBody: body,
    candidateBodyHash: createMemoryBodyHash(body),
    redactedSourceExcerpt: null,
    sourceTextHash: createMemoryBodyHash(body),
    extractionMethod: input.extractionMethod,
    extractionVersion: 1,
  };
}

function memoryInput(scope: MemoryScope, body: string) {
  return {
    workspaceId: "workspace_1",
    repositoryId: scope === "repository" ? "repo_1" : null,
    userId: scope === "user_prefs" ? "user_maintainer" : null,
    scope,
    body,
    source: createDashboardMemorySource({ actorLogin: "maintainer" }),
    actor: maintainer,
  };
}

function privatePrCommentSource(input: {
  readonly sourceId: string;
  readonly body: string;
}) {
  return {
    type: "pr_comment" as const,
    sourceId: input.sourceId,
    githubCommentId: "10000001",
    githubPullRequestNumber: 1,
    githubRepositoryId: "123456",
    url: "https://github.com/example/private/pull/1#issuecomment-10000001",
    actorLogin: "maintainer",
    redactedExcerpt: input.body,
    sourceHash: createMemoryBodyHash(input.body),
    sourceVisibility: "private" as const,
  };
}

function setMemoryItemExpiresAt(
  deps: ReturnType<typeof createHarness>,
  itemId: string,
  expiresAt: Date,
): void {
  const snapshot = deps.memoryItems.items.get(itemId);
  if (!snapshot) throw new Error("missing_memory_item");
  deps.memoryItems.items.set(itemId, { ...snapshot, expiresAt });
}

function setMemoryItemSnapshot(
  deps: ReturnType<typeof createHarness>,
  itemId: string,
  patch: Partial<MemoryItemSnapshot>,
): void {
  const snapshot = deps.memoryItems.items.get(itemId);
  if (!snapshot) throw new Error("missing_memory_item");
  deps.memoryItems.items.set(itemId, { ...snapshot, ...patch });
}

function memoryUsageEvent(
  input: Pick<MemoryUsageEventInput, "id" | "workspaceId" | "occurredAt">,
): MemoryUsageEventInput {
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    repositoryId: `${input.workspaceId}_repo`,
    memoryItemId: `${input.id}_item`,
    eventType: "action_bundle_exposed",
    bundleVersion: 1,
    dedupeKey: `${input.id}_dedupe`,
    metadata: {
      scope: "repository",
      bundleItemCount: 1,
      githubRunId: "1001",
      githubRunAttempt: "1",
      eventName: "pull_request",
    },
    occurredAt: input.occurredAt,
  };
}

function searchHit(
  memoryItemId: string,
  scope: MemoryScope,
  score: number,
): MemorySearchIndexResult {
  return {
    memoryItemId,
    scope,
    score,
    scoreParts: {
      lexicalScore: score,
      semanticScore: 0,
      recencyScore: 0,
      scopeScore: 0,
      riskPenalty: 0,
    },
    explanationCode: "lexical_match",
  };
}
