import type { MemoryAuditPort } from "./memory-audit-port";
import type { MemoryItemRepositoryPort } from "./memory-item-repository-port";
import type { MemoryOutboxPort } from "./memory-outbox-port";
import type { MemorySuggestionRepositoryPort } from "./memory-suggestion-repository-port";

export type MemoryTransactionalPorts = {
  readonly memoryItems: MemoryItemRepositoryPort;
  readonly memorySuggestions: MemorySuggestionRepositoryPort;
  readonly memoryAudit: MemoryAuditPort;
  readonly memoryOutbox: MemoryOutboxPort;
};

export interface MemoryTransactionPort {
  run<T>(work: (ports: MemoryTransactionalPorts) => Promise<T>): Promise<T>;
}
