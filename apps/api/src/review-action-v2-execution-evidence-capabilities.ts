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
const investigationTurnRole = "review_investigation_turn_v1";
const attachmentRole = "review_evidence_attachment_v1";
const contextGatewaySealRole = "review_context_gateway_seal_v1";
const contextReplayRole = "review_context_replay_v1";
const investigationReceiptReplayRole =
  "review_investigation_receipt_replay_v1";
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

export type ReviewActionV2InvestigationTurnAuthority = Readonly<{
  authorizationId: string;
  executionId: string;
  workSlotId: string;
  reviewRevisionHash: string;
  investigationId: string;
  investigationVersion: number;
  dossierDigest: string;
  turnId: string;
  expiresAt: Date;
}>;

export type VerifiedReviewActionV2InvestigationTurnCapability =
  ReviewActionV2InvestigationTurnAuthority &
    Readonly<{ capabilityId: string }>;

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
  contextReplayProofId?: string | null;
  contextReplayProofHash?: string | null;
  contextAttestationId?: string | null;
  contextAttestationHash?: string | null;
  targetCheckoutTreeOid?: string | null;
  replayBinaryHash?: string | null;
  replayPolicyVersion?: string | null;
  expiresAt: Date;
}>;

export type ReviewActionV2ContextGatewaySealAuthority = Readonly<{
  capabilityId?: string;
  authorizationId: string;
  mutationEpoch: bigint;
  scopeHash: string;
  sessionId: string;
  sourceExecutionId: string;
  sourceWorkSlotId: string;
  attemptId: string;
  sourceLeaseId: string;
  sourceFencingToken: string;
  sourceReviewRevisionHash: string;
  checkoutTreeOid: string;
  gatewayPolicyVersion: string;
  gatewayBinaryHash: string;
  confinementEvidenceHash: string;
  expiresAt: Date;
}>;

export type ReviewActionV2ContextReplayAuthority = Readonly<{
  capabilityId?: string;
  attestationId: string;
  attestationHash: string;
  contextReplayPlanHash: string;
  targetCheckoutTreeOid: string;
  gatewayPolicyVersion: string;
  gatewayBinaryHash: string;
  reusePolicyVectorHash: string;
  attachment: ReviewActionV2ReusableAttachmentAuthority;
  expiresAt: Date;
}>;

export type ReviewActionV2InvestigationReceiptReplayAuthority = Readonly<{
  capabilityId?: string;
  sourceCertificateId: string;
  sourceCertificateHash: string;
  attestationId: string;
  attestationHash: string;
  sourceOperationReceiptIds: readonly string[];
  sourceOperationReceiptIdsHash: string;
  contextReplayPlanHash: string;
  targetExecutionId: string;
  targetWorkSlotId: string;
  targetReviewRevisionHash: string;
  targetCheckoutTreeOid: string;
  gatewayPolicyVersion: string;
  gatewayBinaryHash: string;
  reusePolicyVectorHash: string;
  providerKind: ProviderInvocationManifest["providerKind"];
  taskKindSet: ProviderInvocationManifest["taskKindSet"];
  producerReleaseId: string;
  requestedModel: string;
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

  async issueInvestigationTurn(
    authority: ReviewActionV2InvestigationTurnAuthority,
    issuedAt: Date,
  ): Promise<string> {
    const identity = await this.prepareIdentity();
    const signed = await this.codec.sign({
      capabilityId: identity.capabilityId,
      kind: CapabilityKind.InvocationLease,
      audience: CapabilityAudience.ReviewInvocationLease,
      issuer: this.issuer,
      subject: authority.turnId,
      issuedAt,
      notBefore: issuedAt,
      ownershipExpiresAt: authority.expiresAt,
      expiresAt: authority.expiresAt,
      payload: {
        role: investigationTurnRole,
        authorization_id: authority.authorizationId,
        execution_id: authority.executionId,
        work_slot_id: authority.workSlotId,
        review_revision_hash: authority.reviewRevisionHash,
        investigation_id: authority.investigationId,
        investigation_version: String(authority.investigationVersion),
        dossier_digest: authority.dossierDigest,
        turn_id: authority.turnId,
      },
    });
    return signed.token;
  }

  async verifyInvestigationTurn(
    token: string,
    now: Date,
  ): Promise<VerifiedReviewActionV2InvestigationTurnCapability> {
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
      "execution_id",
      "work_slot_id",
      "review_revision_hash",
      "investigation_id",
      "investigation_version",
      "dossier_digest",
      "turn_id",
    ]);
    if (
      string(payload.role) !== investigationTurnRole ||
      claims.subject !== string(payload.turn_id) ||
      claims.ownershipExpiresAt === null
    ) {
      throw new Error("review_action_v2_investigation_turn_claims_invalid");
    }
    const version = Number(string(payload.investigation_version));
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new Error("review_action_v2_investigation_turn_version_invalid");
    }
    return Object.freeze({
      capabilityId: claims.capabilityId,
      authorizationId: string(payload.authorization_id),
      executionId: string(payload.execution_id),
      workSlotId: string(payload.work_slot_id),
      reviewRevisionHash: sha256(payload.review_revision_hash),
      investigationId: string(payload.investigation_id),
      investigationVersion: version,
      dossierDigest: sha256(payload.dossier_digest),
      turnId: string(payload.turn_id),
      expiresAt: new Date(claims.expiresAt),
    });
  }

  async issueReusableAttachment(
    authority: ReviewActionV2ReusableAttachmentAuthority,
    issuedAt: Date,
  ): Promise<string> {
    const identity = await this.prepareIdentity();
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
      payload: attachmentPayload(attachmentRole, authority),
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
      capabilityId: claims.capabilityId,
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
      contextReplayProofId: nullableString(
        payload.context_replay_proof_id ?? nullValue,
      ),
      contextReplayProofHash: nullableSha256(
        payload.context_replay_proof_hash ?? nullValue,
      ),
      contextAttestationId: nullableString(
        payload.context_attestation_id ?? nullValue,
      ),
      contextAttestationHash: nullableSha256(
        payload.context_attestation_hash ?? nullValue,
      ),
      targetCheckoutTreeOid: nullableCommitSha(
        payload.target_checkout_tree_oid ?? nullValue,
      ),
      replayBinaryHash: nullableSha256(payload.replay_binary_hash ?? nullValue),
      replayPolicyVersion: nullableString(
        payload.replay_policy_version ?? nullValue,
      ),
      expiresAt: new Date(claims.expiresAt),
    });
  }

  async issueContextGatewaySeal(
    authority: ReviewActionV2ContextGatewaySealAuthority,
    issuedAt: Date,
  ): Promise<string> {
    const identity = await this.prepareIdentity();
    return (
      await this.codec.sign({
        capabilityId: identity.capabilityId,
        kind: CapabilityKind.InvocationLease,
        audience: CapabilityAudience.ReviewInvocationLease,
        issuer: this.issuer,
        subject: authority.sessionId,
        issuedAt,
        notBefore: issuedAt,
        ownershipExpiresAt: authority.expiresAt,
        expiresAt: authority.expiresAt,
        payload: {
          role: contextGatewaySealRole,
          authorization_id: authority.authorizationId,
          mutation_epoch: authority.mutationEpoch.toString(10),
          scope_hash: authority.scopeHash,
          session_id: authority.sessionId,
          source_execution_id: authority.sourceExecutionId,
          source_work_slot_id: authority.sourceWorkSlotId,
          attempt_id: authority.attemptId,
          source_lease_id: authority.sourceLeaseId,
          source_fencing_token: authority.sourceFencingToken,
          source_revision_hash: authority.sourceReviewRevisionHash,
          checkout_tree_oid: authority.checkoutTreeOid,
          gateway_policy_version: authority.gatewayPolicyVersion,
          gateway_binary_hash: authority.gatewayBinaryHash,
          confinement_evidence_hash: authority.confinementEvidenceHash,
        },
      })
    ).token;
  }

  async verifyContextGatewaySeal(
    token: string,
    now: Date,
  ): Promise<ReviewActionV2ContextGatewaySealAuthority> {
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
      "mutation_epoch",
      "scope_hash",
      "session_id",
      "source_execution_id",
      "source_work_slot_id",
      "attempt_id",
      "source_lease_id",
      "source_fencing_token",
      "source_revision_hash",
      "checkout_tree_oid",
      "gateway_policy_version",
      "gateway_binary_hash",
      "confinement_evidence_hash",
    ]);
    if (
      string(payload.role) !== contextGatewaySealRole ||
      claims.subject !== string(payload.session_id) ||
      claims.ownershipExpiresAt === null
    ) {
      throw new Error("review_context_gateway_seal_capability_claims_invalid");
    }
    return Object.freeze({
      capabilityId: claims.capabilityId,
      authorizationId: string(payload.authorization_id),
      mutationEpoch: unsignedBigInt(payload.mutation_epoch),
      scopeHash: sha256(payload.scope_hash),
      sessionId: string(payload.session_id),
      sourceExecutionId: string(payload.source_execution_id),
      sourceWorkSlotId: string(payload.source_work_slot_id),
      attemptId: string(payload.attempt_id),
      sourceLeaseId: string(payload.source_lease_id),
      sourceFencingToken: unsignedBigInt(payload.source_fencing_token).toString(
        10,
      ),
      sourceReviewRevisionHash: sha256(payload.source_revision_hash),
      checkoutTreeOid: commitSha(payload.checkout_tree_oid),
      gatewayPolicyVersion: string(payload.gateway_policy_version),
      gatewayBinaryHash: sha256(payload.gateway_binary_hash),
      confinementEvidenceHash: sha256(payload.confinement_evidence_hash),
      expiresAt: new Date(claims.expiresAt),
    });
  }

  async issueContextReplay(
    authority: ReviewActionV2ContextReplayAuthority,
    issuedAt: Date,
  ): Promise<string> {
    const identity = await this.prepareIdentity();
    return (
      await this.codec.sign({
        capabilityId: identity.capabilityId,
        kind: CapabilityKind.InvocationLease,
        audience: CapabilityAudience.ReviewInvocationLease,
        issuer: this.issuer,
        subject: authority.attestationId,
        issuedAt,
        notBefore: issuedAt,
        ownershipExpiresAt: null,
        expiresAt: authority.expiresAt,
        payload: {
          ...attachmentPayload(contextReplayRole, authority.attachment),
          attestation_id: authority.attestationId,
          attestation_hash: authority.attestationHash,
          context_replay_plan_hash: authority.contextReplayPlanHash,
          target_checkout_tree_oid: authority.targetCheckoutTreeOid,
          gateway_policy_version: authority.gatewayPolicyVersion,
          gateway_binary_hash: authority.gatewayBinaryHash,
          reuse_policy_vector_hash: authority.reusePolicyVectorHash,
        },
      })
    ).token;
  }

  async verifyContextReplay(
    token: string,
    now: Date,
  ): Promise<ReviewActionV2ContextReplayAuthority> {
    const claims = await this.codec.verify({
      token,
      expectedIssuer: this.issuer,
      expectedAudience: CapabilityAudience.ReviewInvocationLease,
      expectedKind: CapabilityKind.InvocationLease,
      now,
    });
    const payload = claims.payload;
    if (
      payload.role !== contextReplayRole ||
      claims.subject !== payload.attestation_id ||
      claims.ownershipExpiresAt !== null
    ) {
      throw new Error("review_context_replay_capability_claims_invalid");
    }
    const attachment = attachmentAuthorityFromPayload(
      payload,
      new Date(claims.expiresAt),
    );
    return Object.freeze({
      capabilityId: claims.capabilityId,
      attestationId: string(payload.attestation_id),
      attestationHash: sha256(payload.attestation_hash),
      contextReplayPlanHash: sha256(payload.context_replay_plan_hash),
      targetCheckoutTreeOid: commitSha(payload.target_checkout_tree_oid),
      gatewayPolicyVersion: string(payload.gateway_policy_version),
      gatewayBinaryHash: sha256(payload.gateway_binary_hash),
      reusePolicyVectorHash: sha256(payload.reuse_policy_vector_hash),
      attachment,
      expiresAt: new Date(claims.expiresAt),
    });
  }

  async issueInvestigationReceiptReplay(
    authority: ReviewActionV2InvestigationReceiptReplayAuthority,
    issuedAt: Date,
  ): Promise<string> {
    const identity = await this.prepareIdentity();
    return (
      await this.codec.sign({
        capabilityId: identity.capabilityId,
        kind: CapabilityKind.InvocationLease,
        audience: CapabilityAudience.ReviewInvocationLease,
        issuer: this.issuer,
        subject: authority.attestationId,
        issuedAt,
        notBefore: issuedAt,
        ownershipExpiresAt: null,
        expiresAt: authority.expiresAt,
        payload: {
          role: investigationReceiptReplayRole,
          source_certificate_id: authority.sourceCertificateId,
          source_certificate_hash: authority.sourceCertificateHash,
          attestation_id: authority.attestationId,
          attestation_hash: authority.attestationHash,
          source_operation_receipt_ids_json: JSON.stringify(
            authority.sourceOperationReceiptIds,
          ),
          source_operation_receipt_ids_hash:
            authority.sourceOperationReceiptIdsHash,
          context_replay_plan_hash: authority.contextReplayPlanHash,
          target_execution_id: authority.targetExecutionId,
          target_work_slot_id: authority.targetWorkSlotId,
          target_review_revision_hash: authority.targetReviewRevisionHash,
          target_checkout_tree_oid: authority.targetCheckoutTreeOid,
          gateway_policy_version: authority.gatewayPolicyVersion,
          gateway_binary_hash: authority.gatewayBinaryHash,
          reuse_policy_vector_hash: authority.reusePolicyVectorHash,
          provider_kind: authority.providerKind,
          task_kinds: authority.taskKindSet.join(","),
          producer_release_id: authority.producerReleaseId,
          requested_model: authority.requestedModel,
        },
      })
    ).token;
  }

  async verifyInvestigationReceiptReplay(
    token: string,
    now: Date,
  ): Promise<ReviewActionV2InvestigationReceiptReplayAuthority> {
    const claims = await this.codec.verify({
      token,
      expectedIssuer: this.issuer,
      expectedAudience: CapabilityAudience.ReviewInvocationLease,
      expectedKind: CapabilityKind.InvocationLease,
      now,
    });
    const payload = claims.payload;
    if (
      payload.role !== investigationReceiptReplayRole ||
      claims.subject !== payload.attestation_id ||
      claims.ownershipExpiresAt !== null
    ) {
      throw new Error(
        "review_investigation_receipt_replay_capability_claims_invalid",
      );
    }
    const sourceOperationReceiptIds = parseSha256ArrayJson(
      payload.source_operation_receipt_ids_json,
    );
    return Object.freeze({
      capabilityId: claims.capabilityId,
      sourceCertificateId: string(payload.source_certificate_id),
      sourceCertificateHash: sha256(payload.source_certificate_hash),
      attestationId: string(payload.attestation_id),
      attestationHash: sha256(payload.attestation_hash),
      sourceOperationReceiptIds,
      sourceOperationReceiptIdsHash: sha256(
        payload.source_operation_receipt_ids_hash,
      ),
      contextReplayPlanHash: sha256(payload.context_replay_plan_hash),
      targetExecutionId: string(payload.target_execution_id),
      targetWorkSlotId: string(payload.target_work_slot_id),
      targetReviewRevisionHash: sha256(payload.target_review_revision_hash),
      targetCheckoutTreeOid: commitSha(payload.target_checkout_tree_oid),
      gatewayPolicyVersion: string(payload.gateway_policy_version),
      gatewayBinaryHash: sha256(payload.gateway_binary_hash),
      reusePolicyVectorHash: sha256(payload.reuse_policy_vector_hash),
      providerKind: string(
        payload.provider_kind,
      ) as ProviderInvocationManifest["providerKind"],
      taskKindSet: string(payload.task_kinds).split(
        ",",
      ) as ProviderInvocationManifest["taskKindSet"],
      producerReleaseId: string(payload.producer_release_id),
      requestedModel: string(payload.requested_model),
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

function attachmentPayload(
  role: string,
  authority: ReviewActionV2ReusableAttachmentAuthority,
) {
  const manifest = authority.manifest;
  return {
    role,
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
    context_replay_proof_id: authority.contextReplayProofId ?? nullValue,
    context_replay_proof_hash: authority.contextReplayProofHash ?? nullValue,
    context_attestation_id: authority.contextAttestationId ?? nullValue,
    context_attestation_hash: authority.contextAttestationHash ?? nullValue,
    target_checkout_tree_oid: authority.targetCheckoutTreeOid ?? nullValue,
    replay_binary_hash: authority.replayBinaryHash ?? nullValue,
    replay_policy_version: authority.replayPolicyVersion ?? nullValue,
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
  };
}

function attachmentAuthorityFromPayload(
  payload: Readonly<Record<string, unknown>>,
  expiresAt: Date,
): ReviewActionV2ReusableAttachmentAuthority {
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
    manifest: parseManifestPayload(payload),
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
    contextReplayProofId: nullableString(
      payload.context_replay_proof_id ?? nullValue,
    ),
    contextReplayProofHash: nullableSha256(
      payload.context_replay_proof_hash ?? nullValue,
    ),
    contextAttestationId: nullableString(
      payload.context_attestation_id ?? nullValue,
    ),
    contextAttestationHash: nullableSha256(
      payload.context_attestation_hash ?? nullValue,
    ),
    targetCheckoutTreeOid: nullableCommitSha(
      payload.target_checkout_tree_oid ?? nullValue,
    ),
    replayBinaryHash: nullableSha256(payload.replay_binary_hash ?? nullValue),
    replayPolicyVersion: nullableString(
      payload.replay_policy_version ?? nullValue,
    ),
    expiresAt,
  });
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
function parseSha256ArrayJson(value: unknown): readonly string[] {
  if (
    typeof value !== "string" ||
    value.length < 4 ||
    value.length > 128 * 1024
  ) {
    throw new Error("review_action_v2_capability_hash_array_invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("review_action_v2_capability_hash_array_invalid");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.length > 2_000 ||
    parsed.some((entry) => typeof entry !== "string" || !/^[a-f0-9]{64}$/.test(entry)) ||
    new Set(parsed).size !== parsed.length ||
    JSON.stringify([...parsed].sort()) !== value
  ) {
    throw new Error("review_action_v2_capability_hash_array_invalid");
  }
  return Object.freeze([...parsed]);
}
function nullableSha256(value: unknown): string | null {
  return value === nullValue ? null : sha256(value);
}
function nullableCommitSha(value: unknown): string | null {
  return value === nullValue ? null : commitSha(value);
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
