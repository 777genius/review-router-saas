import type { MemoryActor } from "../../domain/memory-actor";
import type { MemoryScope } from "../../domain/memory-scope-policy";

export type MemoryPermissionDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason:
        | "not_repository_maintainer"
        | "not_user_owner"
        | "not_workspace_admin"
        | "repository_unavailable"
        | "permission_service_unavailable";
      readonly retryable: boolean;
    };

export interface MemoryPermissionPort {
  canConfirmMemory(input: {
    readonly workspaceId: string;
    readonly repositoryId: string | null;
    readonly userId: string | null;
    readonly scope: MemoryScope;
    readonly actor: MemoryActor;
  }): Promise<MemoryPermissionDecision>;
}
