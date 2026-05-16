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
  MemoryPolicySimulationDecision,
} from "@reviewrouter/features-memory";
import {
  MemoryManagementPanel,
  type MemoryManagementMode,
  type MemoryManagementNotice,
} from "./memory-management-panel";

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
  it("keeps the split memory layout with knowledge, pending, and table modes", () => {
    renderMemoryManagementPanel();

    expect(screen.getByTestId("memory-management-panel")).toBeTruthy();
    expect(screen.getByTestId("memory-scope-rail")).toBeTruthy();
    expect(screen.getAllByText("Scope filter").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Knowledge").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Pending").length).toBeGreaterThan(0);
    expect(screen.getByText("Table")).toBeTruthy();
    expect(screen.getByText("Policy safeguards")).toBeTruthy();
    expect(screen.getByTestId("memory-knowledge-list")).toBeTruthy();
  });

  it("renders the operational table mode without losing action controls", () => {
    renderMemoryManagementPanel({ mode: "table" });

    expect(screen.getByTestId("memory-confirmed-table")).toBeTruthy();
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByText("Showing 1-1 of 1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Export JSON" }).getAttribute("href"),
    ).toBe("/api/dashboard/memory/export?workspace=workspace_1");
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
    renderMemoryManagementPanel({ mode: "suggestions" });

    fireEvent.click(screen.getByRole("button", { name: "Edit suggestion" }));

    const dialog = screen.getByRole("dialog", {
      name: "Edit and approve suggestion",
    });
    expect(within(dialog).getByDisplayValue("Prefer small PRs.")).toBeTruthy();
    expect(within(dialog).getByText(/checks run again/)).toBeTruthy();
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
      (screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Add memory" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("renders read-only pending suggestions with disabled approval controls", () => {
    renderMemoryManagementPanel({
      mode: "suggestions",
      mutationsEnabled: false,
    });

    expect(
      (
        screen.getByRole("button", {
          name: "Edit suggestion",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("disables memory writes while keeping confirmed cleanup actions available", () => {
    renderMemoryManagementPanel({ memoryWritesEnabled: false });

    expect(
      screen.getByText(/Balanced Memory writes are disabled/),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Add memory" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Edit" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Disable" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(
      (screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("disables suggestion approval while keeping rejection available when writes are off", () => {
    renderMemoryManagementPanel({
      mode: "suggestions",
      memoryWritesEnabled: false,
    });

    expect(
      (screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement)
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
      (screen.getByRole("button", { name: "Reject" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("surfaces quota, stale edit, and indexing notices in the same layout", () => {
    renderMemoryManagementPanel({
      notices: [
        {
          id: "quota",
          title: "Workspace memory quota is almost full",
          body: "New approvals stay blocked until quota is freed.",
          tone: "warning",
        },
        {
          id: "stale",
          title: "Memory changed before this edit was saved",
          body: "Reload the latest version and retry.",
          tone: "danger",
        },
      ],
    });

    expect(
      screen.getByText("Workspace memory quota is almost full"),
    ).toBeTruthy();
    expect(
      screen.getByText("Memory changed before this edit was saved"),
    ).toBeTruthy();
  });

  it("renders admin policy simulation without adding mutation controls", () => {
    renderMemoryManagementPanel({
      policySimulation: [policySimulationDecision()],
    });

    expect(screen.getByText("Policy simulator")).toBeTruthy();
    expect(screen.getByText("Synthetic only")).toBeTruthy();
    expect(screen.getByText("Workspace write")).toBeTruthy();
    expect(screen.getByText("Workspace admin")).toBeTruthy();
  });
});

function renderMemoryManagementPanel(
  options: {
    readonly mutationsEnabled?: boolean;
    readonly memoryWritesEnabled?: boolean;
    readonly policySimulation?: readonly MemoryPolicySimulationDecision[];
    readonly mode?: MemoryManagementMode;
    readonly notices?: readonly MemoryManagementNotice[];
  } = {},
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
      memoryWritesEnabled={options.memoryWritesEnabled ?? true}
      {...(options.policySimulation
        ? { policySimulation: options.policySimulation }
        : {})}
      {...(options.mode ? { mode: options.mode } : {})}
      {...(options.notices ? { notices: options.notices } : {})}
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

function policySimulationDecision(
  overrides: Partial<MemoryPolicySimulationDecision> = {},
): MemoryPolicySimulationDecision {
  return {
    allowed: overrides.allowed ?? true,
    reason: overrides.reason ?? "allowed",
    retryable: overrides.retryable ?? false,
    action: overrides.action ?? "direct_save",
    scope: overrides.scope ?? "workspace",
    repositoryId:
      overrides.repositoryId === undefined ? null : overrides.repositoryId,
    requiredAuthority: overrides.requiredAuthority ?? "workspace_admin",
    blockedBy: overrides.blockedBy ?? null,
    policyVersion: overrides.policyVersion ?? 1,
    policyHash: overrides.policyHash ?? "fnv1a:test",
    matchedPolicies: overrides.matchedPolicies ?? ["memory_policy_config"],
    precedence: overrides.precedence ?? [
      "scope",
      "policy",
      "permission",
      "safety",
      "active_quota",
    ],
    invalidates: overrides.invalidates ?? [],
    safety: overrides.safety ?? {
      fixture: "safe_project_rule",
      severity: "safe",
      riskLevel: "low",
      flags: [],
      mayEmbed: true,
      mayUseInRuntimeBundle: true,
    },
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
