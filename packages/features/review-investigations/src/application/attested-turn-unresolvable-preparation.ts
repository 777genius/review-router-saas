import {
  InvestigationOperationKind,
  type VerifiedInvestigationOperationEvidence,
} from "../domain/investigation-operation-evidence";
import { InvestigationObligationState } from "../domain/review-investigation-types";
import type { ReviewInvestigation } from "../domain/review-investigation";
import {
  InvestigationEvidenceRequirementKind,
  parseInvestigationEvidenceRequirement,
} from "../domain/obligation-closure-policy";
import type { VerifiedOperationEvidenceIndex } from "./verified-operation-evidence-index";

export enum DeterministicUnresolvableReason {
  SpecializedArtifactDecoderUnavailable = "specialized_artifact_decoder_unavailable",
}

export type ProviderUnresolvableClaim = Readonly<{
  obligationId: string;
  reason: string;
  evidenceOperationReceiptIds: readonly string[];
}>;

export type DeterministicUnresolvableDecision = Readonly<{
  obligationId: string;
  reason: string;
  deterministicPolicy: true;
}>;

export class AttestedTurnUnresolvablePreparation {
  prepare(input: {
    readonly investigation: ReviewInvestigation;
    readonly providerClaims: readonly ProviderUnresolvableClaim[];
    readonly operationEvidence: VerifiedOperationEvidenceIndex;
  }): readonly DeterministicUnresolvableDecision[] {
    const turn = input.investigation.activeTurn;
    if (turn === null) throw invalidClaim();
    const assigned = new Set(turn.obligationIds);
    const obligations = new Map(
      input.investigation.obligations.map((item) => [item.obligationId, item]),
    );
    const seen = new Set<string>();
    return Object.freeze(
      input.providerClaims.map((claim) => {
        if (
          seen.has(claim.obligationId) ||
          !assigned.has(claim.obligationId) ||
          claim.evidenceOperationReceiptIds.length === 0
        ) {
          throw invalidClaim();
        }
        seen.add(claim.obligationId);
        const obligation = obligations.get(claim.obligationId);
        if (
          !obligation ||
          obligation.state !== InvestigationObligationState.Open
        ) {
          throw invalidClaim();
        }
        const requirement = parseInvestigationEvidenceRequirement(
          obligation.canonicalRequirement,
        );
        if (
          requirement.kind !==
          InvestigationEvidenceRequirementKind.BinaryArtifactBoundary
        ) {
          throw invalidClaim();
        }
        const evidence = claim.evidenceOperationReceiptIds.map((receiptId) =>
          input.operationEvidence.get(receiptId),
        );
        if (
          evidence.some((item) => item === undefined) ||
          !evidence.some(isCanonicalInventoryEvidence)
        ) {
          throw invalidClaim();
        }
        return Object.freeze({
          obligationId: obligation.obligationId,
          reason: `${DeterministicUnresolvableReason.SpecializedArtifactDecoderUnavailable}:${requirement.contentKind}`,
          deterministicPolicy: true as const,
        });
      }),
    );
  }
}

function isCanonicalInventoryEvidence(
  evidence: VerifiedInvestigationOperationEvidence | undefined,
): boolean {
  return (
    evidence?.operationKind === InvestigationOperationKind.CanonicalInventory &&
    evidence.complete
  );
}

function invalidClaim(): Error {
  return new Error("investigation_unresolvable_claim_invalid");
}
