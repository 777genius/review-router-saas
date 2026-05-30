import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { GitLabCiIdTokenVerifierPort } from "../../application/ports/gitlab-ci-id-token-verifier-port";
import {
  defaultGitLabIssuer,
  gitLabCiIdTokenClaimsSchema,
  type GitLabCiIdTokenClaims,
} from "../../domain/gitlab-ci-identity";

export type JoseGitLabCiIdTokenVerifierOptions = {
  readonly jwks?: JWTVerifyGetKey;
  readonly issuer?: string;
  readonly jwksUrl?: string;
  readonly clockToleranceSeconds?: number;
};

export class JoseGitLabCiIdTokenVerifier implements GitLabCiIdTokenVerifierPort {
  private readonly jwks: JWTVerifyGetKey;
  private readonly issuer: string;
  private readonly clockToleranceSeconds: number;

  constructor(options: JoseGitLabCiIdTokenVerifierOptions = {}) {
    this.issuer = normalizeIssuer(options.issuer ?? defaultGitLabIssuer);
    this.jwks =
      options.jwks ??
      createRemoteJWKSet(
        new URL(options.jwksUrl ?? `${this.issuer}/oauth/discovery/keys`),
      );
    this.clockToleranceSeconds = options.clockToleranceSeconds ?? 60;
  }

  async verify(input: {
    readonly token: string;
    readonly audience: string;
  }): Promise<GitLabCiIdTokenClaims> {
    const verified = await jwtVerify(input.token, this.jwks, {
      issuer: this.issuer,
      audience: input.audience,
      clockTolerance: this.clockToleranceSeconds,
    });

    return gitLabCiIdTokenClaimsSchema.parse(verified.payload);
  }
}

function normalizeIssuer(issuer: string): string {
  return issuer.replace(/\/+$/, "");
}
