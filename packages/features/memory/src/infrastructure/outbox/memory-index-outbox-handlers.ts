import {
  OutboxHandlerError,
  type OutboxEvent,
  type OutboxHandler,
} from "@reviewrouter/features-outbox";
import type { MemoryItemSnapshot } from "../../domain/memory-item";
import type { MemoryItemRepositoryPort } from "../../application/ports/memory-item-repository-port";
import type { MemorySearchIndexPort } from "../../application/ports/memory-search-index-port";

export type MemoryIndexOutboxHandlerDependencies = {
  readonly memoryItems: Pick<
    MemoryItemRepositoryPort,
    "findById" | "markIndexingDeleted" | "markIndexingSucceeded"
  >;
  readonly searchIndex: MemorySearchIndexPort;
};

const memoryLifecycleEventTypes = [
  "memory.item.created",
  "memory.item.deleted",
  "memory.item.disabled",
  "memory.item.edited",
  "memory.item.expired",
  "memory.suggestion.created",
  "memory.suggestion.confirmed",
  "memory.suggestion.rejected",
] as const;

export function createMemoryOutboxHandlers(
  dependencies: MemoryIndexOutboxHandlerDependencies,
): readonly OutboxHandler[] {
  return [
    ...memoryLifecycleEventTypes.map((type) => createNoopMemoryHandler(type)),
    createMemoryEmbeddingReindexRequestedHandler(dependencies),
    createMemoryEmbeddingDeleteRequestedHandler(dependencies),
  ];
}

export function createMemoryEmbeddingReindexRequestedHandler(
  dependencies: MemoryIndexOutboxHandlerDependencies,
): OutboxHandler {
  return {
    type: "memory.embedding.reindex.requested",
    version: 1,
    async handle(event) {
      const ids = requireMemoryEventIds(event);
      const payload = parseVersionedIndexPayload(event.payload);
      const item = await dependencies.memoryItems.findById({
        workspaceId: ids.workspaceId,
        itemId: ids.memoryItemId,
      });
      if (!item || item.status !== "active") {
        await dependencies.searchIndex.deleteDocument(ids);
        await dependencies.memoryItems.markIndexingDeleted({
          workspaceId: ids.workspaceId,
          itemId: ids.memoryItemId,
        });
        return;
      }
      if (!matchesIndexPayload(item, payload)) {
        return;
      }
      await dependencies.searchIndex.upsertDocument({
        workspaceId: item.workspaceId,
        memoryItemId: item.id,
        repositoryId: item.repositoryId,
        userId: item.userId,
        scope: item.scope,
        body: item.body,
        bodyHash: item.bodyHash,
        bodyVersion: item.bodyVersion,
        tags: item.tags,
        updatedAt: item.updatedAt,
      });
      await dependencies.memoryItems.markIndexingSucceeded({
        workspaceId: item.workspaceId,
        itemId: item.id,
        bodyHash: item.bodyHash,
        bodyVersion: item.bodyVersion,
      });
    },
  };
}

export function createMemoryEmbeddingDeleteRequestedHandler(
  dependencies: MemoryIndexOutboxHandlerDependencies,
): OutboxHandler {
  return {
    type: "memory.embedding.delete.requested",
    version: 1,
    async handle(event) {
      const ids = requireMemoryEventIds(event);
      await dependencies.searchIndex.deleteDocument(ids);
      await dependencies.memoryItems.markIndexingDeleted({
        workspaceId: ids.workspaceId,
        itemId: ids.memoryItemId,
      });
    },
  };
}

function createNoopMemoryHandler(type: string): OutboxHandler {
  return {
    type,
    version: 1,
    async handle(event) {
      requireMemoryEventIds(event);
    },
  };
}

function requireMemoryEventIds(event: OutboxEvent): {
  readonly workspaceId: string;
  readonly memoryItemId: string;
} {
  if (!event.workspaceId || !event.aggregateId) {
    throw new OutboxHandlerError(
      "Memory outbox event is missing workspace or aggregate id",
      "invalid_memory_outbox_event_ids",
      false,
    );
  }
  return {
    workspaceId: event.workspaceId,
    memoryItemId: event.aggregateId,
  };
}

function parseVersionedIndexPayload(payload: unknown): {
  readonly bodyHash: string;
  readonly bodyVersion: number;
} {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("bodyHash" in payload) ||
    !("bodyVersion" in payload) ||
    typeof (payload as { readonly bodyHash?: unknown }).bodyHash !== "string" ||
    typeof (payload as { readonly bodyVersion?: unknown }).bodyVersion !==
      "number"
  ) {
    throw new OutboxHandlerError(
      "Invalid memory index outbox payload",
      "invalid_memory_index_payload",
      false,
    );
  }
  return {
    bodyHash: (payload as { readonly bodyHash: string }).bodyHash,
    bodyVersion: (payload as { readonly bodyVersion: number }).bodyVersion,
  };
}

function matchesIndexPayload(
  item: MemoryItemSnapshot,
  payload: { readonly bodyHash: string; readonly bodyVersion: number },
): boolean {
  return (
    item.bodyHash === payload.bodyHash &&
    item.bodyVersion === payload.bodyVersion
  );
}
