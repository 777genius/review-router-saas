import { describe, expect, it } from "vitest";
import type { AuditLogRepositoryPort } from "@reviewrouter/features-audit-log";
import type { AuditEventInput } from "@reviewrouter/features-audit-log";
import type { SupportDiagnosticsRepositoryPort } from "../application/ports/support-diagnostics-repository-port";
import { getWorkspaceSupportDiagnostics } from "../application/use-cases/get-workspace-support-diagnostics";
import { summarizeSupportDiagnostics } from "../domain/support-diagnostics";

class StaticSupportDiagnosticsRepository implements SupportDiagnosticsRepositoryPort {
  async getWorkspaceDiagnosticsInput() {
    return supportInput;
  }
}

class InMemoryAuditLog implements AuditLogRepositoryPort {
  public readonly events: AuditEventInput[] = [];

  async append(event: AuditEventInput): Promise<void> {
    this.events.push(event);
  }
}

const checkedAt = new Date("2026-05-03T20:00:00.000Z");

const supportInput = {
  workspace: {
    id: "workspace_1",
    name: "Workspace",
    slug: "workspace",
  },
  installations: [
    { status: "active", repositorySelection: "selected" },
    { status: "removed", repositorySelection: "all" },
  ],
  repositories: [
    {
      id: "repo_1",
      selected: true,
      archived: false,
      setupStatus: "configured",
      latestProviderSetupState: "configured",
      latestProviderHealth: "ok",
      latestFindingCounts: { critical: 1, major: 2, minor: 0, info: 0 },
      latestCommentCounts: { inline: 3, summary: 1 },
    },
    {
      id: "repo_2",
      selected: true,
      archived: false,
      setupStatus: "setup_pr_open",
      latestProviderSetupState: "missing",
      latestProviderHealth: "failed",
      latestFindingCounts: {
        critical: null,
        major: 1,
        minor: null,
        info: null,
      },
      latestCommentCounts: { inline: 1, summary: null },
    },
    {
      id: "repo_3",
      selected: false,
      archived: true,
      setupStatus: "not_configured",
      latestProviderSetupState: null,
      latestProviderHealth: null,
      latestFindingCounts: null,
      latestCommentCounts: null,
    },
  ],
  workflowProvisioning: [{ status: "setup_pr_open" }, { status: "failed" }],
  outbox: [
    { status: "pending", type: "installation.sync_requested" },
    { status: "dead_letter", type: "installation.sync_requested" },
  ],
  memory: {
    itemStatusCounts: { active: 2, disabled: 1, expired: 1 },
    itemScopeCounts: { repository: 2, workspace: 1, user_prefs: 1 },
    itemIndexStateCounts: { indexed: 1, index_pending: 1, index_deleted: 2 },
    suggestionStatusCounts: { pending: 1, expired: 1, superseded: 1 },
    usageEventCount: 7,
  },
  recentAuditActions: ["review_config.saved", "workflow.setup_pr_opened"],
};

describe("support diagnostics", () => {
  it("summarizes workspace metadata without code or secrets", () => {
    const snapshot = summarizeSupportDiagnostics(supportInput, checkedAt);

    expect(snapshot).toMatchObject({
      workspaceId: "workspace_1",
      installationCounts: { active: 1, removed: 1 },
      repositoryCounts: {
        total: 3,
        selected: 2,
        archived: 1,
        notConfigured: 1,
        setupPrOpen: 1,
        configured: 1,
      },
      providerCounts: {
        unknown: 1,
        missing: 1,
        configured: 1,
        unhealthy: 1,
      },
      actionRunCounts: {
        repositoriesWithReports: 2,
        criticalFindings: 1,
        majorFindings: 3,
        inlineComments: 4,
        summaryComments: 1,
      },
      workflowProvisioningCounts: {
        setup_pr_open: 1,
        failed: 1,
      },
      outboxCounts: {
        pending: 1,
        deadLetter: 1,
      },
      memoryCounts: {
        items: {
          total: 4,
          active: 2,
          disabled: 1,
          expired: 1,
          deleted: 0,
        },
        scopes: {
          repository: 2,
          workspace: 1,
          userPrefs: 1,
        },
        index: {
          pending: 1,
          indexed: 1,
          failed: 0,
          deleted: 2,
        },
        suggestions: {
          pending: 1,
          expired: 1,
          superseded: 1,
        },
        usageEvents: 7,
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain("CODEX_AUTH_JSON");
    expect(JSON.stringify(snapshot)).not.toContain("Prefer guard clauses");
  });

  it("audits local support diagnostics access with safe counts only", async () => {
    const auditLog = new InMemoryAuditLog();
    const snapshot = await getWorkspaceSupportDiagnostics(
      {
        workspaceId: "workspace_1",
        checkedAt,
        audit: {
          actor: "support:777genius",
          reason: "local_admin_override",
        },
      },
      {
        diagnostics: new StaticSupportDiagnosticsRepository(),
        auditLog,
      },
    );

    expect(snapshot?.repositoryCounts.total).toBe(3);
    expect(auditLog.events).toEqual([
      expect.objectContaining({
        action: "support.diagnostics_viewed",
        actor: "support:777genius",
        metadata: {
          reason: "local_admin_override",
          repositoryTotal: 3,
          outboxDeadLetter: 1,
          providerUnhealthy: 1,
          actionReports: 2,
          memoryItems: 4,
          activeMemoryItems: 2,
          pendingMemorySuggestions: 1,
        },
      }),
    ]);
  });
});
