import type {
  ReviewPublicationAttempt,
  ReviewPublicationAuditTombstone,
  ReviewPublicationClaimCapabilityFacts,
  ReviewPublicationClaimTerm,
  ReviewPublicationCorrectionReason,
  ReviewPublicationExternalEffect,
  ReviewPublicationExternalEffectKind,
  ReviewPublicationOperation,
  ReviewPublicationOperationAttempt,
  ReviewPublicationOperationCapabilityFacts,
  ReviewPublicationOperationPlan,
  ReviewPublicationOutcomeCorrection,
  ReviewPublicationPermitIdentity,
  ReviewPublicationReceipt,
  ReviewPublicationReceiptStatus,
  ReviewPublicationScope,
  ReviewPublicationTerminalOutcome,
} from "../../domain/review-publication-attempt";
import type { ReviewPublicationLifecycleObservationVersion } from "../../domain/review-lifecycle-thread-state-witness";

export enum ReviewPublicationCapability {
  Request = "request_review_publication",
  Claim = "claim_review_publication",
  ClaimReconciliation = "claim_review_publication_reconciliation",
  BeginOperation = "begin_review_publication_operation",
}

export interface ReviewPublicationCapabilityGate {
  require(capability: ReviewPublicationCapability): void;
}

export interface ReviewPublicationClockPort {
  now(): Date;
}

export type ReviewPublicationAttemptView = {
  readonly attempt: ReviewPublicationAttempt;
  readonly activeClaim: ReviewPublicationClaimTerm | null;
  readonly operationAttempts: readonly ReviewPublicationOperationAttempt[];
  readonly effects: readonly ReviewPublicationExternalEffect[];
  readonly receipts: readonly ReviewPublicationReceipt[];
  readonly tombstones: readonly ReviewPublicationAuditTombstone[];
  readonly corrections: readonly ReviewPublicationOutcomeCorrection[];
};

export interface ReviewPublicationAttemptQueryPort {
  findById(
    publicationAttemptId: string,
  ): Promise<ReviewPublicationAttemptView | null>;
  findByPermitIdentity(
    permit: ReviewPublicationPermitIdentity,
  ): Promise<ReviewPublicationAttemptView | null>;
}

export interface ReviewPublicationIdempotencyQueryPort {
  findClaimByRequest(input: {
    readonly publicationAttemptId: string;
    readonly acquireRequestIdHash: string;
  }): Promise<{
    readonly requestHash: string;
    readonly attempt: ReviewPublicationAttempt;
    readonly claim: ReviewPublicationClaimTerm;
    readonly capability: ReviewPublicationClaimCapabilityFacts;
  } | null>;
  findOperationBeginByRequest(input: {
    readonly publicationAttemptId: string;
    readonly publicationOperationId: string;
    readonly claimId: string;
    readonly acquireRequestIdHash: string;
  }): Promise<{
    readonly requestHash: string;
    readonly attempt: ReviewPublicationAttempt;
    readonly operation: ReviewPublicationOperation;
    readonly operationAttempt: ReviewPublicationOperationAttempt;
    readonly capability: ReviewPublicationOperationCapabilityFacts;
  } | null>;
}

export type RequestReviewPublicationCommand = {
  readonly publicationAttemptId: string;
  readonly requestIdHash: string;
  readonly requestHash: string;
  readonly permit: ReviewPublicationPermitIdentity;
  readonly operations: readonly ReviewPublicationOperationPlan[];
  readonly createdAt: Date;
  readonly retainUntil: Date;
};

export enum RequestReviewPublicationStatus {
  Applied = "applied",
  Restored = "restored",
  RequestConflict = "request_conflict",
  IdentityConflict = "identity_conflict",
}

export type RequestReviewPublicationResult =
  | {
      readonly status:
        | RequestReviewPublicationStatus.Applied
        | RequestReviewPublicationStatus.Restored;
      readonly attempt: ReviewPublicationAttempt;
    }
  | {
      readonly status:
        | RequestReviewPublicationStatus.RequestConflict
        | RequestReviewPublicationStatus.IdentityConflict;
    };

export interface RequestReviewPublicationCommandPort {
  request(
    command: RequestReviewPublicationCommand,
  ): Promise<RequestReviewPublicationResult>;
}

export type ClaimReviewPublicationCommand = {
  readonly publicationAttemptId: string;
  readonly expectedAttemptVersion: bigint;
  readonly claimId: string;
  readonly ownerIdHash: string;
  readonly acquireRequestIdHash: string;
  readonly requestHash: string;
  readonly claimCapabilityId: string;
  readonly capabilitySigningKeyId: string;
  readonly acquiredAt: Date;
  readonly expiresAt: Date;
  readonly reportUntil: Date;
  readonly retainUntil: Date;
};

export enum ClaimReviewPublicationStatus {
  Acquired = "acquired",
  Restored = "restored",
  Missing = "missing",
  VersionConflict = "version_conflict",
  RequestConflict = "request_conflict",
  AlreadyClaimed = "already_claimed",
  Terminal = "terminal",
}

export type ClaimReviewPublicationResult =
  | {
      readonly status:
        | ClaimReviewPublicationStatus.Acquired
        | ClaimReviewPublicationStatus.Restored;
      readonly attempt: ReviewPublicationAttempt;
      readonly claim: ReviewPublicationClaimTerm;
      readonly capability: ReviewPublicationClaimCapabilityFacts;
    }
  | {
      readonly status:
        | ClaimReviewPublicationStatus.Missing
        | ClaimReviewPublicationStatus.RequestConflict
        | ClaimReviewPublicationStatus.AlreadyClaimed
        | ClaimReviewPublicationStatus.Terminal;
    }
  | {
      readonly status: ClaimReviewPublicationStatus.VersionConflict;
      readonly currentVersion: bigint;
    };

export interface ClaimReviewPublicationCommandPort {
  claim(
    command: ClaimReviewPublicationCommand,
  ): Promise<ClaimReviewPublicationResult>;
}

export type RenewReviewPublicationClaimCommand = {
  readonly publicationAttemptId: string;
  readonly claimId: string;
  readonly ownerIdHash: string;
  readonly claimFencingToken: bigint;
  readonly extendByMs: number;
  readonly minimumRemainingMs: number;
  readonly requestedAt: Date;
};

export enum RenewReviewPublicationClaimStatus {
  Renewed = "renewed",
  Missing = "missing",
  StaleClaim = "stale_claim",
  InsufficientWindow = "insufficient_window",
  Terminal = "terminal",
}

export type RenewReviewPublicationClaimResult =
  | {
      readonly status: RenewReviewPublicationClaimStatus.Renewed;
      readonly claim: ReviewPublicationClaimTerm;
    }
  | {
      readonly status: Exclude<
        RenewReviewPublicationClaimStatus,
        RenewReviewPublicationClaimStatus.Renewed
      >;
    };

export interface RenewReviewPublicationClaimCommandPort {
  renewClaim(
    command: RenewReviewPublicationClaimCommand,
  ): Promise<RenewReviewPublicationClaimResult>;
}

export type BeginReviewPublicationOperationCommand = {
  readonly publicationAttemptId: string;
  readonly publicationOperationId: string;
  readonly expectedAttemptVersion: bigint;
  readonly claimId: string;
  readonly claimFencingToken: bigint;
  readonly acquireRequestIdHash: string;
  readonly requestHash: string;
  readonly operationAttemptId: string;
  readonly operationCapabilityId: string;
  readonly capabilitySigningKeyId: string;
  readonly effectReportId: string;
  readonly startedAt: Date;
  readonly effectReportUntil: Date;
  readonly retainUntil: Date;
};

export enum BeginReviewPublicationOperationStatus {
  Begun = "begun",
  Restored = "restored",
  Missing = "missing",
  VersionConflict = "version_conflict",
  RequestConflict = "request_conflict",
  StaleClaim = "stale_claim",
  DependencyNotCompleted = "dependency_not_completed",
  OperationCompleted = "operation_completed",
  OperationInFlight = "operation_in_flight",
  Terminal = "terminal",
}

export type BeginReviewPublicationOperationResult =
  | {
      readonly status:
        | BeginReviewPublicationOperationStatus.Begun
        | BeginReviewPublicationOperationStatus.Restored;
      readonly attempt: ReviewPublicationAttempt;
      readonly operation: ReviewPublicationOperation;
      readonly operationAttempt: ReviewPublicationOperationAttempt;
      readonly capability: ReviewPublicationOperationCapabilityFacts;
    }
  | {
      readonly status:
        | BeginReviewPublicationOperationStatus.Missing
        | BeginReviewPublicationOperationStatus.RequestConflict
        | BeginReviewPublicationOperationStatus.StaleClaim
        | BeginReviewPublicationOperationStatus.DependencyNotCompleted
        | BeginReviewPublicationOperationStatus.OperationCompleted
        | BeginReviewPublicationOperationStatus.OperationInFlight
        | BeginReviewPublicationOperationStatus.Terminal;
    }
  | {
      readonly status: BeginReviewPublicationOperationStatus.VersionConflict;
      readonly currentVersion: bigint;
    };

export interface BeginReviewPublicationOperationCommandPort {
  begin(
    command: BeginReviewPublicationOperationCommand,
  ): Promise<BeginReviewPublicationOperationResult>;
}

export type RecordReviewExternalEffectCommand = {
  readonly capability: ReviewPublicationOperationCapabilityFacts;
  readonly effectId: string;
  readonly reportRequestHash: string;
  readonly externalObjectId: string;
  readonly observedObjectHash: string;
  readonly effectKind: ReviewPublicationExternalEffectKind;
  readonly observedAt: Date;
};

export enum RecordReviewExternalEffectStatus {
  Recorded = "recorded",
  Restored = "restored",
  Missing = "missing",
  ReportExpired = "report_expired",
  RequestConflict = "request_conflict",
  ExternalObjectConflict = "external_object_conflict",
  CapabilityMismatch = "capability_mismatch",
}

export type RecordReviewExternalEffectResult =
  | {
      readonly status:
        | RecordReviewExternalEffectStatus.Recorded
        | RecordReviewExternalEffectStatus.Restored;
      readonly effect: ReviewPublicationExternalEffect;
    }
  | {
      readonly status: Exclude<
        RecordReviewExternalEffectStatus,
        | RecordReviewExternalEffectStatus.Recorded
        | RecordReviewExternalEffectStatus.Restored
      >;
    };

export interface RecordReviewExternalEffectCommandPort {
  record(
    command: RecordReviewExternalEffectCommand,
  ): Promise<RecordReviewExternalEffectResult>;
}

export type CompleteReviewPublicationOperationCommand = {
  readonly publicationAttemptId: string;
  readonly publicationOperationId: string;
  readonly expectedAttemptVersion: bigint;
  readonly claimId: string;
  readonly claimFencingToken: bigint;
  readonly completionRequestIdHash: string;
  readonly requestHash: string;
  readonly receiptId: string;
  readonly canonicalEffectId: string;
  readonly receiptHash: string;
  readonly completedAt: Date;
};

export enum CompleteReviewPublicationOperationStatus {
  Completed = "completed",
  Restored = "restored",
  Missing = "missing",
  VersionConflict = "version_conflict",
  RequestConflict = "request_conflict",
  StaleClaim = "stale_claim",
  CanonicalEffectConflict = "canonical_effect_conflict",
  Terminal = "terminal",
}

export type CompleteReviewPublicationOperationResult =
  | {
      readonly status:
        | CompleteReviewPublicationOperationStatus.Completed
        | CompleteReviewPublicationOperationStatus.Restored;
      readonly attempt: ReviewPublicationAttempt;
      readonly receipt: ReviewPublicationReceipt;
    }
  | {
      readonly status: Exclude<
        CompleteReviewPublicationOperationStatus,
        | CompleteReviewPublicationOperationStatus.Completed
        | CompleteReviewPublicationOperationStatus.Restored
        | CompleteReviewPublicationOperationStatus.VersionConflict
      >;
    }
  | {
      readonly status: CompleteReviewPublicationOperationStatus.VersionConflict;
      readonly currentVersion: bigint;
    };

export interface CompleteReviewPublicationOperationCommandPort {
  complete(
    command: CompleteReviewPublicationOperationCommand,
  ): Promise<CompleteReviewPublicationOperationResult>;
}

export type TerminalizeUnknownReviewPublicationCommand = {
  readonly publicationAttemptId: string;
  readonly publicationOperationId: string;
  readonly expectedAttemptVersion: bigint;
  readonly claimId: string | null;
  readonly claimFencingToken: bigint | null;
  readonly tombstoneId: string;
  readonly finalOutcome?:
    | ReviewPublicationTerminalOutcome.SupersededNoEffect
    | ReviewPublicationTerminalOutcome.FailedNoEffect
    | ReviewPublicationTerminalOutcome.StaleCompensated
    | ReviewPublicationTerminalOutcome.StaleVisible
    | ReviewPublicationTerminalOutcome.TerminalUnknown;
  readonly finalReason: string;
  readonly lastErrorCode: string;
  readonly terminalizedBy: string;
  readonly terminalizedAt: Date;
  readonly retainUntil: Date;
};

export enum TerminalizeUnknownReviewPublicationStatus {
  Terminalized = "terminalized",
  Restored = "restored",
  Missing = "missing",
  VersionConflict = "version_conflict",
  StaleClaim = "stale_claim",
  TooEarly = "too_early",
  Conflict = "conflict",
}

export type TerminalizeUnknownReviewPublicationResult =
  | {
      readonly status:
        | TerminalizeUnknownReviewPublicationStatus.Terminalized
        | TerminalizeUnknownReviewPublicationStatus.Restored;
      readonly attempt: ReviewPublicationAttempt;
      readonly tombstone: ReviewPublicationAuditTombstone;
    }
  | {
      readonly status: Exclude<
        TerminalizeUnknownReviewPublicationStatus,
        | TerminalizeUnknownReviewPublicationStatus.Terminalized
        | TerminalizeUnknownReviewPublicationStatus.Restored
        | TerminalizeUnknownReviewPublicationStatus.VersionConflict
      >;
    }
  | {
      readonly status: TerminalizeUnknownReviewPublicationStatus.VersionConflict;
      readonly currentVersion: bigint;
    };

export interface TerminalizeUnknownReviewPublicationCommandPort {
  terminalizeUnknown(
    command: TerminalizeUnknownReviewPublicationCommand,
  ): Promise<TerminalizeUnknownReviewPublicationResult>;
}

export type AdjudicateReviewPublicationOutcomeCommand = {
  readonly publicationAttemptId: string;
  readonly expectedAttemptVersion: bigint;
  readonly correctionId: string;
  readonly correctionOrdinal: number;
  readonly correctedOutcome:
    | ReviewPublicationTerminalOutcome.Succeeded
    | ReviewPublicationTerminalOutcome.StaleCompensated
    | ReviewPublicationTerminalOutcome.StaleVisible;
  readonly evidenceHash: string;
  readonly safeReason: ReviewPublicationCorrectionReason;
  readonly correctedBy: string;
  readonly correctedAt: Date;
  readonly retainUntil: Date;
  readonly provenReceipts: readonly ReviewPublicationProvenReceipt[];
};

export type ReviewPublicationProvenReceipt = {
  readonly receiptId: string;
  readonly publicationOperationId: string;
  readonly canonicalEffectId: string;
  readonly canonicalExternalObjectId: string;
  readonly receiptHash: string;
  readonly provenAt: Date;
};

export enum ReviewPublicationAdjudicationEvidenceStatus {
  Proven = "proven",
  Rejected = "rejected",
  Unavailable = "unavailable",
}

export type ReviewPublicationAdjudicationEvidenceDecision =
  | {
      readonly status: ReviewPublicationAdjudicationEvidenceStatus.Proven;
      readonly evidenceHash: string;
      readonly provenReceipts: readonly ReviewPublicationProvenReceipt[];
    }
  | {
      readonly status:
        | ReviewPublicationAdjudicationEvidenceStatus.Rejected
        | ReviewPublicationAdjudicationEvidenceStatus.Unavailable;
      readonly reason: string;
    };

export interface ReviewPublicationAdjudicationEvidencePort {
  resolve(input: {
    readonly publicationAttemptId: string;
    readonly correctedOutcome: AdjudicateReviewPublicationOutcomeCommand["correctedOutcome"];
    readonly evidenceHash: string;
  }): Promise<ReviewPublicationAdjudicationEvidenceDecision>;
}

export class ReviewPublicationAdjudicationRejectedError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "ReviewPublicationAdjudicationRejectedError";
  }
}

export enum AdjudicateReviewPublicationOutcomeStatus {
  Corrected = "corrected",
  Restored = "restored",
  Missing = "missing",
  VersionConflict = "version_conflict",
  Conflict = "conflict",
  NotTerminalUnknown = "not_terminal_unknown",
  MissingCanonicalReceipts = "missing_canonical_receipts",
}

export type AdjudicateReviewPublicationOutcomeResult =
  | {
      readonly status:
        | AdjudicateReviewPublicationOutcomeStatus.Corrected
        | AdjudicateReviewPublicationOutcomeStatus.Restored;
      readonly attempt: ReviewPublicationAttempt;
      readonly correction: ReviewPublicationOutcomeCorrection;
    }
  | {
      readonly status: Exclude<
        AdjudicateReviewPublicationOutcomeStatus,
        | AdjudicateReviewPublicationOutcomeStatus.Corrected
        | AdjudicateReviewPublicationOutcomeStatus.Restored
        | AdjudicateReviewPublicationOutcomeStatus.VersionConflict
      >;
    }
  | {
      readonly status: AdjudicateReviewPublicationOutcomeStatus.VersionConflict;
      readonly currentVersion: bigint;
    };

export interface AdjudicateReviewPublicationOutcomeCommandPort {
  adjudicate(
    command: AdjudicateReviewPublicationOutcomeCommand,
  ): Promise<AdjudicateReviewPublicationOutcomeResult>;
}

export enum CurrentPublicationPermitStatus {
  Current = "current",
  Missing = "missing",
  Stale = "stale",
  Unavailable = "unavailable",
}

export type CurrentPublicationPermitDecision =
  | {
      readonly status: CurrentPublicationPermitStatus.Current;
      readonly permit: ReviewPublicationPermitIdentity;
    }
  | {
      readonly status: Exclude<
        CurrentPublicationPermitStatus,
        CurrentPublicationPermitStatus.Current
      >;
      readonly reason: string;
    };

export interface CurrentPublicationPermitPort {
  resolve(input: {
    readonly executionId: string;
    readonly generation: bigint;
    readonly projectionHash: string;
  }): Promise<CurrentPublicationPermitDecision>;
}

export enum ReviewPublicationRunControlStatus {
  Allowed = "allowed",
  AuthorizationRevoked = "authorization_revoked",
  ProducerReleaseRevoked = "producer_release_revoked",
  Missing = "missing",
  Unavailable = "unavailable",
}

export type ReviewPublicationRunControlDecision = {
  readonly status: ReviewPublicationRunControlStatus;
  readonly authorizationId: string;
  readonly producerReleaseId: string;
};

export interface ReviewPublicationRunControlDecisionPort {
  resolve(input: {
    readonly authorizationId: string;
    readonly producerReleaseId: string;
  }): Promise<ReviewPublicationRunControlDecision>;
}

export enum CurrentMutationAuthorityStatus {
  Active = "active",
  Inactive = "inactive",
  Missing = "missing",
  Unavailable = "unavailable",
}

export type CurrentMutationAuthorityDecision = {
  readonly status: CurrentMutationAuthorityStatus;
  readonly mutationEpoch: bigint | null;
};

export interface CurrentMutationAuthorityPort {
  resolve(
    scope: ReviewPublicationScope,
  ): Promise<CurrentMutationAuthorityDecision>;
}

export enum CurrentReviewRevisionStatus {
  Current = "current",
  Changed = "changed",
  Missing = "missing",
  Unavailable = "unavailable",
}

export type CurrentReviewRevisionDecision = {
  readonly status: CurrentReviewRevisionStatus;
  readonly reviewedHeadSha: string | null;
  readonly reviewRevisionHash: string | null;
};

export interface CurrentReviewRevisionPort {
  resolve(
    scope: ReviewPublicationScope,
  ): Promise<CurrentReviewRevisionDecision>;
}

export enum CurrentPublicationLifecycleStatus {
  Current = "current",
  Changed = "changed",
  Missing = "missing",
  Unavailable = "unavailable",
}

export type CurrentPublicationLifecycleDecision = {
  readonly status: CurrentPublicationLifecycleStatus;
  readonly lifecycleStateHash: string | null;
  readonly commandLedgerWatermark: bigint | null;
};

export interface CurrentPublicationLifecyclePort {
  resolve(
    scope: ReviewPublicationScope,
  ): Promise<CurrentPublicationLifecycleDecision>;
}

export type ReviewPublicationLifecycleTargetIdentity = {
  readonly targetId: string;
  readonly threadId: string;
  readonly mutationEligible: boolean;
  readonly observation?: ReviewPublicationLifecycleTargetObservation;
};

export type ReviewPublicationLifecycleTargetObservation = {
  readonly markerFingerprint: string;
  readonly threadStateHash: string;
};

export enum ReviewPublicationLifecycleExpectationStatus {
  Available = "available",
  Missing = "missing",
  Unavailable = "unavailable",
}

export type ReviewPublicationLifecycleExpectationDecision =
  | {
      readonly status: ReviewPublicationLifecycleExpectationStatus.Available;
      readonly reviewedHeadSha: string;
      readonly lifecycleStateHash: string;
      readonly commandLedgerWatermark: bigint;
      readonly observedNotAfter: Date;
      readonly lifecycleObservationVersion: ReviewPublicationLifecycleObservationVersion | null;
      readonly targets: readonly ReviewPublicationLifecycleTargetIdentity[];
      readonly createdTargetFingerprints: readonly string[];
    }
  | {
      readonly status:
        | ReviewPublicationLifecycleExpectationStatus.Missing
        | ReviewPublicationLifecycleExpectationStatus.Unavailable;
    };

export interface ReviewPublicationLifecycleExpectationPort {
  resolve(
    scope: ReviewPublicationScope,
  ): Promise<ReviewPublicationLifecycleExpectationDecision>;
}

export type LiveReviewPublicationLifecycleTargetIdentity = Omit<
  ReviewPublicationLifecycleTargetIdentity,
  "mutationEligible" | "observation"
> & {
  readonly markerFingerprint: string;
  readonly threadStateHash: string;
  readonly isResolved: boolean;
  readonly parentOwnedByIntegration: boolean;
  readonly hasRelevantInteractionAfterParent: boolean;
  readonly parentCreatedAt: Date;
  readonly lastRelevantChangeAt: Date;
};

export enum LiveReviewPublicationLifecycleStatus {
  Available = "available",
  Missing = "missing",
  Unavailable = "unavailable",
}

export type LiveReviewPublicationLifecycleDecision =
  | {
      readonly status: LiveReviewPublicationLifecycleStatus.Available;
      readonly reviewedHeadSha: string;
      readonly commandLedgerWatermark: bigint;
      readonly targets: readonly LiveReviewPublicationLifecycleTargetIdentity[];
    }
  | {
      readonly status:
        | LiveReviewPublicationLifecycleStatus.Missing
        | LiveReviewPublicationLifecycleStatus.Unavailable;
    };

export interface LiveReviewPublicationLifecyclePort {
  resolve(
    scope: ReviewPublicationScope,
  ): Promise<LiveReviewPublicationLifecycleDecision>;
}

export enum CurrentReviewSafetyDecisionStatus {
  Allowed = "allowed",
  Disabled = "disabled",
  Stale = "stale",
  Unavailable = "unavailable",
}

export type CurrentReviewSafetyDecision = {
  readonly status: CurrentReviewSafetyDecisionStatus;
  readonly decisionHash: string | null;
};

export interface CurrentReviewSafetyDecisionPort {
  resolve(input: {
    readonly scope: ReviewPublicationScope;
    readonly capability: ReviewPublicationCapability;
  }): Promise<CurrentReviewSafetyDecision>;
}

export type ReviewPublicationDecisionPorts = {
  readonly permits: CurrentPublicationPermitPort;
  readonly runControl: ReviewPublicationRunControlDecisionPort;
  readonly authority: CurrentMutationAuthorityPort;
  readonly revision: CurrentReviewRevisionPort;
  readonly lifecycle: CurrentPublicationLifecyclePort;
  readonly safety: CurrentReviewSafetyDecisionPort;
};

export enum ReviewPublicationGateRejectionReason {
  PublicationExpired = "publication_expired",
  PermitNotCurrent = "permit_not_current",
  PermitMismatch = "permit_mismatch",
  RunControlDenied = "run_control_denied",
  MutationAuthorityNotActive = "mutation_authority_not_active",
  MutationEpochMismatch = "mutation_epoch_mismatch",
  RevisionNotCurrent = "revision_not_current",
  LifecycleNotCurrent = "lifecycle_not_current",
  LifecycleStatusNotCurrent = "lifecycle_status_not_current",
  PublicationFactsUnavailable = "publication_facts_unavailable",
  LifecycleHashMismatch = "lifecycle_hash_mismatch",
  LifecycleWatermarkMismatch = "lifecycle_watermark_mismatch",
  SafetyDenied = "safety_denied",
  SafetyDecisionMismatch = "safety_decision_mismatch",
}

export class ReviewPublicationGateRejectedError extends Error {
  constructor(readonly reason: ReviewPublicationGateRejectionReason) {
    super(reason);
    this.name = "ReviewPublicationGateRejectedError";
  }
}

export class ReviewPublicationCapabilityDisabledError extends Error {
  constructor(readonly capability: ReviewPublicationCapability) {
    super(`review_publication_capability_disabled:${capability}`);
    this.name = "ReviewPublicationCapabilityDisabledError";
  }
}

export type ReviewPublicationGatewayObject = {
  readonly externalObjectId: string;
  readonly effectKind: ReviewPublicationExternalEffectKind;
  readonly markerHash: string;
  readonly bodyHash: string;
  readonly observedObjectHash: string;
  readonly observedAt: Date;
};

export interface ReviewPublicationGatewayPort {
  findAllByMarker(input: {
    readonly operation: ReviewPublicationOperation;
    readonly cursor: string | null;
  }): Promise<{
    readonly objects: readonly ReviewPublicationGatewayObject[];
    readonly nextCursor: string | null;
  }>;
  applyOperation(input: {
    readonly operation: ReviewPublicationOperation;
    readonly capability: ReviewPublicationOperationCapabilityFacts;
  }): Promise<ReviewPublicationGatewayObject>;
  markStaleOrDelete(input: {
    readonly operation: ReviewPublicationOperation;
    readonly canonicalExternalObjectId: string;
    readonly duplicateExternalObjectIds: readonly string[];
    readonly compensateCanonical: boolean;
  }): Promise<ReviewPublicationReceiptStatus>;
}
