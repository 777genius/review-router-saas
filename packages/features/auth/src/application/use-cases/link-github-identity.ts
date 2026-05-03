import type { GitHubExternalIdentity } from "../../domain/github-external-identity";
import type { AuthenticatedPrincipal } from "../../domain/authenticated-principal";
import type { UserRepositoryPort } from "../ports/user-repository-port";
import type { WorkspaceMembershipRepositoryPort } from "../ports/workspace-membership-repository-port";

export type LinkGitHubIdentityDependencies = {
  readonly users: UserRepositoryPort;
  readonly memberships?: WorkspaceMembershipRepositoryPort;
};

export async function linkGitHubIdentity(
  identity: GitHubExternalIdentity,
  dependencies: LinkGitHubIdentityDependencies,
): Promise<AuthenticatedPrincipal> {
  const principal = await dependencies.users.upsertGitHubUser(identity);
  await dependencies.memberships?.ensurePersonalWorkspaceOwner(principal);
  return principal;
}
