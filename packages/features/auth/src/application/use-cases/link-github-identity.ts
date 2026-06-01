import {
  gitHubIdentityToExternalIdentity,
  type GitHubExternalIdentity,
} from "../../domain/github-external-identity";
import type { AuthenticatedPrincipal } from "../../domain/authenticated-principal";
import type { UserRepositoryPort } from "../ports/user-repository-port";
import type { WorkspaceMembershipRepositoryPort } from "../ports/workspace-membership-repository-port";
import { linkExternalIdentity } from "./link-external-identity";

export type LinkGitHubIdentityDependencies = {
  readonly users: UserRepositoryPort;
  readonly memberships?: WorkspaceMembershipRepositoryPort;
};

export async function linkGitHubIdentity(
  identity: GitHubExternalIdentity,
  dependencies: LinkGitHubIdentityDependencies,
): Promise<AuthenticatedPrincipal> {
  return linkExternalIdentity(gitHubIdentityToExternalIdentity(identity), {
    users: dependencies.users,
    ...(dependencies.memberships
      ? { memberships: dependencies.memberships }
      : {}),
  });
}
