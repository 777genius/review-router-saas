import {
  InvestigationOperationKind,
  type VerifiedInvestigationOperationEvidence,
} from "../domain/investigation-operation-evidence";
import {
  InvestigationObligationKind,
  InvestigationObligationState,
} from "../domain/review-investigation-types";
import type { ReviewInvestigation } from "../domain/review-investigation";
import {
  InvestigationEvidenceRequirementKind,
  ObligationClosureDecisionKind,
  VersionedObligationClosurePolicy,
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
    const inventoryObligations = input.investigation.obligations.filter(
      (item) => item.kind === InvestigationObligationKind.InventoryWitness,
    );
    const closurePolicy = new VersionedObligationClosurePolicy();
    const obligations = new Map(
      input.investigation.obligations.map((item) => [item.obligationId, item]),
    );
    const claimCounts = new Map<string, number>();
    for (const claim of input.providerClaims) {
      claimCounts.set(
        claim.obligationId,
        (claimCounts.get(claim.obligationId) ?? 0) + 1,
      );
    }
    return Object.freeze(
      input.providerClaims.flatMap((claim) => {
        if (
          claimCounts.get(claim.obligationId) !== 1 ||
          !assigned.has(claim.obligationId) ||
          claim.evidenceOperationReceiptIds.length === 0
        ) {
          return [];
        }
        const obligation = obligations.get(claim.obligationId);
        if (
          !obligation ||
          obligation.state !== InvestigationObligationState.Open
        ) {
          return [];
        }
        const requirement = parseInvestigationEvidenceRequirement(
          obligation.canonicalRequirement,
        );
        if (
          requirement.kind !==
          InvestigationEvidenceRequirementKind.BinaryArtifactBoundary
        ) {
          return [];
        }
        const evidence = claim.evidenceOperationReceiptIds.map((receiptId) =>
          input.operationEvidence.get(receiptId),
        );
        // Re-prove the investigation's inventory scope without changing its
        // obligation state; an unrelated complete inventory is insufficient.
        if (
          evidence.some((item) => item === undefined) ||
          !inventoryObligations.some(
            (inventory) =>
              closurePolicy.decide({
                obligation: inventory,
                operations: evidence.filter(isCanonicalInventoryEvidence),
                revision: input.investigation.revision,
              }).kind === ObligationClosureDecisionKind.Accepted,
          )
        ) {
          return [];
        }
        return [
          Object.freeze({
            obligationId: obligation.obligationId,
            reason: `${DeterministicUnresolvableReason.SpecializedArtifactDecoderUnavailable}:${requirement.contentKind}`,
            deterministicPolicy: true as const,
          }),
        ];
      }),
    );
  }
}

function isCanonicalInventoryEvidence(
  evidence: VerifiedInvestigationOperationEvidence | undefined,
): evidence is VerifiedInvestigationOperationEvidence {
  return (
    evidence?.operationKind === InvestigationOperationKind.CanonicalInventory
  );
}

function invalidClaim(): Error {
  return new Error("investigation_unresolvable_claim_invalid");
}
