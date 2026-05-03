import type { OutboxFailure } from "../../domain/outbox-event";
import type { OutboxMaintenanceRepositoryPort } from "../ports/outbox-maintenance-repository-port";

export async function listWorkspaceOutboxFailures(
  input: { readonly workspaceId: string; readonly limit?: number },
  dependencies: { readonly outbox: OutboxMaintenanceRepositoryPort },
): Promise<readonly OutboxFailure[]> {
  return dependencies.outbox.listWorkspaceFailures({
    workspaceId: input.workspaceId,
    limit: Math.min(Math.max(input.limit ?? 10, 1), 50),
  });
}
