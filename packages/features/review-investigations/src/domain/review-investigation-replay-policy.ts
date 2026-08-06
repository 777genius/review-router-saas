import type {
  InvestigationEvidenceReceipt,
  InvestigationObligation,
} from "./investigation-obligation";
import type { ReviewInvestigation } from "./review-investigation";
import {
  ContextCriticDecision,
  InvestigationObligationKind,
  InvestigationObligationState,
  ReviewInvestigationConclusion,
  ReviewInvestigationState,
} from "./review-investigation-types";

export enum CleanCertificateEligibilityReason {
  Eligible = "eligible",
  NotConcluded = "not_concluded",
  NotVerifiedClean = "not_verified_clean",
  FindingsPresent = "findings_present",
  CertificateMissing = "certificate_missing",
  CriticNotAccepted = "critic_not_accepted",
  ProvenanceMissing = "provenance_missing",
  Expired = "expired",
}

export enum ReceiptReplayEligibilityReason {
  Eligible = "eligible",
  CheckpointMissing = "checkpoint_missing",
  SourceInFlight = "source_in_flight",
  SourceExpired = "source_expired",
  TerminalBindingInvalid = "terminal_binding_invalid",
  CheckpointExpired = "checkpoint_expired",
  NoCommittedReceipts = "no_committed_receipts",
}

export type ReplayEligibility<Reason extends string> = Readonly<{
  eligible: boolean;
  reason: Reason;
}>;

export function evaluateCleanCertificateEligibility(
  investigation: ReviewInvestigation,
  nowMs: number,
): ReplayEligibility<CleanCertificateEligibilityReason> {
  const certificate = investigation.certificate;
  if (investigation.state !== ReviewInvestigationState.Concluded)
    return clean(CleanCertificateEligibilityReason.NotConcluded);
  if (investigation.conclusion !== ReviewInvestigationConclusion.VerifiedClean)
    return clean(CleanCertificateEligibilityReason.NotVerifiedClean);
  if (investigation.findings.length > 0)
    return clean(CleanCertificateEligibilityReason.FindingsPresent);
  if (
    certificate === null ||
    certificate.conclusion !== ReviewInvestigationConclusion.VerifiedClean
  )
    return clean(CleanCertificateEligibilityReason.CertificateMissing);
  if (certificate.criticDecision !== ContextCriticDecision.Accept)
    return clean(CleanCertificateEligibilityReason.CriticNotAccepted);
  if (
    certificate.criticAttestationId === null ||
    certificate.criticAttestationHash === null ||
    certificate.terminalProviderKind === null ||
    certificate.terminalActualModel === null
  )
    return clean(CleanCertificateEligibilityReason.ProvenanceMissing);
  if (Date.parse(certificate.expiresAt) <= nowMs)
    return clean(CleanCertificateEligibilityReason.Expired);
  return clean(CleanCertificateEligibilityReason.Eligible, true);
}

export function evaluateReceiptReplayEligibility(
  investigation: ReviewInvestigation,
  nowMs: number,
): ReplayEligibility<ReceiptReplayEligibilityReason> {
  const checkpoint = investigation.replayEvidenceCheckpoint;
  if (checkpoint === null)
    return replay(ReceiptReplayEligibilityReason.CheckpointMissing);
  if (investigation.state === ReviewInvestigationState.Expired)
    return replay(ReceiptReplayEligibilityReason.SourceExpired);
  if (
    ![
      ReviewInvestigationState.Concluded,
      ReviewInvestigationState.Inconclusive,
      ReviewInvestigationState.Superseded,
    ].includes(investigation.state)
  )
    return replay(ReceiptReplayEligibilityReason.SourceInFlight);
  if (
    checkpoint.sourceState !== investigation.state ||
    checkpoint.sourceConclusion !== investigation.conclusion ||
    checkpoint.sourceInvestigationId !== investigation.investigationId ||
    checkpoint.sourceInvestigationVersion !== investigation.version
  )
    return replay(ReceiptReplayEligibilityReason.TerminalBindingInvalid);
  if (Date.parse(checkpoint.expiresAt) <= nowMs)
    return replay(ReceiptReplayEligibilityReason.CheckpointExpired);
  const receipts = investigation.obligations.filter(
    isCommittedReplayableObligation,
  );
  if (receipts.length === 0)
    return replay(ReceiptReplayEligibilityReason.NoCommittedReceipts);
  return replay(ReceiptReplayEligibilityReason.Eligible, true);
}

export function isCommittedReplayableObligation(
  obligation: InvestigationObligation,
): obligation is InvestigationObligation & {
  readonly receipt: InvestigationEvidenceReceipt;
} {
  return (
    obligation.kind !== InvestigationObligationKind.ContextCritic &&
    obligation.kind !== InvestigationObligationKind.FindingRevalidation &&
    obligation.state === InvestigationObligationState.Satisfied &&
    obligation.receipt !== null &&
    obligation.receipt.complete &&
    !obligation.receipt.truncated &&
    !obligation.receipt.failed &&
    obligation.receipt.acceptedAttestationId !== null &&
    obligation.receipt.acceptedAttestationHash !== null &&
    obligation.receipt.operationReceiptIds.length > 0
  );
}

function clean(reason: CleanCertificateEligibilityReason, eligible = false) {
  return Object.freeze({ eligible, reason });
}
function replay(reason: ReceiptReplayEligibilityReason, eligible = false) {
  return Object.freeze({ eligible, reason });
}
