import type { GitHubActionsOidcClaims } from "../../domain/action-control-plane.js";

export interface GitHubActionsOidcTokenVerifierPort {
  verify(input: {
    readonly token: string;
    readonly audience: string;
  }): Promise<GitHubActionsOidcClaims>;
}
