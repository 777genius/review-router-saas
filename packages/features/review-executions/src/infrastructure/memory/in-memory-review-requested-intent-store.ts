import {
  ReviewRequestedClaimStatus,
  ReviewRequestedRegisterStatus,
  ReviewRequestedTransitionStatus,
  type BeginReviewRequestedSubmissionCommand,
  type ClaimReviewRequestedIntentCommand,
  type CancelReviewRequestedPreAdmissionCommand,
  type DeferReviewRequestedResolutionCommand,
  type LinkReviewRequestedAdmissionCommand,
  type RecordReviewRequestedAdmissionDecisionCommand,
  type RecordReviewRequestedDispatchCommand,
  type RecoverReviewRequestedDispatchCommand,
  type RegisterReviewRequestedIntentCommand,
  type ReviewRequestedIntentCommandPort,
  type ReviewRequestedIntentPrunerPort,
  type ReviewRequestedIntentQueryPort,
} from "../../application/ports/review-requested-intent-ports";
import type { ReviewExecutionFencingTokenSourcePort } from "../../application/ports/review-execution-ports";
import {
  assertDate,
  scopeKey,
  type ReviewExecutionScope,
} from "../../domain/review-execution";
import {
  cancelReviewRequestedPreAdmissionIntent,
  ReviewRequestedClaimDecisionStatus,
  ReviewRequestedDispatchRecoveryDecisionStatus,
  ReviewRequestAdmissionState,
  ReviewRequestedRegistrationDecisionStatus,
  ReviewRequestedTransitionDecisionStatus,
  ReviewRequestedIntentState,
  assessReviewRequestedClaim,
  beginReviewRequestedSubmission,
  claimReviewRequestedIntent,
  decideReviewRequestedAdmission,
  decideReviewRequestedAdmissionLink,
  decideReviewRequestedDispatch,
  decideReviewRequestedDispatchRecovery,
  decideReviewRequestedRegistration,
  deferReviewRequestedResolution,
  type ReviewRequestedIntent,
} from "../../domain/review-requested-intent";
import { MonotonicBigIntFencingTokenSource } from "./monotonic-bigint-fencing-token-source";

export class InMemoryReviewRequestedIntentStore
  implements
    ReviewRequestedIntentQueryPort,
    ReviewRequestedIntentCommandPort,
    ReviewRequestedIntentPrunerPort
{
  private readonly intents = new Map<string, ReviewRequestedIntent>();
  private readonly deliveryIndex = new Map<string, string>();
  private readonly pendingByScope = new Map<string, string>();
  private transactionTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly fencingTokens: ReviewExecutionFencingTokenSourcePort = new MonotonicBigIntFencingTokenSource(),
  ) {}

  async findByRequestId(
    requestId: string,
  ): Promise<ReviewRequestedIntent | null> {
    await this.transactionTail;
    const intent = this.intents.get(requestId);
    return intent ? cloneIntent(intent) : null;
  }

  async findByDeliveryIdentity(
    deliveryIdentityHash: string,
  ): Promise<ReviewRequestedIntent | null> {
    await this.transactionTail;
    const requestId = this.deliveryIndex.get(deliveryIdentityHash);
    const intent = requestId ? this.intents.get(requestId) : undefined;
    return intent ? cloneIntent(intent) : null;
  }

  async findPendingByScope(
    scope: ReviewExecutionScope,
  ): Promise<ReviewRequestedIntent | null> {
    await this.transactionTail;
    const requestId = this.pendingByScope.get(scopeKey(scope));
    const intent = requestId ? this.intents.get(requestId) : undefined;
    return intent ? cloneIntent(intent) : null;
  }

  async findBySourceRunIdentity(input: {
    readonly workspaceId: string;
    readonly repositoryConnectionId: string;
    readonly scmRepositoryIdentityId: string;
    readonly pullRequestNumber: number;
    readonly sourceRunId: string;
    readonly sourceRunAttempt: string;
  }): Promise<ReviewRequestedIntent | null> {
    await this.transactionTail;
    const matched = [...this.intents.values()].filter(
      (intent) =>
        scopeKey(intent) === scopeKey(input) &&
        intent.sourceRunId === input.sourceRunId &&
        intent.sourceRunAttempt === input.sourceRunAttempt,
    );
    if (matched.length > 1) {
      throw new Error("review_requested_source_run_identity_corrupted");
    }
    return matched[0] ? cloneIntent(matched[0]) : null;
  }

  async findByRepositorySourceRunIdentity(input: {
    readonly repositoryConnectionId: string;
    readonly sourceRunId: string;
    readonly sourceRunAttempt: string;
  }): Promise<ReviewRequestedIntent | null> {
    await this.transactionTail;
    const matched = [...this.intents.values()].filter(
      (intent) =>
        intent.repositoryConnectionId === input.repositoryConnectionId &&
        intent.sourceRunId === input.sourceRunId &&
        intent.sourceRunAttempt === input.sourceRunAttempt,
    );
    if (matched.length > 1) {
      throw new Error("review_requested_source_run_identity_corrupted");
    }
    return matched[0] ? cloneIntent(matched[0]) : null;
  }

  async listDue(input: {
    readonly now: Date;
    readonly limit: number;
  }): Promise<readonly ReviewRequestedIntent[]> {
    await this.transactionTail;
    assertDate(input.now, "review_requested_due_now");
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit <= 0 ||
      input.limit > 1_000
    ) {
      throw new Error("review_requested_invalid_due_limit");
    }
    return [...this.intents.values()]
      .filter(
        (intent) =>
          (intent.state === ReviewRequestedIntentState.PendingDispatch &&
            intent.notBefore <= input.now) ||
          (intent.state === ReviewRequestedIntentState.Dispatching &&
            intent.claim !== null &&
            intent.claim.claimUntil <= input.now),
      )
      .sort(
        (left, right) =>
          left.notBefore.getTime() - right.notBefore.getTime() ||
          left.createdAt.getTime() - right.createdAt.getTime() ||
          left.requestId.localeCompare(right.requestId),
      )
      .slice(0, input.limit)
      .map(cloneIntent);
  }

  async listDueForResolution(input: {
    readonly now: Date;
    readonly limit: number;
  }): Promise<readonly ReviewRequestedIntent[]> {
    await this.transactionTail;
    assertDate(input.now, "review_requested_resolution_now");
    assertListBounds(input.limit);
    return [...this.intents.values()]
      .filter(
        (intent) =>
          (intent.state === ReviewRequestedIntentState.ReconcilingDispatch ||
            intent.state ===
              ReviewRequestedIntentState.AwaitingAuthorization) &&
          intent.nextResolutionAt !== null &&
          intent.nextResolutionAt <= input.now,
      )
      .sort(
        (left, right) =>
          requiredResolutionDate(left).getTime() -
            requiredResolutionDate(right).getTime() ||
          left.requestId.localeCompare(right.requestId),
      )
      .slice(0, input.limit)
      .map(cloneIntent);
  }

  async registerIntent(command: RegisterReviewRequestedIntentCommand) {
    return this.atomic(() => {
      const candidate = command.candidate;
      const deliveryRequestId = this.deliveryIndex.get(
        candidate.deliveryIdentityHash,
      );
      const key = scopeKey(candidate);
      const oldPendingId = this.pendingByScope.get(key) ?? null;
      const preAdmissionId =
        oldPendingId ??
        [...this.intents.values()].find(
          (intent) =>
            scopeKey(intent) === key &&
            (intent.state === ReviewRequestedIntentState.Dispatching ||
              intent.state === ReviewRequestedIntentState.ReconcilingDispatch ||
              intent.state ===
                ReviewRequestedIntentState.AwaitingAuthorization),
        )?.requestId ??
        null;
      const decision = decideReviewRequestedRegistration({
        candidate,
        existingByDelivery: deliveryRequestId
          ? requiredIntent(this.intents, deliveryRequestId)
          : null,
        existingByRequestId: this.intents.get(candidate.requestId) ?? null,
        preAdmissionInScope: preAdmissionId
          ? requiredIntent(this.intents, preAdmissionId)
          : null,
      });
      if (
        decision.status === ReviewRequestedRegistrationDecisionStatus.Restore
      ) {
        return {
          status: ReviewRequestedRegisterStatus.Restored,
          intent: cloneIntent(decision.intent),
        };
      }
      if (
        decision.status ===
        ReviewRequestedRegistrationDecisionStatus.IdempotencyConflict
      ) {
        return {
          status: ReviewRequestedRegisterStatus.IdempotencyConflict,
          intent: cloneIntent(decision.intent),
        };
      }
      if (
        decision.status ===
        ReviewRequestedRegistrationDecisionStatus.RegisterAndSupersede
      ) {
        this.intents.set(
          decision.supersededIntent.requestId,
          decision.supersededIntent,
        );
      }
      const intent = decision.intent;
      this.intents.set(intent.requestId, intent);
      this.deliveryIndex.set(intent.deliveryIdentityHash, intent.requestId);
      if (intent.state === ReviewRequestedIntentState.PendingDispatch) {
        this.pendingByScope.set(key, intent.requestId);
      }
      return {
        status: ReviewRequestedRegisterStatus.Registered,
        intent: cloneIntent(intent),
      };
    });
  }

  async claimIntent(command: ClaimReviewRequestedIntentCommand) {
    return this.atomic(() => {
      const intent = this.intents.get(command.requestId);
      if (!intent) {
        return { status: ReviewRequestedClaimStatus.Missing };
      }
      const laneBusy = [...this.intents.values()].some(
        (candidate) =>
          candidate.requestId !== intent.requestId &&
          scopeKey(candidate) === scopeKey(intent) &&
          ((candidate.state === ReviewRequestedIntentState.Dispatching &&
            candidate.claim !== null &&
            candidate.claim.claimUntil > command.now) ||
            ((candidate.state ===
              ReviewRequestedIntentState.ReconcilingDispatch ||
              candidate.state ===
                ReviewRequestedIntentState.AwaitingAuthorization) &&
              candidate.resolutionDeadlineAt !== null &&
              candidate.resolutionDeadlineAt > command.now)),
      );
      if (laneBusy) {
        return { status: ReviewRequestedClaimStatus.Busy };
      }
      const decision = assessReviewRequestedClaim({ intent, ...command });
      if (decision === ReviewRequestedClaimDecisionStatus.Restored) {
        return {
          status: ReviewRequestedClaimStatus.Restored,
          intent: cloneIntent(intent),
        };
      }
      if (decision === ReviewRequestedClaimDecisionStatus.Busy) {
        return { status: ReviewRequestedClaimStatus.Busy };
      }
      const claimed = claimReviewRequestedIntent({
        intent,
        ...command,
        fencingToken: this.fencingTokens.next(),
      });
      this.intents.set(intent.requestId, claimed);
      this.pendingByScope.delete(scopeKey(intent));
      return {
        status: ReviewRequestedClaimStatus.Claimed,
        intent: cloneIntent(claimed),
      };
    });
  }

  async beginSubmission(command: BeginReviewRequestedSubmissionCommand) {
    return this.atomic(() => {
      const intent = this.intents.get(command.requestId);
      if (!intent) {
        return { status: ReviewRequestedTransitionStatus.Missing };
      }
      const decision = beginReviewRequestedSubmission({
        intent,
        ...command,
      });
      if (
        decision.status === ReviewRequestedTransitionDecisionStatus.Restored
      ) {
        return {
          status: ReviewRequestedTransitionStatus.Restored,
          intent: cloneIntent(decision.intent),
        };
      }
      if (
        decision.status === ReviewRequestedTransitionDecisionStatus.StaleClaim
      ) {
        return { status: ReviewRequestedTransitionStatus.StaleClaim };
      }
      if (
        decision.status === ReviewRequestedTransitionDecisionStatus.Conflict
      ) {
        return { status: ReviewRequestedTransitionStatus.Conflict };
      }
      this.intents.set(intent.requestId, decision.intent);
      return {
        status: ReviewRequestedTransitionStatus.Applied,
        intent: cloneIntent(decision.intent),
      };
    });
  }

  async recordDispatch(command: RecordReviewRequestedDispatchCommand) {
    return this.atomic(() => {
      const intent = this.intents.get(command.requestId);
      if (!intent) {
        return { status: ReviewRequestedTransitionStatus.Missing };
      }
      const sourceRunIdentityOwned = [...this.intents.values()].some(
        (candidate) =>
          candidate.requestId !== intent.requestId &&
          candidate.repositoryConnectionId === intent.repositoryConnectionId &&
          candidate.sourceRunId === command.sourceRunId &&
          candidate.sourceRunAttempt === command.sourceRunAttempt,
      );
      if (sourceRunIdentityOwned) {
        return { status: ReviewRequestedTransitionStatus.StaleClaim };
      }
      const competingPreAdmission = [...this.intents.values()].some(
        (candidate) =>
          candidate.requestId !== intent.requestId &&
          scopeKey(candidate) === scopeKey(intent) &&
          (candidate.state === ReviewRequestedIntentState.PendingDispatch ||
            candidate.state === ReviewRequestedIntentState.Dispatching ||
            candidate.state ===
              ReviewRequestedIntentState.ReconcilingDispatch ||
            candidate.state ===
              ReviewRequestedIntentState.AwaitingAuthorization),
      );
      const decision = decideReviewRequestedDispatch({
        intent,
        competingPreAdmission,
        ...command,
      });
      if (
        decision.status === ReviewRequestedTransitionDecisionStatus.Restored
      ) {
        return {
          status: ReviewRequestedTransitionStatus.Restored,
          intent: cloneIntent(decision.intent),
        };
      }
      if (
        decision.status === ReviewRequestedTransitionDecisionStatus.StaleClaim
      ) {
        return { status: ReviewRequestedTransitionStatus.StaleClaim };
      }
      if (
        decision.status === ReviewRequestedTransitionDecisionStatus.Conflict
      ) {
        return { status: ReviewRequestedTransitionStatus.Conflict };
      }
      const dispatched = decision.intent;
      this.intents.set(intent.requestId, dispatched);
      return {
        status: ReviewRequestedTransitionStatus.Applied,
        intent: cloneIntent(dispatched),
      };
    });
  }

  async linkAdmission(command: LinkReviewRequestedAdmissionCommand) {
    return this.atomic(() => {
      const intent = this.intents.get(command.requestId);
      if (!intent) {
        return { status: ReviewRequestedTransitionStatus.Missing };
      }
      const decision = decideReviewRequestedAdmissionLink({
        intent,
        ...command,
      });
      if (
        decision.status === ReviewRequestedTransitionDecisionStatus.Restored
      ) {
        return {
          status: ReviewRequestedTransitionStatus.Restored,
          intent: cloneIntent(decision.intent),
        };
      }
      if (decision.status !== ReviewRequestedTransitionDecisionStatus.Applied) {
        return { status: ReviewRequestedTransitionStatus.Conflict };
      }
      const linked = decision.intent;
      this.intents.set(intent.requestId, linked);
      return {
        status: ReviewRequestedTransitionStatus.Applied,
        intent: cloneIntent(linked),
      };
    });
  }

  async recordAdmissionDecision(
    command: RecordReviewRequestedAdmissionDecisionCommand,
  ) {
    return this.atomic(() => {
      const intent = this.intents.get(command.requestId);
      if (!intent) {
        return { status: ReviewRequestedTransitionStatus.Missing };
      }
      const decision = decideReviewRequestedAdmission({
        intent,
        ...command,
      });
      if (
        decision.status === ReviewRequestedTransitionDecisionStatus.Restored
      ) {
        return {
          status: ReviewRequestedTransitionStatus.Restored,
          intent: cloneIntent(decision.intent),
        };
      }
      if (decision.status !== ReviewRequestedTransitionDecisionStatus.Applied) {
        return { status: ReviewRequestedTransitionStatus.Conflict };
      }
      this.intents.set(intent.requestId, decision.intent);
      return {
        status: ReviewRequestedTransitionStatus.Applied,
        intent: cloneIntent(decision.intent),
      };
    });
  }

  async cancelPreAdmission(
    command: CancelReviewRequestedPreAdmissionCommand,
  ): Promise<{ readonly cancelled: number }> {
    return this.atomic(() => {
      const key = scopeKey(command);
      const cancellable = [...this.intents.values()].filter(
        (intent) =>
          scopeKey(intent) === key &&
          (intent.state === ReviewRequestedIntentState.PendingDispatch ||
            intent.state === ReviewRequestedIntentState.Dispatching ||
            intent.state === ReviewRequestedIntentState.ReconcilingDispatch ||
            (intent.state ===
              ReviewRequestedIntentState.AwaitingAuthorization &&
              intent.admission.state !== ReviewRequestAdmissionState.Admitted)),
      );
      for (const intent of cancellable) {
        this.intents.set(
          intent.requestId,
          cancelReviewRequestedPreAdmissionIntent(intent, command.now),
        );
      }
      this.pendingByScope.delete(key);
      return { cancelled: cancellable.length };
    });
  }

  async recoverDispatch(command: RecoverReviewRequestedDispatchCommand) {
    return this.atomic(() => {
      const intent = this.intents.get(command.requestId);
      if (!intent) {
        return { status: ReviewRequestedTransitionStatus.Missing };
      }
      const pendingId = this.pendingByScope.get(scopeKey(intent));
      const replacementPending =
        pendingId && pendingId !== intent.requestId
          ? requiredIntent(this.intents, pendingId)
          : null;
      const decision = decideReviewRequestedDispatchRecovery({
        intent,
        expectedVersion: command.expectedVersion,
        replacementPending,
        successorCandidate: command.successorCandidate,
        sourceRunId: command.sourceRunId,
        sourceRunAttempt: command.sourceRunAttempt,
        terminalReason: command.terminalReason,
        now: command.now,
      });
      if (
        decision.status ===
        ReviewRequestedDispatchRecoveryDecisionStatus.Conflict
      ) {
        return { status: ReviewRequestedTransitionStatus.Conflict };
      }
      if (
        decision.status ===
        ReviewRequestedDispatchRecoveryDecisionStatus.Restored
      ) {
        return {
          status: ReviewRequestedTransitionStatus.Restored,
          intent: cloneIntent(decision.intent),
        };
      }
      this.intents.set(intent.requestId, decision.intent);
      if (
        decision.status ===
        ReviewRequestedDispatchRecoveryDecisionStatus.Replaced
      ) {
        if (decision.successor === null) {
          throw new Error("review_requested_recovery_successor_missing");
        }
        this.intents.set(decision.successor.requestId, decision.successor);
        this.deliveryIndex.set(
          decision.successor.deliveryIdentityHash,
          decision.successor.requestId,
        );
        this.pendingByScope.set(
          scopeKey(decision.successor),
          decision.successor.requestId,
        );
      }
      return {
        status: ReviewRequestedTransitionStatus.Applied,
        intent: cloneIntent(decision.intent),
      };
    });
  }

  async deferResolution(command: DeferReviewRequestedResolutionCommand) {
    return this.atomic(() => {
      const intent = this.intents.get(command.requestId);
      if (!intent) {
        return { status: ReviewRequestedTransitionStatus.Missing };
      }
      const decision = deferReviewRequestedResolution({
        intent,
        ...command,
      });
      if (decision.status !== ReviewRequestedTransitionDecisionStatus.Applied) {
        return { status: ReviewRequestedTransitionStatus.Conflict };
      }
      this.intents.set(intent.requestId, decision.intent);
      return {
        status: ReviewRequestedTransitionStatus.Applied,
        intent: cloneIntent(decision.intent),
      };
    });
  }

  async pruneRetainedIntents(input: {
    readonly limit: number;
  }): Promise<number> {
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit <= 0 ||
      input.limit > 1_000
    ) {
      throw new Error("review_requested_invalid_limit");
    }
    return this.atomic(() => {
      const now = new Date();
      const referenced = new Set(
        [...this.intents.values()]
          .map((intent) => intent.supersededByRequestId)
          .filter((requestId): requestId is string => requestId !== null),
      );
      const removable = [...this.intents.values()]
        .filter(
          (intent) =>
            intent.retainUntil < now &&
            (intent.state === ReviewRequestedIntentState.Dispatched ||
              intent.state === ReviewRequestedIntentState.Terminal ||
              intent.state === ReviewRequestedIntentState.Superseded) &&
            !referenced.has(intent.requestId),
        )
        .sort(
          (left, right) =>
            left.retainUntil.getTime() - right.retainUntil.getTime() ||
            left.requestId.localeCompare(right.requestId),
        )
        .slice(0, input.limit);
      for (const intent of removable) {
        this.intents.delete(intent.requestId);
        this.deliveryIndex.delete(intent.deliveryIdentityHash);
        if (this.pendingByScope.get(scopeKey(intent)) === intent.requestId) {
          this.pendingByScope.delete(scopeKey(intent));
        }
      }
      return removable.length;
    });
  }

  private async atomic<T>(operation: () => T): Promise<T> {
    const previous = this.transactionTail;
    let release!: () => void;
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return operation();
    } finally {
      release();
    }
  }
}

function requiredIntent(
  intents: Map<string, ReviewRequestedIntent>,
  requestId: string,
): ReviewRequestedIntent {
  const intent = intents.get(requestId);
  if (!intent) {
    throw new Error("review_requested_intent_store_corrupted");
  }
  return intent;
}

function assertListBounds(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000) {
    throw new Error("review_requested_awaiting_query_invalid");
  }
}

function cloneIntent(intent: ReviewRequestedIntent): ReviewRequestedIntent {
  return {
    ...intent,
    revision: { ...intent.revision },
    admission:
      intent.admission.checkedAt === null
        ? { ...intent.admission }
        : {
            ...intent.admission,
            checkedAt: new Date(intent.admission.checkedAt),
          },
    notBefore: new Date(intent.notBefore),
    submissionStartedAt:
      intent.submissionStartedAt === null
        ? null
        : new Date(intent.submissionStartedAt),
    nextResolutionAt:
      intent.nextResolutionAt === null
        ? null
        : new Date(intent.nextResolutionAt),
    resolutionDeadlineAt:
      intent.resolutionDeadlineAt === null
        ? null
        : new Date(intent.resolutionDeadlineAt),
    claim: intent.claim
      ? {
          ...intent.claim,
          claimedAt: new Date(intent.claim.claimedAt),
          claimUntil: new Date(intent.claim.claimUntil),
        }
      : null,
    createdAt: new Date(intent.createdAt),
    updatedAt: new Date(intent.updatedAt),
    retainUntil: new Date(intent.retainUntil),
  };
}

function requiredResolutionDate(intent: ReviewRequestedIntent): Date {
  if (intent.nextResolutionAt === null) {
    throw new Error("review_requested_resolution_date_missing");
  }
  return intent.nextResolutionAt;
}
