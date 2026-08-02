import type { ReviewInvestigation } from "../../domain/review-investigation";
import type { ReviewInvestigationConclusion } from "../../domain/review-investigation-types";

export type InvestigationTerminalProjection = Readonly<{
  canonicalJson: string;
  terminalOutcomeHash: string;
  conclusion: ReviewInvestigationConclusion;
}>;

/** Anti-corruption boundary from Review Investigations to its terminal consumer. */
export interface InvestigationTerminalProjectionPort {
  project(
    investigation: ReviewInvestigation,
  ): Promise<InvestigationTerminalProjection>;
}
