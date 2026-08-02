import { canonicalJson, type CanonicalValue } from "./canonicalization";
import type {
  ContextCriticDecision,
  InvestigationTurnProviderKind,
  ReviewInvestigationConclusion,
} from "./review-investigation-types";

export type ReviewInvestigationCertificate = Readonly<{
  certificateId: string;
  certificateHash: string;
  investigationId: string;
  investigationVersion: number;
  dossierDigest: string;
  reviewRevisionHash: string;
  stableReviewUnitKey: string;
  providerVoteLaneId: string;
  coverageContractVersion: string;
  expansionRulesVersion: string;
  gatewayPolicyVersion: string;
  criticPolicyVersion: string;
  runtimeProfileVersion: string;
  producerReleaseId: string;
  conclusion: ReviewInvestigationConclusion;
  findingSetHash: string;
  obligationSetHash: string;
  receiptSetHash: string;
  scopeHash: string;
  coverageStateHash: string;
  contextAttestationSetHash: string;
  turnProvenanceHash: string;
  terminalProviderKind: InvestigationTurnProviderKind | null;
  terminalActualModel: string | null;
  terminalOutcomeHash: string;
  terminalObservationCanonicalJson: string;
  criticAttestationId: string | null;
  criticAttestationHash: string | null;
  criticDecision: ContextCriticDecision | null;
  issuedAt: string;
  expiresAt: string;
}>;

export type ReviewInvestigationCertificateCandidate = Omit<
  ReviewInvestigationCertificate,
  "certificateHash"
>;

export function certificateCandidateCanonicalValue(
  candidate: ReviewInvestigationCertificateCandidate,
): CanonicalValue {
  return { ...candidate };
}

export function canonicalInvestigationCertificateCandidate(
  candidate: ReviewInvestigationCertificateCandidate,
): string {
  return canonicalJson(certificateCandidateCanonicalValue(candidate));
}
