import type { Clock } from "@reviewrouter/shared";
import type { MemoryIdGeneratorPort } from "../ports/memory-id-generator-port";
import type { MemoryItemRepositoryPort } from "../ports/memory-item-repository-port";
import type { MemoryPermissionPort } from "../ports/memory-permission-port";
import type { MemorySuggestionRepositoryPort } from "../ports/memory-suggestion-repository-port";
import type { MemoryTransactionPort } from "../ports/memory-transaction-port";

export type MemoryMutationResult =
  | {
      readonly status: "created";
      readonly id: string;
      readonly version: number;
    }
  | {
      readonly status: "updated";
      readonly id: string;
      readonly version: number;
    }
  | {
      readonly status: "noop";
      readonly reason: string;
      readonly id?: string;
    }
  | {
      readonly status: "rejected";
      readonly reason: string;
      readonly retryable?: boolean;
    };

export type MemoryUseCaseDependencies = {
  readonly memoryItems: MemoryItemRepositoryPort;
  readonly memorySuggestions: MemorySuggestionRepositoryPort;
  readonly memoryPermissions: MemoryPermissionPort;
  readonly memoryIds: MemoryIdGeneratorPort;
  readonly memoryTransaction: MemoryTransactionPort;
  readonly clock: Clock;
};
