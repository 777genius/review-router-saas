export type MemoryOutboxEvent = {
  readonly type:
    | "memory.item.created"
    | "memory.item.deleted"
    | "memory.item.disabled"
    | "memory.item.edited"
    | "memory.suggestion.created"
    | "memory.suggestion.confirmed"
    | "memory.suggestion.rejected"
    | "memory.embedding.delete.requested"
    | "memory.embedding.reindex.requested";
  readonly version: 1;
  readonly idempotencyKey: string;
  readonly workspaceId: string;
  readonly repositoryId: string | null;
  readonly aggregateId: string;
  readonly payload: Record<string, unknown>;
  readonly occurredAt: Date;
};

export interface MemoryOutboxPort {
  enqueue(event: MemoryOutboxEvent): Promise<{ readonly created: boolean }>;
}
