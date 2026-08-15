import type { RepositoryId, WorkspaceId } from "../../domain/identifiers";

/** Atomic adapter boundary for leaving hosted-pool mode without losing CAS history. */
export interface RepositoryAuthModeSwitchPort {
  switchToRepositoryOwnedRotating(input: {
    readonly repositoryId: RepositoryId;
    readonly workspaceId: WorkspaceId;
    readonly expectedBindingRevision: number;
    readonly nextBindingRevision: number;
    readonly switchedAt: Date;
  }): Promise<boolean>;
}
