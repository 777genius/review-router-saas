import type {
  BeginReviewPublicationOperationCommand,
  BeginReviewPublicationOperationResult,
  ClaimReviewPublicationCommand,
  ClaimReviewPublicationResult,
  CompleteReviewPublicationOperationCommand,
  CompleteReviewPublicationOperationResult,
  ProveReviewPublicationNoEffectCommand,
  ProveReviewPublicationNoEffectResult,
  RecordReviewExternalEffectCommand,
  RecordReviewExternalEffectResult,
  RenewReviewPublicationClaimCommand,
  RenewReviewPublicationClaimResult,
  ReviewPublicationAttemptQueryPort,
  ReviewPublicationClaimTerm,
  ReviewPublicationGatewayObject,
  ReviewPublicationGatewayPort,
  ReviewPublicationOperation,
  ReviewPublicationOperationCapabilityFacts,
  ReviewPublicationPermitIdentity,
  ReviewPublicationReceiptStatus,
  ReviewPublicationTerminalOutcome,
  TerminalizeUnknownReviewPublicationCommand,
  TerminalizeUnknownReviewPublicationResult,
} from "@reviewrouter/features-review-publishing/v2";

export enum ReviewV2ScmProvider {
  GitHub = "github",
  GitLab = "gitlab",
}

export enum ReviewV2PublicationFreshnessReadStatus {
  Available = "available",
  Missing = "missing",
  Unavailable = "unavailable",
}

export type ReviewV2ScmLiveRevision = {
  readonly baseSha: string;
  readonly mergeBaseSha: string;
  readonly headSha: string;
  readonly reviewRevisionHash: string;
};

export interface ReviewV2ScmLiveRevisionPort {
  readonly provider: ReviewV2ScmProvider;
  readLiveRevision(
    permit: ReviewPublicationPermitIdentity,
  ): Promise<ReviewV2ScmLiveRevision | null>;
}

export type ReviewV2PublicationFreshnessSnapshot = {
  readonly baseSha: string;
  readonly mergeBaseSha: string;
  readonly reviewedHeadSha: string;
  readonly reviewRevisionHash: string;
  readonly lifecycleStateHash: string;
  readonly commandLedgerWatermark: bigint;
  readonly authorizationId: string;
  readonly producerReleaseId: string;
  readonly permitEpoch: bigint;
  readonly publicationSafetyDecisionHash: string;
  readonly publicationNotAfter: Date;
};

export type ReviewV2PublicationFreshnessRead =
  | {
      readonly status: ReviewV2PublicationFreshnessReadStatus.Available;
      readonly snapshot: ReviewV2PublicationFreshnessSnapshot;
    }
  | {
      readonly status:
        | ReviewV2PublicationFreshnessReadStatus.Missing
        | ReviewV2PublicationFreshnessReadStatus.Unavailable;
      readonly safeReason: string;
    };

/** Reads live SCM revision, lifecycle, and command-ledger facts as one snapshot. */
export interface ReviewV2PublicationFreshnessPort {
  read(
    provider: ReviewV2ScmProvider,
    permit: ReviewPublicationPermitIdentity,
  ): Promise<ReviewV2PublicationFreshnessRead>;
}

export enum ReviewV2PublicationCompensationDecision {
  Allowed = "allowed",
  ManualOnly = "manual_only",
}

/**
 * Provider policy for a narrowly scoped stale-object cleanup. In particular,
 * lifecycle operations must remain manual unless the adapter proves compensation.
 */
export interface ReviewV2PublicationCompensationPolicyPort {
  decide(input: {
    readonly operation: ReviewPublicationOperation;
    readonly canonicalObject: ReviewPublicationGatewayObject;
    readonly duplicateObjects: readonly ReviewPublicationGatewayObject[];
    readonly liveFacts: ReviewV2PublicationFreshnessSnapshot;
  }): Promise<ReviewV2PublicationCompensationDecision>;
}

export interface ReviewV2PublicationApplicationPort {
  claim(
    command: Omit<ClaimReviewPublicationCommand, "acquiredAt">,
  ): Promise<ClaimReviewPublicationResult>;
  claimForReconciliation(
    command: Omit<ClaimReviewPublicationCommand, "acquiredAt">,
  ): Promise<ClaimReviewPublicationResult>;
  renewClaim(
    command: Omit<RenewReviewPublicationClaimCommand, "requestedAt">,
  ): Promise<RenewReviewPublicationClaimResult>;
  beginOperation(
    command: Omit<BeginReviewPublicationOperationCommand, "startedAt">,
  ): Promise<BeginReviewPublicationOperationResult>;
  recordEffect(
    command: Omit<RecordReviewExternalEffectCommand, "observedAt">,
  ): Promise<RecordReviewExternalEffectResult>;
  proveNoEffect(
    command: Omit<
      ProveReviewPublicationNoEffectCommand,
      "noEffectProofHash" | "provenAt"
    >,
  ): Promise<ProveReviewPublicationNoEffectResult>;
  completeOperation(
    command: Omit<CompleteReviewPublicationOperationCommand, "completedAt">,
  ): Promise<CompleteReviewPublicationOperationResult>;
  terminalizeUnknown(
    command: Omit<TerminalizeUnknownReviewPublicationCommand, "terminalizedAt">,
  ): Promise<TerminalizeUnknownReviewPublicationResult>;
}

export enum ReviewV2ScmCredentialPurpose {
  Mutate = "mutate",
  ReconcileOnly = "reconcile_only",
}

export enum ReviewV2ScmMutationFailureOutcome {
  DefinitelyNoEffect = "definitely_no_effect",
  EffectMayExist = "effect_may_exist",
}

export class ReviewV2ScmMutationError extends Error {
  constructor(
    readonly safeCode: string,
    readonly outcome: ReviewV2ScmMutationFailureOutcome,
    readonly retryable: boolean,
  ) {
    super(safeCode);
    this.name = "ReviewV2ScmMutationError";
  }
}

export type ReviewV2ScmReconciliationGateway = Pick<
  ReviewPublicationGatewayPort,
  "findAllByMarker" | "markStaleOrDelete"
>;

export type ReviewV2ScmMutationGateway = ReviewV2ScmReconciliationGateway &
  Pick<ReviewPublicationGatewayPort, "applyOperation">;

export type ReviewV2ScmGatewaySession =
  | {
      readonly purpose: ReviewV2ScmCredentialPurpose.Mutate;
      readonly gateway: ReviewV2ScmMutationGateway;
      close(): Promise<void>;
    }
  | {
      readonly purpose: ReviewV2ScmCredentialPurpose.ReconcileOnly;
      readonly gateway: ReviewV2ScmReconciliationGateway;
      close(): Promise<void>;
    };

export type ReviewV2OpaqueSignedOperationCapability = {
  readonly token: string;
  readonly capabilityId: string;
  readonly signingKeyId: string;
  readonly expiresAt: Date;
};

export interface ReviewV2OperationCapabilityIssuerPort {
  issue(input: {
    readonly permit: ReviewPublicationPermitIdentity;
    readonly operation: ReviewPublicationOperation;
    readonly capability: ReviewPublicationOperationCapabilityFacts;
    readonly claim: ReviewPublicationClaimTerm;
  }): Promise<ReviewV2OpaqueSignedOperationCapability>;
}

export interface ReviewV2OperationCapabilityVerifierPort {
  verify(input: {
    readonly signedCapability: ReviewV2OpaqueSignedOperationCapability;
    readonly permit: ReviewPublicationPermitIdentity;
    readonly operation: ReviewPublicationOperation;
    readonly capability: ReviewPublicationOperationCapabilityFacts;
    readonly claim: ReviewPublicationClaimTerm;
  }): Promise<void>;
}

/** Acquires an adapter-bound gateway. No raw SCM credential crosses this port. */
export interface ReviewV2ScmCredentialAcquisitionPort {
  acquire(input: {
    readonly provider: ReviewV2ScmProvider;
    readonly purpose: ReviewV2ScmCredentialPurpose;
    readonly permit: ReviewPublicationPermitIdentity;
    readonly operation: ReviewPublicationOperation;
    readonly capability: ReviewPublicationOperationCapabilityFacts;
    readonly claim: ReviewPublicationClaimTerm;
    readonly signedCapability: ReviewV2OpaqueSignedOperationCapability;
  }): Promise<ReviewV2ScmGatewaySession>;
}

export interface ReviewV2PublicationCapabilityIdentityPort {
  activeSigningKeyId(): Promise<string>;
}

export enum ReviewV2PublicationEffectGateDecision {
  Allowed = "allowed",
  Disabled = "disabled",
  Unavailable = "unavailable",
}

export interface ReviewV2PublicationEffectGatePort {
  authorize(input: {
    readonly provider: ReviewV2ScmProvider;
    readonly permit: ReviewPublicationPermitIdentity;
    readonly operation: ReviewPublicationOperation;
  }): Promise<ReviewV2PublicationEffectGateDecision>;
}

export interface ReviewV2PublicationClockPort {
  now(): Date;
}

export type ReviewV2PublicationExecutorDependencies = {
  readonly attempts: ReviewPublicationAttemptQueryPort;
  readonly application: ReviewV2PublicationApplicationPort;
  readonly freshness: ReviewV2PublicationFreshnessPort;
  readonly compensation: ReviewV2PublicationCompensationPolicyPort;
  readonly operationCapabilities: ReviewV2OperationCapabilityIssuerPort;
  readonly credentials: ReviewV2ScmCredentialAcquisitionPort;
  readonly capabilityIdentity: ReviewV2PublicationCapabilityIdentityPort;
  readonly effectGate: ReviewV2PublicationEffectGatePort;
  readonly clock: ReviewV2PublicationClockPort;
};

export type ReviewV2PublicationExecutorPolicy = {
  readonly claimDurationMs: number;
  readonly minimumMutationLeaseMs: number;
  readonly maxMarkerPages: number;
};

export type ReviewV2PublicationExecutionCommand = {
  readonly publicationAttemptId: string;
  readonly publicationOperationId: string;
  readonly provider: ReviewV2ScmProvider;
  readonly ownerIdHash: string;
};

export enum ReviewV2PublicationExecutionStatus {
  Completed = "completed",
  AlreadyCompleted = "already_completed",
  Busy = "busy",
  Retryable = "retryable",
  Terminalized = "terminalized",
  ManualRequired = "manual_required",
  TerminalUnknown = "terminal_unknown",
}

export type ReviewV2PublicationExecutionResult = {
  readonly status: ReviewV2PublicationExecutionStatus;
  readonly safeReason: string;
  readonly receiptStatus?: ReviewPublicationReceiptStatus;
  readonly terminalOutcome?: ReviewPublicationTerminalOutcome;
};
