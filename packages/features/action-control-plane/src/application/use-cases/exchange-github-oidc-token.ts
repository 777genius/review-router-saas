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
import type {
  ActionConflictReviewDispatchPayload,
  ActionConflictReviewExchangeVerifierPort,
} from "../ports/action-conflict-review-exchange-verifier-port.js";
import type { ActionConflictReviewRuntimeGatePort } from "../ports/action-conflict-review-runtime-gate-port.js";
import { runtimeReviewConfigurationSnapshotId } from "../ports/action-control-plane-repository-port.js";
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
  readonly conflictReviews?: ActionConflictReviewExchangeVerifierPort;
  readonly conflictReviewRuntimeGate?: ActionConflictReviewRuntimeGatePort;
  readonly clock: Clock;
};

export async function exchangeGitHubOidcToken(
  input: {
    readonly oidcToken: string;
    readonly audience: string;
    readonly conflictDispatchPayload?: ActionConflictReviewDispatchPayload;
  },
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
  const issuedAt = dependencies.clock.now();
  await consumeOidcReplayNonceIfConfigured({
    claims,
    issuedAt,
    replayNonces: dependencies.replayNonces,
  });
  await dependencies.entitlements?.assertActionControlPlaneAllowed({
    workspaceId: repository.workspaceId,
    repositoryId: repository.repositoryId,
    repositoryFullName: repository.fullName,
  });
  await dependencies.rateLimits?.assertOidcExchangeAllowed({
    workspaceId: repository.workspaceId,
    repositoryId: repository.repositoryId,
    repositoryFullName: repository.fullName,
    githubRunId: claims.run_id,
    githubRunAttempt: claims.run_attempt,
  });
  if (claims.event_name === "repository_dispatch") {
    await dependencies.conflictReviewRuntimeGate?.assertConflictReviewRuntimeEnabled(
      {
        phase: "session_exchange",
        workspaceId: repository.workspaceId,
        repositoryId: repository.repositoryId,
        repositoryFullName: repository.fullName,
      },
    );
  }
  const configSnapshotId =
    claims.event_name === "repository_dispatch"
      ? runtimeReviewConfigurationSnapshotId(
          await dependencies.repositories.findRuntimeReviewConfiguration({
            workspaceId: repository.workspaceId,
            repositoryId: repository.repositoryId,
          }),
        )
      : undefined;
  const conflictReview = await verifyConflictReviewExchangeIfNeeded({
    claims,
    conflictDispatchPayload: input.conflictDispatchPayload,
    conflictReviews: dependencies.conflictReviews,
    configSnapshotId,
    exchangedAt: issuedAt,
  });

  const sessionClaims: ActionSessionClaims = {
    workspaceId: repository.workspaceId,
    repositoryId: repository.repositoryId,
    githubRepositoryId: repository.githubRepositoryId,
    repository: repository.fullName,
    githubRunId: claims.run_id,
    githubRunAttempt: claims.run_attempt,
    eventName: claims.event_name,
    ...(conflictReview
      ? {
          reviewKind: conflictReview.reviewKind,
          conflictDispatchId: conflictReview.dispatchId,
          pullRequestNumber: conflictReview.pullRequestNumber,
          headSha: conflictReview.headSha,
          baseRef: conflictReview.baseRef,
          baseSha: conflictReview.baseSha,
          configSnapshotId: configSnapshotId!,
        }
      : {}),
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

async function verifyConflictReviewExchangeIfNeeded(input: {
  readonly claims: GitHubActionsOidcClaims;
  readonly conflictDispatchPayload:
    | ActionConflictReviewDispatchPayload
    | undefined;
  readonly conflictReviews:
    | ActionConflictReviewExchangeVerifierPort
    | undefined;
  readonly configSnapshotId: string | undefined;
  readonly exchangedAt: Date;
}) {
  if (input.claims.event_name !== "repository_dispatch") {
    if (input.conflictDispatchPayload) {
      throw new Error("conflict_review_payload_not_allowed");
    }
    return null;
  }
  if (!input.conflictDispatchPayload) {
    throw new Error("conflict_review_payload_required");
  }
  if (!input.conflictReviews) {
    throw new Error("conflict_review_exchange_unavailable");
  }
  if (!input.configSnapshotId) {
    throw new Error("conflict_review_config_snapshot_required");
  }
  return input.conflictReviews.verifyConflictReviewExchange({
    claims: input.claims,
    dispatchPayload: input.conflictDispatchPayload,
    configSnapshotId: input.configSnapshotId,
    exchangedAt: input.exchangedAt,
  });
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
