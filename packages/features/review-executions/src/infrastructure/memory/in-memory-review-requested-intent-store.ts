import {
  ReviewRequestedClaimStatus,
  ReviewRequestedRegisterStatus,
  ReviewRequestedTransitionStatus,
  type ClaimReviewRequestedIntentCommand,
  type LinkReviewRequestedAdmissionCommand,
  type RecordReviewRequestedDispatchCommand,
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
  ReviewRequestedClaimDecisionStatus,
  ReviewRequestedRegistrationDecisionStatus,
  ReviewRequestedTransitionDecisionStatus,
  ReviewRequestedIntentState,
  assessReviewRequestedClaim,
  claimReviewRequestedIntent,
  decideReviewRequestedAdmissionLink,
  decideReviewRequestedDispatch,
  decideReviewRequestedRegistration,
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
          intent.state === ReviewRequestedIntentState.PendingDispatch &&
          intent.notBefore <= input.now,
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

  async registerIntent(command: RegisterReviewRequestedIntentCommand) {
    return this.atomic(() => {
      const candidate = command.candidate;
      const deliveryRequestId = this.deliveryIndex.get(
        candidate.deliveryIdentityHash,
      );
      const key = scopeKey(candidate);
      const oldPendingId = this.pendingByScope.get(key) ?? null;
      const decision = decideReviewRequestedRegistration({
        candidate,
        existingByDelivery: deliveryRequestId
          ? requiredIntent(this.intents, deliveryRequestId)
          : null,
        existingByRequestId: this.intents.get(candidate.requestId) ?? null,
        pendingInScope: oldPendingId
          ? requiredIntent(this.intents, oldPendingId)
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
      this.pendingByScope.set(key, intent.requestId);
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

  async recordDispatch(command: RecordReviewRequestedDispatchCommand) {
    return this.atomic(() => {
      const intent = this.intents.get(command.requestId);
      if (!intent) {
        return { status: ReviewRequestedTransitionStatus.Missing };
      }
      const decision = decideReviewRequestedDispatch({ intent, ...command });
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

function cloneIntent(intent: ReviewRequestedIntent): ReviewRequestedIntent {
  return {
    ...intent,
    revision: { ...intent.revision },
    notBefore: new Date(intent.notBefore),
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
