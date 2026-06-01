import type { AuthenticatedPrincipal } from "../../domain/authenticated-principal";
import type { ExternalIdentity } from "../../domain/external-identity";
import type { GitHubExternalIdentity } from "../../domain/github-external-identity";

export interface UserRepositoryPort {
  /**
   * Provider-neutral identity upsert used by GitHub and GitLab sign-in flows.
   */
  upsertExternalIdentity(
    identity: ExternalIdentity,
  ): Promise<AuthenticatedPrincipal>;

  upsertGitHubUser(
    identity: GitHubExternalIdentity,
  ): Promise<AuthenticatedPrincipal>;
}
