import type {
  ActionRepositoryIdentity,
  ExactActionReleaseIdentityV2Input,
  FixedCanaryBindingInput,
  FixedCanaryTargetIdentity,
  FixedTerminalCanaryExpectation,
  ImmutableActionRef,
  ImmutableEvidenceArtifactLocator,
  Sha256,
  VerifiedActionReleaseV2,
  VerifiedFixedTerminalCanaryReceiptV4,
  WorkflowActionSelection,
} from "../domain/action-release-identity";
import type {
  ActionReleaseOverlapEffectCheckpoint,
  ActionReleaseRollout,
  CanaryArmedActionReleaseRollout,
  ExactProductionActionConfiguration,
  FixedTerminalReceiptVerificationCheckpoint,
  PredecessorAdmissionEffectCheckpoint,
  PromotionReceiptReservation,
  PromotingActionReleaseRollout,
  PromotionUncertainActionReleaseRollout,
  RecoveryAdmissionCloseEffectCheckpoint,
  RecoveryAdmissionReopenEffectCheckpoint,
  RecoveryOnlyActionReleaseRollout,
} from "../domain/action-release-rollout";
import type {
  CompleteLiveActionReferenceInventoryV1,
  PredecessorAdmissionFence,
  PredecessorRemovalProof,
} from "../domain/live-action-reference-inventory";

export const ActionReleaseRepositoryWriteResult = Object.freeze({
  Committed: "committed",
  Stale: "stale",
  ActiveCandidateConflict: "active_candidate_conflict",
  AttemptConflict: "attempt_conflict",
  ReceiptConflict: "receipt_conflict",
  ArtifactConflict: "artifact_conflict",
  ReceiptAlreadyConsumed: "receipt_already_consumed",
} as const);

export type ActionReleaseRepositoryWriteResult =
  (typeof ActionReleaseRepositoryWriteResult)[keyof typeof ActionReleaseRepositoryWriteResult];

export interface ActionReleaseRolloutRepositoryPort {
  load(channel: "production-schema-v5"): Promise<ActionReleaseRollout>;

  /** CAS plus one-active-candidate and globally unique attempt enforcement. */
  createCandidateCas(input: {
    readonly expectedAggregateVersion: bigint;
    readonly next: ActionReleaseRollout;
  }): Promise<ActionReleaseRepositoryWriteResult>;

  compareAndSet(input: {
    readonly expectedAggregateVersion: bigint;
    readonly next: ActionReleaseRollout;
  }): Promise<ActionReleaseRepositoryWriteResult>;

  /**
   * Atomically persists the verification intent and claims both the attempt and
   * immutable artifact. Implementations enforce one locator per attempt and
   * global artifact uniqueness in the same transaction as the aggregate CAS.
   */
  beginReceiptVerificationCas(input: {
    readonly expectedAggregateVersion: bigint;
    readonly effect: Readonly<FixedTerminalReceiptVerificationCheckpoint>;
    readonly artifactId: string;
    readonly artifactSha256: Sha256;
    readonly ownerAttemptId: string;
    readonly next: CanaryArmedActionReleaseRollout;
  }): Promise<ActionReleaseRepositoryWriteResult>;

  /** Persists the verified handle unconsumed; receipt and artifact are unique. */
  attachReceiptOnceAndCas(input: {
    readonly expectedAggregateVersion: bigint;
    readonly receiptId: string;
    readonly artifactId: string;
    readonly ownerAttemptId: string;
    readonly verificationEffectId: string;
    readonly verificationEpoch: bigint;
    readonly next: ActionReleaseRollout;
  }): Promise<ActionReleaseRepositoryWriteResult>;

  /**
   * Atomically consumes the one-shot receipt and persists Promoting before any
   * production effect can be dispatched.
   */
  consumeReceiptAndBeginPromotionCas(input: {
    readonly expectedAggregateVersion: bigint;
    readonly receiptId: string;
    readonly artifactId: string;
    readonly ownerAttemptId: string;
    readonly reservation: PromotionReceiptReservation;
    readonly next: PromotingActionReleaseRollout;
  }): Promise<ActionReleaseRepositoryWriteResult>;
}

export interface ActionReleaseClockPort {
  now(): string;
}

export interface ActionReleaseIdPort {
  nextId(kind: "attempt" | "reservation" | "effect"): string;
}

export interface ActionReleaseDigestPort {
  digestCanonical(value: unknown): Sha256;
  digestBytes(value: Uint8Array): Sha256;
}

export interface FixedCanaryTargetPort {
  /** Compile-time configured target. This operation accepts no repository. */
  getFixedTarget(): Promise<Readonly<FixedCanaryTargetIdentity>>;
}

export type CandidateWorkflowProvisioningReconciliation =
  | Readonly<{ status: "exact"; expectationDigest: Sha256 }>
  | Readonly<{
      status: "pending" | "definite_no_effect";
      observationDigest: Sha256;
    }>;

export interface CandidateWorkflowProvisioningPort {
  /**
   * Read-only planning/observation: returns the complete proposed fresh
   * namespace binding without mutating GitHub or provider state. All mutation
   * belongs to provision after CanaryArmed is durably persisted. No raw Action
   * ref or arbitrary repository is accepted.
   */
  prepareFixedBinding(input: {
    readonly target: Readonly<FixedCanaryTargetIdentity>;
    readonly rolloutAttemptId: string;
    readonly policyRevision: bigint;
    readonly candidateRelease: VerifiedActionReleaseV2;
  }): Promise<FixedCanaryBindingInput>;

  provision(input: {
    readonly selection: Extract<
      WorkflowActionSelection,
      { readonly kind: "isolated_candidate" }
    >;
    readonly schemaVersion: 5;
    readonly binding: FixedCanaryBindingInput;
    readonly eligibility: RepositoryActionEligibilityDecision;
    readonly effectId: Sha256;
    readonly effectEpoch: bigint;
  }): Promise<Readonly<{ expectationDigest: Sha256 }>>;

  /** Read-only continuation for the one durably identified provisioning effect. */
  reconcile(input: {
    readonly selection: Extract<
      WorkflowActionSelection,
      { readonly kind: "isolated_candidate" }
    >;
    readonly schemaVersion: 5;
    readonly binding: FixedCanaryBindingInput;
    readonly eligibility: RepositoryActionEligibilityDecision;
    readonly effectId: Sha256;
    readonly effectEpoch: bigint;
  }): Promise<CandidateWorkflowProvisioningReconciliation>;
}

export interface FixedTerminalCanaryReceiptVerifierPort {
  /**
   * Evidence verification is deterministic, read-only, and replay-safe for an
   * identical immutable locator and expectation. Only the reconcile use case
   * may replay it after a durable uncertain or expired dispatch checkpoint.
   */
  verifyExact(input: {
    readonly locator: ImmutableEvidenceArtifactLocator;
    readonly expected: FixedTerminalCanaryExpectation;
  }): Promise<VerifiedFixedTerminalCanaryReceiptV4>;
}

export interface LiveActionReferenceInventoryPort {
  /** This port has no partial return type; ambiguity rejects or throws. */
  captureComplete(input: {
    readonly channel: "production-schema-v5";
    readonly policyRevision: bigint;
  }): Promise<CompleteLiveActionReferenceInventoryV1>;
}

/** Lower-level complete inventory source contracts for later adapters. */
export interface NamespaceLeaseReferencePort {
  captureRepeatableRead(input: {
    readonly repositoryCohortRevision: bigint;
    readonly policyRevision: bigint;
  }): Promise<
    Readonly<{
      complete: true;
      serverTime: string;
      snapshotIdentity: string;
      digest: Sha256;
    }>
  >;
}

export interface GitHubWorkflowRunReferencePort {
  captureCompletePaginated(input: {
    readonly repositoryCohortRevision: bigint;
    readonly policyRevision: bigint;
  }): Promise<
    Readonly<{
      complete: true;
      appId: string;
      pageCount: number;
      paginationDigest: Sha256;
    }>
  >;
}

export type ProductionActionConfigurationOutcome =
  | Readonly<{
      status: "exact";
      configuration: ExactProductionActionConfiguration;
    }>
  | Readonly<{
      status: "definite_no_effect";
      configuration: ExactProductionActionConfiguration;
    }>
  | Readonly<{
      status: "uncertain";
      observationDigest: Sha256;
    }>;

export type PromotionReconciliationOutcome =
  | Readonly<{
      status: "completed";
      configuration: ExactProductionActionConfiguration;
    }>
  | Readonly<{
      status: "pending";
      observationDigest: Sha256;
    }>
  | Readonly<{
      status: "promoted_failure";
      failureDigest: Sha256;
      configuration: ExactProductionActionConfiguration;
    }>;

export interface ProductionActionConfigurationPort {
  readExact(): Promise<ExactProductionActionConfiguration>;

  stageAdditiveOverlap(input: {
    readonly expected: ExactProductionActionConfiguration;
    readonly primaryRef: ImmutableActionRef;
    readonly candidateRelease: VerifiedActionReleaseV2;
    readonly candidateAttemptId: string;
    readonly effectId: string;
    readonly effectEpoch: bigint;
  }): Promise<ProductionActionConfigurationOutcome>;

  /** Continues only the durably identified staging effect; never blind-writes. */
  reconcileAdditiveOverlap(input: {
    readonly expected: ExactProductionActionConfiguration;
    readonly primaryRef: ImmutableActionRef;
    readonly candidateRelease: VerifiedActionReleaseV2;
    readonly candidateAttemptId: string;
    readonly effect: Readonly<ActionReleaseOverlapEffectCheckpoint>;
  }): Promise<ProductionActionConfigurationOutcome>;

  promotePrimary(input: {
    readonly rollout: PromotingActionReleaseRollout;
    readonly expectedConfigurationDigest: Sha256;
    readonly expectedInventoryDigest: Sha256;
  }): Promise<ProductionActionConfigurationOutcome>;

  reconcilePromotion(input: {
    readonly rollout: PromotionUncertainActionReleaseRollout;
  }): Promise<PromotionReconciliationOutcome>;

  removePredecessor(input: {
    readonly currentPrimary: ImmutableActionRef;
    readonly predecessor: ImmutableActionRef;
    readonly candidateDrainHolds: readonly ImmutableActionRef[];
    readonly proof: PredecessorRemovalProof;
    readonly expectedInventoryDigest: Sha256;
    readonly expectedProductionConsensusDigest: Sha256;
    readonly effectId: string;
    readonly effectEpoch: bigint;
  }): Promise<ProductionActionConfigurationOutcome>;

  reconcilePredecessorRemoval(input: {
    readonly currentPrimary: ImmutableActionRef;
    readonly predecessor: ImmutableActionRef;
    readonly candidateDrainHolds: readonly ImmutableActionRef[];
    readonly proof: PredecessorRemovalProof;
    readonly expectedInventoryDigest: Sha256;
    readonly expectedProductionConsensusDigest: Sha256;
    readonly effectId: string;
    readonly effectEpoch: bigint;
  }): Promise<ProductionActionConfigurationOutcome>;
}

/**
 * Every mutation is idempotent for its persisted effect key. A conflicting
 * observation returns `uncertain`; it never mints a new fence or effect.
 */
export interface AdmissionFencePort {
  closePredecessorAdmission(
    input: PredecessorAdmissionCloseCommand,
  ): Promise<AdmissionEffectOutcome<PredecessorAdmissionFence>>;

  /** Continues or reads back only the durably identified close effect. */
  reconcilePredecessorAdmission(
    input: PredecessorAdmissionCloseCommand,
  ): Promise<AdmissionEffectOutcome<PredecessorAdmissionFence>>;

  assertPredecessorAdmissionClosed(
    fence: PredecessorAdmissionFence,
  ): Promise<boolean>;

  closeSetupAndNewWork(input: {
    readonly effect: Readonly<RecoveryAdmissionCloseEffectCheckpoint>;
  }): Promise<AdmissionEffectOutcome<ExactRecoveryAdmissionCloseObservation>>;

  /** Continues or reads back only the persisted close effect identity. */
  reconcileSetupAndNewWorkClose(input: {
    readonly effect: Readonly<RecoveryAdmissionCloseEffectCheckpoint>;
  }): Promise<AdmissionEffectOutcome<ExactRecoveryAdmissionCloseObservation>>;

  reopenSetupAndNewWork(input: {
    readonly effect: Readonly<RecoveryAdmissionReopenEffectCheckpoint>;
  }): Promise<AdmissionEffectOutcome<ExactRecoveryAdmissionReopenObservation>>;

  /** Continues or reads back only the persisted reopen effect identity. */
  reconcileSetupAndNewWorkReopen(input: {
    readonly effect: Readonly<RecoveryAdmissionReopenEffectCheckpoint>;
  }): Promise<AdmissionEffectOutcome<ExactRecoveryAdmissionReopenObservation>>;
}

export interface PredecessorAdmissionCloseCommand {
  readonly effect: Readonly<PredecessorAdmissionEffectCheckpoint>;
  readonly predecessorRef: ImmutableActionRef;
  readonly successorRef: ImmutableActionRef;
  readonly promotionAttemptId: string;
  readonly repositoryCohortRevision: bigint;
  readonly repositoryCohortDigest: Sha256;
  readonly githubRepositoryIds: readonly string[];
  readonly policyRevision: bigint;
  readonly inventoryScopeDigest: Sha256;
  readonly requiredWindowMs: number;
  readonly authorityEstablishedAt: string;
}

export type AdmissionEffectOutcome<T> =
  | Readonly<{ status: "exact"; observation: Readonly<T> }>
  | Readonly<{ status: "uncertain"; observationDigest: Sha256 }>;

export interface ExactRecoveryAdmissionCloseObservation {
  readonly effectId: string;
  readonly effectEpoch: bigint;
  readonly fenceId: string;
  readonly fenceEpoch: bigint;
  readonly currentPrimary: ImmutableActionRef;
  readonly failureDigest: Sha256;
}

export interface ExactRecoveryAdmissionReopenObservation {
  readonly effectId: string;
  readonly effectEpoch: bigint;
  readonly fenceId: string;
  readonly fenceEpoch: bigint;
  readonly ownerAttemptId: string;
  readonly promotedPrimary: ImmutableActionRef;
  readonly configurationDigest: Sha256;
  readonly openedEpoch: bigint;
}

export interface RepositoryActionEligibilityDecision {
  readonly policyRevision: bigint;
  readonly channelVersion: bigint;
  readonly selectionDigest: Sha256;
  readonly contextDigest: Sha256;
  readonly decisionDigest: Sha256;
  readonly allowed: boolean;
}

export interface RepositoryActionSelectionContext {
  readonly githubRepositoryId: string;
  readonly repositoryFullName: string;
  readonly providerInstanceId: string;
  readonly namespaceId: string | null;
  readonly namespaceEpoch: bigint | null;
  readonly workflowSourceDigest: Sha256;
}

export interface RepositoryActionEligibilityPort {
  authorizeExactSelection(input: {
    readonly selection: WorkflowActionSelection;
    readonly selectionDigest: Sha256;
    readonly contextDigest: Sha256;
    readonly expectedChannelVersion: bigint;
    readonly expectedPolicyRevision: bigint;
  }): Promise<Readonly<RepositoryActionEligibilityDecision>>;
}

export interface ExactTaggedSourceObservation {
  readonly identity: Pick<
    ExactActionReleaseIdentityV2Input,
    | "repository"
    | "tag"
    | "tagRef"
    | "commitTreeSha"
    | "actionManifest"
    | "executable"
    | "taggedSourceTreeSha256"
    | "buildRecipeSha256"
    | "lockfileSha256"
  >;
  readonly committedExecutableBytes: Uint8Array;
  readonly detached: boolean;
  readonly clean: boolean;
  readonly untrackedInputs: boolean;
  readonly shallow: boolean;
  readonly replaceRefs: boolean;
  readonly executableSymlink: boolean;
  readonly ambiguousTag: boolean;
}

export interface ExactTaggedSourcePort {
  inspectExact(input: {
    readonly repository: ActionRepositoryIdentity;
    readonly tag: string;
  }): Promise<ExactTaggedSourceObservation>;

  reobserveTag(input: {
    readonly repository: ActionRepositoryIdentity;
    readonly tag: string;
  }): Promise<
    Readonly<{
      tagRef: ExactTaggedSourceObservation["identity"]["tagRef"];
      commitTreeSha: string;
    }>
  >;
}

export interface DeterministicActionBuildPort {
  /**
   * Builds twice in independent detached paths using only the tagged frozen
   * lockfile and pinned toolchain; ambient node_modules are forbidden.
   */
  rebuildTwice(input: {
    readonly source: ExactTaggedSourceObservation;
  }): Promise<
    Readonly<{
      firstExecutableBytes: Uint8Array;
      secondExecutableBytes: Uint8Array;
      firstDetachedPathDigest: Sha256;
      secondDetachedPathDigest: Sha256;
      toolchainSha256: Sha256;
      dependencyInstallationSha256: Sha256;
    }>
  >;
}

export interface PublishedActionArtifactPort {
  fetchExact(input: {
    readonly repository: ActionRepositoryIdentity;
    readonly tag: string;
    readonly commitSha: string;
  }): Promise<
    Readonly<{
      artifactBytes: Uint8Array;
      executableBytes: Uint8Array;
      publishedBundle: ExactActionReleaseIdentityV2Input["publishedBundle"];
      release: ExactActionReleaseIdentityV2Input["release"];
      installer: ExactActionReleaseIdentityV2Input["installer"];
    }>
  >;
}

declare const verifiedAttestationBrand: unique symbol;
export interface VerifiedActionReleaseAttestationV2 {
  readonly attestation: ExactActionReleaseIdentityV2Input["attestation"];
  readonly trustedWorkflow: ExactActionReleaseIdentityV2Input["trustedWorkflow"];
  readonly expectedExecutableSha256: Sha256;
  readonly [verifiedAttestationBrand]: true;
}

export interface ActionReleaseAttestationVerifierPort {
  /**
   * The release-lane verifier must bind the attestation to this complete
   * immutable publication tuple, not merely to equal executable bytes.
   */
  verifyExact(input: {
    readonly source: ExactTaggedSourceObservation;
    readonly publishedBundle: ExactActionReleaseIdentityV2Input["publishedBundle"];
    readonly release: ExactActionReleaseIdentityV2Input["release"];
    readonly installer: ExactActionReleaseIdentityV2Input["installer"];
  }): Promise<VerifiedActionReleaseAttestationV2>;
}

export interface ExactActionReleaseVerificationPorts {
  readonly source: ExactTaggedSourcePort;
  readonly build: DeterministicActionBuildPort;
  readonly published: PublishedActionArtifactPort;
  readonly attestation: ActionReleaseAttestationVerifierPort;
  readonly digest: ActionReleaseDigestPort;
}

export interface RecoveryOnlyAdmissionResult {
  readonly rollout: RecoveryOnlyActionReleaseRollout;
}
