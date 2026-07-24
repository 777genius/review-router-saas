import type {
  ProviderExecutionProfile,
  ReviewRevision,
} from "../../domain/review-evidence-primitives";

export enum ContextAttestationVerificationStatus {
  Accepted = "accepted",
  Denied = "denied",
}

export enum ContextAttestationVerificationDenialReason {
  None = "none",
  NotFound = "not_found",
  NotAccepted = "not_accepted",
  Expired = "expired",
  HashMismatch = "hash_mismatch",
  SourceBindingMismatch = "source_binding_mismatch",
  CapabilityProfileMismatch = "capability_profile_mismatch",
  ActualModelMismatch = "actual_model_mismatch",
  TerminalOutcomeMismatch = "terminal_outcome_mismatch",
  Unknown = "unknown",
}

export type VerifyAcceptedContextAttestationQuery = Readonly<{
  attestationId: string;
  attestationHash: string;
  sourceExecutionId: string;
  sourceWorkSlotId: string;
  attemptId: string;
  sourceLeaseId: string;
  sourceFencingToken: string;
  sourceRevision: ReviewRevision;
  executionProfile: ProviderExecutionProfile;
  trustedCapabilityProfile: string;
  actualModel: string;
  terminalOutcomeHash: string;
  nowMs: number;
}>;

export type ContextAttestationVerificationDecision = Readonly<{
  status: ContextAttestationVerificationStatus;
  reason: ContextAttestationVerificationDenialReason;
  acceptedAttestationHash: string | null;
}>;

/**
 * Anti-corruption boundary from Review Evidence to Context Attestation.
 *
 * Implementations must read an independently accepted, immutable attestation.
 * They must not validate a manifest supplied by the provider result request.
 */
export interface AcceptedContextAttestationVerificationPort {
  verifyAcceptedAttestation(
    query: VerifyAcceptedContextAttestationQuery,
  ): Promise<ContextAttestationVerificationDecision>;
}
