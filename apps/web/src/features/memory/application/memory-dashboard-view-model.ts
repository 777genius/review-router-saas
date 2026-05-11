import type {
  MemoryDashboardItemDto,
  MemoryDashboardSuggestionDto,
} from "@reviewrouter/features-memory";

export type MemoryDashboardRepositoryOption = {
  readonly id: string;
  readonly name: string;
  readonly fullName: string;
  readonly selected: boolean;
  readonly archived: boolean;
};

export type MemoryDashboardRepositoryRow = {
  readonly id: string;
  readonly label: string;
  readonly count: number;
};

export type MemoryDashboardViewModel = {
  readonly activeItems: readonly MemoryDashboardItemDto[];
  readonly disabledItems: readonly MemoryDashboardItemDto[];
  readonly expiredItems: readonly MemoryDashboardItemDto[];
  readonly selectedRepositories: readonly MemoryDashboardRepositoryOption[];
  readonly defaultRepository: MemoryDashboardRepositoryOption | null;
  readonly firstDetail: MemoryDashboardItemDto | null;
  readonly scopeCounts: {
    readonly repository: number;
    readonly workspace: number;
    readonly userPrefs: number;
  };
  readonly repositoryRows: readonly MemoryDashboardRepositoryRow[];
  readonly pendingSuggestionCount: number;
};

export function buildMemoryDashboardViewModel(input: {
  readonly repositories: readonly MemoryDashboardRepositoryOption[];
  readonly memoryItems: readonly MemoryDashboardItemDto[];
  readonly memorySuggestions: readonly MemoryDashboardSuggestionDto[];
}): MemoryDashboardViewModel {
  const activeItems = input.memoryItems.filter(
    (item) => item.status === "active",
  );
  const disabledItems = input.memoryItems.filter(
    (item) => item.status === "disabled",
  );
  const expiredItems = input.memoryItems.filter(
    (item) => item.status === "expired",
  );
  const selectedRepositories = input.repositories.filter(
    (repository) => repository.selected && !repository.archived,
  );

  return {
    activeItems,
    disabledItems,
    expiredItems,
    selectedRepositories,
    defaultRepository: selectedRepositories[0] ?? null,
    firstDetail: activeItems[0] ?? input.memoryItems[0] ?? null,
    scopeCounts: {
      repository: countMemoryItemsByScope(input.memoryItems, "repository"),
      workspace: countMemoryItemsByScope(input.memoryItems, "workspace"),
      userPrefs: countMemoryItemsByScope(input.memoryItems, "user_prefs"),
    },
    repositoryRows: buildRepositoryRows({
      repositories: selectedRepositories,
      memoryItems: input.memoryItems,
    }),
    pendingSuggestionCount: input.memorySuggestions.length,
  };
}

function countMemoryItemsByScope(
  items: readonly MemoryDashboardItemDto[],
  scope: MemoryDashboardItemDto["scope"],
): number {
  return items.filter((item) => item.scope === scope).length;
}

function buildRepositoryRows(input: {
  readonly repositories: readonly MemoryDashboardRepositoryOption[];
  readonly memoryItems: readonly MemoryDashboardItemDto[];
}): readonly MemoryDashboardRepositoryRow[] {
  return [
    {
      id: "all",
      label: "All repositories",
      count: input.memoryItems.length,
    },
    ...input.repositories.slice(0, 8).map((repository) => ({
      id: repository.id,
      label: repository.name,
      count: input.memoryItems.filter(
        (item) => item.repositoryId === repository.id,
      ).length,
    })),
  ];
}
