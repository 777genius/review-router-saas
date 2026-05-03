import type { AuthenticatedPrincipal } from "../../domain/authenticated-principal";

export type WorkspaceMembership = {
  readonly workspaceId: string;
  readonly role: "owner" | "admin" | "member";
};

export interface WorkspaceMembershipRepositoryPort {
  ensurePersonalWorkspaceOwner(
    principal: AuthenticatedPrincipal,
  ): Promise<WorkspaceMembership>;
}
