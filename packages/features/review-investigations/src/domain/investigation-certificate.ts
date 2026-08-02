import type { CanonicalValue } from "./canonicalization";
import type { ReviewInvestigationConclusion } from "./review-investigation-types";

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
