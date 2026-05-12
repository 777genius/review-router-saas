import type {
  MemoryItem,
  MemoryItemSnapshot,
  MemoryItemStatus,
} from "../../domain/memory-item";
import type { MemoryScope } from "../../domain/memory-scope-policy";

export type MemoryDashboardRepositoryCursor = {
  readonly updatedAt: Date;
  readonly id: string;
};

export type MarkActiveMemoryItemsUsedInput = {
  readonly workspaceId: string;
  readonly itemIds: readonly string[];
  readonly usedAt: Date;
};

export type MarkActiveMemoryItemsUsedResult = {
  readonly updatedCount: number;
};

export interface MemoryItemRepositoryPort {
  save(
    item: MemoryItem,
    options?: {
      readonly expectedVersion?: number;
    },
  ): Promise<void>;

  findById(input: {
    readonly workspaceId: string;
    readonly itemId: string;
  }): Promise<MemoryItemSnapshot | null>;

  findActiveByBodyHash(input: {
    readonly workspaceId: string;
    readonly scope: MemoryScope;
    readonly repositoryId: string | null;
    readonly userId: string | null;
    readonly bodyHash: string;
  }): Promise<MemoryItemSnapshot | null>;

  listActiveForBundle(input: {
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly userId: string | null;
    readonly limit: number;
  }): Promise<readonly MemoryItemSnapshot[]>;

  listForDashboard(input: {
    readonly workspaceId: string;
    readonly repositoryId?: string | null;
    readonly scope?: MemoryScope;
    readonly statuses: readonly MemoryItemStatus[];
    readonly limit: number;
    readonly cursor?: MemoryDashboardRepositoryCursor;
  }): Promise<readonly MemoryItemSnapshot[]>;

  markActiveItemsUsed(
    input: MarkActiveMemoryItemsUsedInput,
  ): Promise<MarkActiveMemoryItemsUsedResult>;
}
