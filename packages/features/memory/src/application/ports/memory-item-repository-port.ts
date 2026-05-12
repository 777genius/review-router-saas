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

export type MarkMemoryItemIndexingSucceededInput = {
  readonly workspaceId: string;
  readonly itemId: string;
  readonly bodyHash: string;
  readonly bodyVersion: number;
};

export type MarkMemoryItemIndexingDeletedInput = {
  readonly workspaceId: string;
  readonly itemId: string;
};

export type MarkMemoryItemIndexingResult = {
  readonly updatedCount: number;
};

export type ListExpiredActiveMemoryItemsInput = {
  readonly workspaceId: string;
  readonly expiredAtOrBefore: Date;
  readonly limit: number;
};

export type ListWorkspaceIdsWithExpiredActiveMemoryInput = {
  readonly expiredAtOrBefore: Date;
  readonly limit: number;
};

export type TerminalMemoryItemPruneCandidate = {
  readonly id: string;
  readonly workspaceId: string;
  readonly repositoryId: string | null;
  readonly status: Extract<MemoryItemStatus, "expired" | "deleted">;
  readonly updatedAt: Date;
};

export type ListPrunableTerminalMemoryItemsInput = {
  readonly workspaceId: string;
  readonly updatedBefore: Date;
  readonly limit: number;
};

export type ListWorkspaceIdsWithPrunableTerminalMemoryInput = {
  readonly updatedBefore: Date;
  readonly limit: number;
};

export type PruneTerminalMemoryItemsRepositoryInput = {
  readonly workspaceId: string;
  readonly itemIds: readonly string[];
  readonly updatedBefore: Date;
};

export type PruneTerminalMemoryItemsRepositoryResult = {
  readonly deletedCount: number;
  readonly deletedIds: readonly string[];
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

  countActiveForWorkspace(input: {
    readonly workspaceId: string;
  }): Promise<number>;

  listActiveForBundle(input: {
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly userId: string | null;
    readonly limit: number;
  }): Promise<readonly MemoryItemSnapshot[]>;

  listActiveByIdsForBundle(input: {
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly userId: string | null;
    readonly itemIds: readonly string[];
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

  listExpiredActive(
    input: ListExpiredActiveMemoryItemsInput,
  ): Promise<readonly MemoryItemSnapshot[]>;

  listWorkspaceIdsWithExpiredActive(
    input: ListWorkspaceIdsWithExpiredActiveMemoryInput,
  ): Promise<readonly string[]>;

  listPrunableTerminal(
    input: ListPrunableTerminalMemoryItemsInput,
  ): Promise<readonly TerminalMemoryItemPruneCandidate[]>;

  listWorkspaceIdsWithPrunableTerminal(
    input: ListWorkspaceIdsWithPrunableTerminalMemoryInput,
  ): Promise<readonly string[]>;

  pruneTerminal(
    input: PruneTerminalMemoryItemsRepositoryInput,
  ): Promise<PruneTerminalMemoryItemsRepositoryResult>;

  markActiveItemsUsed(
    input: MarkActiveMemoryItemsUsedInput,
  ): Promise<MarkActiveMemoryItemsUsedResult>;

  markIndexingSucceeded(
    input: MarkMemoryItemIndexingSucceededInput,
  ): Promise<MarkMemoryItemIndexingResult>;

  markIndexingDeleted(
    input: MarkMemoryItemIndexingDeletedInput,
  ): Promise<MarkMemoryItemIndexingResult>;
}
