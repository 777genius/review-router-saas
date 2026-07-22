import { createHash } from "node:crypto";
import {
  CapabilityAudience,
  CapabilityKind,
  type CapabilityKeyRingPort,
  type SafeCapabilityClaimValue,
  type SignedCapabilityClaims,
  type SignedCapabilityCodecPort,
} from "@reviewrouter/platform-signed-capabilities";
import type {
  IssuedReviewRunAuthorizationToken,
  ReviewRunAuthorizationTokenPort,
  ReviewRunAuthorizationTokenProfile,
  VerifiedReviewRunAuthorizationToken,
} from "../../application/ports/platform-ports";
import type { ReviewRunAuthorization } from "../../domain/review-run-authorization";
import {
  REVIEW_RUN_AUTHORIZATION_TOKEN_ISSUER,
  ReviewRunAuthorizationTokenAudience,
  canonicalJson,
  unsignedDecimal,
} from "../../domain/review-run-control-types";

const basePayloadKeys = [
  "scope_hash",
  "producer_release_id",
  "selected_protocol_version",
  "schema_digest",
  "protocol_limits_profile_id",
  "operational_slo_profile_id",
  "mutation_epoch",
  "authorization_safety_decision_hash",
  "provider_vote_lane_count",
] as const;

export class ReviewRunAuthorizationSignedCapabilityAdapter implements ReviewRunAuthorizationTokenPort {
  private readonly tokenProfile: ReviewRunAuthorizationTokenProfile;

  constructor(
    private readonly codec: SignedCapabilityCodecPort,
    private readonly keyRing: CapabilityKeyRingPort,
    issuer = REVIEW_RUN_AUTHORIZATION_TOKEN_ISSUER,
  ) {
    if (
      issuer.length === 0 ||
      issuer.length > 160 ||
      issuer.trim() !== issuer
    ) {
      throw new Error("review_run_authorization_token_issuer_invalid");
    }
    this.tokenProfile = Object.freeze({
      issuer,
      audience: ReviewRunAuthorizationTokenAudience.ReviewRun,
    });
  }

  profile(): ReviewRunAuthorizationTokenProfile {
    return this.tokenProfile;
  }

  async activeKeyId(): Promise<string> {
    return (await this.keyRing.activeSigningKey()).keyId;
  }

  async issue(
    authorization: ReviewRunAuthorization,
  ): Promise<IssuedReviewRunAuthorizationToken> {
    this.assertTokenProfile(authorization);
    const signed = await this.codec.sign(toSignedClaims(authorization));
    return {
      token: signed.token,
      keyId: signed.signingKeyId,
      expiresAt: new Date(signed.expiresAt),
    };
  }

  async verify(input: {
    readonly token: string;
    readonly now: Date;
  }): Promise<VerifiedReviewRunAuthorizationToken> {
    const claims = await this.codec.verify({
      token: input.token,
      expectedIssuer: this.tokenProfile.issuer,
      expectedAudience: CapabilityAudience.ReviewRun,
      expectedKind: CapabilityKind.RunAuthorization,
      now: input.now,
    });
    return parseContextClaims(claims, this.tokenProfile);
  }

  private assertTokenProfile(authorization: ReviewRunAuthorization): void {
    if (
      authorization.tokenIssuer !== this.tokenProfile.issuer ||
      authorization.tokenAudience !== this.tokenProfile.audience
    ) {
      throw new Error("review_run_authorization_token_profile_drift");
    }
  }
}

function toSignedClaims(
  authorization: ReviewRunAuthorization,
): SignedCapabilityClaims {
  const issuedAt = authorization.renewedAt ?? authorization.createdAt;
  return {
    capabilityId: authorization.authorizationId,
    kind: CapabilityKind.RunAuthorization,
    audience: CapabilityAudience.ReviewRun,
    issuer: authorization.tokenIssuer,
    subject: authorization.authorizationId,
    issuedAt: toNumericDatePrecision(issuedAt),
    notBefore: toNumericDatePrecision(issuedAt),
    ownershipExpiresAt: null,
    expiresAt: toNumericDatePrecision(authorization.expiresAt),
    payload: authorizationPayload(authorization),
  };
}

function authorizationPayload(
  authorization: ReviewRunAuthorization,
): Readonly<Record<string, SafeCapabilityClaimValue>> {
  const payload: Record<string, SafeCapabilityClaimValue> = {
    scope_hash: scopeHash(authorization),
    producer_release_id: authorization.producerReleaseId,
    selected_protocol_version: authorization.selectedProtocolVersion,
    schema_digest: authorization.schemaDigest,
    protocol_limits_profile_id: authorization.protocolLimitsProfileId,
    operational_slo_profile_id: authorization.operationalSloProfileId,
    mutation_epoch: unsignedDecimal(authorization.mutationEpoch),
    authorization_safety_decision_hash:
      authorization.authorizationSafetyDecisionHash,
    provider_vote_lane_count: authorization.providerVoteLanes.length,
  };
  authorization.providerVoteLanes.forEach((lane, index) => {
    payload[voteLaneKey(index)] = lane.providerVoteIdentityHash;
  });
  return Object.freeze(payload);
}

function parseContextClaims(
  claims: SignedCapabilityClaims,
  profile: ReviewRunAuthorizationTokenProfile,
): VerifiedReviewRunAuthorizationToken {
  if (
    claims.capabilityId !== claims.subject ||
    claims.issuer !== profile.issuer ||
    claims.audience !== CapabilityAudience.ReviewRun ||
    claims.kind !== CapabilityKind.RunAuthorization ||
    claims.ownershipExpiresAt !== null
  ) {
    throw new Error("review_run_authorization_token_claims_invalid");
  }
  const laneCount = requiredSafeInteger(
    claims.payload.provider_vote_lane_count,
    "provider_vote_lane_count",
  );
  if (laneCount < 1 || laneCount > 16) {
    throw new Error("review_run_authorization_token_vote_lanes_invalid");
  }
  const expectedKeys = new Set<string>(basePayloadKeys);
  const providerVoteLaneIds: string[] = [];
  for (let index = 0; index < laneCount; index += 1) {
    const key = voteLaneKey(index);
    expectedKeys.add(key);
    providerVoteLaneIds.push(requiredSha256(claims.payload[key], key));
  }
  if (
    Object.keys(claims.payload).length !== expectedKeys.size ||
    Object.keys(claims.payload).some((key) => !expectedKeys.has(key))
  ) {
    throw new Error("review_run_authorization_token_payload_shape_invalid");
  }
  return Object.freeze({
    capabilityId: claims.capabilityId,
    authorizationId: claims.subject,
    issuer: claims.issuer,
    audience: ReviewRunAuthorizationTokenAudience.ReviewRun,
    scopeHash: requiredSha256(claims.payload.scope_hash, "scope_hash"),
    producerReleaseId: requiredString(
      claims.payload.producer_release_id,
      "producer_release_id",
    ),
    selectedProtocolVersion: requiredString(
      claims.payload.selected_protocol_version,
      "selected_protocol_version",
    ),
    schemaDigest: requiredSha256(claims.payload.schema_digest, "schema_digest"),
    protocolLimitsProfileId: requiredString(
      claims.payload.protocol_limits_profile_id,
      "protocol_limits_profile_id",
    ),
    operationalSloProfileId: requiredString(
      claims.payload.operational_slo_profile_id,
      "operational_slo_profile_id",
    ),
    mutationEpoch: requiredUnsignedBigInt(
      claims.payload.mutation_epoch,
      "mutation_epoch",
    ),
    authorizationSafetyDecisionHash: requiredSha256(
      claims.payload.authorization_safety_decision_hash,
      "authorization_safety_decision_hash",
    ),
    providerVoteLaneIds: Object.freeze(providerVoteLaneIds),
    issuedAt: new Date(claims.issuedAt),
    expiresAt: new Date(claims.expiresAt),
  });
}

export function reviewRunAuthorizationScopeHash(
  authorization: Pick<
    ReviewRunAuthorization,
    | "workspaceId"
    | "repositoryConnectionId"
    | "scmRepositoryIdentityId"
    | "pullRequestNumber"
  >,
): string {
  return scopeHash(authorization);
}

function scopeHash(
  authorization: Pick<
    ReviewRunAuthorization,
    | "workspaceId"
    | "repositoryConnectionId"
    | "scmRepositoryIdentityId"
    | "pullRequestNumber"
  >,
): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        workspaceId: authorization.workspaceId,
        repositoryConnectionId: authorization.repositoryConnectionId,
        scmRepositoryIdentityId: authorization.scmRepositoryIdentityId,
        pullRequestNumber: authorization.pullRequestNumber,
      }),
      "utf8",
    )
    .digest("hex");
}

function voteLaneKey(index: number): string {
  return `provider_vote_lane_${index.toString().padStart(2, "0")}`;
}

function requiredString(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value
  ) {
    throw new Error(`review_run_authorization_token_${field}_invalid`);
  }
  return value;
}

function requiredSha256(value: unknown, field: string): string {
  const parsed = requiredString(value, field);
  if (!/^[a-f0-9]{64}$/.test(parsed)) {
    throw new Error(`review_run_authorization_token_${field}_invalid`);
  }
  return parsed;
}

function requiredSafeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`review_run_authorization_token_${field}_invalid`);
  }
  return value;
}

function requiredUnsignedBigInt(value: unknown, field: string): bigint {
  const parsed = requiredString(value, field);
  if (!/^(0|[1-9][0-9]*)$/.test(parsed)) {
    throw new Error(`review_run_authorization_token_${field}_invalid`);
  }
  return BigInt(parsed);
}

function toNumericDatePrecision(value: Date): Date {
  return new Date(Math.floor(value.getTime() / 1_000) * 1_000);
}
