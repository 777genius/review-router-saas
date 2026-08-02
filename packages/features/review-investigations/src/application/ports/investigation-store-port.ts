import type { ReviewInvestigation } from "../../domain/review-investigation";
import type { ReviewInvestigationAbortReason } from "../../domain/review-investigation-types";

export enum InvestigationStoreCommitStatus {
  Committed = "committed",
  Restored = "restored",
  ConcurrencyConflict = "concurrency_conflict",
  IdempotencyConflict = "idempotency_conflict",
}

export type InvestigationStoreCommitResult = Readonly<{
  status: InvestigationStoreCommitStatus;
  investigation: ReviewInvestigation | null;
}>;

export enum InvestigationStoreTransitionKind {
  Opened = "opened",
  TurnPlanned = "turn_planned",
  TurnCommitted = "turn_committed",
  TurnAborted = "turn_aborted",
  Concluded = "concluded",
}

export type InvestigationStoreTransition =
  | Readonly<{ kind: InvestigationStoreTransitionKind.Opened }>
  | Readonly<{
      kind: InvestigationStoreTransitionKind.TurnPlanned;
      turnId: string;
    }>
  | Readonly<{
      kind: InvestigationStoreTransitionKind.TurnCommitted;
      turnId: string;
      acceptedAttestationId: string | null;
      sanitizedOutcomeHash: string | null;
    }>
  | Readonly<{
      kind: InvestigationStoreTransitionKind.TurnAborted;
      turnId: string;
      reason: ReviewInvestigationAbortReason;
    }>
  | Readonly<{ kind: InvestigationStoreTransitionKind.Concluded }>;

export interface InvestigationStorePort {
  restoreCommand(input: {
    readonly commandId: string;
    readonly commandHash: string;
  }): Promise<InvestigationStoreCommitResult | null>;
  findById(investigationId: string): Promise<ReviewInvestigation | null>;
  findByNaturalIdentity(
    naturalIdentityHash: string,
  ): Promise<ReviewInvestigation | null>;
  findByCertificateId(
    certificateId: string,
  ): Promise<ReviewInvestigation | null>;
  commit(input: {
    readonly investigation: ReviewInvestigation;
    readonly expectedVersion: number | null;
    readonly commandId: string;
    readonly commandHash: string;
    readonly transition: InvestigationStoreTransition;
  }): Promise<InvestigationStoreCommitResult>;
}
