import type {
  ReviewExecutionScope,
  ReviewRevision,
} from "../../domain/review-execution";
import type {
  ReviewRequestAdmissionState,
  ReviewRequestedIntent,
  ReviewRequestedIntentCandidate,
  ReviewRequestedIntentState,
  ReviewRequestedIntentTerminalReason,
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

export enum ReviewRequestedDispatchSubmissionStatus {
  Accepted = "accepted",
  DefinitelyNoEffect = "definitely_no_effect",
}

export enum ReviewRequestedDispatchLookupStatus {
  Found = "found",
  Absent = "absent",
  Inconclusive = "inconclusive",
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

export type BeginReviewRequestedSubmissionCommand = ReviewRequestedClaimTerm & {
  readonly now: Date;
  readonly nextResolutionAt: Date;
  readonly resolutionDeadlineAt: Date;
};

export type RecordReviewRequestedDispatchCommand = ReviewRequestedClaimTerm & {
  readonly sourceRunId: string;
  readonly sourceRunAttempt: string;
  readonly now: Date;
  readonly nextResolutionAt: Date;
  readonly resolutionDeadlineAt: Date;
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

export type RecordReviewRequestedAdmissionDecisionCommand = {
  readonly requestId: string;
  readonly expectedVersion: bigint;
  readonly changedLines: number;
  readonly maxChangedLines: number;
  readonly policySnapshotId: string;
  readonly decisionHash: string;
  readonly verdict:
    | ReviewRequestAdmissionState.Admitted
    | ReviewRequestAdmissionState.Rejected;
  readonly now: Date;
};

export type CancelReviewRequestedPreAdmissionCommand = ReviewExecutionScope & {
  readonly now: Date;
};

export type RecoverReviewRequestedDispatchCommand = {
  readonly requestId: string;
  readonly expectedVersion: bigint;
  readonly sourceRunId: string | null;
  readonly sourceRunAttempt: string | null;
  readonly now: Date;
  readonly terminalReason: ReviewRequestedIntentTerminalReason | null;
  readonly successorCandidate: ReviewRequestedIntentCandidate | null;
};

export type DeferReviewRequestedResolutionCommand = {
  readonly requestId: string;
  readonly expectedVersion: bigint;
  readonly expectedState:
    | ReviewRequestedIntentState.ReconcilingDispatch
    | ReviewRequestedIntentState.AwaitingAuthorization;
  readonly now: Date;
  readonly nextResolutionAt: Date;
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
  listDueForResolution(input: {
    readonly now: Date;
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
  beginSubmission(command: BeginReviewRequestedSubmissionCommand): Promise<{
    readonly status: ReviewRequestedTransitionStatus;
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
  recordAdmissionDecision(
    command: RecordReviewRequestedAdmissionDecisionCommand,
  ): Promise<{
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
  deferResolution(command: DeferReviewRequestedResolutionCommand): Promise<{
    readonly status: ReviewRequestedTransitionStatus;
    readonly intent?: ReviewRequestedIntent | undefined;
  }>;
}

export interface ReviewRequestedIntentPrunerPort {
  pruneRetainedIntents(input: { readonly limit: number }): Promise<number>;
}

export type ReviewRequestedDispatchSubmissionResult =
  | {
      readonly status: ReviewRequestedDispatchSubmissionStatus.Accepted;
      readonly sourceRunId: string;
      readonly sourceRunAttempt: string;
    }
  | {
      readonly status: ReviewRequestedDispatchSubmissionStatus.DefinitelyNoEffect;
    };

export interface ReviewRequestedPreparedDispatchPort {
  /** The only potentially effect-bearing call on a fully prepared dispatch. */
  submit(): Promise<ReviewRequestedDispatchSubmissionResult>;
}

export interface ReviewRequestedDispatchGatewayPort {
  /** Resolve repository, credentials, and transport before durable submission. */
  prepare(input: {
    readonly intent: ReviewRequestedIntent;
  }): Promise<ReviewRequestedPreparedDispatchPort>;
  findByRequestIdentity(input: {
    readonly intent: ReviewRequestedIntent;
  }): Promise<
    | {
        readonly status: ReviewRequestedDispatchLookupStatus.Found;
        readonly sourceRunId: string;
        readonly sourceRunAttempt: string;
      }
    | {
        readonly status:
          | ReviewRequestedDispatchLookupStatus.Absent
          | ReviewRequestedDispatchLookupStatus.Inconclusive;
      }
  >;
  inspectKnownRun(input: { readonly intent: ReviewRequestedIntent }): Promise<{
    readonly status: ReviewRequestedDispatchRunStatus;
  }>;
  cancelKnownRun(input: {
    readonly intent: ReviewRequestedIntent;
  }): Promise<void>;
}
