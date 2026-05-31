import type { AuthenticatedPrincipal } from "../../domain/authenticated-principal";
import type { ExternalIdentity } from "../../domain/external-identity";
import type { GitHubExternalIdentity } from "../../domain/github-external-identity";

export interface UserRepositoryPort {
  upsertExternalIdentity(
    identity: ExternalIdentity,
  ): Promise<AuthenticatedPrincipal>;

  upsertGitHubUser(
    identity: GitHubExternalIdentity,
  ): Promise<AuthenticatedPrincipal>;
}
