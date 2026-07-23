import {
  CapabilityAudience,
  CapabilityKind,
  type CapabilityKeyRingPort,
  type SignedCapabilityCodecPort,
} from "@reviewrouter/platform-signed-capabilities";
import type {
  ProviderInvocationManifest,
  ReviewTrustDomain,
} from "@reviewrouter/features-review-evidence";
import type {
  PublicationPermit,
  ReviewInvocationLease,
  ReviewObservationAttachmentKind,
} from "@reviewrouter/features-review-executions";

const leaseRole = "review_execution_lease_v1";
const attachmentRole = "review_evidence_attachment_v1";
const publicationRole = "review_publication_permit_v1";
const nullValue = "~";

export type ReviewActionV2PreparedCapabilityIdentity = Readonly<{
  capabilityId: string;
  signingKeyId: string;
}>;

export type VerifiedReviewActionV2LeaseCapability = Readonly<{
  capabilityId: string;
  authorizationId: string;
  mutationEpoch: bigint;
  scopeHash: string;
  executionId: string;
  workSlotId: string;
  leaseId: string;
  ownerIdHash: string;
  providerInvocationKey: string;
  purpose: string;
  reviewRevisionHash: string;
  attemptId: string | null;
  ownershipExpiresAt: Date;
  resultReportUntil: Date;
}>;

export type ReviewActionV2ReusableAttachmentAuthority = Readonly<{
  authorizationId: string;
  mutationEpoch: bigint;
  scopeHash: string;
  targetExecutionId: string;
  targetWorkSlotId: string;
  targetReviewRevisionHash: string;
  targetPlanHash: string;
  observationId: string;
  sourceExecutionId: string;
  manifest: ProviderInvocationManifest;
  manifestKey: string;
  providerInvocationKey: string;
  providerVoteIdentityHash: string;
  payloadHash: string;
  byteCount: number;
  findingCount: number;
  attachmentKind: Exclude<
    ReviewObservationAttachmentKind,
    | ReviewObservationAttachmentKind.FreshLease
    | ReviewObservationAttachmentKind.ObservationAdoption
  >;
  reuseSafetyDecisionHash: string;
  eligibilityPolicyVersion: string;
  trustDomain: ReviewTrustDomain;
  expiresAt: Date;
}>;

export type VerifiedReviewActionV2PublicationPermit = Readonly<{
  capabilityId: string;
  authorizationId: string;
  executionId: string;
  generation: bigint;
  reviewRevisionHash: string;
  reviewedHeadSha: string;
  projectionHash: string;
  lifecycleStateHash: string;
  commandLedgerWatermark: bigint;
  permitEpoch: bigint;
  publicationSafetyDecisionHash: string;
  publicationNotAfter: Date;
}>;

export class ReviewActionV2ExecutionEvidenceCapabilityAdapter {
  constructor(
    private readonly codec: SignedCapabilityCodecPort,
    private readonly keyRing: CapabilityKeyRingPort,
    private readonly issuer: string,
    private readonly nextCapabilityId: () => string,
  ) {
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(issuer)) {
      throw new Error("review_action_v2_capability_issuer_invalid");
    }
  }

  async prepareIdentity(): Promise<ReviewActionV2PreparedCapabilityIdentity> {
    const capabilityId = this.nextCapabilityId();
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(capabilityId)) {
      throw new Error("review_action_v2_capability_id_invalid");
    }
    return Object.freeze({
      capabilityId,
      signingKeyId: (await this.keyRing.activeSigningKey()).keyId,
    });
  }

  async issueLease(
    lease: ReviewInvocationLease,
    authorizationScopeHash: string,
    issuedAt: Date = lease.acquiredAt,
  ): Promise<string> {
    const signed = await this.codec.sign({
      capabilityId: lease.leaseCapabilityId,
      kind: CapabilityKind.InvocationLease,
      audience: CapabilityAudience.ReviewInvocationLease,
      issuer: this.issuer,
      subject: lease.leaseId,
      issuedAt,
      notBefore: issuedAt,
      ownershipExpiresAt: lease.expiresAt,
      expiresAt: lease.resultReportUntil,
      payload: {
        role: leaseRole,
        authorization_id: lease.authorizationId,
        scope_hash: authorizationScopeHash,
        execution_id: lease.executionId,
        work_slot_id: lease.workSlotId,
        lease_id: lease.leaseId,
        owner_id_hash: lease.ownerIdHash,
        provider_invocation_key: lease.providerInvocationKey,
        purpose: lease.purpose,
        mutation_epoch: lease.mutationEpoch.toString(10),
        review_revision_hash: lease.reviewRevisionHash,
        attempt_id: lease.attemptId ?? nullValue,
      },
    });
    return signed.token;
  }

  async verifyLease(
    token: string,
    now: Date,
  ): Promise<VerifiedReviewActionV2LeaseCapability> {
    const claims = await this.codec.verify({
      token,
      expectedIssuer: this.issuer,
      expectedAudience: CapabilityAudience.ReviewInvocationLease,
      expectedKind: CapabilityKind.InvocationLease,
      now,
    });
    const payload = exactPayload(claims.payload, [
      "role",
      "authorization_id",
      "scope_hash",
      "execution_id",
      "work_slot_id",
      "lease_id",
      "owner_id_hash",
      "provider_invocation_key",
      "purpose",
      "mutation_epoch",
      "review_revision_hash",
      "attempt_id",
    ]);
    if (
      string(payload.role) !== leaseRole ||
      claims.subject !== string(payload.lease_id) ||
      claims.ownershipExpiresAt === null
    ) {
      throw new Error("review_action_v2_lease_capability_claims_invalid");
    }
    return Object.freeze({
      capabilityId: claims.capabilityId,
      authorizationId: string(payload.authorization_id),
      scopeHash: sha256(payload.scope_hash),
      executionId: string(payload.execution_id),
      workSlotId: string(payload.work_slot_id),
      leaseId: string(payload.lease_id),
      ownerIdHash: sha256(payload.owner_id_hash),
      providerInvocationKey: sha256(payload.provider_invocation_key),
      purpose: string(payload.purpose),
      mutationEpoch: unsignedBigInt(payload.mutation_epoch),
      reviewRevisionHash: sha256(payload.review_revision_hash),
      attemptId: nullableString(payload.attempt_id),
      ownershipExpiresAt: new Date(claims.ownershipExpiresAt),
      resultReportUntil: new Date(claims.expiresAt),
    });
  }

  async issueReusableAttachment(
    authority: ReviewActionV2ReusableAttachmentAuthority,
    issuedAt: Date,
  ): Promise<string> {
    const identity = await this.prepareIdentity();
    const manifest = authority.manifest;
    const signed = await this.codec.sign({
      capabilityId: identity.capabilityId,
      kind: CapabilityKind.InvocationLease,
      audience: CapabilityAudience.ReviewInvocationLease,
      issuer: this.issuer,
      subject: authority.observationId,
      issuedAt,
      notBefore: issuedAt,
      ownershipExpiresAt: null,
      expiresAt: authority.expiresAt,
      payload: {
        role: attachmentRole,
        authorization_id: authority.authorizationId,
        mutation_epoch: authority.mutationEpoch.toString(10),
        scope_hash: authority.scopeHash,
        target_execution_id: authority.targetExecutionId,
        target_work_slot_id: authority.targetWorkSlotId,
        target_revision_hash: authority.targetReviewRevisionHash,
        target_plan_hash: authority.targetPlanHash,
        observation_id: authority.observationId,
        source_execution_id: authority.sourceExecutionId,
        manifest_key: authority.manifestKey,
        provider_invocation_key: authority.providerInvocationKey,
        provider_vote_identity_hash: authority.providerVoteIdentityHash,
        payload_hash: authority.payloadHash,
        byte_count: authority.byteCount,
        finding_count: authority.findingCount,
        attachment_kind: authority.attachmentKind,
        reuse_safety_hash: authority.reuseSafetyDecisionHash,
        eligibility_policy_version: authority.eligibilityPolicyVersion,
        trust_domain: authority.trustDomain,
        manifest_version: manifest.manifestVersion,
        manifest_scope_hash: manifest.scopeHash,
        task_kinds: manifest.taskKindSet.join(","),
        provider_kind: manifest.providerKind,
        provider_capability_hash: manifest.providerCapabilityHash,
        requested_model: manifest.requestedModel,
        provider_policy_version: manifest.providerPolicyVersion,
        producer_release_id: manifest.producerReleaseId,
        selected_protocol_version: manifest.selectedProtocolVersion,
        request_envelope_hash: manifest.providerRequestEnvelopeHash,
        output_schema_hash: manifest.outputSchemaHash,
        review_config_hash: manifest.reviewConfigHash,
        runtime_compatibility_key: manifest.runtimeCompatibilityKey,
        file_patch_manifest_hash: manifest.filePatchManifestHash,
        context_manifest_hash: manifest.contextManifestHash,
        memory_bundle_hash: manifest.memoryBundleHash ?? nullValue,
        code_graph_hash: manifest.codeGraphProjectionHash ?? nullValue,
        lifecycle_target_hash: manifest.lifecycleTargetSetHash ?? nullValue,
        live_lifecycle_hash: manifest.liveLifecycleStateHash ?? nullValue,
        tool_policy_hash: manifest.toolPolicyHash,
        execution_profile: manifest.executionProfile,
        base_tree_hash: manifest.baseTreeHash ?? nullValue,
        environment_contract_hash: manifest.environmentContractHash,
      },
    });
    return signed.token;
  }

  async verifyReusableAttachment(
    token: string,
    now: Date,
  ): Promise<ReviewActionV2ReusableAttachmentAuthority> {
    const claims = await this.codec.verify({
      token,
      expectedIssuer: this.issuer,
      expectedAudience: CapabilityAudience.ReviewInvocationLease,
      expectedKind: CapabilityKind.InvocationLease,
      now,
    });
    const payload = claims.payload;
    if (
      payload.role !== attachmentRole ||
      claims.subject !== payload.observation_id ||
      claims.ownershipExpiresAt !== null
    ) {
      throw new Error("review_action_v2_attachment_capability_claims_invalid");
    }
    const manifest = parseManifestPayload(payload);
    return Object.freeze({
      authorizationId: string(payload.authorization_id),
      mutationEpoch: unsignedBigInt(payload.mutation_epoch),
      scopeHash: sha256(payload.scope_hash),
      targetExecutionId: string(payload.target_execution_id),
      targetWorkSlotId: string(payload.target_work_slot_id),
      targetReviewRevisionHash: sha256(payload.target_revision_hash),
      targetPlanHash: sha256(payload.target_plan_hash),
      observationId: string(payload.observation_id),
      sourceExecutionId: string(payload.source_execution_id),
      manifest,
      manifestKey: sha256(payload.manifest_key),
      providerInvocationKey: sha256(payload.provider_invocation_key),
      providerVoteIdentityHash: sha256(payload.provider_vote_identity_hash),
      payloadHash: sha256(payload.payload_hash),
      byteCount: nonNegativeInteger(payload.byte_count),
      findingCount: nonNegativeInteger(payload.finding_count),
      attachmentKind: attachmentKind(payload.attachment_kind),
      reuseSafetyDecisionHash: sha256(payload.reuse_safety_hash),
      eligibilityPolicyVersion: string(payload.eligibility_policy_version),
      trustDomain: string(payload.trust_domain) as ReviewTrustDomain,
      expiresAt: new Date(claims.expiresAt),
    });
  }

  async issuePublicationPermit(
    permit: PublicationPermit,
    issuedAt: Date,
  ): Promise<string> {
    const identity = await this.prepareIdentity();
    return (
      await this.codec.sign({
        capabilityId: identity.capabilityId,
        kind: CapabilityKind.PublicationClaim,
        audience: CapabilityAudience.ReviewPublicationClaim,
        issuer: this.issuer,
        subject: permit.executionId,
        issuedAt,
        notBefore: issuedAt,
        ownershipExpiresAt: null,
        expiresAt: permit.publicationNotAfter,
        payload: {
          role: publicationRole,
          authorization_id: permit.authorizationId,
          execution_id: permit.executionId,
          generation: permit.generation.toString(10),
          review_revision_hash: permit.reviewRevisionHash,
          reviewed_head_sha: permit.reviewedHeadSha,
          projection_hash: permit.projectionHash,
          lifecycle_state_hash: permit.lifecycleStateHash,
          command_ledger_watermark: permit.commandLedgerWatermark.toString(10),
          permit_epoch: permit.permitEpoch.toString(10),
          publication_safety_hash: permit.publicationSafetyDecisionHash,
        },
      })
    ).token;
  }

  async verifyPublicationPermit(
    token: string,
    now: Date,
  ): Promise<VerifiedReviewActionV2PublicationPermit> {
    const claims = await this.codec.verify({
      token,
      expectedIssuer: this.issuer,
      expectedAudience: CapabilityAudience.ReviewPublicationClaim,
      expectedKind: CapabilityKind.PublicationClaim,
      now,
    });
    const payload = exactPayload(claims.payload, [
      "role",
      "authorization_id",
      "execution_id",
      "generation",
      "review_revision_hash",
      "reviewed_head_sha",
      "projection_hash",
      "lifecycle_state_hash",
      "command_ledger_watermark",
      "permit_epoch",
      "publication_safety_hash",
    ]);
    if (
      string(payload.role) !== publicationRole ||
      claims.subject !== string(payload.execution_id) ||
      claims.ownershipExpiresAt !== null
    ) {
      throw new Error("review_action_v2_publication_capability_claims_invalid");
    }
    return Object.freeze({
      capabilityId: claims.capabilityId,
      authorizationId: string(payload.authorization_id),
      executionId: string(payload.execution_id),
      generation: unsignedBigInt(payload.generation),
      reviewRevisionHash: sha256(payload.review_revision_hash),
      reviewedHeadSha: commitSha(payload.reviewed_head_sha),
      projectionHash: sha256(payload.projection_hash),
      lifecycleStateHash: sha256(payload.lifecycle_state_hash),
      commandLedgerWatermark: unsignedBigInt(payload.command_ledger_watermark),
      permitEpoch: unsignedBigInt(payload.permit_epoch),
      publicationSafetyDecisionHash: sha256(payload.publication_safety_hash),
      publicationNotAfter: new Date(claims.expiresAt),
    });
  }
}

function parseManifestPayload(
  payload: Readonly<Record<string, unknown>>,
): ProviderInvocationManifest {
  return {
    manifestVersion: integer(payload.manifest_version) as 1,
    scopeHash: sha256(payload.manifest_scope_hash),
    taskKindSet: string(payload.task_kinds).split(
      ",",
    ) as ProviderInvocationManifest["taskKindSet"],
    providerKind: string(
      payload.provider_kind,
    ) as ProviderInvocationManifest["providerKind"],
    providerCapabilityHash: sha256(payload.provider_capability_hash),
    requestedModel: string(payload.requested_model),
    providerPolicyVersion: string(payload.provider_policy_version),
    producerReleaseId: string(payload.producer_release_id),
    selectedProtocolVersion: string(payload.selected_protocol_version),
    providerRequestEnvelopeHash: sha256(payload.request_envelope_hash),
    outputSchemaHash: sha256(payload.output_schema_hash),
    reviewConfigHash: sha256(payload.review_config_hash),
    runtimeCompatibilityKey: sha256(payload.runtime_compatibility_key),
    filePatchManifestHash: sha256(payload.file_patch_manifest_hash),
    contextManifestHash: sha256(payload.context_manifest_hash),
    memoryBundleHash: nullableSha256(payload.memory_bundle_hash),
    codeGraphProjectionHash: nullableSha256(payload.code_graph_hash),
    lifecycleTargetSetHash: nullableSha256(payload.lifecycle_target_hash),
    liveLifecycleStateHash: nullableSha256(payload.live_lifecycle_hash),
    toolPolicyHash: sha256(payload.tool_policy_hash),
    executionProfile: string(
      payload.execution_profile,
    ) as ProviderInvocationManifest["executionProfile"],
    baseTreeHash: nullableSha256(payload.base_tree_hash),
    environmentContractHash: sha256(payload.environment_contract_hash),
  };
}

function exactPayload(
  payload: Readonly<Record<string, unknown>>,
  keys: readonly string[],
) {
  const actual = Object.keys(payload).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error("review_action_v2_capability_payload_shape_invalid");
  }
  return payload;
}

function string(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512)
    throw new Error("review_action_v2_capability_string_invalid");
  return value;
}
function sha256(value: unknown): string {
  const parsed = string(value);
  if (!/^[a-f0-9]{64}$/.test(parsed))
    throw new Error("review_action_v2_capability_hash_invalid");
  return parsed;
}
function nullableSha256(value: unknown): string | null {
  return value === nullValue ? null : sha256(value);
}
function nullableString(value: unknown): string | null {
  const parsed = string(value);
  return parsed === nullValue ? null : parsed;
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new Error("review_action_v2_capability_integer_invalid");
  return value;
}
function nonNegativeInteger(value: unknown): number {
  const parsed = integer(value);
  if (parsed < 0)
    throw new Error("review_action_v2_capability_integer_invalid");
  return parsed;
}
function unsignedBigInt(value: unknown): bigint {
  const parsed = string(value);
  if (!/^(0|[1-9][0-9]*)$/.test(parsed))
    throw new Error("review_action_v2_capability_decimal_invalid");
  return BigInt(parsed);
}
function commitSha(value: unknown): string {
  const parsed = string(value);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(parsed))
    throw new Error("review_action_v2_capability_commit_sha_invalid");
  return parsed;
}
function attachmentKind(
  value: unknown,
): ReviewActionV2ReusableAttachmentAuthority["attachmentKind"] {
  const parsed = string(value);
  if (!parsed.endsWith("reuse"))
    throw new Error("review_action_v2_attachment_kind_invalid");
  return parsed as ReviewActionV2ReusableAttachmentAuthority["attachmentKind"];
}
