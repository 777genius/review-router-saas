import type {
  ContextAttestationClockPort,
  ContextAttestationStorePort,
} from "../ports/context-attestation-ports";

export enum AcceptedContextAttestationVerificationStatus {
  Accepted = "accepted",
  Denied = "denied",
}

export enum AcceptedContextAttestationVerificationReason {
  None = "none",
  NotFound = "not_found",
  Expired = "expired",
  HashMismatch = "hash_mismatch",
  SourceBindingMismatch = "source_binding_mismatch",
  CapabilityProfileMismatch = "capability_profile_mismatch",
  ActualModelMismatch = "actual_model_mismatch",
  TerminalOutcomeMismatch = "terminal_outcome_mismatch",
}

export type VerifyAcceptedContextAttestationQuery = Readonly<{
  attestationId: string;
  attestationHash: string;
  sourceExecutionId: string;
  sourceWorkSlotId: string;
  attemptId: string;
  sourceLeaseId: string;
  sourceFencingToken: string;
  sourceReviewRevisionHash: string;
  trustedCapabilityProfile: string;
  actualModel: string;
  terminalOutcomeHash: string;
}>;

export type VerifyAcceptedContextAttestationResult = Readonly<{
  status: AcceptedContextAttestationVerificationStatus;
  reason: AcceptedContextAttestationVerificationReason;
  acceptedAttestationHash: string | null;
}>;

export class VerifyAcceptedContextAttestation {
  constructor(
    private readonly dependencies: Readonly<{
      store: ContextAttestationStorePort;
      clock: ContextAttestationClockPort;
    }>,
  ) {}

  async execute(
    query: VerifyAcceptedContextAttestationQuery,
  ): Promise<VerifyAcceptedContextAttestationResult> {
    const attestation = await this.dependencies.store.findAcceptedAttestation(
      query.attestationId,
    );
    if (!attestation) {
      return denied(AcceptedContextAttestationVerificationReason.NotFound);
    }
    if (attestation.reuseExpiresAtMs <= this.dependencies.clock.nowMs()) {
      return denied(AcceptedContextAttestationVerificationReason.Expired);
    }
    if (attestation.attestationHash !== query.attestationHash) {
      return denied(AcceptedContextAttestationVerificationReason.HashMismatch);
    }
    if (
      attestation.sourceExecutionId !== query.sourceExecutionId ||
      attestation.sourceWorkSlotId !== query.sourceWorkSlotId ||
      attestation.attemptId !== query.attemptId ||
      attestation.sourceLeaseId !== query.sourceLeaseId ||
      attestation.sourceFencingToken !== query.sourceFencingToken ||
      attestation.sourceReviewRevisionHash !== query.sourceReviewRevisionHash
    ) {
      return denied(
        AcceptedContextAttestationVerificationReason.SourceBindingMismatch,
      );
    }
    if (
      attestation.trustedCapabilityProfile !== query.trustedCapabilityProfile
    ) {
      return denied(
        AcceptedContextAttestationVerificationReason.CapabilityProfileMismatch,
      );
    }
    if (attestation.actualModel !== query.actualModel) {
      return denied(
        AcceptedContextAttestationVerificationReason.ActualModelMismatch,
      );
    }
    if (attestation.terminalOutcomeHash !== query.terminalOutcomeHash) {
      return denied(
        AcceptedContextAttestationVerificationReason.TerminalOutcomeMismatch,
      );
    }
    return Object.freeze({
      status: AcceptedContextAttestationVerificationStatus.Accepted,
      reason: AcceptedContextAttestationVerificationReason.None,
      acceptedAttestationHash: attestation.attestationHash,
    });
  }
}

function denied(
  reason: AcceptedContextAttestationVerificationReason,
): VerifyAcceptedContextAttestationResult {
  return Object.freeze({
    status: AcceptedContextAttestationVerificationStatus.Denied,
    reason,
    acceptedAttestationHash: null,
  });
}
