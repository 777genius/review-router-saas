import type { AuthenticatedPrincipal } from "../../domain/authenticated-principal";
import type { ExternalIdentity } from "../../domain/external-identity";
import type { UserRepositoryPort } from "../ports/user-repository-port";
import type { WorkspaceMembershipRepositoryPort } from "../ports/workspace-membership-repository-port";

export type LinkExternalIdentityDependencies = {
  readonly users: UserRepositoryPort;
  readonly memberships?: WorkspaceMembershipRepositoryPort;
};

export async function linkExternalIdentity(
  identity: ExternalIdentity,
  dependencies: LinkExternalIdentityDependencies,
): Promise<AuthenticatedPrincipal> {
  const principal = await dependencies.users.upsertExternalIdentity(identity);
  await dependencies.memberships?.ensurePersonalWorkspaceOwner(principal);
  if (identity.provider === "github") {
    await dependencies.memberships?.ensureGitHubUserInstallationWorkspaceOwners(
      principal,
    );
  }
  return principal;
}
