import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { GitHubActionsOidcTokenVerifierPort } from "../../application/ports/github-actions-oidc-token-verifier-port.js";
import {
  githubActionsOidcClaimsSchema,
  githubActionsOidcIssuer,
  type GitHubActionsOidcClaims,
} from "../../domain/action-control-plane.js";

const githubActionsJwksUrl =
  "https://token.actions.githubusercontent.com/.well-known/jwks";

export type JoseGitHubActionsOidcTokenVerifierOptions = {
  readonly jwks?: JWTVerifyGetKey;
  readonly issuer?: string;
  readonly clockToleranceSeconds?: number;
};

export class JoseGitHubActionsOidcTokenVerifier implements GitHubActionsOidcTokenVerifierPort {
  private readonly jwks: JWTVerifyGetKey;
  private readonly issuer: string;
  private readonly clockToleranceSeconds: number;

  constructor(options: JoseGitHubActionsOidcTokenVerifierOptions = {}) {
    this.jwks =
      options.jwks ?? createRemoteJWKSet(new URL(githubActionsJwksUrl));
    this.issuer = options.issuer ?? githubActionsOidcIssuer;
    this.clockToleranceSeconds = options.clockToleranceSeconds ?? 60;
  }

  async verify(input: {
    readonly token: string;
    readonly audience: string;
  }): Promise<GitHubActionsOidcClaims> {
    const verified = await jwtVerify(input.token, this.jwks, {
      issuer: this.issuer,
      audience: input.audience,
      clockTolerance: this.clockToleranceSeconds,
    });

    return githubActionsOidcClaimsSchema.parse(verified.payload);
  }
}
