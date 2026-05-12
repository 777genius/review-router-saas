import { describe, expect, it } from "vitest";
import type { Clock } from "@reviewrouter/shared";
import type { MemoryActor } from "../domain/memory-actor";
import {
  createMemoryBodyHash,
  normalizeMemoryBody,
} from "../domain/memory-body";
import type { MemoryCandidateEnvelope } from "../domain/memory-candidate";
import { MemoryError, memoryError } from "../domain/memory-errors";
import { parseMemoryIntent } from "../domain/memory-intent-policy";
import { MemoryItem, type MemoryItemSnapshot } from "../domain/memory-item";
import type { MemoryScope } from "../domain/memory-scope-policy";
import { createDashboardMemorySource } from "../domain/memory-source";
import type {
  MemorySuggestion,
  MemorySuggestionSnapshot,
  MemorySuggestionStatus,
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
import type {
  MemorySuggestionDashboardRepositoryCursor,
  MemorySuggestionRepositoryPort,
} from "../application/ports/memory-suggestion-repository-port";
import type { MemoryTransactionPort } from "../application/ports/memory-transaction-port";
import type {
  MemoryUsageEventInput,
  MemoryUsageEventPort,
} from "../application/ports/memory-usage-event-port";
import { buildActionMemoryBundle } from "../application/use-cases/build-action-memory-bundle";
import { confirmMemorySuggestion } from "../application/use-cases/confirm-memory-suggestion";
import { deleteMemoryItem } from "../application/use-cases/delete-memory-item";
import { disableMemoryItem } from "../application/use-cases/disable-memory-item";
import { editMemoryItem } from "../application/use-cases/edit-memory-item";
import { expirePendingMemorySuggestions } from "../application/use-cases/expire-pending-memory-suggestions";
import { listMemoryItemsForDashboard } from "../application/use-cases/list-memory-items-for-dashboard";
import { listMemorySuggestionsForDashboard } from "../application/use-cases/list-memory-suggestions-for-dashboard";
import { proposeMemoryFromInteraction } from "../application/use-cases/propose-memory-from-interaction";
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

class CapturingUsageEvents implements MemoryUsageEventPort {
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

function createHarness(decisions: Record<string, MemoryPermissionDecision>) {
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

    const deleted = await deleteMemoryItem(
      { workspaceId: "workspace_1", itemId: created.id, actor: maintainer },
      deps,
    );
    expect(deleted).toMatchObject({ status: "updated", id: created.id });
    expect(deps.memoryItems.items.get(created.id)?.status).toBe("deleted");

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
    expect(deps.memoryOutbox.events).toHaveLength(1);

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
      "Keep service methods small.",
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
});

function candidateEnvelope(input: {
  readonly intent: MemoryCandidateEnvelope["intent"];
  readonly extractionMethod: MemoryCandidateEnvelope["extractionMethod"];
  readonly body: string;
  readonly actor: MemoryActor;
  readonly workspaceId?: string;
  readonly repositoryId?: string;
}): MemoryCandidateEnvelope {
  const body = normalizeMemoryBody(input.body);
  return {
    workspaceId: input.workspaceId ?? "workspace_1",
    repositoryId: input.repositoryId ?? "repo_1",
    userId: input.actor.id,
    source: createDashboardMemorySource({ actorLogin: input.actor.login }),
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
