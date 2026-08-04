import {
  InvestigationObligationKind,
  investigationCanonicalRequirementMaximumLength,
  investigationCanonicalSubjectMaximumLength,
  investigationRiskPriorityMaximum,
  type SeedInvestigationObligation,
} from "@reviewrouter/features-review-investigations";

export const reviewInvestigationSeedEnvelopeContract =
  "review_investigation_seed_envelope.v1" as const;

export type ReviewInvestigationSeedEnvelope = Readonly<{
  contract: typeof reviewInvestigationSeedEnvelopeContract;
  obligations: readonly SeedInvestigationObligation[];
  probePlanHash: string;
  requestedModel: string;
  reviewPromptHash: string;
}>;

const digestPattern = /^[a-f0-9]{64}$/u;

export function parseReviewInvestigationSeedEnvelope(
  value: unknown,
  maximumObligations: number,
): ReviewInvestigationSeedEnvelope {
  if (!Number.isSafeInteger(maximumObligations) || maximumObligations < 1) {
    throw new Error("investigation_seed_envelope_limit_invalid");
  }
  const envelope = record(value);
  exactKeys(envelope, [
    "contract",
    "obligations",
    "probePlanHash",
    "requestedModel",
    "reviewPromptHash",
  ]);
  if (envelope.contract !== reviewInvestigationSeedEnvelopeContract) {
    throw new Error("investigation_seed_envelope_contract_invalid");
  }
  const obligations = array(envelope.obligations);
  if (obligations.length < 1 || obligations.length > maximumObligations) {
    throw new Error("investigation_seed_envelope_obligation_count_invalid");
  }
  const requestedModel = boundedText(envelope.requestedModel, 256);
  return Object.freeze({
    contract: reviewInvestigationSeedEnvelopeContract,
    obligations: Object.freeze(obligations.map(parseObligation)),
    probePlanHash: digest(envelope.probePlanHash),
    requestedModel,
    reviewPromptHash: digest(envelope.reviewPromptHash),
  });
}

function parseObligation(value: unknown): SeedInvestigationObligation {
  const obligation = record(value);
  exactKeys(obligation, [
    "canonicalRequirement",
    "canonicalSubject",
    "kind",
    "riskPriority",
  ]);
  if (
    !Object.values(InvestigationObligationKind).includes(
      obligation.kind as InvestigationObligationKind,
    )
  ) {
    throw new Error("investigation_seed_obligation_kind_invalid");
  }
  if (
    !Number.isSafeInteger(obligation.riskPriority) ||
    Number(obligation.riskPriority) < 0 ||
    Number(obligation.riskPriority) > investigationRiskPriorityMaximum
  ) {
    throw new Error("investigation_seed_obligation_risk_invalid");
  }
  return Object.freeze({
    kind: obligation.kind as InvestigationObligationKind,
    canonicalSubject: boundedText(
      obligation.canonicalSubject,
      investigationCanonicalSubjectMaximumLength,
    ),
    canonicalRequirement: boundedText(
      obligation.canonicalRequirement,
      investigationCanonicalRequirementMaximumLength,
    ),
    riskPriority: Number(obligation.riskPriority),
  });
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("investigation_seed_envelope_shape_invalid");
  }
  return value as Record<string, unknown>;
}

function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error("investigation_seed_envelope_shape_invalid");
  }
  return value;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error("investigation_seed_envelope_shape_invalid");
  }
}

function boundedText(value: unknown, maximumLength: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength
  ) {
    throw new Error("investigation_seed_envelope_text_invalid");
  }
  return value;
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !digestPattern.test(value)) {
    throw new Error("investigation_seed_envelope_digest_invalid");
  }
  return value;
}
