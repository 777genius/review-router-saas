import {
  ProviderVoteLane,
  ReviewProtocolVersion,
  ReviewRunAuthorizationState,
  ReviewRunScope,
  ReviewTrustDomain,
  assertCommitSha,
  assertDate,
  assertIdentifier,
  assertNonNegativeBigInt,
  assertPositiveInteger,
  assertSha256,
  canonicalJson,
  cloneDate,
  invalid,
  unsignedDecimal,
} from "./review-run-control-types";
import type { ReviewRunAuthorizationTokenAudience } from "./review-run-control-types";

export type ReviewRunRevision = {
  readonly baseSha: string;
  readonly mergeBaseSha: string;
  readonly headSha: string;
  readonly reviewRevisionHash: string;
};

export type ReviewRunAuthorization = ReviewRunScope &
  ReviewRunRevision & {
    readonly authorizationId: string;
    readonly version: number;
    readonly sourceRunId: string;
    readonly sourceRunAttempt: string;
    readonly workflowIdentityHash: string;
    readonly trustDomain: ReviewTrustDomain;
    readonly producerReleaseId: string;
    readonly selectedProtocolVersion: ReviewProtocolVersion;
    readonly schemaDigest: string;
    readonly protocolLimitsProfileId: string;
    readonly operationalSloProfileId: string;
    readonly mutationEpoch: bigint;
    readonly providerVoteLanes: readonly ProviderVoteLane[];
    readonly authorizationSafetyDecisionHash: string;
    readonly protocolOfferHash: string;
    readonly oidcReplayKeyHash: string;
    readonly tokenSigningKeyId: string;
    readonly tokenIssuer: string;
    readonly tokenAudience: ReviewRunAuthorizationTokenAudience;
    readonly state: ReviewRunAuthorizationState;
    readonly expiresAt: Date;
    readonly maxExpiresAt: Date;
    readonly createdAt: Date;
    readonly renewedAt: Date | null;
  };

export type ReviewRunAuthorizationCandidate = Omit<
  ReviewRunAuthorization,
  "version" | "state" | "renewedAt"
>;

export function createReviewRunAuthorization(
  candidate: ReviewRunAuthorizationCandidate,
): ReviewRunAuthorization {
  assertAuthorizationCandidate(candidate);
  return {
    ...candidate,
    version: 1,
    providerVoteLanes: normalizeProviderVoteLanes(candidate.providerVoteLanes),
    state: ReviewRunAuthorizationState.Active,
    expiresAt: cloneDate(candidate.expiresAt),
    maxExpiresAt: cloneDate(candidate.maxExpiresAt),
    createdAt: cloneDate(candidate.createdAt),
    renewedAt: null,
  };
}

export function renewReviewRunAuthorization(
  authorization: ReviewRunAuthorization,
  input: { readonly renewedAt: Date; readonly expiresAt: Date },
): ReviewRunAuthorization {
  assertDate(input.renewedAt, "renewed_at");
  assertDate(input.expiresAt, "expires_at");
  if (authorization.state !== ReviewRunAuthorizationState.Active) {
    invalid("authorization_not_active");
  }
  if (input.renewedAt >= authorization.expiresAt) {
    invalid("authorization_already_expired");
  }
  if (input.expiresAt > authorization.maxExpiresAt) {
    invalid("authorization_max_expiry_exceeded");
  }
  if (input.expiresAt <= authorization.expiresAt) {
    return cloneReviewRunAuthorization(authorization);
  }
  return {
    ...authorization,
    version: authorization.version + 1,
    providerVoteLanes: authorization.providerVoteLanes.map((lane) => ({
      ...lane,
    })),
    expiresAt: cloneDate(input.expiresAt),
    maxExpiresAt: cloneDate(authorization.maxExpiresAt),
    createdAt: cloneDate(authorization.createdAt),
    renewedAt: cloneDate(input.renewedAt),
  };
}

export function terminateReviewRunAuthorization(
  authorization: ReviewRunAuthorization,
  input: {
    readonly state:
      | ReviewRunAuthorizationState.Expired
      | ReviewRunAuthorizationState.Revoked;
    readonly at: Date;
  },
): ReviewRunAuthorization {
  assertDate(input.at, "terminated_at");
  if (authorization.state === input.state) {
    return cloneReviewRunAuthorization(authorization);
  }
  if (authorization.state !== ReviewRunAuthorizationState.Active) {
    invalid("authorization_terminal_state_conflict");
  }
  return {
    ...authorization,
    version: authorization.version + 1,
    state: input.state,
    providerVoteLanes: authorization.providerVoteLanes.map((lane) => ({
      ...lane,
    })),
    expiresAt:
      input.state === ReviewRunAuthorizationState.Expired &&
      input.at < authorization.expiresAt
        ? cloneDate(input.at)
        : cloneDate(authorization.expiresAt),
    maxExpiresAt: cloneDate(authorization.maxExpiresAt),
    createdAt: cloneDate(authorization.createdAt),
    renewedAt: authorization.renewedAt
      ? cloneDate(authorization.renewedAt)
      : null,
  };
}

export function reviewRunAuthorizationImmutableKey(
  authorization: ReviewRunAuthorization | ReviewRunAuthorizationCandidate,
): string {
  return canonicalJson({
    workspaceId: authorization.workspaceId,
    repositoryConnectionId: authorization.repositoryConnectionId,
    scmRepositoryIdentityId: authorization.scmRepositoryIdentityId,
    pullRequestNumber: authorization.pullRequestNumber,
    sourceRunId: authorization.sourceRunId,
    sourceRunAttempt: authorization.sourceRunAttempt,
    workflowIdentityHash: authorization.workflowIdentityHash,
    baseSha: authorization.baseSha,
    mergeBaseSha: authorization.mergeBaseSha,
    headSha: authorization.headSha,
    reviewRevisionHash: authorization.reviewRevisionHash,
    trustDomain: authorization.trustDomain,
    producerReleaseId: authorization.producerReleaseId,
    selectedProtocolVersion: authorization.selectedProtocolVersion,
    schemaDigest: authorization.schemaDigest,
    protocolLimitsProfileId: authorization.protocolLimitsProfileId,
    operationalSloProfileId: authorization.operationalSloProfileId,
    mutationEpoch: unsignedDecimal(authorization.mutationEpoch),
    providerVoteLanes: normalizeProviderVoteLanes(
      authorization.providerVoteLanes,
    ),
    authorizationSafetyDecisionHash:
      authorization.authorizationSafetyDecisionHash,
    protocolOfferHash: authorization.protocolOfferHash,
    oidcReplayKeyHash: authorization.oidcReplayKeyHash,
    tokenIssuer: authorization.tokenIssuer,
    tokenAudience: authorization.tokenAudience,
  });
}

export function reviewRunAttemptKey(
  authorization:
    | ReviewRunAuthorization
    | Pick<
        ReviewRunAuthorizationCandidate,
        | "workspaceId"
        | "repositoryConnectionId"
        | "scmRepositoryIdentityId"
        | "pullRequestNumber"
        | "sourceRunId"
        | "sourceRunAttempt"
      >,
): string {
  return [
    authorization.workspaceId,
    authorization.repositoryConnectionId,
    authorization.scmRepositoryIdentityId,
    authorization.pullRequestNumber,
    authorization.sourceRunId,
    authorization.sourceRunAttempt,
  ].join("\u0000");
}

export function cloneReviewRunAuthorization(
  authorization: ReviewRunAuthorization,
): ReviewRunAuthorization {
  return {
    ...authorization,
    providerVoteLanes: authorization.providerVoteLanes.map((lane) => ({
      ...lane,
    })),
    expiresAt: cloneDate(authorization.expiresAt),
    maxExpiresAt: cloneDate(authorization.maxExpiresAt),
    createdAt: cloneDate(authorization.createdAt),
    renewedAt: authorization.renewedAt
      ? cloneDate(authorization.renewedAt)
      : null,
  };
}

function assertAuthorizationCandidate(
  candidate: ReviewRunAuthorizationCandidate,
): void {
  assertIdentifier(candidate.authorizationId, "authorization_id");
  assertIdentifier(candidate.workspaceId, "workspace_id");
  assertIdentifier(
    candidate.repositoryConnectionId,
    "repository_connection_id",
  );
  assertIdentifier(
    candidate.scmRepositoryIdentityId,
    "scm_repository_identity_id",
  );
  assertPositiveInteger(candidate.pullRequestNumber, "pull_request_number");
  assertIdentifier(candidate.sourceRunId, "source_run_id");
  assertIdentifier(candidate.sourceRunAttempt, "source_run_attempt");
  assertSha256(candidate.workflowIdentityHash, "workflow_identity_hash");
  assertCommitSha(candidate.baseSha, "base_sha");
  assertCommitSha(candidate.mergeBaseSha, "merge_base_sha");
  assertCommitSha(candidate.headSha, "head_sha");
  assertSha256(candidate.reviewRevisionHash, "review_revision_hash");
  assertIdentifier(candidate.producerReleaseId, "producer_release_id");
  assertSha256(candidate.schemaDigest, "schema_digest");
  assertIdentifier(
    candidate.protocolLimitsProfileId,
    "protocol_limits_profile_id",
  );
  assertIdentifier(
    candidate.operationalSloProfileId,
    "operational_slo_profile_id",
  );
  assertNonNegativeBigInt(candidate.mutationEpoch, "mutation_epoch");
  assertSha256(
    candidate.authorizationSafetyDecisionHash,
    "authorization_safety_decision_hash",
  );
  assertSha256(candidate.protocolOfferHash, "protocol_offer_hash");
  assertSha256(candidate.oidcReplayKeyHash, "oidc_replay_key_hash");
  if (!Object.values(ReviewTrustDomain).includes(candidate.trustDomain)) {
    invalid("trust_domain_invalid");
  }
  assertIdentifier(candidate.tokenSigningKeyId, "token_signing_key_id");
  assertIdentifier(candidate.tokenIssuer, "token_issuer");
  assertIdentifier(candidate.tokenAudience, "token_audience");
  assertDate(candidate.expiresAt, "expires_at");
  assertDate(candidate.maxExpiresAt, "max_expires_at");
  assertDate(candidate.createdAt, "created_at");
  if (
    candidate.expiresAt <= candidate.createdAt ||
    candidate.maxExpiresAt < candidate.expiresAt
  ) {
    invalid("authorization_expiry_invalid");
  }
  normalizeProviderVoteLanes(candidate.providerVoteLanes);
}

function normalizeProviderVoteLanes(
  lanes: readonly ProviderVoteLane[],
): readonly ProviderVoteLane[] {
  if (lanes.length === 0 || lanes.length > 16) {
    invalid("provider_vote_lanes_invalid");
  }
  const seenProviders = new Set<string>();
  return [...lanes]
    .map((lane) => {
      assertSha256(
        lane.providerVoteIdentityHash,
        "provider_vote_identity_hash",
      );
      if (seenProviders.has(lane.providerKind)) {
        invalid("duplicate_provider_vote_lane");
      }
      seenProviders.add(lane.providerKind);
      return { ...lane };
    })
    .sort((left, right) => left.providerKind.localeCompare(right.providerKind));
}
