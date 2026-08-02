import type { InvestigationEvidenceReceipt, InvestigationObligation } from "./investigation-obligation";
import type { CanonicalValue } from "./canonicalization";
import {
  ContextCriticDecision,
  ReviewInvestigationAbortReason,
  ReviewInvestigationTurnPurpose,
} from "./review-investigation-types";

export type InvestigationFinding = Readonly<{
  fingerprint: string;
  severity: string;
  title: string;
  body: string;
  path: string;
  line: number | null;
  evidenceReceiptIds: readonly string[];
}>;

export type InvestigationTurn = Readonly<{
  turnId: string;
  purpose: ReviewInvestigationTurnPurpose;
  leasedAtVersion: number;
  dossierDigest: string;
  obligationIds: readonly string[];
  semanticTurnOrdinal: number;
  criticCycleOrdinal: number;
  leasedAt: string;
  expiresAt: string;
}>;

export type InvestigationTurnCommit = Readonly<{
  turnId: string;
  closureClaims: readonly Readonly<{
    obligationId: string;
    receipt: InvestigationEvidenceReceipt;
  }>[];
  unresolvableDecisions: readonly Readonly<{
    obligationId: string;
    reason: string;
    deterministicPolicy: boolean;
  }>[];
  proposedObligations: readonly InvestigationObligation[];
  findings: readonly InvestigationFinding[];
  acceptedEvidenceReceiptIds?: readonly string[];
  criticDecision: ContextCriticDecision | null;
  usageTokens: number;
  durationMs: number;
}>;

export type InvestigationTurnAbort = Readonly<{
  turnId: string;
  reason: ReviewInvestigationAbortReason;
  nextEligibleAt: string | null;
}>;

export function findingCanonicalValue(finding: InvestigationFinding): CanonicalValue {
  return {
    fingerprint: finding.fingerprint,
    severity: finding.severity,
    title: finding.title,
    body: finding.body,
    path: finding.path,
    line: finding.line,
    evidenceReceiptIds: [...finding.evidenceReceiptIds].sort(),
  };
}

export function turnCanonicalValue(turn: InvestigationTurn): CanonicalValue {
  return {
    turnId: turn.turnId,
    purpose: turn.purpose,
    leasedAtVersion: turn.leasedAtVersion,
    dossierDigest: turn.dossierDigest,
    obligationIds: [...turn.obligationIds],
    semanticTurnOrdinal: turn.semanticTurnOrdinal,
    criticCycleOrdinal: turn.criticCycleOrdinal,
    leasedAt: turn.leasedAt,
    expiresAt: turn.expiresAt,
  };
}
