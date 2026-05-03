import type { Clock } from "@reviewrouter/shared";
import {
  actionSessionTtlSeconds,
  validateOidcClaimsAgainstRepository,
  type ActionSessionClaims,
} from "../../domain/action-control-plane.js";
import type { ActionEntitlementPolicyPort } from "../ports/action-entitlement-policy-port.js";
import type { ActionControlPlaneRepositoryPort } from "../ports/action-control-plane-repository-port.js";
import type { ActionSessionTokenServicePort } from "../ports/action-session-token-service-port.js";
import type { GitHubActionsOidcTokenVerifierPort } from "../ports/github-actions-oidc-token-verifier-port.js";

export type ExchangeGitHubOidcTokenDependencies = {
  readonly oidcVerifier: GitHubActionsOidcTokenVerifierPort;
  readonly repositories: ActionControlPlaneRepositoryPort;
  readonly sessions: ActionSessionTokenServicePort;
  readonly entitlements?: ActionEntitlementPolicyPort;
  readonly clock: Clock;
};

export async function exchangeGitHubOidcToken(
  input: { readonly oidcToken: string; readonly audience: string },
  dependencies: ExchangeGitHubOidcTokenDependencies,
): Promise<{
  readonly sessionToken: string;
  readonly expiresAt: string;
  readonly repository: string;
}> {
  const claims = await dependencies.oidcVerifier.verify({
    token: input.oidcToken,
    audience: input.audience,
  });
  const repository =
    await dependencies.repositories.findSelectedRepositoryByGithubId(
      claims.repository_id,
    );

  if (!repository) {
    throw new Error("repository_not_registered");
  }

  validateOidcClaimsAgainstRepository({ claims, repository });
  await dependencies.entitlements?.assertActionControlPlaneAllowed({
    workspaceId: repository.workspaceId,
    repositoryId: repository.repositoryId,
    repositoryFullName: repository.fullName,
  });

  const sessionClaims: ActionSessionClaims = {
    workspaceId: repository.workspaceId,
    repositoryId: repository.repositoryId,
    githubRepositoryId: repository.githubRepositoryId,
    repository: repository.fullName,
    githubRunId: claims.run_id,
    githubRunAttempt: claims.run_attempt,
    eventName: claims.event_name,
    protocolVersion: 1,
  };

  const issuedAt = dependencies.clock.now();
  const session = await dependencies.sessions.sign({
    claims: sessionClaims,
    expiresInSeconds: actionSessionTtlSeconds,
    issuedAt,
  });

  return {
    sessionToken: session.token,
    expiresAt: session.expiresAt.toISOString(),
    repository: repository.fullName,
  };
}
