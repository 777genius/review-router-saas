import { describe, expect, it } from "vitest";
import type { MemoryItemSnapshot } from "../domain/memory-item";
import { MemoryItem } from "../domain/memory-item";
import { createDashboardMemorySource } from "../domain/memory-source";
import type { MemorySearchIndexPort } from "../application/ports/memory-search-index-port";
import {
  createMemoryEmbeddingDeleteRequestedHandler,
  createMemoryEmbeddingReindexRequestedHandler,
  createMemoryOutboxHandlers,
} from "../infrastructure/outbox/memory-index-outbox-handlers";
import type { OutboxEvent } from "@reviewrouter/features-outbox";

const now = new Date("2026-05-12T12:00:00.000Z");

class StaticMemoryItems {
  constructor(private readonly items: ReadonlyMap<string, MemoryItemSnapshot>) {}

  async findById(input: {
    readonly workspaceId: string;
    readonly itemId: string;
  }): Promise<MemoryItemSnapshot | null> {
    const item = this.items.get(input.itemId);
    return item?.workspaceId === input.workspaceId ? item : null;
  }
}

class CapturingSearchIndex implements MemorySearchIndexPort {
  readonly upserts: unknown[] = [];
  readonly deletes: unknown[] = [];

  async supports(): ReturnType<MemorySearchIndexPort["supports"]> {
    return { capabilities: ["lexical"] };
  }

  async search(): ReturnType<MemorySearchIndexPort["search"]> {
    return [];
  }

  async upsertDocument(
    input: Parameters<MemorySearchIndexPort["upsertDocument"]>[0],
  ): ReturnType<MemorySearchIndexPort["upsertDocument"]> {
    this.upserts.push(input);
  }

  async deleteDocument(
    input: Parameters<MemorySearchIndexPort["deleteDocument"]>[0],
  ): ReturnType<MemorySearchIndexPort["deleteDocument"]> {
    this.deletes.push(input);
  }
}

describe("memory outbox handlers", () => {
  it("reindexes from canonical active memory instead of outbox payload body", async () => {
    const item = memoryItem("mem_1", "Prefer ports and adapters.");
    const searchIndex = new CapturingSearchIndex();
    const handler = createMemoryEmbeddingReindexRequestedHandler({
      memoryItems: new StaticMemoryItems(new Map([[item.id, item]])),
      searchIndex,
    });

    await handler.handle(
      outboxEvent({
        type: "memory.embedding.reindex.requested",
        aggregateId: item.id,
        payload: {
          bodyHash: item.bodyHash,
          bodyVersion: item.bodyVersion,
        },
      }),
    );

    expect(searchIndex.upserts).toEqual([
      expect.objectContaining({
        workspaceId: "workspace_1",
        memoryItemId: item.id,
        body: "Prefer ports and adapters.",
        bodyHash: item.bodyHash,
      }),
    ]);
    expect(searchIndex.deletes).toEqual([]);
  });

  it("drops stale or inactive index documents without leaking memory body", async () => {
    const item = MemoryItem.fromSnapshot(
      memoryItem("mem_1", "Disabled body must be removed."),
    )
      .disable({
        actor: {
          kind: "github_user",
          id: "user_1",
          githubUserId: "1",
          login: "maintainer",
        },
        now,
      })
      .snapshot();
    const searchIndex = new CapturingSearchIndex();
    const handler = createMemoryEmbeddingReindexRequestedHandler({
      memoryItems: new StaticMemoryItems(new Map([[item.id, item]])),
      searchIndex,
    });

    await handler.handle(
      outboxEvent({
        type: "memory.embedding.reindex.requested",
        aggregateId: item.id,
        payload: {
          bodyHash: item.bodyHash,
          bodyVersion: item.bodyVersion,
        },
      }),
    );

    expect(searchIndex.upserts).toEqual([]);
    expect(searchIndex.deletes).toEqual([
      { workspaceId: "workspace_1", memoryItemId: item.id },
    ]);
  });

  it("ignores stale reindex payloads and handles delete requests", async () => {
    const item = memoryItem("mem_1", "Fresh body wins over stale event.");
    const searchIndex = new CapturingSearchIndex();
    const dependencies = {
      memoryItems: new StaticMemoryItems(new Map([[item.id, item]])),
      searchIndex,
    };

    await createMemoryEmbeddingReindexRequestedHandler(dependencies).handle(
      outboxEvent({
        type: "memory.embedding.reindex.requested",
        aggregateId: item.id,
        payload: {
          bodyHash: "stale_hash",
          bodyVersion: item.bodyVersion,
        },
      }),
    );
    await createMemoryEmbeddingDeleteRequestedHandler(dependencies).handle(
      outboxEvent({
        type: "memory.embedding.delete.requested",
        aggregateId: item.id,
        payload: { scope: "repository" },
      }),
    );

    expect(searchIndex.upserts).toEqual([]);
    expect(searchIndex.deletes).toEqual([
      { workspaceId: "workspace_1", memoryItemId: item.id },
    ]);
  });

  it("registers handlers for lifecycle events so worker does not dead-letter them", () => {
    expect(createMemoryOutboxHandlers({
      memoryItems: new StaticMemoryItems(new Map()),
      searchIndex: new CapturingSearchIndex(),
    }).map((handler) => `${handler.type}@${handler.version}`)).toEqual([
      "memory.item.created@1",
      "memory.item.deleted@1",
      "memory.item.disabled@1",
      "memory.item.edited@1",
      "memory.suggestion.created@1",
      "memory.suggestion.confirmed@1",
      "memory.suggestion.rejected@1",
      "memory.embedding.reindex.requested@1",
      "memory.embedding.delete.requested@1",
    ]);
  });
});

function memoryItem(id: string, body: string): MemoryItemSnapshot {
  return MemoryItem.create({
    id,
    workspaceId: "workspace_1",
    repositoryId: "repo_1",
    userId: null,
    scope: "repository",
    body,
    riskLevel: "low",
    confidence: 1,
    source: createDashboardMemorySource({ actorLogin: "maintainer" }),
    policyVersion: 1,
    safetyPolicyVersion: 1,
    actor: {
      kind: "github_user",
      id: "user_1",
      githubUserId: "1",
      login: "maintainer",
    },
    now,
  }).snapshot();
}

function outboxEvent(input: {
  readonly type: string;
  readonly aggregateId: string | null;
  readonly payload: unknown;
}): OutboxEvent {
  return {
    id: `${input.type}:${input.aggregateId ?? "missing"}`,
    type: input.type,
    version: 1,
    idempotencyKey: `${input.type}:${input.aggregateId ?? "missing"}`,
    workspaceId: "workspace_1",
    repositoryId: "repo_1",
    aggregateId: input.aggregateId,
    payload: input.payload,
    status: "processing",
    attempts: 1,
    maxAttempts: 5,
    nextAttemptAt: null,
    occurredAt: now,
  };
}
