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
  readonly pendingInScope: ReviewRequestedIntent | null;
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
    input.pendingInScope !== null &&
    scopeKey(input.pendingInScope) !== scopeKey(input.candidate)
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
  const pending = input.pendingInScope;
  if (pending?.state === ReviewRequestedIntentState.PendingDispatch) {
    return {
      status: ReviewRequestedRegistrationDecisionStatus.RegisterAndSupersede,
      intent,
      supersededIntent: supersedeReviewRequestedIntent(
        pending,
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

function supersedeReviewRequestedIntent(
  intent: ReviewRequestedIntent,
  supersededByRequestId: string,
  now: Date,
): ReviewRequestedIntent {
  assertIdentifier(supersededByRequestId, "superseded_by_request_id");
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
