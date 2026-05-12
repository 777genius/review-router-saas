// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  MemoryDashboardItemDto,
  MemoryDashboardSuggestionDto,
} from "@reviewrouter/features-memory";
import { MemoryManagementPanel } from "./memory-management-panel";

vi.mock("./actions", () => ({
  confirmMemorySuggestionAction: vi.fn(),
  createMemoryItemAction: vi.fn(),
  deleteMemoryItemAction: vi.fn(),
  disableMemoryItemAction: vi.fn(),
  editMemoryItemAction: vi.fn(),
  rejectMemorySuggestionAction: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("MemoryManagementPanel", () => {
  it("keeps the split memory layout with confirmed, pending, and audit modes", () => {
    renderMemoryManagementPanel();

    expect(screen.getAllByText("Scope").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Confirmed").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Pending").length).toBeGreaterThan(0);
    expect(screen.getByText("Audit")).toBeTruthy();
    expect(screen.getByText("Policy safeguards")).toBeTruthy();
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByText("Showing 1-1 of 1")).toBeTruthy();
  });

  it("shows retention impact before destructive memory actions", () => {
    renderMemoryManagementPanel();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    const dialog = screen.getByRole("dialog", { name: "Delete memory?" });
    expect(
      within(dialog).getByText(
        /queued for retrieval index deletion\. Audit records remain/,
      ),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(/Only the distilled memory record is changed/),
    ).toBeTruthy();
  });

  it("shows edit impact without exposing previous body in audit", () => {
    renderMemoryManagementPanel();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const dialog = screen.getByRole("dialog", { name: "Edit memory" });
    expect(
      within(dialog).getByText(/Previous full body text is not stored/),
    ).toBeTruthy();
    expect(
      within(dialog).getByDisplayValue("Prefer guard clauses."),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(/safe hashes, versions and scope only/),
    ).toBeTruthy();
  });

  it("lets pending suggestions be edited before approval", () => {
    renderMemoryManagementPanel();

    fireEvent.click(screen.getByRole("button", { name: "Edit suggestion" }));

    const dialog = screen.getByRole("dialog", {
      name: "Edit and approve suggestion",
    });
    expect(within(dialog).getByDisplayValue("Prefer small PRs.")).toBeTruthy();
    expect(
      within(dialog).getByText(/checks run again/),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(/Pending suggestions are never used by runtime/),
    ).toBeTruthy();
  });

  it("renders read-only state without hiding memory data", () => {
    renderMemoryManagementPanel({ mutationsEnabled: false });

    expect(screen.getByText(/Memory is in read-only mode/)).toBeTruthy();
    expect(screen.getAllByText("Prefer guard clauses.").length).toBeGreaterThan(
      0,
    );
    expect(
      (screen.getByRole("button", { name: "Edit" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "Edit suggestion",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});

function renderMemoryManagementPanel(
  options: { readonly mutationsEnabled?: boolean } = {},
): void {
  render(
    <MemoryManagementPanel
      workspace={{ id: "workspace_1" }}
      repositories={[
        {
          id: "repo_1",
          name: "api",
          fullName: "777genius/api",
          selected: true,
          archived: false,
        },
      ]}
      memoryItems={[memoryItem()]}
      memorySuggestions={[memorySuggestion()]}
      mutationsEnabled={options.mutationsEnabled ?? true}
    />,
  );
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
