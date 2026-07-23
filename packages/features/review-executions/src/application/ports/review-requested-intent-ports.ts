import type {
  ReviewExecutionScope,
  ReviewRevision,
} from "../../domain/review-execution";
import type {
  ReviewRequestedIntent,
  ReviewRequestedIntentCandidate,
} from "../../domain/review-requested-intent";

export enum ReviewRequestedRegisterStatus {
  Registered = "registered",
  Restored = "restored",
  IdempotencyConflict = "idempotency_conflict",
}

export enum ReviewRequestedClaimStatus {
  Claimed = "claimed",
  Restored = "restored",
  Busy = "busy",
  Missing = "missing",
  StaleClaim = "stale_claim",
}

export enum ReviewRequestedTransitionStatus {
  Applied = "applied",
  Restored = "restored",
  StaleClaim = "stale_claim",
  Conflict = "conflict",
  Missing = "missing",
}

export enum ReviewRequestedDispatchRunStatus {
  Pending = "pending",
  TerminalCurrentRevision = "terminal_current_revision",
  TerminalStaleRevision = "terminal_stale_revision",
}

export type RegisterReviewRequestedIntentCommand = {
  readonly candidate: ReviewRequestedIntentCandidate;
};

export type ClaimReviewRequestedIntentCommand = {
  readonly requestId: string;
  readonly claimId: string;
  readonly ownerIdHash: string;
  readonly now: Date;
  readonly claimUntil: Date;
};

export type ReviewRequestedClaimTerm = {
  readonly requestId: string;
  readonly claimId: string;
  readonly ownerIdHash: string;
  readonly fencingToken: bigint;
};

export type RecordReviewRequestedDispatchCommand = ReviewRequestedClaimTerm & {
  readonly sourceRunId: string;
  readonly sourceRunAttempt: string;
  readonly now: Date;
};

export type LinkReviewRequestedAdmissionCommand = {
  readonly requestId: string;
  readonly sourceRunId: string;
  readonly sourceRunAttempt: string;
  readonly authorizationId: string;
  readonly executionId: string;
  readonly revision: ReviewRevision;
  readonly now: Date;
};

export type CancelReviewRequestedPreAdmissionCommand = ReviewExecutionScope & {
  readonly now: Date;
};

export type RecoverReviewRequestedDispatchCommand = {
  readonly requestId: string;
  readonly sourceRunId: string;
  readonly sourceRunAttempt: string;
  readonly now: Date;
  readonly successorCandidate: ReviewRequestedIntentCandidate | null;
};

export type ReviewRequestedSourceRunIdentity = ReviewExecutionScope & {
  readonly sourceRunId: string;
  readonly sourceRunAttempt: string;
};

export interface ReviewRequestedIntentQueryPort {
  findByRequestId(requestId: string): Promise<ReviewRequestedIntent | null>;
  findByDeliveryIdentity(
    deliveryIdentityHash: string,
  ): Promise<ReviewRequestedIntent | null>;
  findPendingByScope(
    scope: ReviewExecutionScope,
  ): Promise<ReviewRequestedIntent | null>;
  findBySourceRunIdentity(
    identity: ReviewRequestedSourceRunIdentity,
  ): Promise<ReviewRequestedIntent | null>;
  findByRepositorySourceRunIdentity(input: {
    readonly repositoryConnectionId: string;
    readonly sourceRunId: string;
    readonly sourceRunAttempt: string;
  }): Promise<ReviewRequestedIntent | null>;
  listDue(input: {
    readonly now: Date;
    readonly limit: number;
  }): Promise<readonly ReviewRequestedIntent[]>;
  listAwaitingAuthorization(input: {
    readonly now: Date;
    readonly minimumAgeMs: number;
    readonly limit: number;
  }): Promise<readonly ReviewRequestedIntent[]>;
}

export interface ReviewRequestedIntentCommandPort {
  registerIntent(command: RegisterReviewRequestedIntentCommand): Promise<{
    readonly status: ReviewRequestedRegisterStatus;
    readonly intent: ReviewRequestedIntent;
  }>;
  claimIntent(command: ClaimReviewRequestedIntentCommand): Promise<{
    readonly status: ReviewRequestedClaimStatus;
    readonly intent?: ReviewRequestedIntent | undefined;
  }>;
  recordDispatch(command: RecordReviewRequestedDispatchCommand): Promise<{
    readonly status: ReviewRequestedTransitionStatus;
    readonly intent?: ReviewRequestedIntent | undefined;
  }>;
  linkAdmission(command: LinkReviewRequestedAdmissionCommand): Promise<{
    readonly status: ReviewRequestedTransitionStatus;
    readonly intent?: ReviewRequestedIntent | undefined;
  }>;
  cancelPreAdmission(
    command: CancelReviewRequestedPreAdmissionCommand,
  ): Promise<{ readonly cancelled: number }>;
  recoverDispatch(command: RecoverReviewRequestedDispatchCommand): Promise<{
    readonly status: ReviewRequestedTransitionStatus;
    readonly intent?: ReviewRequestedIntent | undefined;
  }>;
}

export interface ReviewRequestedIntentPrunerPort {
  pruneRetainedIntents(input: { readonly limit: number }): Promise<number>;
}

export interface ReviewRequestedDispatchGatewayPort {
  dispatch(input: { readonly intent: ReviewRequestedIntent }): Promise<{
    readonly sourceRunId: string;
    readonly sourceRunAttempt: string;
  }>;
  inspect(input: { readonly intent: ReviewRequestedIntent }): Promise<{
    readonly status: ReviewRequestedDispatchRunStatus;
  }>;
}
