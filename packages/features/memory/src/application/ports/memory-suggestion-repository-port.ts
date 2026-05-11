import type {
  MemorySuggestion,
  MemorySuggestionSnapshot,
  MemorySuggestionStatus,
} from "../../domain/memory-suggestion";
import type { MemoryScope } from "../../domain/memory-scope-policy";

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

  listForDashboard(input: {
    readonly workspaceId: string;
    readonly repositoryId?: string | null;
    readonly scope?: MemoryScope;
    readonly statuses: readonly MemorySuggestionStatus[];
    readonly limit: number;
    readonly cursor?: MemorySuggestionDashboardRepositoryCursor;
    readonly notExpiredAt?: Date;
  }): Promise<readonly MemorySuggestionSnapshot[]>;
}
