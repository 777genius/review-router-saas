import {
  createReviewObservation,
  prepareReviewObservationPayload,
  reviewEvidenceMaxRetainMs,
  type ReviewObservation,
  type ReviewObservationPayload,
} from "../../domain/review-observation";
import { reviewReuseEligibilityPolicyVersion } from "../../domain/review-reuse-eligibility";
import {
  ReviewObservationQualityFlag,
  ReviewObservationStatus,
  ProviderExecutionProfile,
  assertEpochMilliseconds,
  assertIdentifier,
  assertSha256,
} from "../../domain/review-evidence-primitives";
import type { ClockPort } from "../ports/clock-port";
import {
  ContextAttestationVerificationStatus,
  type AcceptedContextAttestationVerificationPort,
} from "../ports/context-attestation-verification-port";
import {
  ReviewExecutionAttemptReportState,
  type ReviewExecutionAttemptFacts,
  type ReviewExecutionAttemptFactsPort,
} from "../ports/review-execution-attempt-facts-port";
import type { CurrentEvidenceWriteSafetyDecisionPort } from "../ports/review-evidence-safety-port";
import {
  ReviewObservationAcceptPersistenceStatus,
  type ReviewObservationCommandPort,
  type ReviewObservationIdentityPort,
} from "../ports/review-observation-ports";
import type { Sha256DigestPort } from "../ports/sha256-digest-port";
import {
  InvestigationCertificateConclusion,
  InvestigationCertificateVerificationStatus,
  type AcceptedInvestigationCertificateVerificationPort,
} from "../ports/investigation-certificate-verification-port";
import { buildProviderInvocationIdentity } from "./build-provider-invocation-identity";

export enum ProviderResultCompletionStatus {
  Success = "success",
  Timeout = "timeout",
  Cancelled = "cancelled",
  RateLimited = "rate_limited",
  Partial = "partial",
  Invalid = "invalid",
  Unknown = "unknown",
}

export enum AcceptReviewObservationStatus {
  Accepted = "accepted",
  Idempotent = "idempotent",
  Rejected = "rejected",
  Conflict = "conflict",
}

export enum AcceptReviewObservationRejectionReason {
  None = "none",
  AttemptNotFound = "attempt_not_found",
  AttemptAuthorityMismatch = "attempt_authority_mismatch",
  AttemptManifestMismatch = "attempt_manifest_mismatch",
  AttemptNotReportable = "attempt_not_reportable",
  ResultReportWindowExpired = "result_report_window_expired",
  EvidenceWritesDisabled = "evidence_writes_disabled",
  ResultNotReusableSuccess = "result_not_reusable_success",
  ContextAttestationNotAccepted = "context_attestation_not_accepted",
  InvestigationCertificatePathDisabled = "investigation_certificate_path_disabled",
  InvestigationCertificateReferenceInvalid = "investigation_certificate_reference_invalid",
  InvestigationCertificateNotAccepted = "investigation_certificate_not_accepted",
}

export type AcceptReviewObservationCommand = Readonly<{
  attemptId: string;
  leaseCapabilityId: string;
  sourceLeaseId: string;
  ownerIdHash: string;
  sourceFencingToken: string;
  completionStatus: ProviderResultCompletionStatus;
  schemaValidated: boolean;
  fullyConsumed: boolean;
  actualModel: string;
  payload: ReviewObservationPayload;
  qualityFlags: readonly ReviewObservationQualityFlag[];
  transportAttemptCount: number;
  contextDependencyAttestationId: string | null;
  contextDependencyAttestationHash: string | null;
  investigationCertificateId: string | null;
  investigationCertificateHash: string | null;
}>;

export type AcceptReviewObservationResult = Readonly<{
  status: AcceptReviewObservationStatus;
  reason: AcceptReviewObservationRejectionReason;
  observation?: ReviewObservation;
  historicalOnly?: boolean;
  eligibilityPolicyVersion?: string;
}>;

export class AcceptReviewObservation {
  constructor(
    private readonly dependencies: Readonly<{
      attempts: ReviewExecutionAttemptFactsPort;
      safety: CurrentEvidenceWriteSafetyDecisionPort;
      observations: ReviewObservationCommandPort;
      identities: ReviewObservationIdentityPort;
      contextAttestations: AcceptedContextAttestationVerificationPort;
      investigationCertificates: AcceptedInvestigationCertificateVerificationPort;
      investigationCertificateAcceptanceEnabled: boolean;
      digest: Sha256DigestPort;
      clock: ClockPort;
      reuseTtlMs: number;
      retainTtlMs: number;
    }>,
  ) {
    validateRetention(dependencies.reuseTtlMs, dependencies.retainTtlMs);
  }

  async execute(
    command: AcceptReviewObservationCommand,
  ): Promise<AcceptReviewObservationResult> {
    assertIdentifier(command.attemptId, "attempt_id");
    assertIdentifier(command.leaseCapabilityId, "lease_capability_id");
    const facts = await this.dependencies.attempts.findAttemptFacts({
      attemptId: command.attemptId,
      leaseCapabilityId: command.leaseCapabilityId,
    });
    if (!facts)
      return rejected(AcceptReviewObservationRejectionReason.AttemptNotFound);
    if (!matchesReportAuthority(facts, command)) {
      return rejected(
        AcceptReviewObservationRejectionReason.AttemptAuthorityMismatch,
      );
    }
    const canonicalIdentity = await buildProviderInvocationIdentity(
      this.dependencies.digest,
      {
        manifest: facts.manifest,
        providerVoteIdentityHash: facts.providerVoteIdentityHash,
      },
    );
    if (
      canonicalIdentity.manifestKey !== facts.manifestKey ||
      canonicalIdentity.providerInvocationKey !== facts.providerInvocationKey
    ) {
      return rejected(
        AcceptReviewObservationRejectionReason.AttemptManifestMismatch,
      );
    }
    if (!isAcceptableReportState(facts.reportState)) {
      return rejected(
        AcceptReviewObservationRejectionReason.AttemptNotReportable,
      );
    }
    const nowMs = this.dependencies.clock.nowMs();
    assertEpochMilliseconds(nowMs, "now_ms");
    if (facts.resultReportUntilMs <= nowMs) {
      return rejected(
        AcceptReviewObservationRejectionReason.ResultReportWindowExpired,
      );
    }
    if (
      command.completionStatus !== ProviderResultCompletionStatus.Success ||
      !command.schemaValidated ||
      !command.fullyConsumed
    ) {
      return rejected(
        AcceptReviewObservationRejectionReason.ResultNotReusableSuccess,
      );
    }
    const safetyDecision =
      await this.dependencies.safety.resolveEvidenceWriteDecision({
        scope: facts.scope,
        providerKind: facts.providerKind,
        taskKindSet: facts.taskKindSet,
      });
    assertSha256(safetyDecision.safetyDecisionHash, "safety_decision_hash");
    if (!safetyDecision.effectAllowed) {
      return rejected(
        AcceptReviewObservationRejectionReason.EvidenceWritesDisabled,
      );
    }
    const preparedPayload = prepareReviewObservationPayload(command.payload);
    const payloadHash = await this.dependencies.digest.digest(
      preparedPayload.canonicalBytes,
    );
    assertSha256(payloadHash, "payload_hash");
    if (
      facts.executionProfile === ProviderExecutionProfile.InvestigationGatewayV1
    ) {
      if (!this.dependencies.investigationCertificateAcceptanceEnabled) {
        return rejected(
          AcceptReviewObservationRejectionReason.InvestigationCertificatePathDisabled,
        );
      }
      const certificateAccepted = await verifyInvestigationCertificate(
        this.dependencies.investigationCertificates,
        facts,
        command,
        preparedPayload.payload.normalizedFindings.length,
        payloadHash,
        nowMs,
      );
      if (certificateAccepted !== AcceptReviewObservationRejectionReason.None) {
        return rejected(certificateAccepted);
      }
    } else {
      if (
        command.investigationCertificateId !== null ||
        command.investigationCertificateHash !== null
      ) {
        return rejected(
          AcceptReviewObservationRejectionReason.InvestigationCertificateReferenceInvalid,
        );
      }
      const attestationAccepted = await verifyContextAttestation(
        this.dependencies.contextAttestations,
        facts,
        command,
        payloadHash,
        nowMs,
      );
      if (!attestationAccepted) {
        return rejected(
          AcceptReviewObservationRejectionReason.ContextAttestationNotAccepted,
        );
      }
    }
    const observation = createReviewObservation({
      observationId: this.dependencies.identities.nextObservationId(),
      scope: facts.scope,
      manifestKey: facts.manifestKey,
      providerInvocationKey: facts.providerInvocationKey,
      providerVoteIdentityHash: facts.providerVoteIdentityHash,
      manifestVersion: facts.manifest.manifestVersion,
      taskKindSet: facts.taskKindSet,
      sourceRevision: facts.revision,
      sourcePlanHash: facts.planHash,
      sourceExecutionId: facts.sourceExecutionId,
      sourceWorkSlotId: facts.sourceWorkSlotId,
      sourceAuthorizationId: facts.sourceAuthorizationId,
      evidenceWriteSafetyDecisionHash: safetyDecision.safetyDecisionHash,
      sourceRunId: facts.sourceRunId,
      sourceRunAttempt: facts.sourceRunAttempt,
      providerKind: facts.providerKind,
      requestedModel: facts.requestedModel,
      actualModel: command.actualModel,
      providerRuntimeVersion: facts.providerRuntimeVersion,
      producerReleaseId: facts.producerReleaseId,
      selectedProtocolVersion: facts.selectedProtocolVersion,
      trustedCapabilityProfile: facts.trustedCapabilityProfile,
      executionProfile: facts.executionProfile,
      attemptId: facts.attemptId,
      sourceLeaseId: facts.sourceLeaseId,
      sourceFencingToken: facts.sourceFencingToken,
      status: ReviewObservationStatus.Success,
      payload: preparedPayload.payload,
      payloadHash,
      byteCount: preparedPayload.byteCount,
      findingCount: preparedPayload.findingCount,
      qualityFlags: command.qualityFlags,
      transportAttemptCount: command.transportAttemptCount,
      contextDependencyAttestationId: command.contextDependencyAttestationId,
      contextDependencyAttestationHash:
        command.contextDependencyAttestationHash,
      investigationCertificateId: command.investigationCertificateId,
      investigationCertificateHash: command.investigationCertificateHash,
      trustDomain: facts.trustDomain,
      createdAtMs: nowMs,
      reuseExpiresAtMs: nowMs + this.dependencies.reuseTtlMs,
      retainUntilMs: nowMs + this.dependencies.retainTtlMs,
    });
    const persistence =
      await this.dependencies.observations.acceptObservation(observation);
    switch (persistence.status) {
      case ReviewObservationAcceptPersistenceStatus.Accepted:
        return Object.freeze({
          status: AcceptReviewObservationStatus.Accepted,
          reason: AcceptReviewObservationRejectionReason.None,
          observation: persistence.observation,
          eligibilityPolicyVersion: reviewReuseEligibilityPolicyVersion,
          historicalOnly:
            facts.reportState ===
            ReviewExecutionAttemptReportState.SupersededHistoricalOnly,
        });
      case ReviewObservationAcceptPersistenceStatus.Idempotent:
        return Object.freeze({
          status: AcceptReviewObservationStatus.Idempotent,
          reason: AcceptReviewObservationRejectionReason.None,
          observation: persistence.observation,
          eligibilityPolicyVersion: reviewReuseEligibilityPolicyVersion,
          historicalOnly:
            facts.reportState ===
            ReviewExecutionAttemptReportState.SupersededHistoricalOnly,
        });
      case ReviewObservationAcceptPersistenceStatus.Conflict:
        return Object.freeze({
          status: AcceptReviewObservationStatus.Conflict,
          reason: AcceptReviewObservationRejectionReason.None,
        });
    }
  }
}

async function verifyInvestigationCertificate(
  certificates: AcceptedInvestigationCertificateVerificationPort,
  facts: ReviewExecutionAttemptFacts,
  command: AcceptReviewObservationCommand,
  findingCount: number,
  terminalOutcomeHash: string,
  nowMs: number,
): Promise<AcceptReviewObservationRejectionReason> {
  if (
    command.contextDependencyAttestationId !== null ||
    command.contextDependencyAttestationHash !== null ||
    (command.investigationCertificateId === null) !==
      (command.investigationCertificateHash === null) ||
    command.investigationCertificateId === null ||
    command.investigationCertificateHash === null
  ) {
    return AcceptReviewObservationRejectionReason.InvestigationCertificateReferenceInvalid;
  }
  const inconclusive = command.qualityFlags.includes(
    ReviewObservationQualityFlag.InvestigationInconclusive,
  );
  const findings = command.qualityFlags.includes(
    ReviewObservationQualityFlag.InvestigationFindings,
  );
  if (
    findingCount > 0 !== findings ||
    (inconclusive && findings && findingCount === 0)
  ) {
    return AcceptReviewObservationRejectionReason.InvestigationCertificateReferenceInvalid;
  }
  const expectedConclusion = inconclusive
    ? InvestigationCertificateConclusion.Inconclusive
    : findingCount > 0
      ? InvestigationCertificateConclusion.Findings
      : InvestigationCertificateConclusion.VerifiedClean;
  const decision = await certificates.verifyAcceptedCertificate({
    certificateId: command.investigationCertificateId,
    certificateHash: command.investigationCertificateHash,
    scope: facts.scope,
    revision: facts.revision,
    providerVoteIdentityHash: facts.providerVoteIdentityHash,
    terminalOutcomeHash,
    expectedConclusion,
    producerReleaseId: facts.producerReleaseId,
    nowMs,
  });
  return decision.status ===
    InvestigationCertificateVerificationStatus.Accepted &&
    decision.acceptedCertificateHash === command.investigationCertificateHash &&
    decision.conclusion === expectedConclusion
    ? AcceptReviewObservationRejectionReason.None
    : AcceptReviewObservationRejectionReason.InvestigationCertificateNotAccepted;
}

async function verifyContextAttestation(
  attestations: AcceptedContextAttestationVerificationPort,
  facts: ReviewExecutionAttemptFacts,
  command: AcceptReviewObservationCommand,
  terminalOutcomeHash: string,
  nowMs: number,
): Promise<boolean> {
  const attestationId = command.contextDependencyAttestationId;
  const attestationHash = command.contextDependencyAttestationHash;
  const hasId = attestationId !== null;
  const hasHash = attestationHash !== null;
  if (hasId !== hasHash) return false;
  if (facts.executionProfile !== ProviderExecutionProfile.ContextGatewayV1) {
    return !hasId;
  }
  if (attestationId === null || attestationHash === null) return false;
  assertIdentifier(attestationId, "context_dependency_attestation_id");
  assertSha256(attestationHash, "context_dependency_attestation_hash");
  const decision = await attestations.verifyAcceptedAttestation({
    attestationId,
    attestationHash,
    sourceExecutionId: facts.sourceExecutionId,
    sourceWorkSlotId: facts.sourceWorkSlotId,
    attemptId: facts.attemptId,
    sourceLeaseId: facts.sourceLeaseId,
    sourceFencingToken: facts.sourceFencingToken,
    sourceRevision: facts.revision,
    executionProfile: facts.executionProfile,
    trustedCapabilityProfile: facts.trustedCapabilityProfile,
    actualModel: command.actualModel,
    terminalOutcomeHash,
    nowMs,
  });
  return (
    decision.status === ContextAttestationVerificationStatus.Accepted &&
    decision.acceptedAttestationHash === attestationHash
  );
}

function matchesReportAuthority(
  facts: ReviewExecutionAttemptFacts,
  command: AcceptReviewObservationCommand,
): boolean {
  return (
    facts.attemptId === command.attemptId &&
    facts.leaseCapabilityId === command.leaseCapabilityId &&
    facts.sourceLeaseId === command.sourceLeaseId &&
    facts.ownerIdHash === command.ownerIdHash &&
    facts.sourceFencingToken === command.sourceFencingToken
  );
}

function isAcceptableReportState(
  state: ReviewExecutionAttemptReportState,
): boolean {
  return (
    state === ReviewExecutionAttemptReportState.Reportable ||
    state === ReviewExecutionAttemptReportState.SupersededHistoricalOnly
  );
}

function validateRetention(reuseTtlMs: number, retainTtlMs: number): void {
  if (
    !Number.isSafeInteger(reuseTtlMs) ||
    reuseTtlMs <= 0 ||
    !Number.isSafeInteger(retainTtlMs) ||
    retainTtlMs < reuseTtlMs ||
    retainTtlMs > reviewEvidenceMaxRetainMs
  ) {
    throw new Error("review_evidence_retention_policy_invalid");
  }
}

function rejected(
  reason: AcceptReviewObservationRejectionReason,
): AcceptReviewObservationResult {
  return Object.freeze({
    status: AcceptReviewObservationStatus.Rejected,
    reason,
  });
}
