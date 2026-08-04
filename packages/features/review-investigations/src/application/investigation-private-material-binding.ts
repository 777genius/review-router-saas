import { canonicalJson } from "../domain/canonicalization";
import {
  canonicalInvestigationSearchQueryPrivateMaterialAssociatedData,
  investigationSearchQueryPrivateMaterialPurpose,
} from "../domain/investigation-private-material";
import type { InvestigationObligation } from "../domain/investigation-obligation";
import {
  InvestigationEvidenceRequirementKind,
  obligationEvidenceRequirementVersionV2,
  parseInvestigationEvidenceRequirement,
  type CompletePageChainRequirementV2,
} from "../domain/obligation-closure-policy";
import type { ReviewInvestigation } from "../domain/review-investigation";

export function requirePersistedSearchQueryRequirement(
  obligation: InvestigationObligation,
): CompletePageChainRequirementV2 {
  const requirement = parseInvestigationEvidenceRequirement(
    obligation.canonicalRequirement,
  );
  if (
    requirement.kind !==
      InvestigationEvidenceRequirementKind.CompletePageChain ||
    requirement.requirementVersion !== obligationEvidenceRequirementVersionV2
  ) {
    throw new Error("investigation_private_material_obligation_invalid");
  }
  return requirement;
}

export function canonicalSearchQueryPrivateMaterialIdentity(input: {
  readonly investigation: ReviewInvestigation;
  readonly obligation: InvestigationObligation;
  readonly queryHash: string;
}): string {
  return canonicalJson({
    identityVersion: 1,
    purpose: investigationSearchQueryPrivateMaterialPurpose,
    investigationId: input.investigation.investigationId,
    obligationId: input.obligation.obligationId,
    coverageContractVersion: input.obligation.coverageContractVersion,
    stableReviewUnitKey: input.obligation.stableReviewUnitKey,
    canonicalSubject: input.obligation.canonicalSubject,
    canonicalRequirement: input.obligation.canonicalRequirement,
    queryHash: input.queryHash,
  });
}

export function canonicalSearchQueryPrivateMaterialAssociatedData(input: {
  readonly investigation: ReviewInvestigation;
  readonly obligation: InvestigationObligation;
  readonly privateMaterialId: string;
  readonly queryHash: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}): string {
  return canonicalInvestigationSearchQueryPrivateMaterialAssociatedData({
    associatedDataVersion: 1,
    purpose: investigationSearchQueryPrivateMaterialPurpose,
    privateMaterialId: input.privateMaterialId,
    investigationId: input.investigation.investigationId,
    obligationId: input.obligation.obligationId,
    coverageContractVersion: input.obligation.coverageContractVersion,
    stableReviewUnitKey: input.obligation.stableReviewUnitKey,
    canonicalSubject: input.obligation.canonicalSubject,
    canonicalRequirement: input.obligation.canonicalRequirement,
    queryHash: input.queryHash,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
  });
}
