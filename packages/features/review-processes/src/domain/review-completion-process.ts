export enum ReviewCompletionProcessState {
  AwaitingPublication = "awaiting_publication",
  PublicationInProgress = "publication_in_progress",
  AwaitingSnapshot = "awaiting_snapshot",
  Completed = "completed",
  CompletedSuperseded = "completed_superseded",
  PartialCompleted = "partial_completed",
  PublicationNotApplied = "publication_not_applied",
  PublicationStaleCompensated = "publication_stale_compensated",
  PublicationStaleVisible = "publication_stale_visible",
  BlockedPublicationUnknown = "blocked_publication_unknown",
}

export enum ReviewCompletionWakeupKind {
  ExecutionFinalized = "execution_finalized",
  PublicationChanged = "publication_changed",
  SnapshotChanged = "snapshot_changed",
  RecoveryScan = "recovery_scan",
  DueScan = "due_scan",
}

export enum ReviewCompletionSafeReason {
  AwaitingPublication = "awaiting_publication",
  PartialCoverage = "partial_coverage",
  PartialCoveragePublished = "partial_coverage_published",
  ExecutionFactsUnavailable = "execution_facts_unavailable",
  PublicationRequested = "publication_requested",
  PublicationPending = "publication_pending",
  PublicationSucceeded = "publication_succeeded",
  PublicationSupersededNoEffect = "publication_superseded_no_effect",
  PublicationFailedNoEffect = "publication_failed_no_effect",
  PublicationStaleCompensated = "publication_stale_compensated",
  PublicationStaleVisible = "publication_stale_visible",
  PublicationTerminalUnknown = "publication_terminal_unknown",
  PublicationOutcomeUnavailable = "publication_outcome_unavailable",
  PublicationCommandAmbiguous = "publication_command_ambiguous",
  SnapshotCommitted = "snapshot_committed",
  SnapshotAlreadyCurrent = "snapshot_already_current",
  SnapshotSuperseded = "snapshot_superseded",
  SnapshotOutcomeUnavailable = "snapshot_outcome_unavailable",
  SnapshotCommandAmbiguous = "snapshot_command_ambiguous",
}

export type ReviewCompletionProcess = {
  readonly executionId: string;
  readonly processVersion: bigint;
  readonly finalizedArtifactId: string;
  readonly publicationAttemptId: string | null;
  readonly snapshotCommitReceiptId: string | null;
  readonly state: ReviewCompletionProcessState;
  readonly lastWakeupKind: ReviewCompletionWakeupKind;
  readonly lastWakeupAt: Date;
  readonly nextActionAt: Date | null;
  readonly attemptCount: number;
  readonly lastSafeReason: ReviewCompletionSafeReason;
  readonly activeClaimId: string | null;
  readonly claimOwnerHash: string | null;
  readonly claimFencingToken: bigint | null;
  readonly claimUntil: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly retainUntil: Date;
};

export type CreateReviewCompletionProcessInput = {
  readonly executionId: string;
  readonly finalizedArtifactId: string;
  readonly wakeupKind: ReviewCompletionWakeupKind;
  readonly wakeupAt: Date;
  readonly retainUntil: Date;
};

export type ReviewCompletionProcessClaim = {
  readonly claimId: string;
  readonly executionId: string;
  readonly ownerIdHash: string;
  readonly fencingToken: bigint;
  readonly processVersion: bigint;
  readonly claimUntil: Date;
};

export type ReviewCompletionTransition = {
  readonly state: ReviewCompletionProcessState;
  readonly publicationAttemptId?: string | null;
  readonly snapshotCommitReceiptId?: string | null;
  readonly nextActionAt: Date | null;
  readonly lastSafeReason: ReviewCompletionSafeReason;
  readonly now: Date;
};

export function createReviewCompletionProcess(
  input: CreateReviewCompletionProcessInput,
): ReviewCompletionProcess {
  assertIdentity(input.executionId, "executionId");
  assertIdentity(input.finalizedArtifactId, "finalizedArtifactId");
  if (input.retainUntil.getTime() <= input.wakeupAt.getTime()) {
    throw new Error("review_completion_process_invalid_retention");
  }

  return {
    executionId: input.executionId,
    processVersion: 1n,
    finalizedArtifactId: input.finalizedArtifactId,
    publicationAttemptId: null,
    snapshotCommitReceiptId: null,
    state: ReviewCompletionProcessState.AwaitingPublication,
    lastWakeupKind: input.wakeupKind,
    lastWakeupAt: new Date(input.wakeupAt),
    nextActionAt: new Date(input.wakeupAt),
    attemptCount: 0,
    lastSafeReason: ReviewCompletionSafeReason.AwaitingPublication,
    activeClaimId: null,
    claimOwnerHash: null,
    claimFencingToken: null,
    claimUntil: null,
    createdAt: new Date(input.wakeupAt),
    updatedAt: new Date(input.wakeupAt),
    retainUntil: new Date(input.retainUntil),
  };
}

export function wakeReviewCompletionProcess(
  process: ReviewCompletionProcess,
  input: CreateReviewCompletionProcessInput,
): ReviewCompletionProcess {
  if (process.executionId !== input.executionId) {
    throw new Error("review_completion_process_execution_mismatch");
  }
  if (process.finalizedArtifactId !== input.finalizedArtifactId) {
    throw new Error("review_completion_process_artifact_conflict");
  }

  const isNewerWakeup =
    input.wakeupAt.getTime() > process.lastWakeupAt.getTime();
  const shouldSchedule =
    isNewerWakeup &&
    !isReviewCompletionProcessTerminal(process.state) &&
    (process.nextActionAt === null ||
      input.wakeupAt.getTime() < process.nextActionAt.getTime());
  const retainUntil =
    input.retainUntil.getTime() > process.retainUntil.getTime()
      ? input.retainUntil
      : process.retainUntil;

  if (
    !isNewerWakeup &&
    !shouldSchedule &&
    retainUntil === process.retainUntil
  ) {
    return process;
  }

  return {
    ...process,
    processVersion: process.processVersion + 1n,
    lastWakeupKind: isNewerWakeup ? input.wakeupKind : process.lastWakeupKind,
    lastWakeupAt: isNewerWakeup
      ? new Date(input.wakeupAt)
      : new Date(process.lastWakeupAt),
    nextActionAt: shouldSchedule
      ? new Date(input.wakeupAt)
      : copyDate(process.nextActionAt),
    updatedAt: isNewerWakeup
      ? new Date(input.wakeupAt)
      : new Date(process.updatedAt),
    retainUntil: new Date(retainUntil),
  };
}

export function applyReviewCompletionTransition(
  process: ReviewCompletionProcess,
  transition: ReviewCompletionTransition,
): ReviewCompletionProcess {
  if (isReviewCompletionProcessTerminal(process.state)) {
    return process;
  }
  if (
    transition.nextActionAt !== null &&
    transition.nextActionAt.getTime() < transition.now.getTime()
  ) {
    throw new Error("review_completion_process_due_time_in_past");
  }

  const next: ReviewCompletionProcess = {
    ...process,
    processVersion: process.processVersion + 1n,
    state: transition.state,
    publicationAttemptId:
      transition.publicationAttemptId === undefined
        ? process.publicationAttemptId
        : transition.publicationAttemptId,
    snapshotCommitReceiptId:
      transition.snapshotCommitReceiptId === undefined
        ? process.snapshotCommitReceiptId
        : transition.snapshotCommitReceiptId,
    nextActionAt: copyDate(transition.nextActionAt),
    attemptCount: process.attemptCount + 1,
    lastSafeReason: transition.lastSafeReason,
    activeClaimId: null,
    claimOwnerHash: null,
    claimFencingToken: null,
    claimUntil: null,
    updatedAt: new Date(transition.now),
  };
  assertTerminalScheduling(next);
  return next;
}

export function isReviewCompletionProcessTerminal(
  state: ReviewCompletionProcessState,
): boolean {
  return ![
    ReviewCompletionProcessState.AwaitingPublication,
    ReviewCompletionProcessState.PublicationInProgress,
    ReviewCompletionProcessState.AwaitingSnapshot,
  ].includes(state);
}

export function isSameReviewCompletionClaim(
  process: ReviewCompletionProcess,
  claim: ReviewCompletionProcessClaim,
): boolean {
  return (
    process.executionId === claim.executionId &&
    process.processVersion === claim.processVersion &&
    process.activeClaimId === claim.claimId &&
    process.claimOwnerHash === claim.ownerIdHash &&
    process.claimFencingToken === claim.fencingToken &&
    process.claimUntil?.getTime() === claim.claimUntil.getTime()
  );
}

function assertTerminalScheduling(process: ReviewCompletionProcess): void {
  if (
    isReviewCompletionProcessTerminal(process.state) &&
    process.nextActionAt
  ) {
    throw new Error("review_completion_process_terminal_is_scheduled");
  }
  if (
    process.state === ReviewCompletionProcessState.AwaitingSnapshot &&
    process.publicationAttemptId === null
  ) {
    throw new Error("review_completion_process_snapshot_without_publication");
  }
  if (
    [
      ReviewCompletionProcessState.Completed,
      ReviewCompletionProcessState.CompletedSuperseded,
    ].includes(process.state) &&
    process.snapshotCommitReceiptId === null
  ) {
    throw new Error("review_completion_process_completed_without_receipt");
  }
  if (
    process.state === ReviewCompletionProcessState.PartialCompleted &&
    process.publicationAttemptId === null
  ) {
    throw new Error(
      "review_completion_process_partial_completed_without_publication",
    );
  }
  if (
    process.state === ReviewCompletionProcessState.PartialCompleted &&
    process.snapshotCommitReceiptId !== null
  ) {
    throw new Error(
      "review_completion_process_partial_completed_with_snapshot",
    );
  }
}

function assertIdentity(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`review_completion_process_invalid_${field}`);
  }
}

function copyDate(value: Date | null): Date | null {
  return value ? new Date(value) : null;
}
