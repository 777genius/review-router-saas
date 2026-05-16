import type { AuditLogRepositoryPort } from "@reviewrouter/features-audit-log";
import { recordAuditEvent } from "@reviewrouter/features-audit-log";
import {
  summarizeSupportDiagnostics,
  type SupportDiagnosticsSnapshot,
} from "../../domain/support-diagnostics";
import type { SupportDiagnosticsRepositoryPort } from "../ports/support-diagnostics-repository-port";

export type GetWorkspaceSupportDiagnosticsInput = {
  readonly workspaceId: string;
  readonly checkedAt: Date;
  readonly audit?: {
    readonly actor: string;
    readonly reason: "local_admin_override" | "workspace_admin";
  };
};

export async function getWorkspaceSupportDiagnostics(
  input: GetWorkspaceSupportDiagnosticsInput,
  dependencies: {
    readonly diagnostics: SupportDiagnosticsRepositoryPort;
    readonly auditLog?: AuditLogRepositoryPort;
  },
): Promise<SupportDiagnosticsSnapshot | null> {
  const diagnosticsInput =
    await dependencies.diagnostics.getWorkspaceDiagnosticsInput(
      input.workspaceId,
    );
  if (!diagnosticsInput) {
    return null;
  }

  const snapshot = summarizeSupportDiagnostics(
    diagnosticsInput,
    input.checkedAt,
  );

  if (input.audit && dependencies.auditLog) {
    await recordAuditEvent(
      {
        workspaceId: input.workspaceId,
        actor: input.audit.actor,
        action: "support.diagnostics_viewed",
        targetType: "workspace",
        targetId: input.workspaceId,
        metadata: {
          reason: input.audit.reason,
          repositoryTotal: snapshot.repositoryCounts.total,
          outboxDeadLetter: snapshot.outboxCounts.deadLetter,
          providerUnhealthy: snapshot.providerCounts.unhealthy,
          actionReports: snapshot.actionRunCounts.repositoriesWithReports,
          memoryItems: snapshot.memoryCounts.items.total,
          activeMemoryItems: snapshot.memoryCounts.items.active,
          pendingMemorySuggestions: snapshot.memoryCounts.suggestions.pending,
        },
      },
      { auditLog: dependencies.auditLog },
    );
  }

  return snapshot;
}
