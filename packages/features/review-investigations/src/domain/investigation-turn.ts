import type {
  InvestigationEvidenceReceipt,
  InvestigationObligation,
} from "./investigation-obligation";
import {
  canonicalJson,
  ReviewInvestigationDomainError,
  type CanonicalValue,
} from "./canonicalization";
import type { InvestigationTokenUsage } from "./investigation-token-usage";
import {
  ContextCriticDecision,
  InvestigationFindingSeverity,
  InvestigationTurnProviderKind,
  ReviewInvestigationAbortReason,
  ReviewInvestigationRuntimeProfile,
  ReviewInvestigationTurnPurpose,
} from "./review-investigation-types";

export type InvestigationFinding = Readonly<{
  fingerprint: string;
  severity: InvestigationFindingSeverity;
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
  provenance: InvestigationTurnProvenance | null;
}>;

type InvestigationTurnObligationClaim = Readonly<{
  obligationId: string;
}>;

export function assertInvestigationTurnObligationClaimScope(input: {
  readonly turn: InvestigationTurn;
  readonly closureClaims: readonly InvestigationTurnObligationClaim[];
  readonly unresolvableClaims: readonly InvestigationTurnObligationClaim[];
}): void {
  const assigned = new Set(input.turn.obligationIds);
  const claimed = new Set<string>();
  for (const claim of [...input.closureClaims, ...input.unresolvableClaims]) {
    if (!assigned.has(claim.obligationId) || claimed.has(claim.obligationId)) {
      throw new ReviewInvestigationDomainError("turn_obligation_claim_invalid");
    }
    claimed.add(claim.obligationId);
  }
}

export type InvestigationTurnProvenance = Readonly<{
  turnId: string;
  purpose: ReviewInvestigationTurnPurpose;
  actualProviderKind: InvestigationTurnProviderKind;
  actualModel: string;
  runtimeProfile: ReviewInvestigationRuntimeProfile;
  durationMs: number;
  acceptedAttestationId: string;
  acceptedAttestationHash: string;
  terminalOutcomeHash: string;
}> &
  InvestigationTokenUsage;

export function turnProvenanceCanonicalValue(
  provenance: InvestigationTurnProvenance,
): CanonicalValue {
  return { ...provenance };
}

export function canonicalTurnProvenanceSet(
  provenance: readonly InvestigationTurnProvenance[],
): string {
  return canonicalJson(provenance.map(turnProvenanceCanonicalValue));
}

export function canonicalContextAttestationSet(
  provenance: readonly InvestigationTurnProvenance[],
): string {
  return canonicalJson(
    provenance
      .map((item) => ({
        id: item.acceptedAttestationId,
        hash: item.acceptedAttestationHash,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  );
}

export function latestCriticTurnProvenance(
  provenance: readonly InvestigationTurnProvenance[],
): InvestigationTurnProvenance | null {
  return (
    [...provenance]
      .reverse()
      .find((item) => item.purpose === ReviewInvestigationTurnPurpose.Critic) ??
    null
  );
}

export function summarizeTerminalDiscoveryProvenance(
  provenance: readonly InvestigationTurnProvenance[],
): Readonly<{
  providerKind: InvestigationTurnProviderKind | null;
  actualModel: string | null;
}> {
  const discovery = provenance.filter(
    (item) => item.purpose === ReviewInvestigationTurnPurpose.Discovery,
  );
  const providerKinds = new Set(
    discovery.map((item) => item.actualProviderKind),
  );
  const actualModels = new Set(discovery.map((item) => item.actualModel));
  if (providerKinds.size > 1 || actualModels.size > 1) {
    throw new Error("investigation_terminal_provenance_ambiguous");
  }
  return Object.freeze({
    providerKind: discovery[0]?.actualProviderKind ?? null,
    actualModel: discovery[0]?.actualModel ?? null,
  });
}

export type InvestigationTurnAbort = Readonly<{
  turnId: string;
  reason: ReviewInvestigationAbortReason;
  nextEligibleAt: string | null;
}>;

export function findingCanonicalValue(
  finding: InvestigationFinding,
): CanonicalValue {
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
