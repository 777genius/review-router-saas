import type { GitLabActionSessionClaims } from "../../domain/gitlab-ci-identity";

export interface GitLabActionSessionTokenServicePort {
  sign(input: {
    readonly claims: GitLabActionSessionClaims;
    readonly expiresInSeconds: number;
    readonly issuedAt: Date;
  }): Promise<{ readonly token: string; readonly expiresAt: Date }>;

  verify(input: {
    readonly token: string;
    readonly now: Date;
  }): Promise<GitLabActionSessionClaims>;
}
