import { canonicalJson } from "./canonicalization";
import type { SeedInvestigationObligation } from "./coverage-contract";
import { investigationRiskPriorityMaximum } from "./investigation-critic-policy";
import {
  investigationCanonicalRequirementMaximumLength,
  investigationCanonicalSubjectMaximumLength,
} from "./investigation-obligation";
import {
  InvestigationEvidenceRequirementKind,
  canonicalFileObligationSubject,
  canonicalInvestigationEvidenceRequirement,
  parseInvestigationEvidenceRequirement,
} from "./obligation-closure-policy";
import { InvestigationObligationKind } from "./review-investigation-types";

const maximumProviderProposalsPerObservation = 256;

export function parseProviderInvestigationObligationProposals(
  value: unknown,
): readonly SeedInvestigationObligation[] {
  if (
    !Array.isArray(value) ||
    value.length > maximumProviderProposalsPerObservation
  ) {
    throw new Error("investigation_obligation_proposals_invalid");
  }
  const identities = new Set<string>();
  const proposals = value.map((item) => {
    const proposal = exactProposalRecord(item);
    const kind = providerProposalKind(proposal.kind);
    const canonicalSubject = canonicalText(
      proposal.canonicalSubject,
      investigationCanonicalSubjectMaximumLength,
      "investigation_obligation_proposal_subject_invalid",
    );
    const canonicalRequirement = canonicalText(
      proposal.canonicalRequirement,
      investigationCanonicalRequirementMaximumLength,
      "investigation_obligation_proposal_requirement_invalid",
    );
    const requirement = providerProposalRequirement(canonicalRequirement);
    const expectedSubject = canonicalFileObligationSubject({
      pathHash: requirement.pathHash,
      revision: requirement.revision,
    });
    if (canonicalSubject !== expectedSubject) {
      throw new Error("investigation_obligation_proposal_subject_mismatch");
    }
    const riskPriority = boundedRiskPriority(proposal.riskPriority);
    const normalized = Object.freeze({
      kind,
      canonicalSubject: expectedSubject,
      canonicalRequirement:
        canonicalInvestigationEvidenceRequirement(requirement),
      riskPriority,
    });
    const identity = canonicalJson({
      kind: normalized.kind,
      canonicalSubject: normalized.canonicalSubject,
      canonicalRequirement: normalized.canonicalRequirement,
    });
    if (identities.has(identity)) {
      throw new Error("investigation_obligation_proposal_duplicate");
    }
    identities.add(identity);
    return normalized;
  });
  return Object.freeze(proposals);
}

function exactProposalRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("investigation_obligation_proposal_invalid");
  }
  const proposal = value as Record<string, unknown>;
  const expected = [
    "canonicalRequirement",
    "canonicalSubject",
    "kind",
    "riskPriority",
  ];
  const actual = Object.keys(proposal).sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error("investigation_obligation_proposal_shape_invalid");
  }
  return proposal;
}

function providerProposalKind(value: unknown): InvestigationObligationKind {
  if (typeof value !== "string") {
    throw new Error("investigation_obligation_proposal_kind_invalid");
  }

  switch (value) {
    case InvestigationObligationKind.BaseContent:
      return InvestigationObligationKind.BaseContent;
    case InvestigationObligationKind.RelatedManifest:
      return InvestigationObligationKind.RelatedManifest;
    case InvestigationObligationKind.DirectCaller:
      return InvestigationObligationKind.DirectCaller;
    case InvestigationObligationKind.DirectCallee:
      return InvestigationObligationKind.DirectCallee;
    case InvestigationObligationKind.TestEvidence:
      return InvestigationObligationKind.TestEvidence;
    case InvestigationObligationKind.SchemaContract:
      return InvestigationObligationKind.SchemaContract;
    case InvestigationObligationKind.ConfigurationContract:
      return InvestigationObligationKind.ConfigurationContract;
    case InvestigationObligationKind.MigrationContract:
      return InvestigationObligationKind.MigrationContract;
    case InvestigationObligationKind.GeneratedSource:
      return InvestigationObligationKind.GeneratedSource;
    case InvestigationObligationKind.DependencyContract:
      return InvestigationObligationKind.DependencyContract;
    case InvestigationObligationKind.SideEffectParity:
      return InvestigationObligationKind.SideEffectParity;
    case InvestigationObligationKind.ExternalContract:
      return InvestigationObligationKind.ExternalContract;
    case InvestigationObligationKind.InventoryWitness:
    case InvestigationObligationKind.ChangedContent:
    case InvestigationObligationKind.DirectReferenceSearch:
    case InvestigationObligationKind.BinaryArtifact:
    case InvestigationObligationKind.ContextCritic:
      throw new Error("investigation_obligation_proposal_kind_unsupported");
    default:
      throw new Error("investigation_obligation_proposal_kind_invalid");
  }
}

function providerProposalRequirement(value: string) {
  let requirement;
  try {
    requirement = parseInvestigationEvidenceRequirement(value);
  } catch {
    throw new Error("investigation_obligation_proposal_requirement_invalid");
  }
  if (requirement.kind !== InvestigationEvidenceRequirementKind.CompleteFile) {
    throw new Error(
      "investigation_obligation_proposal_requirement_unsupported",
    );
  }
  return requirement;
}

function boundedRiskPriority(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 0 ||
    Number(value) > investigationRiskPriorityMaximum
  ) {
    throw new Error("investigation_obligation_proposal_risk_priority_invalid");
  }
  return Number(value);
}

function canonicalText(
  value: unknown,
  maximumLength: number,
  error: string,
): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximumLength ||
    value.trim() !== value ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
      );
    })
  ) {
    throw new Error(error);
  }
  return value;
}
