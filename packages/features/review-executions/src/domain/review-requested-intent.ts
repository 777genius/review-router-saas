import {
  assertDate,
  assertIdentifier,
  assertReviewExecutionScope,
  assertReviewRevision,
  assertSha256,
  reviewRevisionsEqual,
  scopeKey,
  type ReviewExecutionScope,
  type ReviewRevision,
} from "./review-execution";

export enum ReviewRequestedTriggerKind {
  PullRequestSynchronized = "pull_request_synchronized",
  PullRequestReadyForReview = "pull_request_ready_for_review",
  ManualCommand = "manual_command",
  LifecycleChanged = "lifecycle_changed",
}

export enum ReviewRequestedIntentState {
  PendingDispatch = "pending_dispatch",
  Dispatching = "dispatching",
  ReconcilingDispatch = "reconciling_dispatch",
  AwaitingAuthorization = "awaiting_authorization",
  Dispatched = "dispatched",
  Terminal = "terminal",
  Superseded = "superseded",
}

export enum ReviewRequestedIntentTerminalReason {
  DispatchFailedNoEffect = "dispatch_failed_no_effect",
  DispatchOutcomeUnknown = "dispatch_outcome_unknown",
  AuthorizationDeadlineExceeded = "authorization_deadline_exceeded",
  DispatchAttemptsExhausted = "dispatch_attempts_exhausted",
  MaxChangedLinesExceeded = "max_changed_lines_exceeded",
}

export enum ReviewRequestAdmissionState {
  NotEvaluated = "not_evaluated",
  Admitted = "admitted",
  Rejected = "rejected",
}

export const reviewRequestedAdmissionHandoffMinimumMs = 30_000;

export type ReviewRequestAdmission =
  | {
      readonly state: ReviewRequestAdmissionState.NotEvaluated;
      readonly changedLines: null;
      readonly maxChangedLines: null;
      readonly policySnapshotId: null;
      readonly decisionHash: null;
      readonly checkedAt: null;
    }
  | {
      readonly state:
        | ReviewRequestAdmissionState.Admitted
        | ReviewRequestAdmissionState.Rejected;
      readonly changedLines: number;
      readonly maxChangedLines: number;
      readonly policySnapshotId: string;
      readonly decisionHash: string;
      readonly checkedAt: Date;
    };

export type ReviewRequestedClaim = {
  readonly claimId: string;
  readonly ownerIdHash: string;
  readonly fencingToken: bigint;
  readonly claimedAt: Date;
  readonly claimUntil: Date;
};

export type ReviewRequestedIntent = ReviewExecutionScope & {
  readonly requestId: string;
  readonly dispatchAttempt: number;
  readonly version: bigint;
  readonly revision: ReviewRevision;
  readonly triggerKind: ReviewRequestedTriggerKind;
  readonly deliveryIdentityHash: string;
  readonly canonicalRequestHash: string;
  readonly state: ReviewRequestedIntentState;
  readonly notBefore: Date;
  readonly claim: ReviewRequestedClaim | null;
  readonly submissionStartedAt: Date | null;
  readonly nextResolutionAt: Date | null;
  readonly resolutionDeadlineAt: Date | null;
  readonly sourceRunId: string | null;
  readonly sourceRunAttempt: string | null;
  readonly authorizationId: string | null;
  readonly executionId: string | null;
  readonly terminalReason: ReviewRequestedIntentTerminalReason | null;
  readonly admission: ReviewRequestAdmission;
  readonly supersededByRequestId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly retainUntil: Date;
};

export type ReviewRequestedIntentCandidate = ReviewExecutionScope & {
  readonly requestId: string;
  readonly dispatchAttempt?: number;
  readonly revision: ReviewRevision;
  readonly triggerKind: ReviewRequestedTriggerKind;
  readonly deliveryIdentityHash: string;
  readonly canonicalRequestHash: string;
  readonly notBefore: Date;
  readonly createdAt: Date;
  readonly retainUntil: Date;
};

export enum ReviewRequestedRegistrationDecisionStatus {
  Register = "register",
  RegisterSuperseded = "register_superseded",
  RegisterAndSupersede = "register_and_supersede",
  Restore = "restore",
  IdempotencyConflict = "idempotency_conflict",
}

export type ReviewRequestedRegistrationDecision =
  | {
      readonly status: ReviewRequestedRegistrationDecisionStatus.Register;
      readonly intent: ReviewRequestedIntent;
      readonly supersededIntent: null;
    }
  | {
      readonly status: ReviewRequestedRegistrationDecisionStatus.RegisterSuperseded;
      readonly intent: ReviewRequestedIntent;
      readonly supersededIntent: null;
    }
  | {
      readonly status: ReviewRequestedRegistrationDecisionStatus.RegisterAndSupersede;
      readonly intent: ReviewRequestedIntent;
      readonly supersededIntent: ReviewRequestedIntent;
    }
  | {
      readonly status: ReviewRequestedRegistrationDecisionStatus.Restore;
      readonly intent: ReviewRequestedIntent;
    }
  | {
      readonly status: ReviewRequestedRegistrationDecisionStatus.IdempotencyConflict;
      readonly intent: ReviewRequestedIntent;
    };

export enum ReviewRequestedClaimDecisionStatus {
  Acquire = "acquire",
  Takeover = "takeover",
  Restored = "restored",
  Busy = "busy",
}

export enum ReviewRequestedTransitionDecisionStatus {
  Applied = "applied",
  Restored = "restored",
  StaleClaim = "stale_claim",
  Conflict = "conflict",
}

export enum ReviewRequestedDispatchRecoveryDecisionStatus {
  Replaced = "replaced",
  Superseded = "superseded",
  Terminalized = "terminalized",
  Restored = "restored",
  Conflict = "conflict",
}

export type ReviewRequestedDispatchRecoveryDecision =
  | {
      readonly status:
        | ReviewRequestedDispatchRecoveryDecisionStatus.Replaced
        | ReviewRequestedDispatchRecoveryDecisionStatus.Superseded
        | ReviewRequestedDispatchRecoveryDecisionStatus.Terminalized
        | ReviewRequestedDispatchRecoveryDecisionStatus.Restored;
      readonly intent: ReviewRequestedIntent;
      readonly successor: ReviewRequestedIntent | null;
      readonly createSuccessor: boolean;
    }
  | {
      readonly status: ReviewRequestedDispatchRecoveryDecisionStatus.Conflict;
    };

export type ReviewRequestedTransitionDecision =
  | {
      readonly status: ReviewRequestedTransitionDecisionStatus.Applied;
      readonly intent: ReviewRequestedIntent;
    }
  | {
      readonly status: ReviewRequestedTransitionDecisionStatus.Restored;
      readonly intent: ReviewRequestedIntent;
    }
  | {
      readonly status: ReviewRequestedTransitionDecisionStatus.StaleClaim;
    }
  | {
      readonly status: ReviewRequestedTransitionDecisionStatus.Conflict;
    };

export function createReviewRequestedIntent(
  candidate: ReviewRequestedIntentCandidate,
): ReviewRequestedIntent {
  assertReviewRequestedIntentCandidate(candidate);
  return {
    ...candidate,
    dispatchAttempt: candidate.dispatchAttempt ?? 1,
    revision: { ...candidate.revision },
    version: 1n,
    state: ReviewRequestedIntentState.PendingDispatch,
    claim: null,
    submissionStartedAt: null,
    nextResolutionAt: null,
    resolutionDeadlineAt: null,
    sourceRunId: null,
    sourceRunAttempt: null,
    authorizationId: null,
    executionId: null,
    terminalReason: null,
    admission: {
      state: ReviewRequestAdmissionState.NotEvaluated,
      changedLines: null,
      maxChangedLines: null,
      policySnapshotId: null,
      decisionHash: null,
      checkedAt: null,
    },
    supersededByRequestId: null,
    createdAt: new Date(candidate.createdAt),
    updatedAt: new Date(candidate.createdAt),
    notBefore: new Date(candidate.notBefore),
    retainUntil: new Date(candidate.retainUntil),
  };
}

export function decideReviewRequestedAdmission(input: {
  readonly intent: ReviewRequestedIntent;
  readonly expectedVersion: bigint;
  readonly changedLines: number;
  readonly maxChangedLines: number;
  readonly policySnapshotId: string;
  readonly decisionHash: string;
  readonly verdict:
    | ReviewRequestAdmissionState.Admitted
    | ReviewRequestAdmissionState.Rejected;
  readonly now: Date;
}): ReviewRequestedTransitionDecision {
  assertDate(input.now, "review_request_admission_checked_at");
  assertIdentifier(
    input.policySnapshotId,
    "review_request_admission_policy_snapshot_id",
  );
  assertSha256(input.decisionHash, "review_request_admission_decision_hash");
  assertNonNegativeSafeInteger(
    input.changedLines,
    "review_request_admission_changed_lines",
  );
  if (
    !Number.isSafeInteger(input.maxChangedLines) ||
    input.maxChangedLines < 1
  ) {
    throw new Error("review_request_admission_max_changed_lines_invalid");
  }
  const expectedVerdict =
    input.changedLines > input.maxChangedLines
      ? ReviewRequestAdmissionState.Rejected
      : ReviewRequestAdmissionState.Admitted;
  if (input.verdict !== expectedVerdict) {
    throw new Error("review_request_admission_verdict_invalid");
  }
  const existing = input.intent.admission;
  if (existing.state !== ReviewRequestAdmissionState.NotEvaluated) {
    const exactDecision =
      existing.state === input.verdict &&
      existing.changedLines === input.changedLines &&
      existing.maxChangedLines === input.maxChangedLines &&
      existing.policySnapshotId === input.policySnapshotId &&
      existing.decisionHash === input.decisionHash;
    const decisionUsable =
      (existing.state === ReviewRequestAdmissionState.Rejected &&
        input.intent.state === ReviewRequestedIntentState.Terminal &&
        input.intent.terminalReason ===
          ReviewRequestedIntentTerminalReason.MaxChangedLinesExceeded) ||
      (input.intent.state ===
        ReviewRequestedIntentState.AwaitingAuthorization &&
        input.intent.authorizationId === null &&
        input.intent.executionId === null &&
        input.intent.resolutionDeadlineAt !== null &&
        input.intent.resolutionDeadlineAt.getTime() - input.now.getTime() >=
          reviewRequestedAdmissionHandoffMinimumMs);
    return exactDecision && decisionUsable
      ? {
          status: ReviewRequestedTransitionDecisionStatus.Restored,
          intent: input.intent,
        }
      : { status: ReviewRequestedTransitionDecisionStatus.Conflict };
  }
  if (
    input.intent.version !== input.expectedVersion ||
    input.intent.state !== ReviewRequestedIntentState.AwaitingAuthorization ||
    input.intent.authorizationId !== null ||
    input.intent.executionId !== null
  ) {
    return { status: ReviewRequestedTransitionDecisionStatus.Conflict };
  }
  if (
    input.verdict === ReviewRequestAdmissionState.Admitted &&
    (input.intent.resolutionDeadlineAt === null ||
      input.intent.resolutionDeadlineAt.getTime() - input.now.getTime() <
        reviewRequestedAdmissionHandoffMinimumMs)
  ) {
    return { status: ReviewRequestedTransitionDecisionStatus.Conflict };
  }
  const admission = {
    state: input.verdict,
    changedLines: input.changedLines,
    maxChangedLines: input.maxChangedLines,
    policySnapshotId: input.policySnapshotId,
    decisionHash: input.decisionHash,
    checkedAt: new Date(input.now),
  } as const;
  if (input.verdict === ReviewRequestAdmissionState.Admitted) {
    return {
      status: ReviewRequestedTransitionDecisionStatus.Applied,
      intent: {
        ...input.intent,
        version: input.intent.version + 1n,
        admission,
        updatedAt: new Date(input.now),
      },
    };
  }
  return {
    status: ReviewRequestedTransitionDecisionStatus.Applied,
    intent: {
      ...input.intent,
      version: input.intent.version + 1n,
      state: ReviewRequestedIntentState.Terminal,
      claim: null,
      nextResolutionAt: null,
      terminalReason:
        ReviewRequestedIntentTerminalReason.MaxChangedLinesExceeded,
      admission,
      updatedAt: new Date(input.now),
    },
  };
}

export function assertReviewRequestedIntentCandidate(
  candidate: ReviewRequestedIntentCandidate,
): void {
  assertReviewExecutionScope(candidate);
  assertIdentifier(candidate.requestId, "request_id");
  if (
    candidate.dispatchAttempt !== undefined &&
    (!Number.isSafeInteger(candidate.dispatchAttempt) ||
      candidate.dispatchAttempt <= 0 ||
      candidate.dispatchAttempt > 10)
  ) {
    throw new Error("review_requested_dispatch_attempt_invalid");
  }
  assertReviewRevision(candidate.revision);
  if (
    !Object.values(ReviewRequestedTriggerKind).includes(candidate.triggerKind)
  ) {
    throw new Error("review_requested_invalid_trigger_kind");
  }
  assertSha256(candidate.deliveryIdentityHash, "delivery_identity_hash");
  assertSha256(candidate.canonicalRequestHash, "canonical_request_hash");
  assertDate(candidate.notBefore, "not_before");
  assertDate(candidate.createdAt, "created_at");
  assertDate(candidate.retainUntil, "retain_until");
  if (candidate.notBefore < candidate.createdAt) {
    throw new Error("review_requested_not_before_precedes_creation");
  }
  if (candidate.retainUntil <= candidate.createdAt) {
    throw new Error("review_requested_invalid_retention");
  }
}

export function reviewRequestedIntentIsPending(
  intent: ReviewRequestedIntent,
): boolean {
  return intent.state === ReviewRequestedIntentState.PendingDispatch;
}

export function decideReviewRequestedRegistration(input: {
  readonly candidate: ReviewRequestedIntentCandidate;
  readonly existingByDelivery: ReviewRequestedIntent | null;
  readonly existingByRequestId: ReviewRequestedIntent | null;
  readonly preAdmissionInScope: ReviewRequestedIntent | null;
}): ReviewRequestedRegistrationDecision {
  assertReviewRequestedIntentCandidate(input.candidate);
  if (
    input.existingByDelivery !== null &&
    input.existingByDelivery.deliveryIdentityHash !==
      input.candidate.deliveryIdentityHash
  ) {
    throw new Error("review_requested_delivery_index_corrupted");
  }
  if (
    input.existingByRequestId !== null &&
    input.existingByRequestId.requestId !== input.candidate.requestId
  ) {
    throw new Error("review_requested_request_index_corrupted");
  }
  if (
    input.preAdmissionInScope !== null &&
    scopeKey(input.preAdmissionInScope) !== scopeKey(input.candidate)
  ) {
    throw new Error("review_requested_scope_index_corrupted");
  }
  if (input.existingByDelivery !== null) {
    return {
      status:
        input.existingByDelivery.canonicalRequestHash ===
        input.candidate.canonicalRequestHash
          ? ReviewRequestedRegistrationDecisionStatus.Restore
          : ReviewRequestedRegistrationDecisionStatus.IdempotencyConflict,
      intent: input.existingByDelivery,
    };
  }
  if (input.existingByRequestId !== null) {
    return {
      status: ReviewRequestedRegistrationDecisionStatus.IdempotencyConflict,
      intent: input.existingByRequestId,
    };
  }
  const intent = createReviewRequestedIntent(input.candidate);
  const preAdmission = input.preAdmissionInScope;
  if (
    preAdmission?.state === ReviewRequestedIntentState.PendingDispatch &&
    compareIngressOrder(input.candidate, preAdmission) < 0
  ) {
    return {
      status: ReviewRequestedRegistrationDecisionStatus.RegisterSuperseded,
      intent: supersedeReviewRequestedIntent(
        intent,
        preAdmission.requestId,
        input.candidate.createdAt,
      ),
      supersededIntent: null,
    };
  }
  const supersedable =
    preAdmission !== null &&
    preAdmission.admission.state !== ReviewRequestAdmissionState.Admitted &&
    (preAdmission.state === ReviewRequestedIntentState.PendingDispatch ||
      ((preAdmission.state === ReviewRequestedIntentState.Dispatching ||
        preAdmission.state === ReviewRequestedIntentState.ReconcilingDispatch ||
        preAdmission.state ===
          ReviewRequestedIntentState.AwaitingAuthorization) &&
        !reviewRevisionsEqual(
          preAdmission.revision,
          input.candidate.revision,
        )));
  if (preAdmission !== null && supersedable) {
    return {
      status: ReviewRequestedRegistrationDecisionStatus.RegisterAndSupersede,
      intent,
      supersededIntent: supersedeReviewRequestedIntent(
        preAdmission,
        intent.requestId,
        input.candidate.createdAt,
      ),
    };
  }
  return {
    status: ReviewRequestedRegistrationDecisionStatus.Register,
    intent,
    supersededIntent: null,
  };
}

function compareIngressOrder(
  candidate: ReviewRequestedIntentCandidate,
  existing: ReviewRequestedIntent,
): number {
  return (
    candidate.createdAt.getTime() - existing.createdAt.getTime() ||
    candidate.requestId.localeCompare(existing.requestId)
  );
}

export function assessReviewRequestedClaim(input: {
  readonly intent: ReviewRequestedIntent;
  readonly claimId: string;
  readonly ownerIdHash: string;
  readonly now: Date;
  readonly claimUntil: Date;
}): ReviewRequestedClaimDecisionStatus {
  assertIdentifier(input.claimId, "claim_id");
  assertIdentifier(input.ownerIdHash, "claim_owner_id_hash");
  assertDate(input.now, "claim_now");
  assertDate(input.claimUntil, "claim_until");
  if (input.claimUntil <= input.now) {
    throw new Error("review_requested_invalid_claim_deadline");
  }
  if (
    input.intent.state === ReviewRequestedIntentState.Dispatching &&
    input.intent.claim?.claimId === input.claimId &&
    input.intent.claim.ownerIdHash === input.ownerIdHash
  ) {
    return ReviewRequestedClaimDecisionStatus.Restored;
  }
  const expired =
    input.intent.state === ReviewRequestedIntentState.Dispatching &&
    input.intent.claim !== null &&
    input.intent.claim.claimUntil <= input.now;
  if (
    (input.intent.state !== ReviewRequestedIntentState.PendingDispatch &&
      !expired) ||
    (input.intent.state === ReviewRequestedIntentState.PendingDispatch &&
      input.intent.notBefore > input.now)
  ) {
    return ReviewRequestedClaimDecisionStatus.Busy;
  }
  return expired
    ? ReviewRequestedClaimDecisionStatus.Takeover
    : ReviewRequestedClaimDecisionStatus.Acquire;
}

export function claimReviewRequestedIntent(input: {
  readonly intent: ReviewRequestedIntent;
  readonly claimId: string;
  readonly ownerIdHash: string;
  readonly fencingToken: bigint;
  readonly now: Date;
  readonly claimUntil: Date;
}): ReviewRequestedIntent {
  if (input.fencingToken <= 0n) {
    throw new Error("review_requested_invalid_fencing_token");
  }
  const decision = assessReviewRequestedClaim(input);
  if (
    decision !== ReviewRequestedClaimDecisionStatus.Acquire &&
    decision !== ReviewRequestedClaimDecisionStatus.Takeover
  ) {
    throw new Error("review_requested_claim_not_allowed");
  }
  return {
    ...input.intent,
    version: input.intent.version + 1n,
    state: ReviewRequestedIntentState.Dispatching,
    claim: {
      claimId: input.claimId,
      ownerIdHash: input.ownerIdHash,
      fencingToken: input.fencingToken,
      claimedAt: new Date(input.now),
      claimUntil: new Date(input.claimUntil),
    },
    updatedAt: new Date(input.now),
  };
}

export function decideReviewRequestedDispatch(input: {
  readonly intent: ReviewRequestedIntent;
  readonly competingPreAdmission: boolean;
  readonly claimId: string;
  readonly ownerIdHash: string;
  readonly fencingToken: bigint;
  readonly sourceRunId: string;
  readonly sourceRunAttempt: string;
  readonly now: Date;
  readonly nextResolutionAt: Date;
  readonly resolutionDeadlineAt: Date;
}): ReviewRequestedTransitionDecision {
  assertIdentifier(input.sourceRunId, "source_run_id");
  assertIdentifier(input.sourceRunAttempt, "source_run_attempt");
  assertDate(input.now, "dispatch_recorded_at");
  assertResolutionWindow(
    input.now,
    input.nextResolutionAt,
    input.resolutionDeadlineAt,
  );
  if (
    input.intent.state === ReviewRequestedIntentState.AwaitingAuthorization &&
    input.intent.sourceRunId === input.sourceRunId &&
    input.intent.sourceRunAttempt === input.sourceRunAttempt
  ) {
    return {
      status: ReviewRequestedTransitionDecisionStatus.Restored,
      intent: input.intent,
    };
  }
  if (
    input.intent.state === ReviewRequestedIntentState.ReconcilingDispatch &&
    input.intent.resolutionDeadlineAt !== null &&
    input.intent.resolutionDeadlineAt <= input.now &&
    input.competingPreAdmission
  ) {
    return { status: ReviewRequestedTransitionDecisionStatus.Conflict };
  }
  const claim = input.intent.claim;
  if (
    input.intent.state !== ReviewRequestedIntentState.ReconcilingDispatch ||
    claim === null ||
    !reviewRequestedClaimMatches(input.intent, input) ||
    input.intent.submissionStartedAt === null
  ) {
    return { status: ReviewRequestedTransitionDecisionStatus.StaleClaim };
  }
  return {
    status: ReviewRequestedTransitionDecisionStatus.Applied,
    intent: {
      ...input.intent,
      version: input.intent.version + 1n,
      state: ReviewRequestedIntentState.AwaitingAuthorization,
      claim: null,
      sourceRunId: input.sourceRunId,
      sourceRunAttempt: input.sourceRunAttempt,
      nextResolutionAt: new Date(input.nextResolutionAt),
      resolutionDeadlineAt: new Date(input.resolutionDeadlineAt),
      updatedAt: new Date(input.now),
    },
  };
}

export function decideReviewRequestedAdmissionLink(input: {
  readonly intent: ReviewRequestedIntent;
  readonly sourceRunId: string;
  readonly sourceRunAttempt: string;
  readonly authorizationId: string;
  readonly executionId: string;
  readonly revision: ReviewRevision;
  readonly now: Date;
}): ReviewRequestedTransitionDecision {
  assertIdentifier(input.sourceRunId, "source_run_id");
  assertIdentifier(input.sourceRunAttempt, "source_run_attempt");
  assertIdentifier(input.authorizationId, "authorization_id");
  assertIdentifier(input.executionId, "execution_id");
  assertReviewRevision(input.revision);
  assertDate(input.now, "admission_linked_at");
  if (input.intent.state === ReviewRequestedIntentState.Dispatched) {
    return input.intent.authorizationId === input.authorizationId &&
      input.intent.executionId === input.executionId &&
      input.intent.sourceRunId === input.sourceRunId &&
      input.intent.sourceRunAttempt === input.sourceRunAttempt &&
      reviewRevisionsEqual(input.intent.revision, input.revision)
      ? {
          status: ReviewRequestedTransitionDecisionStatus.Restored,
          intent: input.intent,
        }
      : { status: ReviewRequestedTransitionDecisionStatus.Conflict };
  }
  if (
    input.intent.state !== ReviewRequestedIntentState.AwaitingAuthorization ||
    input.intent.sourceRunId !== input.sourceRunId ||
    input.intent.sourceRunAttempt !== input.sourceRunAttempt ||
    input.intent.admission.state !== ReviewRequestAdmissionState.Admitted ||
    !reviewRevisionsEqual(input.intent.revision, input.revision) ||
    input.intent.resolutionDeadlineAt === null ||
    input.intent.resolutionDeadlineAt <= input.now
  ) {
    return { status: ReviewRequestedTransitionDecisionStatus.Conflict };
  }
  return {
    status: ReviewRequestedTransitionDecisionStatus.Applied,
    intent: {
      ...input.intent,
      version: input.intent.version + 1n,
      state: ReviewRequestedIntentState.Dispatched,
      authorizationId: input.authorizationId,
      executionId: input.executionId,
      nextResolutionAt: null,
      updatedAt: new Date(input.now),
    },
  };
}

export function decideReviewRequestedDispatchRecovery(input: {
  readonly intent: ReviewRequestedIntent;
  readonly expectedVersion: bigint;
  readonly replacementPending: ReviewRequestedIntent | null;
  readonly successorCandidate: ReviewRequestedIntentCandidate | null;
  readonly sourceRunId: string | null;
  readonly sourceRunAttempt: string | null;
  readonly terminalReason: ReviewRequestedIntentTerminalReason | null;
  readonly now: Date;
}): ReviewRequestedDispatchRecoveryDecision {
  if (input.sourceRunId !== null) {
    assertIdentifier(input.sourceRunId, "source_run_id");
  }
  if (input.sourceRunAttempt !== null) {
    assertIdentifier(input.sourceRunAttempt, "source_run_attempt");
  }
  assertDate(input.now, "dispatch_recovered_at");
  if (input.successorCandidate !== null) {
    assertReviewRequestedIntentCandidate(input.successorCandidate);
  }
  if (input.intent.state === ReviewRequestedIntentState.Terminal) {
    return input.successorCandidate === null &&
      input.terminalReason === input.intent.terminalReason &&
      input.sourceRunId === input.intent.sourceRunId &&
      input.sourceRunAttempt === input.intent.sourceRunAttempt
      ? {
          status: ReviewRequestedDispatchRecoveryDecisionStatus.Restored,
          intent: input.intent,
          successor: null,
          createSuccessor: false,
        }
      : { status: ReviewRequestedDispatchRecoveryDecisionStatus.Conflict };
  }
  if (input.intent.version !== input.expectedVersion) {
    return {
      status: ReviewRequestedDispatchRecoveryDecisionStatus.Conflict,
    };
  }
  const reconciling =
    input.intent.state === ReviewRequestedIntentState.ReconcilingDispatch &&
    input.intent.sourceRunId === null &&
    input.intent.sourceRunAttempt === null &&
    input.sourceRunId === null &&
    input.sourceRunAttempt === null;
  const awaiting =
    input.intent.state === ReviewRequestedIntentState.AwaitingAuthorization &&
    input.sourceRunId !== null &&
    input.sourceRunAttempt !== null &&
    input.intent.sourceRunId === input.sourceRunId &&
    input.intent.sourceRunAttempt === input.sourceRunAttempt;
  if (
    (!reconciling && !awaiting) ||
    input.intent.authorizationId !== null ||
    input.intent.executionId !== null
  ) {
    return {
      status: ReviewRequestedDispatchRecoveryDecisionStatus.Conflict,
    };
  }
  if (input.successorCandidate === null && input.terminalReason !== null) {
    return {
      status: ReviewRequestedDispatchRecoveryDecisionStatus.Terminalized,
      intent: terminalizeReviewRequestedIntent({
        intent: input.intent,
        expectedVersion: input.expectedVersion,
        terminalReason: input.terminalReason,
        now: input.now,
      }),
      successor: null,
      createSuccessor: false,
    };
  }
  if (input.replacementPending !== null) {
    if (
      input.replacementPending.requestId === input.intent.requestId ||
      scopeKey(input.replacementPending) !== scopeKey(input.intent) ||
      input.replacementPending.state !==
        ReviewRequestedIntentState.PendingDispatch
    ) {
      throw new Error("review_requested_recovery_replacement_invalid");
    }
    return {
      status: ReviewRequestedDispatchRecoveryDecisionStatus.Superseded,
      intent: supersedeReviewRequestedIntent(
        input.intent,
        input.replacementPending.requestId,
        input.now,
      ),
      successor: input.replacementPending,
      createSuccessor: false,
    };
  }
  if (input.successorCandidate === null) {
    return {
      status: ReviewRequestedDispatchRecoveryDecisionStatus.Superseded,
      intent: supersedeReviewRequestedIntent(input.intent, null, input.now),
      successor: null,
      createSuccessor: false,
    };
  }
  const successor = createReviewRequestedIntent(input.successorCandidate);
  if (
    successor.requestId === input.intent.requestId ||
    scopeKey(successor) !== scopeKey(input.intent) ||
    !reviewRevisionsEqual(successor.revision, input.intent.revision) ||
    successor.triggerKind !== input.intent.triggerKind ||
    successor.dispatchAttempt !== input.intent.dispatchAttempt + 1
  ) {
    throw new Error("review_requested_recovery_successor_invalid");
  }
  return {
    status: ReviewRequestedDispatchRecoveryDecisionStatus.Replaced,
    intent: supersedeReviewRequestedIntent(
      input.intent,
      successor.requestId,
      input.now,
    ),
    successor,
    createSuccessor: true,
  };
}

export function beginReviewRequestedSubmission(input: {
  readonly intent: ReviewRequestedIntent;
  readonly claimId: string;
  readonly ownerIdHash: string;
  readonly fencingToken: bigint;
  readonly now: Date;
  readonly nextResolutionAt: Date;
  readonly resolutionDeadlineAt: Date;
}): ReviewRequestedTransitionDecision {
  assertDate(input.now, "submission_started_at");
  assertResolutionWindow(
    input.now,
    input.nextResolutionAt,
    input.resolutionDeadlineAt,
  );
  if (
    input.intent.state === ReviewRequestedIntentState.ReconcilingDispatch &&
    reviewRequestedClaimMatches(input.intent, input)
  ) {
    return {
      status: ReviewRequestedTransitionDecisionStatus.Restored,
      intent: input.intent,
    };
  }
  const claim = input.intent.claim;
  if (
    input.intent.state !== ReviewRequestedIntentState.Dispatching ||
    claim === null ||
    !reviewRequestedClaimMatches(input.intent, input) ||
    claim.claimUntil <= input.now
  ) {
    return { status: ReviewRequestedTransitionDecisionStatus.StaleClaim };
  }
  return {
    status: ReviewRequestedTransitionDecisionStatus.Applied,
    intent: {
      ...input.intent,
      version: input.intent.version + 1n,
      state: ReviewRequestedIntentState.ReconcilingDispatch,
      submissionStartedAt: new Date(input.now),
      nextResolutionAt: new Date(input.nextResolutionAt),
      resolutionDeadlineAt: new Date(input.resolutionDeadlineAt),
      updatedAt: new Date(input.now),
    },
  };
}

export function deferReviewRequestedResolution(input: {
  readonly intent: ReviewRequestedIntent;
  readonly expectedVersion: bigint;
  readonly expectedState:
    | ReviewRequestedIntentState.ReconcilingDispatch
    | ReviewRequestedIntentState.AwaitingAuthorization;
  readonly now: Date;
  readonly nextResolutionAt: Date;
}): ReviewRequestedTransitionDecision {
  assertDate(input.now, "resolution_deferred_at");
  assertDate(input.nextResolutionAt, "next_resolution_at");
  if (
    input.intent.version !== input.expectedVersion ||
    input.intent.state !== input.expectedState ||
    input.intent.resolutionDeadlineAt === null
  ) {
    return { status: ReviewRequestedTransitionDecisionStatus.Conflict };
  }
  if (
    input.now >= input.intent.resolutionDeadlineAt ||
    input.nextResolutionAt <= input.now ||
    input.nextResolutionAt > input.intent.resolutionDeadlineAt
  ) {
    return { status: ReviewRequestedTransitionDecisionStatus.Conflict };
  }
  return {
    status: ReviewRequestedTransitionDecisionStatus.Applied,
    intent: {
      ...input.intent,
      version: input.intent.version + 1n,
      nextResolutionAt: new Date(input.nextResolutionAt),
      updatedAt: new Date(input.now),
    },
  };
}

function terminalizeReviewRequestedIntent(input: {
  readonly intent: ReviewRequestedIntent;
  readonly expectedVersion: bigint;
  readonly terminalReason: ReviewRequestedIntentTerminalReason;
  readonly now: Date;
}): ReviewRequestedIntent {
  assertDate(input.now, "terminalized_at");
  if (input.intent.version !== input.expectedVersion) {
    throw new Error("review_requested_terminal_version_conflict");
  }
  const validReason =
    (input.intent.state === ReviewRequestedIntentState.ReconcilingDispatch &&
      (input.terminalReason ===
        ReviewRequestedIntentTerminalReason.DispatchFailedNoEffect ||
        input.terminalReason ===
          ReviewRequestedIntentTerminalReason.DispatchOutcomeUnknown ||
        input.terminalReason ===
          ReviewRequestedIntentTerminalReason.DispatchAttemptsExhausted)) ||
    (input.intent.state === ReviewRequestedIntentState.AwaitingAuthorization &&
      (input.terminalReason ===
        ReviewRequestedIntentTerminalReason.AuthorizationDeadlineExceeded ||
        input.terminalReason ===
          ReviewRequestedIntentTerminalReason.DispatchAttemptsExhausted));
  if (!validReason) {
    throw new Error("review_requested_terminal_reason_invalid");
  }
  const deadlineBound =
    input.terminalReason ===
      ReviewRequestedIntentTerminalReason.DispatchOutcomeUnknown ||
    input.terminalReason ===
      ReviewRequestedIntentTerminalReason.AuthorizationDeadlineExceeded;
  if (
    deadlineBound &&
    (input.intent.resolutionDeadlineAt === null ||
      input.now < input.intent.resolutionDeadlineAt)
  ) {
    throw new Error("review_requested_terminal_deadline_not_reached");
  }
  return {
    ...input.intent,
    version: input.intent.version + 1n,
    state: ReviewRequestedIntentState.Terminal,
    claim: null,
    nextResolutionAt: null,
    terminalReason: input.terminalReason,
    updatedAt: new Date(input.now),
  };
}

function assertNonNegativeSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field}_invalid`);
  }
}

export function cancelReviewRequestedPreAdmissionIntent(
  intent: ReviewRequestedIntent,
  now: Date,
): ReviewRequestedIntent {
  if (
    intent.state !== ReviewRequestedIntentState.PendingDispatch &&
    intent.state !== ReviewRequestedIntentState.Dispatching &&
    intent.state !== ReviewRequestedIntentState.ReconcilingDispatch &&
    intent.state !== ReviewRequestedIntentState.AwaitingAuthorization
  ) {
    throw new Error("review_requested_intent_not_pre_admission");
  }
  if (intent.admission.state === ReviewRequestAdmissionState.Admitted) {
    throw new Error("review_requested_intent_already_admitted");
  }
  return supersedeReviewRequestedIntent(intent, null, now);
}

function supersedeReviewRequestedIntent(
  intent: ReviewRequestedIntent,
  supersededByRequestId: string | null,
  now: Date,
): ReviewRequestedIntent {
  if (supersededByRequestId !== null) {
    assertIdentifier(supersededByRequestId, "superseded_by_request_id");
  }
  assertDate(now, "superseded_at");
  return {
    ...intent,
    version: intent.version + 1n,
    state: ReviewRequestedIntentState.Superseded,
    claim: null,
    nextResolutionAt: null,
    terminalReason: null,
    supersededByRequestId,
    updatedAt: new Date(now),
  };
}

function assertResolutionWindow(
  now: Date,
  nextResolutionAt: Date,
  resolutionDeadlineAt: Date,
): void {
  assertDate(nextResolutionAt, "next_resolution_at");
  assertDate(resolutionDeadlineAt, "resolution_deadline_at");
  if (nextResolutionAt <= now || resolutionDeadlineAt < nextResolutionAt) {
    throw new Error("review_requested_resolution_window_invalid");
  }
}

function reviewRequestedClaimMatches(
  intent: ReviewRequestedIntent,
  term: {
    readonly claimId: string;
    readonly ownerIdHash: string;
    readonly fencingToken: bigint;
  },
): boolean {
  return (
    intent.claim?.claimId === term.claimId &&
    intent.claim.ownerIdHash === term.ownerIdHash &&
    intent.claim.fencingToken === term.fencingToken
  );
}
