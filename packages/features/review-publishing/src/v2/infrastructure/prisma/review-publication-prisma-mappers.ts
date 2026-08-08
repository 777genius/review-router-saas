import {
  ReviewPublicationAttemptStateV2 as DbAttemptState,
  ReviewPublicationClaimStateV2 as DbClaimState,
  ReviewPublicationEffectStrategyV2 as DbEffectStrategy,
  ReviewPublicationExternalEffectKindV2 as DbEffectKind,
  ReviewPublicationKindV2 as DbPublicationKind,
  ReviewPublicationOperationAttemptStateV2 as DbOperationAttemptState,
  ReviewPublicationOperationRoleV2 as DbOperationRole,
  ReviewPublicationOperationStateV2 as DbOperationState,
  ReviewPublicationTerminalOutcomeV2 as DbTerminalOutcome,
  type ReviewPublicationAttemptV2 as DbAttempt,
  type ReviewPublicationAuditTombstoneV2 as DbTombstone,
  type ReviewPublicationClaimTermV2 as DbClaim,
  type ReviewPublicationExternalEffectV2 as DbEffect,
  type ReviewPublicationOperationAttemptV2 as DbOperationAttempt,
  type ReviewPublicationOperationV2 as DbOperation,
  type ReviewPublicationOutcomeCorrectionV2 as DbCorrection,
  type ReviewPublicationReceiptV2 as DbReceipt,
} from "@prisma/client";
import {
  ReviewPublicationAttemptState,
  ReviewPublicationClaimState,
  ReviewPublicationCorrectionReason,
  ReviewPublicationEffectStrategy,
  ReviewPublicationExternalEffectKind,
  ReviewPublicationKind,
  ReviewPublicationOperationAttemptState,
  ReviewPublicationOperationRole,
  ReviewPublicationOperationState,
  ReviewPublicationReceiptStatus,
  ReviewPublicationTerminalOutcome,
  reviewPublicationV2SchemaVersion,
  type ReviewPublicationAttempt,
  type ReviewPublicationAuditTombstone,
  type ReviewPublicationClaimTerm,
  type ReviewPublicationExternalEffect,
  type ReviewPublicationOperation,
  type ReviewPublicationOperationAttempt,
  type ReviewPublicationOutcomeCorrection,
  type ReviewPublicationReceipt,
} from "../../domain/review-publication-attempt";

export function toDomainAttempt(
  row: DbAttempt,
  operations: readonly DbOperation[],
): ReviewPublicationAttempt {
  return {
    schemaVersion: reviewPublicationV2SchemaVersion,
    publicationAttemptId: row.publicationAttemptId,
    requestHash: row.requestHash,
    permit: {
      workspaceId: row.workspaceId,
      repositoryConnectionId: row.repositoryConnectionId,
      scmRepositoryIdentityId: row.scmRepositoryIdentityId,
      pullRequestNumber: row.pullRequestNumber,
      executionId: row.executionId,
      generation: row.generation,
      authorizationId: row.authorizationId,
      producerReleaseId: row.producerReleaseId,
      reviewedHeadSha: row.reviewedHeadSha,
      reviewRevisionHash: row.reviewRevisionHash,
      projectionHash: row.projectionHash,
      lifecycleStateHash: row.lifecycleStateHash,
      commandLedgerWatermark: row.commandLedgerWatermark,
      permitEpoch: row.permitEpoch,
      publicationSafetyDecisionHash: row.publicationSafetyDecisionHash,
      publicationNotAfter: new Date(row.publicationNotAfter),
    },
    version: row.version,
    activeClaimId: row.activeClaimId,
    state: toDomainAttemptState(row.state),
    terminalOutcome:
      row.terminalOutcome === null
        ? null
        : toDomainTerminalOutcome(row.terminalOutcome),
    operations: operations.map(toDomainOperation),
    createdAt: new Date(row.createdAt),
    retainUntil: new Date(row.retainUntil),
  };
}

export function toDomainOperation(
  row: DbOperation,
): ReviewPublicationOperation {
  return {
    publicationOperationId: row.publicationOperationId,
    publicationAttemptId: row.publicationAttemptId,
    publicationKind: toDomainPublicationKind(row.publicationKind),
    chunkIndex: row.chunkIndex,
    effectStrategy: toDomainEffectStrategy(row.effectStrategy),
    role: toDomainOperationRole(row.role),
    markerHash: row.markerHash,
    bodyHash: row.bodyHash,
    renderPolicyVersion: row.renderPolicyVersion,
    targetCommitId: row.targetCommitId,
    reviewRevisionHash: row.reviewRevisionHash,
    required: row.required,
    dependsOnOperationId: row.dependsOnOperationId,
    state: toDomainOperationState(row.state),
    reconcileUntil: new Date(row.reconcileUntil),
  };
}

export function toDomainClaim(row: DbClaim): ReviewPublicationClaimTerm {
  return {
    claimId: row.claimId,
    publicationAttemptId: row.publicationAttemptId,
    ownerIdHash: row.ownerIdHash,
    acquireRequestIdHash: row.acquireRequestIdHash,
    requestHash: row.acquireRequestHash,
    claimCapabilityId: row.claimCapabilityId,
    capabilitySigningKeyId: row.capabilitySigningKeyId,
    fencingToken: row.fencingToken,
    state: toDomainClaimState(row.state),
    acquiredAt: new Date(row.acquiredAt),
    renewedAt: new Date(row.renewedAt),
    expiresAt: new Date(row.expiresAt),
    retainUntil: new Date(row.retainUntil),
  };
}

export function toDomainOperationAttempt(
  row: DbOperationAttempt,
): ReviewPublicationOperationAttempt {
  const state = toDomainOperationAttemptState(row.state);
  const proofComplete =
    row.noEffectProofId !== null &&
    row.noEffectProofHash !== null &&
    row.noEffectReason !== null &&
    row.noEffectProvenAt !== null;
  if (
    (state === ReviewPublicationOperationAttemptState.NoEffectProven) !==
    proofComplete
  ) {
    throw new Error("publication_no_effect_proof_incomplete");
  }
  return {
    operationAttemptId: row.operationAttemptId,
    publicationAttemptId: row.publicationAttemptId,
    publicationOperationId: row.publicationOperationId,
    claimId: row.claimId,
    acquireRequestIdHash: row.acquireRequestIdHash,
    requestHash: row.acquireRequestHash,
    operationCapabilityId: row.operationCapabilityId,
    capabilitySigningKeyId: row.capabilitySigningKeyId,
    effectReportId: row.effectReportId,
    claimFencingToken: row.claimFencingToken,
    state,
    noEffectProofId: row.noEffectProofId,
    noEffectProofHash: row.noEffectProofHash,
    noEffectReason: row.noEffectReason,
    noEffectProvenAt:
      row.noEffectProvenAt === null ? null : new Date(row.noEffectProvenAt),
    startedAt: new Date(row.startedAt),
    effectReportUntil: new Date(row.effectReportUntil),
    retainUntil: new Date(row.retainUntil),
  };
}

export function toDomainEffect(row: DbEffect): ReviewPublicationExternalEffect {
  return {
    effectId: row.effectId,
    publicationAttemptId: row.publicationAttemptId,
    publicationOperationId: row.publicationOperationId,
    operationAttemptId: row.operationAttemptId,
    effectReportId: row.effectReportId,
    reportRequestHash: row.reportRequestHash,
    externalObjectId: row.externalObjectId,
    observedObjectHash: row.observedObjectHash,
    effectKind: toDomainEffectKind(row.effectKind),
    observedAt: new Date(row.observedAt),
  };
}

export function toDomainReceipt(row: DbReceipt): ReviewPublicationReceipt {
  return {
    receiptId: row.receiptId,
    publicationAttemptId: row.publicationAttemptId,
    publicationOperationId: row.publicationOperationId,
    canonicalEffectId: row.canonicalEffectId,
    canonicalExternalObjectId: row.canonicalExternalObjectId,
    status: toDomainReceiptStatus(row.status),
    receiptHash: row.receiptHash,
    updatedAt: new Date(row.updatedAt),
  };
}

export function toDomainTombstone(
  row: DbTombstone,
): ReviewPublicationAuditTombstone {
  if (row.finalOutcome === DbTerminalOutcome.succeeded) {
    throw new Error("publication_tombstone_outcome_invalid");
  }
  return {
    tombstoneId: row.tombstoneId,
    publicationAttemptId: row.publicationAttemptId,
    publicationOperationId: row.publicationOperationId,
    reviewRevisionHash: row.reviewRevisionHash,
    markerHash: row.markerHash,
    bodyHash: row.bodyHash,
    knownExternalObjectIds: [...row.knownExternalObjectIds],
    finalOutcome: toDomainTombstoneOutcome(row.finalOutcome),
    finalReason: row.finalReason,
    lastErrorCode: row.lastErrorCode ?? "",
    terminalizedBy: row.terminalizedBy,
    terminalizedAt: new Date(row.terminalizedAt),
    retainUntil: new Date(row.retainUntil),
  };
}

export function toDomainCorrection(
  row: DbCorrection,
): ReviewPublicationOutcomeCorrection {
  if (row.priorOutcome !== DbTerminalOutcome.terminal_unknown) {
    throw new Error("publication_correction_prior_outcome_invalid");
  }
  return {
    correctionId: row.correctionId,
    publicationAttemptId: row.publicationAttemptId,
    correctionOrdinal: row.correctionOrdinal,
    priorOutcome: ReviewPublicationTerminalOutcome.TerminalUnknown,
    correctedOutcome: toCorrectedDomainOutcome(row.correctedOutcome),
    evidenceHash: row.evidenceHash,
    safeReason: toDomainCorrectionReason(row.safeReason),
    correctedBy: row.correctedBy,
    correctedAt: new Date(row.correctedAt),
    retainUntil: new Date(row.retainUntil),
  };
}

export function toDbAttemptState(
  value: ReviewPublicationAttemptState,
): DbAttemptState {
  switch (value) {
    case ReviewPublicationAttemptState.Pending:
      return DbAttemptState.pending;
    case ReviewPublicationAttemptState.Publishing:
      return DbAttemptState.publishing;
    case ReviewPublicationAttemptState.Reconciling:
      return DbAttemptState.reconciling;
    case ReviewPublicationAttemptState.Terminal:
      return DbAttemptState.terminal;
  }
}

export function toDbClaimState(
  value: ReviewPublicationClaimState,
): DbClaimState {
  switch (value) {
    case ReviewPublicationClaimState.Active:
      return DbClaimState.active;
    case ReviewPublicationClaimState.Expired:
      return DbClaimState.expired;
    case ReviewPublicationClaimState.Released:
      return DbClaimState.released;
    case ReviewPublicationClaimState.Revoked:
      return DbClaimState.revoked;
  }
}

export function toDbPublicationKind(
  value: ReviewPublicationKind,
): DbPublicationKind {
  switch (value) {
    case ReviewPublicationKind.Summary:
      return DbPublicationKind.summary;
    case ReviewPublicationKind.ManagedCheck:
      return DbPublicationKind.managed_check;
    case ReviewPublicationKind.PendingReviewCreate:
      return DbPublicationKind.pending_review_create;
    case ReviewPublicationKind.PendingReviewSubmit:
      return DbPublicationKind.pending_review_submit;
    case ReviewPublicationKind.SubmittedReview:
      return DbPublicationKind.submitted_review;
    case ReviewPublicationKind.ThreadLifecycle:
      return DbPublicationKind.thread_lifecycle;
  }
}

export function toDbEffectStrategy(
  value: ReviewPublicationEffectStrategy,
): DbEffectStrategy {
  switch (value) {
    case ReviewPublicationEffectStrategy.MutableSingleton:
      return DbEffectStrategy.mutable_singleton;
    case ReviewPublicationEffectStrategy.PendingThenSubmit:
      return DbEffectStrategy.pending_then_submit;
    case ReviewPublicationEffectStrategy.AppendOnlyCanonicalReceipt:
      return DbEffectStrategy.append_only_canonical_receipt;
    case ReviewPublicationEffectStrategy.ReversibleLifecycle:
      return DbEffectStrategy.reversible_lifecycle;
  }
}

export function toDbOperationRole(
  value: ReviewPublicationOperationRole,
): DbOperationRole {
  switch (value) {
    case ReviewPublicationOperationRole.Standalone:
      return DbOperationRole.standalone;
    case ReviewPublicationOperationRole.PendingReviewCreate:
      return DbOperationRole.pending_review_create;
    case ReviewPublicationOperationRole.PendingReviewSubmit:
      return DbOperationRole.pending_review_submit;
  }
}

export function toDbOperationState(
  value: ReviewPublicationOperationState,
): DbOperationState {
  switch (value) {
    case ReviewPublicationOperationState.Planned:
      return DbOperationState.planned;
    case ReviewPublicationOperationState.InFlight:
      return DbOperationState.in_flight;
    case ReviewPublicationOperationState.EffectObserved:
      return DbOperationState.effect_observed;
    case ReviewPublicationOperationState.Reconciling:
      return DbOperationState.reconciling;
    case ReviewPublicationOperationState.Completed:
      return DbOperationState.completed;
    case ReviewPublicationOperationState.SupersededNoEffect:
      return DbOperationState.superseded_no_effect;
    case ReviewPublicationOperationState.FailedNoEffect:
      return DbOperationState.failed_no_effect;
    case ReviewPublicationOperationState.StaleCompensated:
      return DbOperationState.stale_compensated;
    case ReviewPublicationOperationState.StaleVisible:
      return DbOperationState.stale_visible;
    case ReviewPublicationOperationState.TerminalUnknown:
      return DbOperationState.terminal_unknown;
  }
}

export function toDbOperationAttemptState(
  value: ReviewPublicationOperationAttemptState,
): DbOperationAttemptState {
  switch (value) {
    case ReviewPublicationOperationAttemptState.Active:
      return DbOperationAttemptState.active;
    case ReviewPublicationOperationAttemptState.EffectObserved:
      return DbOperationAttemptState.effect_observed;
    case ReviewPublicationOperationAttemptState.NoEffectProven:
      return DbOperationAttemptState.no_effect_proven;
    case ReviewPublicationOperationAttemptState.Completed:
      return DbOperationAttemptState.completed;
    case ReviewPublicationOperationAttemptState.Stale:
      return DbOperationAttemptState.stale;
    case ReviewPublicationOperationAttemptState.TerminalUnknown:
      return DbOperationAttemptState.terminal_unknown;
  }
}

export function toDbEffectKind(
  value: ReviewPublicationExternalEffectKind,
): DbEffectKind {
  switch (value) {
    case ReviewPublicationExternalEffectKind.MutationAcknowledged:
      return DbEffectKind.mutation_acknowledged;
    case ReviewPublicationExternalEffectKind.MarkerReconciled:
      return DbEffectKind.marker_reconciled;
    case ReviewPublicationExternalEffectKind.LifecycleCompensated:
      return DbEffectKind.lifecycle_compensated;
  }
}

export function toDbTerminalOutcome(
  value: ReviewPublicationTerminalOutcome,
): DbTerminalOutcome {
  switch (value) {
    case ReviewPublicationTerminalOutcome.Succeeded:
      return DbTerminalOutcome.succeeded;
    case ReviewPublicationTerminalOutcome.SupersededNoEffect:
      return DbTerminalOutcome.superseded_no_effect;
    case ReviewPublicationTerminalOutcome.FailedNoEffect:
      return DbTerminalOutcome.failed_no_effect;
    case ReviewPublicationTerminalOutcome.StaleCompensated:
      return DbTerminalOutcome.stale_compensated;
    case ReviewPublicationTerminalOutcome.StaleVisible:
      return DbTerminalOutcome.stale_visible;
    case ReviewPublicationTerminalOutcome.TerminalUnknown:
      return DbTerminalOutcome.terminal_unknown;
  }
}

function toDomainAttemptState(
  value: DbAttemptState,
): ReviewPublicationAttemptState {
  switch (value) {
    case DbAttemptState.pending:
      return ReviewPublicationAttemptState.Pending;
    case DbAttemptState.publishing:
      return ReviewPublicationAttemptState.Publishing;
    case DbAttemptState.reconciling:
      return ReviewPublicationAttemptState.Reconciling;
    case DbAttemptState.terminal:
      return ReviewPublicationAttemptState.Terminal;
  }
}

function toDomainClaimState(value: DbClaimState): ReviewPublicationClaimState {
  switch (value) {
    case DbClaimState.active:
      return ReviewPublicationClaimState.Active;
    case DbClaimState.expired:
      return ReviewPublicationClaimState.Expired;
    case DbClaimState.released:
      return ReviewPublicationClaimState.Released;
    case DbClaimState.revoked:
      return ReviewPublicationClaimState.Revoked;
  }
}

function toDomainPublicationKind(
  value: DbPublicationKind,
): ReviewPublicationKind {
  switch (value) {
    case DbPublicationKind.summary:
      return ReviewPublicationKind.Summary;
    case DbPublicationKind.managed_check:
      return ReviewPublicationKind.ManagedCheck;
    case DbPublicationKind.pending_review_create:
      return ReviewPublicationKind.PendingReviewCreate;
    case DbPublicationKind.pending_review_submit:
      return ReviewPublicationKind.PendingReviewSubmit;
    case DbPublicationKind.submitted_review:
      return ReviewPublicationKind.SubmittedReview;
    case DbPublicationKind.thread_lifecycle:
      return ReviewPublicationKind.ThreadLifecycle;
  }
}

function toDomainEffectStrategy(
  value: DbEffectStrategy,
): ReviewPublicationEffectStrategy {
  switch (value) {
    case DbEffectStrategy.mutable_singleton:
      return ReviewPublicationEffectStrategy.MutableSingleton;
    case DbEffectStrategy.pending_then_submit:
      return ReviewPublicationEffectStrategy.PendingThenSubmit;
    case DbEffectStrategy.append_only_canonical_receipt:
      return ReviewPublicationEffectStrategy.AppendOnlyCanonicalReceipt;
    case DbEffectStrategy.reversible_lifecycle:
      return ReviewPublicationEffectStrategy.ReversibleLifecycle;
  }
}

function toDomainOperationRole(
  value: DbOperationRole,
): ReviewPublicationOperationRole {
  switch (value) {
    case DbOperationRole.standalone:
      return ReviewPublicationOperationRole.Standalone;
    case DbOperationRole.pending_review_create:
      return ReviewPublicationOperationRole.PendingReviewCreate;
    case DbOperationRole.pending_review_submit:
      return ReviewPublicationOperationRole.PendingReviewSubmit;
  }
}

function toDomainOperationState(
  value: DbOperationState,
): ReviewPublicationOperationState {
  switch (value) {
    case DbOperationState.planned:
      return ReviewPublicationOperationState.Planned;
    case DbOperationState.in_flight:
      return ReviewPublicationOperationState.InFlight;
    case DbOperationState.effect_observed:
      return ReviewPublicationOperationState.EffectObserved;
    case DbOperationState.reconciling:
      return ReviewPublicationOperationState.Reconciling;
    case DbOperationState.completed:
      return ReviewPublicationOperationState.Completed;
    case DbOperationState.superseded_no_effect:
      return ReviewPublicationOperationState.SupersededNoEffect;
    case DbOperationState.failed_no_effect:
      return ReviewPublicationOperationState.FailedNoEffect;
    case DbOperationState.stale_compensated:
      return ReviewPublicationOperationState.StaleCompensated;
    case DbOperationState.stale_visible:
      return ReviewPublicationOperationState.StaleVisible;
    case DbOperationState.terminal_unknown:
      return ReviewPublicationOperationState.TerminalUnknown;
  }
}

function toDomainOperationAttemptState(
  value: DbOperationAttemptState,
): ReviewPublicationOperationAttemptState {
  switch (value) {
    case DbOperationAttemptState.active:
      return ReviewPublicationOperationAttemptState.Active;
    case DbOperationAttemptState.effect_observed:
      return ReviewPublicationOperationAttemptState.EffectObserved;
    case DbOperationAttemptState.no_effect_proven:
      return ReviewPublicationOperationAttemptState.NoEffectProven;
    case DbOperationAttemptState.completed:
      return ReviewPublicationOperationAttemptState.Completed;
    case DbOperationAttemptState.stale:
      return ReviewPublicationOperationAttemptState.Stale;
    case DbOperationAttemptState.terminal_unknown:
      return ReviewPublicationOperationAttemptState.TerminalUnknown;
  }
}

function toDomainEffectKind(
  value: DbEffectKind,
): ReviewPublicationExternalEffectKind {
  switch (value) {
    case DbEffectKind.mutation_acknowledged:
      return ReviewPublicationExternalEffectKind.MutationAcknowledged;
    case DbEffectKind.marker_reconciled:
      return ReviewPublicationExternalEffectKind.MarkerReconciled;
    case DbEffectKind.lifecycle_compensated:
      return ReviewPublicationExternalEffectKind.LifecycleCompensated;
  }
}

function toDomainTerminalOutcome(
  value: DbTerminalOutcome,
): ReviewPublicationTerminalOutcome {
  switch (value) {
    case DbTerminalOutcome.succeeded:
      return ReviewPublicationTerminalOutcome.Succeeded;
    case DbTerminalOutcome.superseded_no_effect:
      return ReviewPublicationTerminalOutcome.SupersededNoEffect;
    case DbTerminalOutcome.failed_no_effect:
      return ReviewPublicationTerminalOutcome.FailedNoEffect;
    case DbTerminalOutcome.stale_compensated:
      return ReviewPublicationTerminalOutcome.StaleCompensated;
    case DbTerminalOutcome.stale_visible:
      return ReviewPublicationTerminalOutcome.StaleVisible;
    case DbTerminalOutcome.terminal_unknown:
      return ReviewPublicationTerminalOutcome.TerminalUnknown;
  }
}

function toDomainTombstoneOutcome(
  value: DbTerminalOutcome,
): ReviewPublicationAuditTombstone["finalOutcome"] {
  switch (value) {
    case DbTerminalOutcome.succeeded:
      throw new Error("publication_tombstone_outcome_invalid");
    case DbTerminalOutcome.superseded_no_effect:
      return ReviewPublicationTerminalOutcome.SupersededNoEffect;
    case DbTerminalOutcome.failed_no_effect:
      return ReviewPublicationTerminalOutcome.FailedNoEffect;
    case DbTerminalOutcome.stale_compensated:
      return ReviewPublicationTerminalOutcome.StaleCompensated;
    case DbTerminalOutcome.stale_visible:
      return ReviewPublicationTerminalOutcome.StaleVisible;
    case DbTerminalOutcome.terminal_unknown:
      return ReviewPublicationTerminalOutcome.TerminalUnknown;
  }
}

function toCorrectedDomainOutcome(
  value: DbTerminalOutcome,
): ReviewPublicationOutcomeCorrection["correctedOutcome"] {
  switch (value) {
    case DbTerminalOutcome.succeeded:
      return ReviewPublicationTerminalOutcome.Succeeded;
    case DbTerminalOutcome.stale_compensated:
      return ReviewPublicationTerminalOutcome.StaleCompensated;
    case DbTerminalOutcome.stale_visible:
      return ReviewPublicationTerminalOutcome.StaleVisible;
    case DbTerminalOutcome.superseded_no_effect:
    case DbTerminalOutcome.failed_no_effect:
    case DbTerminalOutcome.terminal_unknown:
      throw new Error("publication_correction_outcome_invalid");
  }
}

function toDomainReceiptStatus(value: string): ReviewPublicationReceiptStatus {
  switch (value) {
    case ReviewPublicationReceiptStatus.Succeeded:
      return ReviewPublicationReceiptStatus.Succeeded;
    case ReviewPublicationReceiptStatus.Compensated:
      return ReviewPublicationReceiptStatus.Compensated;
    case ReviewPublicationReceiptStatus.StaleVisible:
      return ReviewPublicationReceiptStatus.StaleVisible;
    default:
      throw new Error("publication_receipt_status_invalid");
  }
}

function toDomainCorrectionReason(
  value: string,
): ReviewPublicationCorrectionReason {
  switch (value) {
    case ReviewPublicationCorrectionReason.CanonicalEffectsProven:
      return ReviewPublicationCorrectionReason.CanonicalEffectsProven;
    case ReviewPublicationCorrectionReason.StaleEffectCompensated:
      return ReviewPublicationCorrectionReason.StaleEffectCompensated;
    case ReviewPublicationCorrectionReason.StaleEffectVisible:
      return ReviewPublicationCorrectionReason.StaleEffectVisible;
    default:
      throw new Error("publication_correction_reason_invalid");
  }
}
