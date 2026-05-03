import type { WorkspaceEntitlement } from "../../domain/entitlement";

export interface EntitlementRepositoryPort {
  findWorkspaceEntitlement(
    workspaceId: string,
  ): Promise<WorkspaceEntitlement | null>;
  upsertWorkspaceEntitlement(entitlement: WorkspaceEntitlement): Promise<void>;
}
