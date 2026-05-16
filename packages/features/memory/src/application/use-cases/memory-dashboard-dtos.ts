import type {
  MemoryIndexState,
  MemoryItemStatus,
  MemoryItemVisibility,
} from "../../domain/memory-item";
import type {
  MemoryRiskLevel,
  MemorySafetyFlag,
  MemorySafetySeverity,
} from "../../domain/memory-safety-policy";
import type { MemoryScope } from "../../domain/memory-scope-policy";
import type {
  MemorySource,
  MemorySourceType,
} from "../../domain/memory-source";
import type { MemorySuggestionStatus } from "../../domain/memory-suggestion";

export type MemorySourceSummaryDto = {
  readonly type: MemorySourceType;
  readonly url: string | null;
  readonly actorLogin: string | null;
  readonly redactedExcerpt: string | null;
  readonly githubPullRequestNumber: number | null;
  readonly sourceVisibility: MemorySource["sourceVisibility"];
};

export type MemoryDashboardItemDto = {
  readonly id: string;
  readonly workspaceId: string;
  readonly repositoryId: string | null;
  readonly userId: string | null;
  readonly scope: MemoryScope;
  readonly status: MemoryItemStatus;
  readonly body: string;
  readonly tags: readonly string[];
  readonly riskLevel: MemoryRiskLevel;
  readonly confidence: number;
  readonly source: MemorySourceSummaryDto;
  readonly createdBy: string;
  readonly confirmedBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastUsedAt: string | null;
  readonly expiresAt: string | null;
  readonly version: number;
  readonly visibility: MemoryItemVisibility;
  readonly originSuggestionId: string | null;
  readonly indexState: MemoryIndexState;
  readonly indexVersion: number | null;
};

export type MemoryDashboardSuggestionDto = {
  readonly id: string;
  readonly workspaceId: string;
  readonly repositoryId: string | null;
  readonly userId: string | null;
  readonly suggestedScope: MemoryScope;
  readonly suggestedBody: string;
  readonly reason: string;
  readonly source: MemorySourceSummaryDto;
  readonly safety: {
    readonly severity: MemorySafetySeverity;
    readonly riskLevel: MemoryRiskLevel;
    readonly blockedReason: string | null;
    readonly flags: readonly MemorySafetyFlag[];
    readonly mayEmbed: boolean;
    readonly mayUseInRuntimeBundle: boolean;
  };
  readonly status: MemorySuggestionStatus;
  readonly createdByActor: string;
  readonly expiresAt: string;
  readonly isExpired: boolean;
  readonly relatedMemoryItemId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly resolvedAt: string | null;
  readonly resolvedBy: string | null;
  readonly resolutionReason: string | null;
  readonly version: number;
};

export function toMemorySourceSummaryDto(
  source: MemorySource,
): MemorySourceSummaryDto {
  return {
    type: source.type,
    url: source.url,
    actorLogin: source.actorLogin,
    redactedExcerpt: source.redactedExcerpt,
    githubPullRequestNumber: source.githubPullRequestNumber,
    sourceVisibility: source.sourceVisibility,
  };
}
