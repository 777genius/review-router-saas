import type { InvestigationObligation } from "./investigation-obligation";
import type { InvestigationTurnProvenance } from "./investigation-turn";
import {
  InvestigationObligationKind,
  ReviewInvestigationTurnPurpose,
} from "./review-investigation-types";

export const reviewInvestigationCriticPolicyV1 =
  "review-investigation-critic.v1";
export const investigationRiskPriorityMaximum = 1_000_000;
export const independentCriticRiskPriorityV1 = 800_000;

export function maximumSemanticRiskPriority(
  obligations: readonly InvestigationObligation[],
): number {
  return obligations.reduce((maximum, obligation) => {
    if (
      obligation.kind === InvestigationObligationKind.InventoryWitness ||
      obligation.kind === InvestigationObligationKind.ContextCritic
    ) {
      return maximum;
    }
    return Math.max(maximum, obligation.riskPriority);
  }, 0);
}

export function requiresIndependentCritic(input: {
  readonly criticPolicyVersion: string;
  readonly obligations: readonly InvestigationObligation[];
}): boolean {
  return (
    input.criticPolicyVersion === reviewInvestigationCriticPolicyV1 &&
    maximumSemanticRiskPriority(input.obligations) >=
      independentCriticRiskPriorityV1
  );
}

export function hasIndependentCriticProvenance(
  provenance: readonly InvestigationTurnProvenance[],
  criticTurnId?: string,
): boolean {
  const discoveryProviders = new Set(
    provenance
      .filter(
        (item) => item.purpose === ReviewInvestigationTurnPurpose.Discovery,
      )
      .map((item) => item.actualProviderKind),
  );
  const critic = [...provenance]
    .reverse()
    .find(
      (item) =>
        item.purpose === ReviewInvestigationTurnPurpose.Critic &&
        (criticTurnId === undefined || item.turnId === criticTurnId),
    );
  return (
    discoveryProviders.size > 0 &&
    critic !== undefined &&
    !discoveryProviders.has(critic.actualProviderKind)
  );
}
