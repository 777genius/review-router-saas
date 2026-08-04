import type { InvestigationStoreTransition } from "./ports/investigation-store-port";
import { InvestigationStoreTransitionKind } from "./ports/investigation-store-port";
import {
  createEncryptedInvestigationPrivateMaterial,
  type EncryptedInvestigationPrivateMaterial,
} from "../domain/investigation-private-material";
import {
  InvestigationEvidenceRequirementKind,
  obligationEvidenceRequirementVersionV2,
  parseInvestigationEvidenceRequirement,
} from "../domain/obligation-closure-policy";
import type { ReviewInvestigation } from "../domain/review-investigation";
import { reviewInvestigationCoverageProfileV2 } from "../domain/coverage-contract";

export function validateInvestigationPrivateMaterialCommit(input: {
  readonly investigation: ReviewInvestigation;
  readonly expectedVersion: number | null;
  readonly transition: InvestigationStoreTransition;
  readonly privateMaterials: readonly EncryptedInvestigationPrivateMaterial[];
}): readonly EncryptedInvestigationPrivateMaterial[] {
  const requiredObligationIds =
    persistedSearchQueryPrivateMaterialObligationIds(input.investigation);
  if (
    input.investigation.contract.expansionRulesVersion !==
    reviewInvestigationCoverageProfileV2.expansionRulesVersion
  ) {
    if (input.privateMaterials.length > 0) {
      throw new Error("investigation_private_material_transition_invalid");
    }
    return Object.freeze([]);
  }

  const isOpen =
    input.expectedVersion === null &&
    input.transition.kind === InvestigationStoreTransitionKind.Opened;
  if (!isOpen) {
    if (input.privateMaterials.length > 0) {
      throw new Error("investigation_private_material_transition_invalid");
    }
    return Object.freeze([]);
  }

  const obligations = new Set(
    input.investigation.obligations.map((item) => item.obligationId),
  );
  const materialByObligation = new Map<
    string,
    EncryptedInvestigationPrivateMaterial
  >();
  const materialIds = new Set<string>();
  for (const candidate of input.privateMaterials) {
    const material = createEncryptedInvestigationPrivateMaterial(candidate);
    if (
      material.investigationId !== input.investigation.investigationId ||
      material.obligationId === null ||
      !obligations.has(material.obligationId) ||
      !requiredObligationIds.has(material.obligationId) ||
      material.createdAt !== input.investigation.createdAt ||
      materialIds.has(material.privateMaterialId) ||
      materialByObligation.has(material.obligationId)
    ) {
      throw new Error("investigation_private_material_binding_invalid");
    }
    materialIds.add(material.privateMaterialId);
    materialByObligation.set(material.obligationId, material);
  }
  if (
    materialByObligation.size !== requiredObligationIds.size ||
    [...requiredObligationIds].some(
      (obligationId) => !materialByObligation.has(obligationId),
    )
  ) {
    throw new Error("investigation_private_material_required");
  }
  return Object.freeze(
    [...materialByObligation.values()].sort((left, right) =>
      left.obligationId!.localeCompare(right.obligationId!),
    ),
  );
}

export function assertPersistedInvestigationRequirementsSanitized(
  investigation: ReviewInvestigation,
): void {
  persistedSearchQueryPrivateMaterialObligationIds(investigation);
}

function persistedSearchQueryPrivateMaterialObligationIds(
  investigation: ReviewInvestigation,
): ReadonlySet<string> {
  if (
    investigation.contract.expansionRulesVersion !==
    reviewInvestigationCoverageProfileV2.expansionRulesVersion
  ) {
    return new Set();
  }
  const requiredObligationIds = new Set<string>();
  for (const obligation of investigation.obligations) {
    const requirement = parseInvestigationEvidenceRequirement(
      obligation.canonicalRequirement,
    );
    if (
      requirement.kind ===
        InvestigationEvidenceRequirementKind.CompleteChangedFile &&
      requirement.requirementVersion !== obligationEvidenceRequirementVersionV2
    ) {
      throw new Error("investigation_persisted_search_query_forbidden");
    }
    if (
      requirement.kind ===
        InvestigationEvidenceRequirementKind.CompletePageChain ||
      requirement.kind ===
        InvestigationEvidenceRequirementKind.CompleteRelationContext
    ) {
      if (
        requirement.requirementVersion !==
        obligationEvidenceRequirementVersionV2
      ) {
        throw new Error("investigation_persisted_search_query_forbidden");
      }
      if (
        requirement.kind ===
        InvestigationEvidenceRequirementKind.CompletePageChain
      ) {
        requiredObligationIds.add(obligation.obligationId);
      }
    }
  }
  return requiredObligationIds;
}
