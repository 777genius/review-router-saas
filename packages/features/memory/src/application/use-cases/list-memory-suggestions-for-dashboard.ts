import type { Clock } from "@reviewrouter/shared";
import type {
  MemorySuggestionSnapshot,
  MemorySuggestionStatus,
} from "../../domain/memory-suggestion";
import type { MemoryScope } from "../../domain/memory-scope-policy";
import type { MemorySuggestionRepositoryPort } from "../ports/memory-suggestion-repository-port";
import type { MemoryDashboardSuggestionDto } from "./memory-dashboard-dtos";
import { toMemorySourceSummaryDto } from "./memory-dashboard-dtos";
import {
  buildDashboardPage,
  type MemoryDashboardCursorDto,
  normalizeDashboardPageSize,
  parseDashboardCursor,
} from "./memory-dashboard-pagination";

const DEFAULT_MEMORY_SUGGESTION_STATUSES: readonly MemorySuggestionStatus[] = [
  "pending",
];

export type ListMemorySuggestionsForDashboardInput = {
  readonly workspaceId: string;
  readonly repositoryId?: string | null;
  readonly scope?: MemoryScope;
  readonly statuses?: readonly MemorySuggestionStatus[];
  readonly includeExpiredPending?: boolean;
  readonly limit?: number;
  readonly cursor?: MemoryDashboardCursorDto | null;
};

export type ListMemorySuggestionsForDashboardDeps = {
  readonly memorySuggestions: MemorySuggestionRepositoryPort;
  readonly clock: Clock;
};

export async function listMemorySuggestionsForDashboard(
  input: ListMemorySuggestionsForDashboardInput,
  deps: ListMemorySuggestionsForDashboardDeps,
): Promise<{
  readonly suggestions: readonly MemoryDashboardSuggestionDto[];
  readonly nextCursor: MemoryDashboardCursorDto | null;
}> {
  const limit = normalizeDashboardPageSize(input.limit);
  const statuses = input.statuses?.length
    ? input.statuses
    : DEFAULT_MEMORY_SUGGESTION_STATUSES;
  const cursor = parseDashboardCursor(input.cursor);
  const notExpiredAt =
    input.includeExpiredPending === true || !isPendingOnly(statuses)
      ? undefined
      : deps.clock.now();
  const records = await deps.memorySuggestions.listForDashboard({
    workspaceId: input.workspaceId,
    statuses,
    limit: limit + 1,
    ...(input.repositoryId !== undefined
      ? { repositoryId: input.repositoryId }
      : {}),
    ...(input.scope ? { scope: input.scope } : {}),
    ...(cursor ? { cursor } : {}),
    ...(notExpiredAt ? { notExpiredAt } : {}),
  });

  const page = buildDashboardPage(records, limit, (suggestion) =>
    toMemoryDashboardSuggestionDto(suggestion, deps.clock.now()),
  );
  return {
    suggestions: page.items,
    nextCursor: page.nextCursor,
  };
}

function toMemoryDashboardSuggestionDto(
  suggestion: MemorySuggestionSnapshot,
  now: Date,
): MemoryDashboardSuggestionDto {
  return {
    id: suggestion.id,
    workspaceId: suggestion.workspaceId,
    repositoryId: suggestion.repositoryId,
    userId: suggestion.userId,
    suggestedScope: suggestion.suggestedScope,
    suggestedBody: suggestion.suggestedBody,
    reason: suggestion.reason,
    source: toMemorySourceSummaryDto(suggestion.source),
    safety: {
      severity: suggestion.safetyReport.severity,
      riskLevel: suggestion.safetyReport.riskLevel,
      blockedReason: suggestion.safetyReport.blockedReason,
      flags: suggestion.safetyReport.flags,
      mayEmbed: suggestion.safetyReport.mayEmbed,
      mayUseInRuntimeBundle: suggestion.safetyReport.mayUseInRuntimeBundle,
    },
    status: suggestion.status,
    createdByActor: suggestion.createdByActor,
    expiresAt: suggestion.expiresAt.toISOString(),
    isExpired: suggestion.expiresAt <= now,
    relatedMemoryItemId: suggestion.relatedMemoryItemId,
    createdAt: suggestion.createdAt.toISOString(),
    updatedAt: suggestion.updatedAt.toISOString(),
    resolvedAt: suggestion.resolvedAt?.toISOString() ?? null,
    resolvedBy: suggestion.resolvedBy,
    resolutionReason: suggestion.resolutionReason,
    version: suggestion.version,
  };
}

function isPendingOnly(statuses: readonly MemorySuggestionStatus[]): boolean {
  return statuses.length === 1 && statuses[0] === "pending";
}
