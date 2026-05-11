import { describe, expect, it } from "vitest";
import type {
  MemoryDashboardItemDto,
  MemoryDashboardSuggestionDto,
} from "@reviewrouter/features-memory";
import { buildMemoryDashboardViewModel } from "./memory-dashboard-view-model";

describe("buildMemoryDashboardViewModel", () => {
  it("derives counts, active detail, and repository rows without UI logic", () => {
    const model = buildMemoryDashboardViewModel({
      repositories: [
        repository({ id: "repo_1", name: "api" }),
        repository({ id: "repo_2", name: "web" }),
        repository({ id: "repo_archived", name: "old", archived: true }),
      ],
      memoryItems: [
        memoryItem({
          id: "mem_active",
          repositoryId: "repo_1",
          scope: "repository",
          status: "active",
        }),
        memoryItem({
          id: "mem_workspace",
          repositoryId: null,
          scope: "workspace",
          status: "disabled",
        }),
        memoryItem({
          id: "mem_user",
          repositoryId: null,
          scope: "user_prefs",
          status: "expired",
        }),
      ],
      memorySuggestions: [memorySuggestion({ id: "suggestion_1" })],
    });

    expect(model.scopeCounts).toEqual({
      repository: 1,
      workspace: 1,
      userPrefs: 1,
    });
    expect(model.activeItems.map((item) => item.id)).toEqual(["mem_active"]);
    expect(model.disabledItems.map((item) => item.id)).toEqual([
      "mem_workspace",
    ]);
    expect(model.expiredItems.map((item) => item.id)).toEqual(["mem_user"]);
    expect(model.firstDetail?.id).toBe("mem_active");
    expect(model.defaultRepository?.id).toBe("repo_1");
    expect(model.repositoryRows).toEqual([
      { id: "all", label: "All repositories", count: 3 },
      { id: "repo_1", label: "api", count: 1 },
      { id: "repo_2", label: "web", count: 0 },
    ]);
    expect(model.pendingSuggestionCount).toBe(1);
  });
});

function repository(
  overrides: Partial<{
    readonly id: string;
    readonly name: string;
    readonly fullName: string;
    readonly selected: boolean;
    readonly archived: boolean;
  }> = {},
) {
  const name = overrides.name ?? "example";
  return {
    id: overrides.id ?? "repo_1",
    name,
    fullName: overrides.fullName ?? `777genius/${name}`,
    selected: overrides.selected ?? true,
    archived: overrides.archived ?? false,
  };
}

function memoryItem(
  overrides: Partial<MemoryDashboardItemDto> = {},
): MemoryDashboardItemDto {
  return {
    id: overrides.id ?? "mem_1",
    workspaceId: overrides.workspaceId ?? "workspace_1",
    repositoryId:
      overrides.repositoryId === undefined ? "repo_1" : overrides.repositoryId,
    userId: overrides.userId ?? null,
    scope: overrides.scope ?? "repository",
    status: overrides.status ?? "active",
    body: overrides.body ?? "Prefer guard clauses.",
    tags: overrides.tags ?? [],
    riskLevel: overrides.riskLevel ?? "low",
    confidence: overrides.confidence ?? 0.9,
    source: overrides.source ?? {
      type: "dashboard",
      url: null,
      actorLogin: "777genius",
      redactedExcerpt: null,
      githubPullRequestNumber: null,
      sourceVisibility: "internal",
    },
    createdBy: overrides.createdBy ?? "github_user:user_1",
    confirmedBy: overrides.confirmedBy ?? "github_user:user_1",
    createdAt: overrides.createdAt ?? "2026-05-03T12:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-05-03T12:00:00.000Z",
    lastUsedAt: overrides.lastUsedAt ?? null,
    expiresAt: overrides.expiresAt ?? null,
    version: overrides.version ?? 1,
    visibility: overrides.visibility ?? "repository_runtime",
    originSuggestionId: overrides.originSuggestionId ?? null,
    indexState: overrides.indexState ?? "indexed",
    indexVersion: overrides.indexVersion ?? 1,
  };
}

function memorySuggestion(
  overrides: Partial<MemoryDashboardSuggestionDto> = {},
): MemoryDashboardSuggestionDto {
  return {
    id: overrides.id ?? "suggestion_1",
    workspaceId: overrides.workspaceId ?? "workspace_1",
    repositoryId:
      overrides.repositoryId === undefined ? "repo_1" : overrides.repositoryId,
    userId: overrides.userId ?? null,
    suggestedScope: overrides.suggestedScope ?? "repository",
    suggestedBody: overrides.suggestedBody ?? "Prefer small PRs.",
    reason: overrides.reason ?? "explicit_natural_language",
    source: overrides.source ?? {
      type: "pr_comment",
      url: null,
      actorLogin: "777genius",
      redactedExcerpt: null,
      githubPullRequestNumber: 17,
      sourceVisibility: "private",
    },
    safety: overrides.safety ?? {
      severity: "safe",
      riskLevel: "low",
      blockedReason: null,
      flags: [],
      mayEmbed: true,
      mayUseInRuntimeBundle: false,
    },
    status: overrides.status ?? "pending",
    createdByActor: overrides.createdByActor ?? "github_user:user_1",
    expiresAt: overrides.expiresAt ?? "2026-05-17T12:00:00.000Z",
    isExpired: overrides.isExpired ?? false,
    relatedMemoryItemId: overrides.relatedMemoryItemId ?? null,
    createdAt: overrides.createdAt ?? "2026-05-03T12:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-05-03T12:00:00.000Z",
    resolvedAt: overrides.resolvedAt ?? null,
    resolvedBy: overrides.resolvedBy ?? null,
    resolutionReason: overrides.resolutionReason ?? null,
    version: overrides.version ?? 1,
  };
}
