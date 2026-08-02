import type {
  ReviewEvidenceScope,
  ReviewRevision,
} from "../../domain/review-evidence-primitives";

export enum InvestigationCertificateConclusion {
  VerifiedClean = "verified_clean",
  Findings = "findings",
  Inconclusive = "inconclusive",
}

export enum InvestigationCertificateVerificationStatus {
  Accepted = "accepted",
  Denied = "denied",
}

export enum InvestigationCertificateVerificationDenialReason {
  None = "none",
  NotFound = "not_found",
  NotAccepted = "not_accepted",
  Expired = "expired",
  HashMismatch = "hash_mismatch",
  ScopeMismatch = "scope_mismatch",
  RevisionMismatch = "revision_mismatch",
  VoteLaneMismatch = "vote_lane_mismatch",
  TerminalOutcomeMismatch = "terminal_outcome_mismatch",
  ConclusionMismatch = "conclusion_mismatch",
  ProducerReleaseMismatch = "producer_release_mismatch",
  Unknown = "unknown",
}

export type VerifyInvestigationCertificateQuery = Readonly<{
  certificateId: string;
  certificateHash: string;
  scope: ReviewEvidenceScope;
  revision: ReviewRevision;
  providerVoteIdentityHash: string;
  terminalOutcomeHash: string;
  expectedConclusion: InvestigationCertificateConclusion;
  producerReleaseId: string;
  nowMs: number;
}>;

export type InvestigationCertificateVerificationDecision = Readonly<{
  status: InvestigationCertificateVerificationStatus;
  reason: InvestigationCertificateVerificationDenialReason;
  acceptedCertificateHash: string | null;
  conclusion: InvestigationCertificateConclusion | null;
}>;

/** Anti-corruption boundary from Review Evidence to Review Investigations. */
export interface AcceptedInvestigationCertificateVerificationPort {
  verifyAcceptedCertificate(
    query: VerifyInvestigationCertificateQuery,
  ): Promise<InvestigationCertificateVerificationDecision>;
}
