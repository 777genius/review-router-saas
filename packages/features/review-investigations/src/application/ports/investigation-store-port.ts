import type { ReviewInvestigation } from "../../domain/review-investigation";
import type { ReviewInvestigationScope } from "../../domain/coverage-contract";
import type { ReviewInvestigationAbortReason } from "../../domain/review-investigation-types";
import type { EncryptedInvestigationPrivateMaterial } from "../../domain/investigation-private-material";
import type { TurnResultAdmissionKind } from "../../domain/turn-result-admission";
import type { InvestigationExecutionAuthorityVerdict } from "./execution-authority-port";

export enum InvestigationStoreCommitStatus {
  Committed = "committed",
  Restored = "restored",
  ConcurrencyConflict = "concurrency_conflict",
  IdempotencyConflict = "idempotency_conflict",
  LeaseFenceConflict = "lease_fence_conflict",
}

export type InvestigationStoreCommitResult = Readonly<{
  status: InvestigationStoreCommitStatus;
  investigation: ReviewInvestigation | null;
}>;

export enum InvestigationStoreCommitGuardKind {
  LeaseFence = "lease_fence",
  ExecutionAuthority = "execution_authority",
}

export type InvestigationStoreCommitGuard =
  | Readonly<{
      kind: InvestigationStoreCommitGuardKind.LeaseFence;
      leaseId: string;
      attemptId: string;
      turnId: string;
      fencingToken: string;
      leaseCapabilityId?: string;
      authorizationId?: string;
      mutationEpoch?: bigint;
      resultAdmission?: TurnResultAdmissionKind;
      admittedAt?: string;
      effectiveDeadline?: string;
    }>
  | Readonly<{
      kind: InvestigationStoreCommitGuardKind.ExecutionAuthority;
      expectedVerdict: InvestigationExecutionAuthorityVerdict;
      resultAdmission?: TurnResultAdmissionKind;
      admittedAt?: string;
      effectiveDeadline?: string;
    }>;

export enum InvestigationStoreTransitionKind {
  Opened = "opened",
  TurnPlanned = "turn_planned",
  TurnCommitted = "turn_committed",
  TurnAborted = "turn_aborted",
  ActiveTurnExpired = "active_turn_expired",
  PrivateMaterialExpired = "private_material_expired",
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
  | Readonly<{
      kind: InvestigationStoreTransitionKind.ActiveTurnExpired;
      turnId: string;
    }>
  | Readonly<{
      kind: InvestigationStoreTransitionKind.PrivateMaterialExpired;
      affectedObligationIds: readonly string[];
      expiredTurnId: string | null;
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
  findReplayCandidates(input: {
    readonly scope: ReviewInvestigationScope;
    readonly targetReviewRevisionHash: string;
    readonly stableReviewUnitKey: string;
    readonly providerVoteLaneId: string;
    readonly producerReleaseId: string;
    readonly limit: number;
  }): Promise<readonly ReviewInvestigation[]>;
  findExpiredActiveTurnIds(input: {
    readonly expiresAtOrBefore: string;
    readonly limit: number;
  }): Promise<readonly string[]>;
  commit(input: {
    readonly investigation: ReviewInvestigation;
    readonly expectedVersion: number | null;
    readonly commandId: string;
    readonly commandHash: string;
    readonly transition: InvestigationStoreTransition;
    readonly guard?: InvestigationStoreCommitGuard;
    readonly privateMaterials?: readonly EncryptedInvestigationPrivateMaterial[];
  }): Promise<InvestigationStoreCommitResult>;
}
