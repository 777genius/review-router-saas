import type { GitLabCiIdTokenClaims } from "../../domain/gitlab-ci-identity";

export interface GitLabCiIdTokenVerifierPort {
  verify(input: {
    readonly token: string;
    readonly audience: string;
  }): Promise<GitLabCiIdTokenClaims>;
}
