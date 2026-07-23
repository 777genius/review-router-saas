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
  AwaitingAuthorization = "awaiting_authorization",
  Dispatched = "dispatched",
  Superseded = "superseded",
}

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
  readonly sourceRunId: string | null;
  readonly sourceRunAttempt: string | null;
  readonly authorizationId: string | null;
  readonly executionId: string | null;
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
  Conflict = "conflict",
}

export type ReviewRequestedDispatchRecoveryDecision =
  | {
      readonly status:
        | ReviewRequestedDispatchRecoveryDecisionStatus.Replaced
        | ReviewRequestedDispatchRecoveryDecisionStatus.Superseded;
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
    sourceRunId: null,
    sourceRunAttempt: null,
    authorizationId: null,
    executionId: null,
    supersededByRequestId: null,
    createdAt: new Date(candidate.createdAt),
    updatedAt: new Date(candidate.createdAt),
    notBefore: new Date(candidate.notBefore),
    retainUntil: new Date(candidate.retainUntil),
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
    (preAdmission.state === ReviewRequestedIntentState.PendingDispatch ||
      ((preAdmission.state === ReviewRequestedIntentState.Dispatching ||
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
  readonly claimId: string;
  readonly ownerIdHash: string;
  readonly fencingToken: bigint;
  readonly sourceRunId: string;
  readonly sourceRunAttempt: string;
  readonly now: Date;
}): ReviewRequestedTransitionDecision {
  assertIdentifier(input.sourceRunId, "source_run_id");
  assertIdentifier(input.sourceRunAttempt, "source_run_attempt");
  assertDate(input.now, "dispatch_recorded_at");
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
      state: ReviewRequestedIntentState.AwaitingAuthorization,
      claim: null,
      sourceRunId: input.sourceRunId,
      sourceRunAttempt: input.sourceRunAttempt,
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
    !reviewRevisionsEqual(input.intent.revision, input.revision)
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
      updatedAt: new Date(input.now),
    },
  };
}

export function decideReviewRequestedDispatchRecovery(input: {
  readonly intent: ReviewRequestedIntent;
  readonly replacementPending: ReviewRequestedIntent | null;
  readonly successorCandidate: ReviewRequestedIntentCandidate | null;
  readonly sourceRunId: string;
  readonly sourceRunAttempt: string;
  readonly now: Date;
}): ReviewRequestedDispatchRecoveryDecision {
  assertIdentifier(input.sourceRunId, "source_run_id");
  assertIdentifier(input.sourceRunAttempt, "source_run_attempt");
  assertDate(input.now, "dispatch_recovered_at");
  if (input.successorCandidate !== null) {
    assertReviewRequestedIntentCandidate(input.successorCandidate);
  }
  if (
    input.intent.state !== ReviewRequestedIntentState.AwaitingAuthorization ||
    input.intent.sourceRunId !== input.sourceRunId ||
    input.intent.sourceRunAttempt !== input.sourceRunAttempt ||
    input.intent.authorizationId !== null ||
    input.intent.executionId !== null
  ) {
    return {
      status: ReviewRequestedDispatchRecoveryDecisionStatus.Conflict,
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

export function cancelReviewRequestedPreAdmissionIntent(
  intent: ReviewRequestedIntent,
  now: Date,
): ReviewRequestedIntent {
  if (
    intent.state !== ReviewRequestedIntentState.PendingDispatch &&
    intent.state !== ReviewRequestedIntentState.Dispatching &&
    intent.state !== ReviewRequestedIntentState.AwaitingAuthorization
  ) {
    throw new Error("review_requested_intent_not_pre_admission");
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
    supersededByRequestId,
    updatedAt: new Date(now),
  };
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
