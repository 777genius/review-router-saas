import type { Clock } from "@reviewrouter/shared";
import type { MemoryIdGeneratorPort } from "../ports/memory-id-generator-port";
import type { MemoryItemRepositoryPort } from "../ports/memory-item-repository-port";
import type { MemoryPermissionPort } from "../ports/memory-permission-port";
import type { MemoryQuotaPolicyPort } from "../ports/memory-quota-policy-port";
import type { MemorySuggestionRepositoryPort } from "../ports/memory-suggestion-repository-port";
import type { MemoryTransactionPort } from "../ports/memory-transaction-port";
import type { MemoryUsageEventPort } from "../ports/memory-usage-event-port";

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
  readonly memoryUsageEvents: MemoryUsageEventPort;
  readonly memoryQuotaPolicy?: MemoryQuotaPolicyPort;
  readonly memoryIds: MemoryIdGeneratorPort;
  readonly memoryTransaction: MemoryTransactionPort;
  readonly clock: Clock;
};
