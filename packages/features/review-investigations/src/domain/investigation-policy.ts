import { assertPositiveInteger, type CanonicalValue } from "./canonicalization";

export type ReviewInvestigationPolicy = Readonly<{
  policyId: string;
  maxObligations: number;
  maxExpansionDepth: number;
  maxSemanticTurns: number;
  maxOperationalAttempts: number;
  maxCriticCycles: number;
  maxFindings: number;
  maxProposalsPerTurn: number;
  maxReceiptsPerTurn: number;
  maxSeedProbesPerFile?: number;
  maxSeedProbesOverall?: number;
}>;

export enum InvestigationPolicyCanonicalVersion {
  LegacyV1 = "review-investigation-policy.v1",
  SeedProbeV2 = "review-investigation-policy.v2",
}

export const currentInvestigationPolicyCanonicalVersion =
  InvestigationPolicyCanonicalVersion.SeedProbeV2;

export function parseInvestigationPolicyCanonicalVersion(
  value: string,
): InvestigationPolicyCanonicalVersion {
  switch (value) {
    case InvestigationPolicyCanonicalVersion.LegacyV1:
      return InvestigationPolicyCanonicalVersion.LegacyV1;
    case InvestigationPolicyCanonicalVersion.SeedProbeV2:
      return InvestigationPolicyCanonicalVersion.SeedProbeV2;
    default:
      throw new Error("investigation_policy_canonical_version_corrupt");
  }
}

export function assertInvestigationPolicy(
  policy: ReviewInvestigationPolicy,
): void {
  for (const field of Object.keys(policy)) {
    if (!investigationPolicyFields.has(field)) {
      throw new Error("investigation_policy_field_unknown");
    }
  }
  if (
    typeof policy.policyId !== "string" ||
    policy.policyId.trim().length === 0
  ) {
    throw new Error("policy_id_invalid");
  }
  for (const field of requiredPositiveIntegerFields) {
    assertPositiveInteger(policy[field], field);
  }
  const hasPerFile = policy.maxSeedProbesPerFile !== undefined;
  const hasOverall = policy.maxSeedProbesOverall !== undefined;
  if (hasPerFile !== hasOverall) {
    throw new Error("seed_probe_policy_incomplete");
  }
  if (hasPerFile && hasOverall) {
    assertPositiveInteger(policy.maxSeedProbesPerFile!, "maxSeedProbesPerFile");
    assertPositiveInteger(policy.maxSeedProbesOverall!, "maxSeedProbesOverall");
  }
}

export function assertInvestigationPolicyCanonicalCompatibility(
  policy: ReviewInvestigationPolicy,
  version: InvestigationPolicyCanonicalVersion,
): void {
  assertInvestigationPolicy(policy);
  if (
    version === InvestigationPolicyCanonicalVersion.LegacyV1 &&
    (policy.maxSeedProbesPerFile !== undefined ||
      policy.maxSeedProbesOverall !== undefined)
  ) {
    throw new Error("investigation_policy_canonical_downgrade_invalid");
  }
}

export function policyCanonicalValue(
  policy: ReviewInvestigationPolicy,
  version: InvestigationPolicyCanonicalVersion = currentInvestigationPolicyCanonicalVersion,
): CanonicalValue {
  assertInvestigationPolicyCanonicalCompatibility(policy, version);
  const base = {
    policyId: policy.policyId,
    maxObligations: policy.maxObligations,
    maxExpansionDepth: policy.maxExpansionDepth,
    maxSemanticTurns: policy.maxSemanticTurns,
    maxOperationalAttempts: policy.maxOperationalAttempts,
    maxCriticCycles: policy.maxCriticCycles,
    maxFindings: policy.maxFindings,
    maxProposalsPerTurn: policy.maxProposalsPerTurn,
    maxReceiptsPerTurn: policy.maxReceiptsPerTurn,
  };
  if (policy.maxSeedProbesPerFile === undefined) {
    return base;
  }
  return {
    ...base,
    maxSeedProbesPerFile: policy.maxSeedProbesPerFile,
    maxSeedProbesOverall: policy.maxSeedProbesOverall!,
  };
}

const requiredPositiveIntegerFields = [
  "maxObligations",
  "maxExpansionDepth",
  "maxSemanticTurns",
  "maxOperationalAttempts",
  "maxCriticCycles",
  "maxFindings",
  "maxProposalsPerTurn",
  "maxReceiptsPerTurn",
] as const satisfies readonly (keyof ReviewInvestigationPolicy)[];

const investigationPolicyFields = new Set<string>([
  "policyId",
  ...requiredPositiveIntegerFields,
  "maxSeedProbesPerFile",
  "maxSeedProbesOverall",
]);
