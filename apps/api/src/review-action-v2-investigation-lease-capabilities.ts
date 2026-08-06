import {
  CapabilityAudience,
  CapabilityKind,
  type CapabilityKeyRingPort,
  type SafeCapabilityClaimValue,
  type SignedCapabilityCodecPort,
} from "@reviewrouter/platform-signed-capabilities";
import {
  ReviewInvestigationLeasePurpose,
  type ReviewInvestigationLease,
} from "@reviewrouter/features-review-investigations";

const investigationLeaseRole = "review_investigation_shadow_lease_v1";

export type ReviewActionV2InvestigationLeaseCapabilityIdentity = Readonly<{
  capabilityId: string;
  signingKeyId: string;
}>;

export type VerifiedReviewActionV2InvestigationLeaseCapability = Readonly<{
  capabilityId: string;
  authorizationId: string;
  mutationEpoch: bigint;
  scopeHash: string;
  executionId: string;
  workSlotId: string;
  reviewRevisionHash: string;
  investigationId: string;
  investigationVersion: number;
  turnId: string;
  turnPurpose: string;
  providerVoteLaneId: string;
  providerStrategyId: string;
  investigationManifestHash: string;
  ownerIdHash: string;
  leaseId: string;
  attemptId: string;
  fencingToken: bigint;
  ownershipExpiresAt: Date;
  resultReportUntil: Date;
}>;

export interface ReviewActionV2InvestigationLeaseCapabilityPort {
  prepareIdentity(): Promise<ReviewActionV2InvestigationLeaseCapabilityIdentity>;
  issue(
    lease: ReviewInvestigationLease,
    authorizationScopeHash: string,
  ): Promise<string>;
  verify(
    token: string,
    now: Date,
  ): Promise<VerifiedReviewActionV2InvestigationLeaseCapability>;
}

export class ReviewActionV2InvestigationLeaseCapabilityAdapter implements ReviewActionV2InvestigationLeaseCapabilityPort {
  constructor(
    private readonly codec: SignedCapabilityCodecPort,
    private readonly keyRing: CapabilityKeyRingPort,
    private readonly issuer: string,
    private readonly nextCapabilityId: () => string,
  ) {
    identifier(issuer, "investigation_lease_capability_issuer");
  }

  async prepareIdentity(): Promise<ReviewActionV2InvestigationLeaseCapabilityIdentity> {
    const capabilityId = this.nextCapabilityId();
    identifier(capabilityId, "investigation_lease_capability_id");
    return Object.freeze({
      capabilityId,
      signingKeyId: (await this.keyRing.activeSigningKey()).keyId,
    });
  }

  async issue(
    lease: ReviewInvestigationLease,
    authorizationScopeHash: string,
  ): Promise<string> {
    if (lease.purpose !== ReviewInvestigationLeasePurpose.ShadowTurn) {
      throw new Error("investigation_lease_capability_purpose_invalid");
    }
    const signed = await this.codec.sign({
      capabilityId: lease.leaseCapabilityId,
      kind: CapabilityKind.InvestigationShadowLease,
      audience: CapabilityAudience.ReviewInvestigationShadowLease,
      issuer: this.issuer,
      subject: lease.leaseId,
      issuedAt: new Date(lease.renewedAt),
      notBefore: new Date(lease.renewedAt),
      ownershipExpiresAt: new Date(lease.expiresAt),
      expiresAt: new Date(lease.resultReportUntil),
      payload: {
        role: investigationLeaseRole,
        authorization_id: lease.authorizationId,
        mutation_epoch: lease.mutationEpoch.toString(10),
        scope_hash: authorizationScopeHash,
        execution_id: lease.executionId,
        work_slot_id: lease.workSlotId,
        review_revision_hash: lease.revision.reviewRevisionHash,
        investigation_id: lease.investigationId,
        investigation_version: String(lease.investigationVersion),
        turn_id: lease.turnId,
        turn_purpose: lease.turnPurpose,
        provider_vote_lane_id: lease.providerVoteLaneId,
        provider_strategy_id: lease.providerStrategyId,
        investigation_manifest_hash: lease.investigationManifestHash,
        owner_id_hash: lease.ownerIdHash,
        lease_id: lease.leaseId,
        attempt_id: lease.attemptId,
        fencing_token: lease.fencingToken.toString(10),
      },
    });
    return signed.token;
  }

  async verify(
    token: string,
    now: Date,
  ): Promise<VerifiedReviewActionV2InvestigationLeaseCapability> {
    const claims = await this.codec.verify({
      token,
      expectedIssuer: this.issuer,
      expectedAudience: CapabilityAudience.ReviewInvestigationShadowLease,
      expectedKind: CapabilityKind.InvestigationShadowLease,
      now,
    });
    const payload = exactPayload(claims.payload, [
      "role",
      "authorization_id",
      "mutation_epoch",
      "scope_hash",
      "execution_id",
      "work_slot_id",
      "review_revision_hash",
      "investigation_id",
      "investigation_version",
      "turn_id",
      "turn_purpose",
      "provider_vote_lane_id",
      "provider_strategy_id",
      "investigation_manifest_hash",
      "owner_id_hash",
      "lease_id",
      "attempt_id",
      "fencing_token",
    ]);
    if (
      text(field(payload, "role")) !== investigationLeaseRole ||
      claims.subject !== text(field(payload, "lease_id")) ||
      claims.ownershipExpiresAt === null
    ) {
      throw new Error("investigation_lease_capability_claims_invalid");
    }
    return Object.freeze({
      capabilityId: claims.capabilityId,
      authorizationId: text(field(payload, "authorization_id")),
      mutationEpoch: unsignedBigInt(field(payload, "mutation_epoch")),
      scopeHash: sha256(field(payload, "scope_hash")),
      executionId: text(field(payload, "execution_id")),
      workSlotId: text(field(payload, "work_slot_id")),
      reviewRevisionHash: sha256(field(payload, "review_revision_hash")),
      investigationId: text(field(payload, "investigation_id")),
      investigationVersion: positiveInteger(
        field(payload, "investigation_version"),
      ),
      turnId: text(field(payload, "turn_id")),
      turnPurpose: text(field(payload, "turn_purpose")),
      providerVoteLaneId: text(field(payload, "provider_vote_lane_id")),
      providerStrategyId: sha256(field(payload, "provider_strategy_id")),
      investigationManifestHash: sha256(
        field(payload, "investigation_manifest_hash"),
      ),
      ownerIdHash: sha256(field(payload, "owner_id_hash")),
      leaseId: text(field(payload, "lease_id")),
      attemptId: text(field(payload, "attempt_id")),
      fencingToken: unsignedBigInt(field(payload, "fencing_token")),
      ownershipExpiresAt: new Date(claims.ownershipExpiresAt),
      resultReportUntil: new Date(claims.expiresAt),
    });
  }
}

export class DisabledReviewActionV2InvestigationLeaseCapabilityAdapter implements ReviewActionV2InvestigationLeaseCapabilityPort {
  async prepareIdentity(): Promise<never> {
    throw new Error("review_investigation_lease_capability_disabled");
  }

  async issue(): Promise<never> {
    throw new Error("review_investigation_lease_capability_disabled");
  }

  async verify(): Promise<never> {
    throw new Error("review_investigation_lease_capability_disabled");
  }
}

function field(
  payload: Readonly<Record<string, SafeCapabilityClaimValue>>,
  key: string,
): SafeCapabilityClaimValue {
  const value = payload[key];
  if (value === undefined) {
    throw new Error("investigation_lease_capability_payload_invalid");
  }
  return value;
}

function exactPayload(
  payload: Readonly<Record<string, SafeCapabilityClaimValue>>,
  keys: readonly string[],
): Readonly<Record<string, SafeCapabilityClaimValue>> {
  const actual = Object.keys(payload).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    !actual.every((key, index) => key === expected[index])
  ) {
    throw new Error("investigation_lease_capability_payload_invalid");
  }
  return payload;
}

function text(value: SafeCapabilityClaimValue): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("investigation_lease_capability_string_invalid");
  }
  return value;
}

function identifier(value: string, field: string): string {
  if (!/^[A-Za-z0-9._:-]{1,160}$/u.test(value)) {
    throw new Error(`${field}_invalid`);
  }
  return value;
}

function sha256(value: SafeCapabilityClaimValue): string {
  const candidate = text(value);
  if (!/^[a-f0-9]{64}$/u.test(candidate)) {
    throw new Error("investigation_lease_capability_hash_invalid");
  }
  return candidate;
}

function unsignedBigInt(value: SafeCapabilityClaimValue): bigint {
  const candidate = text(value);
  if (!/^(0|[1-9][0-9]*)$/u.test(candidate)) {
    throw new Error("investigation_lease_capability_integer_invalid");
  }
  return BigInt(candidate);
}

function positiveInteger(value: SafeCapabilityClaimValue): number {
  const candidate = Number(text(value));
  if (!Number.isSafeInteger(candidate) || candidate < 1) {
    throw new Error("investigation_lease_capability_integer_invalid");
  }
  return candidate;
}
