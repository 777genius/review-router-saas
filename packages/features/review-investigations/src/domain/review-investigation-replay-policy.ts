import type { ReviewInvestigation } from "./review-investigation";
import {
  ContextCriticDecision,
  ReviewInvestigationConclusion,
  ReviewInvestigationState,
} from "./review-investigation-types";

export function isVerifiedCleanReplaySource(
  investigation: ReviewInvestigation,
  nowMs: number,
): boolean {
  const certificate = investigation.certificate;
  return (
    investigation.state === ReviewInvestigationState.Concluded &&
    investigation.conclusion === ReviewInvestigationConclusion.VerifiedClean &&
    investigation.findings.length === 0 &&
    certificate !== null &&
    certificate.conclusion === ReviewInvestigationConclusion.VerifiedClean &&
    certificate.criticDecision === ContextCriticDecision.Accept &&
    certificate.criticAttestationId !== null &&
    certificate.criticAttestationHash !== null &&
    certificate.terminalProviderKind !== null &&
    certificate.terminalActualModel !== null &&
    Date.parse(certificate.expiresAt) > nowMs
  );
}
