import { memoryError } from "../../domain/memory-errors";

export const MEMORY_DASHBOARD_DEFAULT_PAGE_SIZE = 50;
export const MEMORY_DASHBOARD_MAX_PAGE_SIZE = 100;

export type MemoryDashboardCursorDto = {
  readonly updatedAt: string;
  readonly id: string;
};

export type ParsedMemoryDashboardCursor = {
  readonly updatedAt: Date;
  readonly id: string;
};

export function normalizeDashboardPageSize(limit?: number): number {
  if (limit === undefined) return MEMORY_DASHBOARD_DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit)) {
    throw memoryError("memory_input_invalid");
  }
  return Math.min(MEMORY_DASHBOARD_MAX_PAGE_SIZE, Math.max(1, limit));
}

export function parseDashboardCursor(
  cursor?: MemoryDashboardCursorDto | null,
): ParsedMemoryDashboardCursor | undefined {
  if (!cursor) return undefined;
  if (cursor.id.trim().length === 0) {
    throw memoryError("memory_input_invalid");
  }
  const updatedAt = new Date(cursor.updatedAt);
  if (Number.isNaN(updatedAt.getTime())) {
    throw memoryError("memory_input_invalid");
  }
  return { updatedAt, id: cursor.id };
}

export function buildDashboardPage<TRecord extends DashboardRecord, TDto>(
  records: readonly TRecord[],
  limit: number,
  mapRecord: (record: TRecord) => TDto,
): {
  readonly items: readonly TDto[];
  readonly nextCursor: MemoryDashboardCursorDto | null;
} {
  const pageItems = records.slice(0, limit);
  const hasMore = records.length > limit;
  const lastItem = pageItems[pageItems.length - 1];
  return {
    items: pageItems.map(mapRecord),
    nextCursor:
      hasMore && lastItem
        ? {
            updatedAt: lastItem.updatedAt.toISOString(),
            id: lastItem.id,
          }
        : null,
  };
}

type DashboardRecord = {
  readonly id: string;
  readonly updatedAt: Date;
};
