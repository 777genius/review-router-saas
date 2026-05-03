import type { AuthenticatedPrincipal } from "../../domain/authenticated-principal";
import type { GitHubExternalIdentity } from "../../domain/github-external-identity";

export interface UserRepositoryPort {
  upsertGitHubUser(
    identity: GitHubExternalIdentity,
  ): Promise<AuthenticatedPrincipal>;
}
