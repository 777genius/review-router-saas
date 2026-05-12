import type { Clock } from "@reviewrouter/shared";
import {
  actionSessionTtlSeconds,
  buildActionOidcReplayNonceKey,
  resolveActionOidcReplayNonceExpiresAt,
  validateOidcClaimsAgainstRepository,
  type ActionSessionClaims,
  type GitHubActionsOidcClaims,
} from "../../domain/action-control-plane.js";
import type { ActionOidcReplayNonceStorePort } from "../ports/action-oidc-replay-nonce-store-port.js";
import type { ActionEntitlementPolicyPort } from "../ports/action-entitlement-policy-port.js";
import type { ActionControlPlaneRepositoryPort } from "../ports/action-control-plane-repository-port.js";
import type { ActionRateLimitPolicyPort } from "../ports/action-rate-limit-policy-port.js";
import type { ActionSessionTokenServicePort } from "../ports/action-session-token-service-port.js";
import type { GitHubActionsOidcTokenVerifierPort } from "../ports/github-actions-oidc-token-verifier-port.js";

export type ExchangeGitHubOidcTokenDependencies = {
  readonly oidcVerifier: GitHubActionsOidcTokenVerifierPort;
  readonly repositories: ActionControlPlaneRepositoryPort;
  readonly sessions: ActionSessionTokenServicePort;
  readonly entitlements?: ActionEntitlementPolicyPort;
  readonly rateLimits?: ActionRateLimitPolicyPort;
  readonly replayNonces?: ActionOidcReplayNonceStorePort;
  readonly clock: Clock;
};

export async function exchangeGitHubOidcToken(
  input: { readonly oidcToken: string; readonly audience: string },
  dependencies: ExchangeGitHubOidcTokenDependencies,
): Promise<{
  readonly protocolVersion: 1;
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
  const issuedAt = dependencies.clock.now();
  await consumeOidcReplayNonceIfConfigured({
    claims,
    issuedAt,
    replayNonces: dependencies.replayNonces,
  });

  await dependencies.rateLimits?.assertOidcExchangeAllowed({
    workspaceId: repository.workspaceId,
    repositoryId: repository.repositoryId,
    repositoryFullName: repository.fullName,
    eventName: claims.event_name,
    githubActorLogin: claims.actor,
    githubRunId: claims.run_id,
    githubRunAttempt: claims.run_attempt,
  });

  const sessionClaims: ActionSessionClaims = {
    workspaceId: repository.workspaceId,
    repositoryId: repository.repositoryId,
    githubRepositoryId: repository.githubRepositoryId,
    repository: repository.fullName,
    githubActorLogin: claims.actor,
    githubRunId: claims.run_id,
    githubRunAttempt: claims.run_attempt,
    eventName: claims.event_name,
    protocolVersion: 1,
  };

  const session = await dependencies.sessions.sign({
    claims: sessionClaims,
    expiresInSeconds: actionSessionTtlSeconds,
    issuedAt,
  });

  return {
    protocolVersion: 1,
    sessionToken: session.token,
    expiresAt: session.expiresAt.toISOString(),
    repository: repository.fullName,
  };
}

async function consumeOidcReplayNonceIfConfigured(input: {
  readonly claims: GitHubActionsOidcClaims;
  readonly issuedAt: Date;
  readonly replayNonces: ActionOidcReplayNonceStorePort | undefined;
}): Promise<void> {
  if (!input.replayNonces) {
    return;
  }

  const consumed = await input.replayNonces.tryConsumeNonce({
    key: buildActionOidcReplayNonceKey(input.claims),
    expiresAt: resolveActionOidcReplayNonceExpiresAt({
      claims: input.claims,
      now: input.issuedAt,
    }),
    now: input.issuedAt,
  });

  if (!consumed) {
    throw new Error("oidc_replay_detected");
  }
}
