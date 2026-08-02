import {
  InvestigationObligationState,
  ReviewInvestigationNextActionKind,
  ReviewInvestigationState,
  ReviewInvestigationTurnPurpose,
} from "../domain/review-investigation-types";
import type { ReviewInvestigation } from "../domain/review-investigation";
import type { InvestigationTurn } from "../domain/investigation-turn";

export type ReviewInvestigationReadModel = Readonly<{
  investigationId: string;
  version: number;
  state: ReviewInvestigationState;
  dossierDigest: string;
  openObligationCount: number;
  satisfiedObligationCount: number;
  unresolvableObligationCount: number;
  findingCount: number;
  semanticTurns: number;
  operationalAttempts: number;
  criticCycles: number;
  nextEligibleAt: string | null;
  nextAction: ReviewInvestigationNextActionKind;
  turn: InvestigationTurn | null;
}>;

export function toInvestigationReadModel(
  investigation: ReviewInvestigation,
): ReviewInvestigationReadModel {
  return {
    investigationId: investigation.investigationId,
    version: investigation.version,
    state: investigation.state,
    dossierDigest: investigation.dossierDigest,
    openObligationCount: count(
      investigation,
      InvestigationObligationState.Open,
    ),
    satisfiedObligationCount: count(
      investigation,
      InvestigationObligationState.Satisfied,
    ),
    unresolvableObligationCount: count(
      investigation,
      InvestigationObligationState.Unresolvable,
    ),
    findingCount: investigation.findings.length,
    semanticTurns: investigation.semanticTurns,
    operationalAttempts: investigation.operationalAttempts,
    criticCycles: investigation.criticCycles,
    nextEligibleAt: investigation.nextEligibleAt,
    nextAction:
      investigation.nextEligibleAt !== null &&
      investigation.state === ReviewInvestigationState.AwaitingTurn
        ? ReviewInvestigationNextActionKind.AwaitCapacity
        : nextAction(investigation),
    turn: investigation.activeTurn ? { ...investigation.activeTurn } : null,
  };
}

function count(
  investigation: ReviewInvestigation,
  state: InvestigationObligationState,
): number {
  return investigation.obligations.filter((item) => item.state === state).length;
}

function nextAction(
  investigation: ReviewInvestigation,
): ReviewInvestigationNextActionKind {
  switch (investigation.state) {
    case ReviewInvestigationState.AwaitingTurn:
    case ReviewInvestigationState.Provisional:
      return ReviewInvestigationNextActionKind.RunTurn;
    case ReviewInvestigationState.TurnLeased:
      return investigation.activeTurn?.purpose === ReviewInvestigationTurnPurpose.Critic
        ? ReviewInvestigationNextActionKind.RunCritic
        : ReviewInvestigationNextActionKind.RunTurn;
    case ReviewInvestigationState.AwaitingCritic:
      return ReviewInvestigationNextActionKind.RunCritic;
    case ReviewInvestigationState.ReadyToConclude:
      return ReviewInvestigationNextActionKind.Conclude;
    case ReviewInvestigationState.Concluded:
    case ReviewInvestigationState.Inconclusive:
    case ReviewInvestigationState.Superseded:
    case ReviewInvestigationState.Expired:
      return ReviewInvestigationNextActionKind.Terminal;
  }
}
