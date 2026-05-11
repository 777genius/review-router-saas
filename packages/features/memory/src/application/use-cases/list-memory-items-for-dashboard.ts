import type {
  MemoryItemSnapshot,
  MemoryItemStatus,
} from "../../domain/memory-item";
import type { MemoryScope } from "../../domain/memory-scope-policy";
import type { MemoryItemRepositoryPort } from "../ports/memory-item-repository-port";
import type { MemoryDashboardItemDto } from "./memory-dashboard-dtos";
import { toMemorySourceSummaryDto } from "./memory-dashboard-dtos";
import {
  buildDashboardPage,
  type MemoryDashboardCursorDto,
  normalizeDashboardPageSize,
  parseDashboardCursor,
} from "./memory-dashboard-pagination";

const DEFAULT_MEMORY_ITEM_STATUSES: readonly MemoryItemStatus[] = [
  "active",
  "disabled",
  "expired",
];

export type ListMemoryItemsForDashboardInput = {
  readonly workspaceId: string;
  readonly repositoryId?: string | null;
  readonly scope?: MemoryScope;
  readonly statuses?: readonly MemoryItemStatus[];
  readonly limit?: number;
  readonly cursor?: MemoryDashboardCursorDto | null;
};

export type ListMemoryItemsForDashboardDeps = {
  readonly memoryItems: MemoryItemRepositoryPort;
};

export async function listMemoryItemsForDashboard(
  input: ListMemoryItemsForDashboardInput,
  deps: ListMemoryItemsForDashboardDeps,
): Promise<{
  readonly items: readonly MemoryDashboardItemDto[];
  readonly nextCursor: MemoryDashboardCursorDto | null;
}> {
  const limit = normalizeDashboardPageSize(input.limit);
  const cursor = parseDashboardCursor(input.cursor);
  const records = await deps.memoryItems.listForDashboard({
    workspaceId: input.workspaceId,
    statuses: input.statuses?.length
      ? input.statuses
      : DEFAULT_MEMORY_ITEM_STATUSES,
    limit: limit + 1,
    ...(input.repositoryId !== undefined
      ? { repositoryId: input.repositoryId }
      : {}),
    ...(input.scope ? { scope: input.scope } : {}),
    ...(cursor ? { cursor } : {}),
  });

  return buildDashboardPage(records, limit, toMemoryDashboardItemDto);
}

function toMemoryDashboardItemDto(
  item: MemoryItemSnapshot,
): MemoryDashboardItemDto {
  return {
    id: item.id,
    workspaceId: item.workspaceId,
    repositoryId: item.repositoryId,
    userId: item.userId,
    scope: item.scope,
    status: item.status,
    body: item.body,
    tags: item.tags,
    riskLevel: item.riskLevel,
    confidence: item.confidence,
    source: toMemorySourceSummaryDto(item.source),
    createdBy: item.createdBy,
    confirmedBy: item.confirmedBy,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
    lastUsedAt: item.lastUsedAt?.toISOString() ?? null,
    expiresAt: item.expiresAt?.toISOString() ?? null,
    version: item.version,
    visibility: item.visibility,
    originSuggestionId: item.originSuggestionId,
    indexState: item.indexState,
    indexVersion: item.indexVersion,
  };
}
