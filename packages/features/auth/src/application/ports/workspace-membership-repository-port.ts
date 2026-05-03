import type { AuthenticatedPrincipal } from "../../domain/authenticated-principal";

export type WorkspaceMembership = {
  readonly workspaceId: string;
  readonly workspaceSlug?: string;
  readonly role: "owner" | "admin" | "member";
  readonly source?: "personal" | "github_user_installation";
};

export interface WorkspaceMembershipRepositoryPort {
  ensurePersonalWorkspaceOwner(
    principal: AuthenticatedPrincipal,
  ): Promise<WorkspaceMembership>;

  ensureGitHubUserInstallationWorkspaceOwners(
    principal: AuthenticatedPrincipal,
  ): Promise<readonly WorkspaceMembership[]>;
}
