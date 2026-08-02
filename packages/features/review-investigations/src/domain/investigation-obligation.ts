import {
  InvestigationObligationKind,
  InvestigationObligationState,
} from "./review-investigation-types";
import {
  assertDigest,
  assertIdentifier,
  ReviewInvestigationDomainError,
  type CanonicalValue,
} from "./canonicalization";

export enum InvestigationObligationOrigin {
  CoverageContract = "coverage_contract",
  DeterministicExpansion = "deterministic_expansion",
  AgentProposal = "agent_proposal",
  CriticProposal = "critic_proposal",
}

export enum InvestigationReceiptKind {
  Blob = "blob",
  Tree = "tree",
  Search = "search",
  GitFact = "git_fact",
  Relation = "relation",
  Critic = "critic",
}

export type InvestigationEvidenceReceipt = Readonly<{
  receiptId: string;
  operationKey: string;
  kind: InvestigationReceiptKind;
  canonicalSubject: string;
  reviewRevisionHash: string;
  gatewayPolicyVersion: string;
  evidenceDigest: string;
  complete: boolean;
  truncated: boolean;
  failed: boolean;
}>;

export type InvestigationObligation = Readonly<{
  obligationId: string;
  coverageContractVersion: string;
  stableReviewUnitKey: string;
  kind: InvestigationObligationKind;
  canonicalSubject: string;
  canonicalRequirement: string;
  riskPriority: number;
  origin: InvestigationObligationOrigin;
  state: InvestigationObligationState;
  receipt: InvestigationEvidenceReceipt | null;
  unresolvableReason: string | null;
}>;

export type InvestigationObligationIdentity = Readonly<{
  coverageContractVersion: string;
  stableReviewUnitKey: string;
  kind: InvestigationObligationKind;
  canonicalSubject: string;
  canonicalRequirement: string;
}>;

export function obligationIdentity(
  input: Omit<InvestigationObligationIdentity, "kind"> & {
    readonly kind: InvestigationObligationKind;
  },
): InvestigationObligationIdentity {
  assertIdentifier(input.coverageContractVersion, "coverage_contract_version");
  assertIdentifier(input.stableReviewUnitKey, "stable_review_unit_key");
  assertIdentifier(input.canonicalSubject, "canonical_subject");
  assertIdentifier(input.canonicalRequirement, "canonical_requirement");
  return { ...input };
}

export function createInvestigationObligation(input: {
  readonly obligationId: string;
  readonly identity: InvestigationObligationIdentity;
  readonly riskPriority: number;
  readonly origin: InvestigationObligationOrigin;
}): InvestigationObligation {
  assertDigest(input.obligationId, "obligation_id");
  if (!Number.isSafeInteger(input.riskPriority) || input.riskPriority < 0) {
    throw new ReviewInvestigationDomainError("risk_priority_invalid");
  }
  return {
    obligationId: input.obligationId,
    ...input.identity,
    riskPriority: input.riskPriority,
    origin: input.origin,
    state: InvestigationObligationState.Open,
    receipt: null,
    unresolvableReason: null,
  };
}

export function mergeInvestigationObligations(
  current: readonly InvestigationObligation[],
  additions: readonly InvestigationObligation[],
): readonly InvestigationObligation[] {
  const byId = new Map(current.map((item) => [item.obligationId, item]));
  for (const addition of additions) {
    const existing = byId.get(addition.obligationId);
    if (existing && !sameObligationIdentity(existing, addition)) {
      throw new ReviewInvestigationDomainError("obligation_identity_collision");
    }
    if (!existing) {
      byId.set(addition.obligationId, addition);
      continue;
    }
    byId.set(addition.obligationId, {
      ...existing,
      riskPriority: Math.max(existing.riskPriority, addition.riskPriority),
      origin: strongerOrigin(existing.origin, addition.origin),
    });
  }
  return sortObligations([...byId.values()]);
}

function sameObligationIdentity(
  left: InvestigationObligation,
  right: InvestigationObligation,
): boolean {
  return (
    left.coverageContractVersion === right.coverageContractVersion &&
    left.stableReviewUnitKey === right.stableReviewUnitKey &&
    left.kind === right.kind &&
    left.canonicalSubject === right.canonicalSubject &&
    left.canonicalRequirement === right.canonicalRequirement
  );
}

function strongerOrigin(
  left: InvestigationObligationOrigin,
  right: InvestigationObligationOrigin,
): InvestigationObligationOrigin {
  const rank: Readonly<Record<InvestigationObligationOrigin, number>> = {
    [InvestigationObligationOrigin.CoverageContract]: 0,
    [InvestigationObligationOrigin.DeterministicExpansion]: 1,
    [InvestigationObligationOrigin.CriticProposal]: 2,
    [InvestigationObligationOrigin.AgentProposal]: 3,
  };
  return rank[left] <= rank[right] ? left : right;
}

export function satisfyInvestigationObligation(input: {
  readonly obligation: InvestigationObligation;
  readonly receipt: InvestigationEvidenceReceipt;
  readonly reviewRevisionHash: string;
  readonly gatewayPolicyVersion: string;
}): InvestigationObligation {
  if (input.obligation.state !== InvestigationObligationState.Open) {
    if (
      input.obligation.state === InvestigationObligationState.Satisfied &&
      input.obligation.receipt?.receiptId === input.receipt.receiptId
    ) {
      return input.obligation;
    }
    throw new ReviewInvestigationDomainError("obligation_not_open");
  }
  assertReceipt(input.receipt);
  if (
    input.receipt.reviewRevisionHash !== input.reviewRevisionHash ||
    input.receipt.gatewayPolicyVersion !== input.gatewayPolicyVersion ||
    input.receipt.canonicalSubject !== input.obligation.canonicalSubject ||
    !input.receipt.complete ||
    input.receipt.truncated ||
    input.receipt.failed
  ) {
    throw new ReviewInvestigationDomainError("obligation_receipt_invalid");
  }
  return {
    ...input.obligation,
    state: InvestigationObligationState.Satisfied,
    receipt: { ...input.receipt },
    unresolvableReason: null,
  };
}

export function markInvestigationObligationUnresolvable(input: {
  readonly obligation: InvestigationObligation;
  readonly reason: string;
  readonly deterministicPolicy: boolean;
}): InvestigationObligation {
  if (!input.deterministicPolicy || input.obligation.state !== InvestigationObligationState.Open) {
    throw new ReviewInvestigationDomainError("unresolvable_policy_decision_invalid");
  }
  assertIdentifier(input.reason, "unresolvable_reason");
  return {
    ...input.obligation,
    state: InvestigationObligationState.Unresolvable,
    receipt: null,
    unresolvableReason: input.reason,
  };
}

export function obligationCanonicalValue(
  obligation: InvestigationObligation,
): string {
  return JSON.stringify(obligationCanonicalObject(obligation));
}

export function obligationCanonicalObject(
  obligation: InvestigationObligation,
): CanonicalValue {
  return {
    obligationId: obligation.obligationId,
    coverageContractVersion: obligation.coverageContractVersion,
    stableReviewUnitKey: obligation.stableReviewUnitKey,
    kind: obligation.kind,
    canonicalSubject: obligation.canonicalSubject,
    canonicalRequirement: obligation.canonicalRequirement,
    riskPriority: obligation.riskPriority,
    origin: obligation.origin,
    state: obligation.state,
    receipt: obligation.receipt ? receiptCanonicalObject(obligation.receipt) : null,
    unresolvableReason: obligation.unresolvableReason,
  };
}

export function sortObligations(
  obligations: readonly InvestigationObligation[],
): readonly InvestigationObligation[] {
  return [...obligations].sort((left, right) =>
    left.obligationId.localeCompare(right.obligationId),
  );
}

function assertReceipt(receipt: InvestigationEvidenceReceipt): void {
  assertIdentifier(receipt.receiptId, "receipt_id");
  assertIdentifier(receipt.operationKey, "operation_key");
  assertIdentifier(receipt.canonicalSubject, "receipt_subject");
  assertDigest(receipt.reviewRevisionHash, "receipt_revision_hash");
  assertIdentifier(receipt.gatewayPolicyVersion, "receipt_gateway_policy_version");
  assertDigest(receipt.evidenceDigest, "receipt_evidence_digest");
}

function receiptCanonicalObject(receipt: InvestigationEvidenceReceipt): CanonicalValue {
  return {
    receiptId: receipt.receiptId,
    operationKey: receipt.operationKey,
    kind: receipt.kind,
    canonicalSubject: receipt.canonicalSubject,
    reviewRevisionHash: receipt.reviewRevisionHash,
    gatewayPolicyVersion: receipt.gatewayPolicyVersion,
    evidenceDigest: receipt.evidenceDigest,
    complete: receipt.complete,
    truncated: receipt.truncated,
    failed: receipt.failed,
  };
}
