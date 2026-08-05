import {
  AcceptedContextAttestationVerificationReason,
  AcceptedContextAttestationVerificationStatus,
  VerifyAcceptedContextAttestation,
  ContextLeaseAuthorityKind,
} from "@reviewrouter/features-review-context-attestation";
import {
  ContextAttestationVerificationDenialReason,
  ContextAttestationVerificationStatus,
  ProviderExecutionProfile,
  type AcceptedContextAttestationVerificationPort,
  type ContextAttestationVerificationDecision,
  type VerifyAcceptedContextAttestationQuery,
} from "@reviewrouter/features-review-evidence";

export class ReviewContextAttestationEvidenceAdapter implements AcceptedContextAttestationVerificationPort {
  constructor(private readonly verifier: VerifyAcceptedContextAttestation) {}

  async verifyAcceptedAttestation(
    query: VerifyAcceptedContextAttestationQuery,
  ): Promise<ContextAttestationVerificationDecision> {
    if (query.executionProfile !== ProviderExecutionProfile.ContextGatewayV1) {
      return denied(
        ContextAttestationVerificationDenialReason.SourceBindingMismatch,
      );
    }
    const result = await this.verifier.execute({
      attestationId: query.attestationId,
      attestationHash: query.attestationHash,
      sourceExecutionId: query.sourceExecutionId,
      sourceWorkSlotId: query.sourceWorkSlotId,
      attemptId: query.attemptId,
      sourceLeaseAuthorityKind: ContextLeaseAuthorityKind.StandardExecution,
      sourceLeaseId: query.sourceLeaseId,
      sourceFencingToken: query.sourceFencingToken,
      sourceReviewRevisionHash: query.sourceRevision.reviewRevisionHash,
      trustedCapabilityProfile: query.trustedCapabilityProfile,
      actualModel: query.actualModel,
      terminalOutcomeHash: query.terminalOutcomeHash,
    });
    if (
      result.status === AcceptedContextAttestationVerificationStatus.Accepted
    ) {
      return Object.freeze({
        status: ContextAttestationVerificationStatus.Accepted,
        reason: ContextAttestationVerificationDenialReason.None,
        acceptedAttestationHash: result.acceptedAttestationHash,
      });
    }
    return denied(mapDenialReason(result.reason));
  }
}

function mapDenialReason(
  reason: AcceptedContextAttestationVerificationReason,
): ContextAttestationVerificationDenialReason {
  switch (reason) {
    case AcceptedContextAttestationVerificationReason.None:
      return ContextAttestationVerificationDenialReason.None;
    case AcceptedContextAttestationVerificationReason.NotFound:
      return ContextAttestationVerificationDenialReason.NotFound;
    case AcceptedContextAttestationVerificationReason.Expired:
      return ContextAttestationVerificationDenialReason.Expired;
    case AcceptedContextAttestationVerificationReason.HashMismatch:
      return ContextAttestationVerificationDenialReason.HashMismatch;
    case AcceptedContextAttestationVerificationReason.SourceBindingMismatch:
      return ContextAttestationVerificationDenialReason.SourceBindingMismatch;
    case AcceptedContextAttestationVerificationReason.CapabilityProfileMismatch:
      return ContextAttestationVerificationDenialReason.CapabilityProfileMismatch;
    case AcceptedContextAttestationVerificationReason.ActualModelMismatch:
      return ContextAttestationVerificationDenialReason.ActualModelMismatch;
    case AcceptedContextAttestationVerificationReason.TerminalOutcomeMismatch:
      return ContextAttestationVerificationDenialReason.TerminalOutcomeMismatch;
  }
}

function denied(
  reason: ContextAttestationVerificationDenialReason,
): ContextAttestationVerificationDecision {
  return Object.freeze({
    status: ContextAttestationVerificationStatus.Denied,
    reason,
    acceptedAttestationHash: null,
  });
}
