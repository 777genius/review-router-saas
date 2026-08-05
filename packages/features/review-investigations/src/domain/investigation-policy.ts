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
  maxSeedProbesPerFile: number;
  maxSeedProbesOverall: number;
}>;

export function assertInvestigationPolicy(
  policy: ReviewInvestigationPolicy,
): void {
  for (const [field, value] of Object.entries(policy)) {
    if (field === "policyId") {
      if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error("policy_id_invalid");
      }
      continue;
    }
    assertPositiveInteger(value as number, field);
  }
}

export function policyCanonicalValue(
  policy: ReviewInvestigationPolicy,
): CanonicalValue {
  return {
    policyId: policy.policyId,
    maxObligations: policy.maxObligations,
    maxExpansionDepth: policy.maxExpansionDepth,
    maxSemanticTurns: policy.maxSemanticTurns,
    maxOperationalAttempts: policy.maxOperationalAttempts,
    maxCriticCycles: policy.maxCriticCycles,
    maxFindings: policy.maxFindings,
    maxProposalsPerTurn: policy.maxProposalsPerTurn,
    maxReceiptsPerTurn: policy.maxReceiptsPerTurn,
    maxSeedProbesPerFile: policy.maxSeedProbesPerFile,
    maxSeedProbesOverall: policy.maxSeedProbesOverall,
  };
}
