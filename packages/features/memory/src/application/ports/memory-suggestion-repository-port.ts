import type {
  MemorySuggestion,
  MemorySuggestionSnapshot,
  MemorySuggestionStatus,
} from "../../domain/memory-suggestion";
import type { MemoryScope } from "../../domain/memory-scope-policy";
import type { MemoryActor } from "../../domain/memory-actor";
import type { MemorySourceType } from "../../domain/memory-source";

export type MemorySuggestionDashboardRepositoryCursor = {
  readonly updatedAt: Date;
  readonly id: string;
};

export interface MemorySuggestionRepositoryPort {
  save(suggestion: MemorySuggestion): Promise<void>;

  findById(input: {
    readonly workspaceId: string;
    readonly suggestionId: string;
  }): Promise<MemorySuggestionSnapshot | null>;

  findPendingByDedupeKey(input: {
    readonly workspaceId: string;
    readonly dedupeKey: string;
  }): Promise<MemorySuggestionSnapshot | null>;

  countPendingForWorkspace(input: {
    readonly workspaceId: string;
    readonly notExpiredAt?: Date;
  }): Promise<number>;

  supersedePendingBySource(input: {
    readonly workspaceId: string;
    readonly repositoryId: string | null;
    readonly userId: string | null;
    readonly scope: MemoryScope;
    readonly sourceType: MemorySourceType;
    readonly sourceId: string;
    readonly createdByActor: MemoryActor;
    readonly replacementSuggestionId: string;
    readonly excludeSuggestionId: string;
    readonly supersededAt: Date;
    readonly limit: number;
  }): Promise<readonly MemorySuggestionSnapshot[]>;

  listForDashboard(input: {
    readonly workspaceId: string;
    readonly repositoryId?: string | null;
    readonly scope?: MemoryScope;
    readonly statuses: readonly MemorySuggestionStatus[];
    readonly limit: number;
    readonly cursor?: MemorySuggestionDashboardRepositoryCursor;
    readonly notExpiredAt?: Date;
  }): Promise<readonly MemorySuggestionSnapshot[]>;

  listExpiredPending(input: {
    readonly workspaceId: string;
    readonly expiredAtOrBefore: Date;
    readonly limit: number;
  }): Promise<readonly MemorySuggestionSnapshot[]>;

  listWorkspaceIdsWithExpiredPending(input: {
    readonly expiredAtOrBefore: Date;
    readonly limit: number;
  }): Promise<readonly string[]>;
}
