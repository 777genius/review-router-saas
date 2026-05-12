export type MemoryAuditEvent = {
  readonly workspaceId: string;
  readonly actor: string;
  readonly action:
    | "memory.item.created"
    | "memory.item.deleted"
    | "memory.item.disabled"
    | "memory.item.edited"
    | "memory.suggestion.created"
    | "memory.suggestion.blocked"
    | "memory.suggestion.confirmed"
    | "memory.suggestion.expired"
    | "memory.suggestion.rejected"
    | "memory.suggestion.superseded"
    | "memory.bundle.served";
  readonly targetType: "memory_item" | "memory_suggestion" | "memory_bundle";
  readonly targetId: string;
  readonly metadata: Record<string, unknown>;
};

export interface MemoryAuditPort {
  record(event: MemoryAuditEvent): Promise<void>;
}
