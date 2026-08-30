import { sha256Canonical } from "./canonical-json";
import {
  assertImmutableActionRef,
  assertVerifiedActionReleaseV2,
  assertVerifiedFixedTerminalCanaryReceiptV4,
  attestedLiveNamespaceActionSelection,
  exactActionInstallerIdentity,
  fixedCanaryBinding,
  fixedTerminalCanaryExpectation,
  immutableEvidenceArtifactLocator,
  isolatedCandidateActionSelection,
  productionPrimaryActionSelection,
  sameActionRef,
  sameActionRepository,
  sha256,
  terminalCanaryReceiptIdentityDigest,
  type FixedCanaryBinding,
  type FixedCanaryBindingInput,
  type FixedTerminalCanaryExpectation,
  type ExactActionInstallerIdentity,
  type ImmutableActionRef,
  type ImmutableEvidenceArtifactLocator,
  type Sha256,
  type VerifiedActionReleaseV2,
  type VerifiedFixedTerminalCanaryReceiptV4,
  type WorkflowSourceIdentity,
  type WorkflowActionSelection,
} from "./action-release-identity";
import {
  assertCompleteLiveActionReferenceInventory,
  assertPredecessorRemovalProof,
  assertZeroPredecessorReferenceCapture,
  exactInventoryActionRefs,
  liveActionReferenceInventoryScopeDigest,
  predecessorAdmissionFence,
  type CompleteLiveActionReferenceInventoryV1,
  type PredecessorAdmissionFence,
  type PredecessorRemovalProof,
  type ZeroPredecessorReferenceCapture,
} from "./live-action-reference-inventory";

export const ACTION_RELEASE_CHANNEL = "production-schema-v5" as const;

export const ActionReleaseRolloutPhase = Object.freeze({
  Steady: "steady",
  CandidateRegistered: "candidate_registered",
  OverlapStaged: "overlap_staged",
  CanaryArmed: "canary_armed",
  CanaryVerified: "canary_verified",
  PromotionPrepared: "promotion_prepared",
  Promoting: "promoting",
  PromotionUncertain: "promotion_uncertain",
  CandidateAborted: "candidate_aborted",
  RecoveryOnly: "recovery_only",
} as const);

export type ActionReleaseRolloutPhase =
  (typeof ActionReleaseRolloutPhase)[keyof typeof ActionReleaseRolloutPhase];

export const ActionReleaseRolloutTransitionErrorCode = Object.freeze({
  InvalidPhase: "action_release_rollout_invalid_phase",
  InvalidVersion: "action_release_rollout_version_invalid",
  CandidateInvalid: "action_release_candidate_invalid",
  CandidateBindingMismatch: "action_release_candidate_binding_mismatch",
  CandidateAlreadyPrimary: "action_release_candidate_already_primary",
  ActionRepositoryMismatch: "action_release_repository_mismatch",
  AttemptReplay: "action_release_attempt_replay",
  OverlapInvalid: "action_release_overlap_invalid",
  CanaryBindingInvalid: "action_release_canary_binding_invalid",
  ReceiptInvalid: "action_release_receipt_invalid",
  PromotionPreparationInvalid: "action_release_promotion_preparation_invalid",
  PromotionReservationInvalid: "action_release_promotion_reservation_invalid",
  PromotionReadbackInvalid: "action_release_promotion_readback_invalid",
  ReconcileOnly: "action_release_promotion_reconcile_only",
  AbortForbidden: "action_release_abort_forbidden",
  RecoveryForbidden: "action_release_recovery_forbidden",
  AdmissionClosed: "action_release_admission_closed",
  AdmissionEffectInvalid: "action_release_admission_effect_invalid",
  SelectionRejected: "action_release_selection_rejected",
  PredecessorRetentionInvalid: "action_release_predecessor_retention_invalid",
  PredecessorRemovalNotReady: "action_release_predecessor_removal_not_ready",
} as const);

export type ActionReleaseRolloutTransitionErrorCode =
  (typeof ActionReleaseRolloutTransitionErrorCode)[keyof typeof ActionReleaseRolloutTransitionErrorCode];

export class ActionReleaseRolloutTransitionError extends Error {
  readonly code: ActionReleaseRolloutTransitionErrorCode;

  constructor(code: ActionReleaseRolloutTransitionErrorCode) {
    super(code);
    this.name = "ActionReleaseRolloutTransitionError";
    this.code = code;
  }
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,511}$/u;

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(code: ActionReleaseRolloutTransitionErrorCode): never {
  throw new ActionReleaseRolloutTransitionError(code);
}

function timestamp(value: string): number {
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  )
    fail(ActionReleaseRolloutTransitionErrorCode.CandidateBindingMismatch);
  return milliseconds;
}

function nextRevision(rollout: ActionReleaseRollout): bigint {
  return rollout.aggregateVersion + 1n;
}

export interface ExactProductionActionConfiguration {
  readonly schemaVersion: 1;
  readonly revision: bigint;
  readonly observedAt: string;
  readonly serviceIds: readonly string[];
  readonly primaryRef: ImmutableActionRef;
  readonly installerRef: ImmutableActionRef;
  readonly installer: Readonly<ExactActionInstallerIdentity>;
  readonly reusableWorkflowRef: ImmutableActionRef;
  readonly runtimeRef: ImmutableActionRef;
  readonly refreshActionRef: ImmutableActionRef;
  readonly interactionRuntimeRef: ImmutableActionRef;
  readonly knownRefs: readonly ImmutableActionRef[];
  readonly isolatedCandidateAttemptId: string | null;
  readonly isolatedCandidateBindingDigest: Sha256 | null;
  readonly configurationDigest: Sha256;
}

function configurationDigestInput(
  value: Omit<ExactProductionActionConfiguration, "configurationDigest">,
): unknown {
  const ref = (actionRef: ImmutableActionRef) => ({
    repositoryId: actionRef.repository.repositoryId,
    repositoryFullName: actionRef.repository.fullName,
    commitSha: actionRef.commitSha,
  });
  return {
    ...value,
    revision: value.revision.toString(),
    primaryRef: ref(value.primaryRef),
    installerRef: ref(value.installerRef),
    reusableWorkflowRef: ref(value.reusableWorkflowRef),
    runtimeRef: ref(value.runtimeRef),
    refreshActionRef: ref(value.refreshActionRef),
    interactionRuntimeRef: ref(value.interactionRuntimeRef),
    knownRefs: value.knownRefs.map(ref),
  };
}

export function exactProductionActionConfiguration(
  input: Omit<ExactProductionActionConfiguration, "configurationDigest">,
): ExactProductionActionConfiguration {
  if (
    input.schemaVersion !== 1 ||
    input.revision < 1n ||
    input.serviceIds.length === 0 ||
    input.serviceIds.some((serviceId) => !IDENTIFIER_PATTERN.test(serviceId)) ||
    new Set(input.serviceIds).size !== input.serviceIds.length ||
    (input.isolatedCandidateAttemptId !== null &&
      !IDENTIFIER_PATTERN.test(input.isolatedCandidateAttemptId)) ||
    (input.isolatedCandidateAttemptId === null &&
      input.isolatedCandidateBindingDigest !== null)
  )
    fail(ActionReleaseRolloutTransitionErrorCode.OverlapInvalid);
  if (input.isolatedCandidateBindingDigest !== null)
    sha256(
      input.isolatedCandidateBindingDigest,
      "isolated_candidate_binding_digest",
    );
  timestamp(input.observedAt);
  const refFields = [
    input.primaryRef,
    input.installerRef,
    input.reusableWorkflowRef,
    input.runtimeRef,
    input.refreshActionRef,
    input.interactionRuntimeRef,
    ...input.knownRefs,
  ];
  refFields.forEach(assertImmutableActionRef);
  const installer = exactActionInstallerIdentity(
    input.installer,
    input.installerRef,
  );
  const serviceIds = [...input.serviceIds].sort();
  const knownRefs = [...input.knownRefs].sort((left, right) =>
    codeUnitCompare(left.canonical, right.canonical),
  );
  if (new Set(knownRefs.map((ref) => ref.canonical)).size !== knownRefs.length)
    fail(ActionReleaseRolloutTransitionErrorCode.OverlapInvalid);
  const unsigned = Object.freeze({
    schemaVersion: 1 as const,
    revision: input.revision,
    observedAt: input.observedAt,
    serviceIds: Object.freeze(serviceIds),
    primaryRef: input.primaryRef,
    installerRef: input.installerRef,
    installer,
    reusableWorkflowRef: input.reusableWorkflowRef,
    runtimeRef: input.runtimeRef,
    refreshActionRef: input.refreshActionRef,
    interactionRuntimeRef: input.interactionRuntimeRef,
    knownRefs: Object.freeze(knownRefs),
    isolatedCandidateAttemptId: input.isolatedCandidateAttemptId,
    isolatedCandidateBindingDigest: input.isolatedCandidateBindingDigest,
  });
  return Object.freeze({
    ...unsigned,
    configurationDigest: sha256(
      `sha256:${sha256Canonical(configurationDigestInput(unsigned))}`,
      "production_action_configuration_digest",
    ),
  });
}

export function assertExactProductionActionConfiguration(
  configuration: ExactProductionActionConfiguration,
): ExactProductionActionConfiguration {
  const { configurationDigest, ...unsigned } = configuration;
  const expected = sha256(
    `sha256:${sha256Canonical(configurationDigestInput(unsigned))}`,
    "production_action_configuration_digest",
  );
  if (configurationDigest !== expected)
    fail(ActionReleaseRolloutTransitionErrorCode.OverlapInvalid);
  return configuration;
}

export interface ActionReleaseCandidateAttempt {
  readonly attemptId: string;
  /** Audit lineage only. Never use this field to derive trust or eligibility. */
  readonly fromRelease: ImmutableActionRef;
  readonly candidateRelease: VerifiedActionReleaseV2;
  readonly policyRevision: bigint;
  readonly registeredAt: string;
  readonly originAdmissionMode: "normal" | "recovery_only";
  readonly originRecoveryFence: Readonly<{
    fenceId: string;
    epoch: bigint;
  }> | null;
}

export interface ActionReleaseInventoryIdentity {
  readonly inventoryDigest: Sha256;
  readonly inventoryScopeDigest: Sha256;
  readonly capturedAt: string;
  readonly repositoryCohortRevision: bigint;
  readonly repositoryCohortDigest: Sha256;
  readonly githubRepositoryIds: readonly string[];
  readonly policyRevision: bigint;
  readonly exactRefs: readonly ImmutableActionRef[];
  readonly maximumQueueLeaseWindowMs: number;
}

export interface ActionReleasePromotionPreparation {
  readonly inventory: Readonly<ActionReleaseInventoryIdentity>;
  readonly configuration: ExactProductionActionConfiguration;
  readonly configurationDigest: Sha256;
  readonly configurationRevision: bigint;
  readonly preparedAt: string;
  readonly validUntil: string;
}

export interface PromotionReceiptReservation {
  readonly reservationId: string;
  readonly ownerAttemptId: string;
  readonly receiptId: string;
  readonly artifactId: string;
  readonly canonicalPayloadDigest: Sha256;
  readonly artifactSha256: Sha256;
  readonly expectationDigest: Sha256;
  readonly receiptIdentityDigest: Sha256;
  readonly reservedAt: string;
  readonly epoch: bigint;
}

export const ActionReleaseOverlapEffectState = Object.freeze({
  Dispatching: "dispatching",
  Verified: "verified",
  Uncertain: "uncertain",
} as const);

export type ActionReleaseOverlapEffectState =
  (typeof ActionReleaseOverlapEffectState)[keyof typeof ActionReleaseOverlapEffectState];

export interface ActionReleaseOverlapEffectCheckpoint {
  readonly effectId: string;
  readonly ownerAttemptId: string;
  readonly epoch: bigint;
  readonly state: ActionReleaseOverlapEffectState;
  readonly expectedConfiguration: ExactProductionActionConfiguration;
  readonly observationDigest: Sha256 | null;
  readonly updatedAt: string;
}

export const ActionReleasePromotionEffectState = Object.freeze({
  Dispatching: "dispatching",
  Uncertain: "uncertain",
} as const);

export type ActionReleasePromotionEffectState =
  (typeof ActionReleasePromotionEffectState)[keyof typeof ActionReleasePromotionEffectState];

export interface ActionReleasePromotionEffectCheckpoint {
  readonly effectId: string;
  readonly ownerAttemptId: string;
  readonly epoch: bigint;
  readonly state: ActionReleasePromotionEffectState;
  readonly observationDigest: Sha256 | null;
  readonly updatedAt: string;
}

export const ActionReleaseAdmissionEffectOperation = Object.freeze({
  CloseRecovery: "close_recovery_admission",
  ReopenRecovery: "reopen_recovery_admission",
} as const);

export type ActionReleaseAdmissionEffectOperation =
  (typeof ActionReleaseAdmissionEffectOperation)[keyof typeof ActionReleaseAdmissionEffectOperation];

export const ActionReleaseAdmissionEffectState = Object.freeze({
  Dispatching: "dispatching",
  Uncertain: "uncertain",
  Verified: "verified",
} as const);

export type ActionReleaseAdmissionEffectState =
  (typeof ActionReleaseAdmissionEffectState)[keyof typeof ActionReleaseAdmissionEffectState];

export interface RecoveryAdmissionCloseEffectCheckpoint {
  readonly operation: typeof ActionReleaseAdmissionEffectOperation.CloseRecovery;
  readonly effectId: string;
  readonly epoch: bigint;
  readonly state: ActionReleaseAdmissionEffectState;
  readonly currentPrimary: ImmutableActionRef;
  readonly failureDigest: Sha256;
  readonly fenceId: string;
  readonly fenceEpoch: bigint;
  readonly observationDigest: Sha256 | null;
  readonly updatedAt: string;
}

export interface RecoveryAdmissionReopenEffectCheckpoint {
  readonly operation: typeof ActionReleaseAdmissionEffectOperation.ReopenRecovery;
  readonly effectId: string;
  readonly epoch: bigint;
  readonly state:
    | typeof ActionReleaseAdmissionEffectState.Dispatching
    | typeof ActionReleaseAdmissionEffectState.Uncertain;
  readonly ownerAttemptId: string;
  readonly fenceId: string;
  readonly fenceEpoch: bigint;
  readonly promotedPrimary: ImmutableActionRef;
  readonly promotedConfiguration: ExactProductionActionConfiguration;
  readonly observationDigest: Sha256 | null;
  readonly updatedAt: string;
}

export type ActionReleaseAdmissionEffectCheckpoint =
  | Readonly<RecoveryAdmissionCloseEffectCheckpoint>
  | Readonly<RecoveryAdmissionReopenEffectCheckpoint>;

export interface PredecessorAdmissionEffectCheckpoint {
  readonly effectId: string;
  readonly epoch: bigint;
  readonly state:
    | typeof ActionReleaseAdmissionEffectState.Dispatching
    | typeof ActionReleaseAdmissionEffectState.Uncertain;
  readonly fenceId: string;
  readonly fenceEpoch: bigint;
  readonly observationDigest: Sha256 | null;
  readonly startedAt: string;
  readonly updatedAt: string;
}

export interface PredecessorRemovalEffect {
  readonly effectId: string;
  readonly epoch: bigint;
  readonly state: "dispatching" | "uncertain";
  readonly proof: PredecessorRemovalProof;
  readonly observationDigest: Sha256 | null;
  readonly updatedAt: string;
}

export interface ActionReleasePredecessorRetention {
  readonly predecessorRef: ImmutableActionRef;
  readonly promotionAttemptId: string;
  readonly repositoryCohortRevision: bigint;
  readonly repositoryCohortDigest: Sha256;
  readonly githubRepositoryIds: readonly string[];
  readonly policyRevision: bigint;
  readonly inventoryScopeDigest: Sha256;
  readonly configurationDigest: Sha256;
  readonly configurationRevision: bigint;
  readonly installer: Readonly<ExactActionInstallerIdentity>;
  readonly serviceIds: readonly string[];
  readonly requiredWindowMs: number;
  readonly authorityEstablishedAt: string;
  readonly admissionEffect: Readonly<PredecessorAdmissionEffectCheckpoint> | null;
  readonly fence: Readonly<PredecessorAdmissionFence> | null;
  readonly firstZeroCapture: Readonly<ZeroPredecessorReferenceCapture> | null;
  readonly removalEffect: Readonly<PredecessorRemovalEffect> | null;
}

export interface CompletedActionReleasePromotion {
  readonly attemptId: string;
  readonly fromRelease: ImmutableActionRef;
  readonly toRelease: ImmutableActionRef;
  readonly receiptId: string;
  readonly artifactId: string;
  readonly completedAt: string;
  readonly configurationDigest: Sha256;
}

interface ActionReleaseRolloutBase {
  readonly schemaVersion: 1;
  readonly channel: typeof ACTION_RELEASE_CHANNEL;
  readonly phase: ActionReleaseRolloutPhase;
  readonly aggregateVersion: bigint;
  readonly channelVersion: bigint;
  readonly primaryRef: ImmutableActionRef;
  readonly admissionMode: "normal" | "recovery_only";
  readonly recoveryAdmissionEffect: ActionReleaseAdmissionEffectCheckpoint | null;
  readonly latestInventory: Readonly<ActionReleaseInventoryIdentity> | null;
  readonly predecessorRetention: Readonly<ActionReleasePredecessorRetention> | null;
  /** Fail-closed staged-candidate drain holds; never general/candidate eligibility. */
  readonly candidateDrainHolds: readonly ImmutableActionRef[];
  /** Monotonic audit identity set; attempt IDs are never reusable. */
  readonly usedCandidateAttemptIds: readonly string[];
  readonly lastCompletedPromotion: Readonly<CompletedActionReleasePromotion> | null;
}

export interface SteadyActionReleaseRollout extends ActionReleaseRolloutBase {
  readonly phase: typeof ActionReleaseRolloutPhase.Steady;
  readonly admissionMode: "normal";
}

interface CandidateBearingActionReleaseRollout extends ActionReleaseRolloutBase {
  readonly candidate: Readonly<ActionReleaseCandidateAttempt>;
  readonly overlapEffect: Readonly<ActionReleaseOverlapEffectCheckpoint> | null;
}

export interface CandidateRegisteredActionReleaseRollout extends CandidateBearingActionReleaseRollout {
  readonly phase: typeof ActionReleaseRolloutPhase.CandidateRegistered;
}

export interface OverlapStagedActionReleaseRollout extends CandidateBearingActionReleaseRollout {
  readonly phase: typeof ActionReleaseRolloutPhase.OverlapStaged;
  readonly overlapConfiguration: ExactProductionActionConfiguration;
}

export interface CandidateProvisioningEligibilitySnapshot {
  readonly aggregateVersion: bigint;
  readonly phase: typeof ActionReleaseRolloutPhase.CanaryArmed;
  readonly admissionMode: "normal" | "recovery_only";
  readonly policyRevision: bigint;
  readonly channelVersion: bigint;
  readonly selectionDigest: Sha256;
  readonly contextDigest: Sha256;
  readonly decisionDigest: Sha256;
}

export interface CandidateProvisioningCheckpoint {
  readonly effectId: Sha256;
  readonly epoch: bigint;
  readonly state: "prepared" | "dispatching" | "verified" | "uncertain";
  readonly eligibility: Readonly<CandidateProvisioningEligibilitySnapshot> | null;
  readonly observationDigest: Sha256 | null;
  readonly updatedAt: string;
}

export const FixedTerminalReceiptVerificationState = Object.freeze({
  Dispatching: "dispatching",
  Uncertain: "uncertain",
  Verified: "verified",
} as const);

export type FixedTerminalReceiptVerificationState =
  (typeof FixedTerminalReceiptVerificationState)[keyof typeof FixedTerminalReceiptVerificationState];

export interface FixedTerminalReceiptVerificationCheckpoint {
  readonly effectId: string;
  readonly ownerAttemptId: string;
  readonly epoch: bigint;
  readonly locator: Readonly<ImmutableEvidenceArtifactLocator>;
  readonly expectationDigest: Sha256;
  readonly state: FixedTerminalReceiptVerificationState;
  readonly leaseExpiresAt: string;
  readonly observationDigest: Sha256 | null;
  readonly updatedAt: string;
}

export interface CanaryArmedActionReleaseRollout extends CandidateBearingActionReleaseRollout {
  readonly phase: typeof ActionReleaseRolloutPhase.CanaryArmed;
  readonly overlapConfiguration: ExactProductionActionConfiguration;
  readonly canary: Readonly<FixedCanaryBinding>;
  readonly expectation: Readonly<FixedTerminalCanaryExpectation>;
  readonly provisioning: Readonly<CandidateProvisioningCheckpoint>;
  readonly receiptVerification: Readonly<FixedTerminalReceiptVerificationCheckpoint> | null;
}

export interface CanaryVerifiedActionReleaseRollout extends CandidateBearingActionReleaseRollout {
  readonly phase: typeof ActionReleaseRolloutPhase.CanaryVerified;
  readonly overlapConfiguration: ExactProductionActionConfiguration;
  readonly canary: Readonly<FixedCanaryBinding>;
  readonly expectation: Readonly<FixedTerminalCanaryExpectation>;
  readonly provisioning: Readonly<CandidateProvisioningCheckpoint> & {
    readonly state: "verified";
  };
  readonly receiptVerification: Readonly<FixedTerminalReceiptVerificationCheckpoint> & {
    readonly state: "verified";
  };
  readonly receipt: VerifiedFixedTerminalCanaryReceiptV4;
}

export interface PromotionPreparedActionReleaseRollout extends CandidateBearingActionReleaseRollout {
  readonly phase: typeof ActionReleaseRolloutPhase.PromotionPrepared;
  readonly overlapConfiguration: ExactProductionActionConfiguration;
  readonly canary: Readonly<FixedCanaryBinding>;
  readonly expectation: Readonly<FixedTerminalCanaryExpectation>;
  readonly provisioning: Readonly<CandidateProvisioningCheckpoint> & {
    readonly state: "verified";
  };
  readonly receiptVerification: Readonly<FixedTerminalReceiptVerificationCheckpoint> & {
    readonly state: "verified";
  };
  readonly receipt: VerifiedFixedTerminalCanaryReceiptV4;
  readonly preparation: Readonly<ActionReleasePromotionPreparation>;
}

export interface PromotingActionReleaseRollout extends CandidateBearingActionReleaseRollout {
  readonly phase: typeof ActionReleaseRolloutPhase.Promoting;
  readonly overlapConfiguration: ExactProductionActionConfiguration;
  readonly canary: Readonly<FixedCanaryBinding>;
  readonly expectation: Readonly<FixedTerminalCanaryExpectation>;
  readonly provisioning: Readonly<CandidateProvisioningCheckpoint> & {
    readonly state: "verified";
  };
  readonly receiptVerification: Readonly<FixedTerminalReceiptVerificationCheckpoint> & {
    readonly state: "verified";
  };
  readonly receipt: VerifiedFixedTerminalCanaryReceiptV4;
  readonly preparation: Readonly<ActionReleasePromotionPreparation>;
  readonly reservation: Readonly<PromotionReceiptReservation>;
  readonly effect: Readonly<ActionReleasePromotionEffectCheckpoint>;
}

export interface PromotionUncertainActionReleaseRollout extends CandidateBearingActionReleaseRollout {
  readonly phase: typeof ActionReleaseRolloutPhase.PromotionUncertain;
  readonly overlapConfiguration: ExactProductionActionConfiguration;
  readonly canary: Readonly<FixedCanaryBinding>;
  readonly expectation: Readonly<FixedTerminalCanaryExpectation>;
  readonly provisioning: Readonly<CandidateProvisioningCheckpoint> & {
    readonly state: "verified";
  };
  readonly receiptVerification: Readonly<FixedTerminalReceiptVerificationCheckpoint> & {
    readonly state: "verified";
  };
  readonly receipt: VerifiedFixedTerminalCanaryReceiptV4;
  readonly preparation: Readonly<ActionReleasePromotionPreparation>;
  readonly reservation: Readonly<PromotionReceiptReservation>;
  readonly effect: Readonly<ActionReleasePromotionEffectCheckpoint> & {
    readonly state: "uncertain";
  };
}

export interface CandidateAbortedActionReleaseRollout extends ActionReleaseRolloutBase {
  readonly phase: typeof ActionReleaseRolloutPhase.CandidateAborted;
  readonly abortedCandidate: Readonly<ActionReleaseCandidateAttempt>;
  readonly abortedAt: string;
  readonly abortReasonDigest: Sha256;
  readonly receiptIdentity: Readonly<{
    receiptId: string;
    artifactId: string;
  }> | null;
}

export interface RecoveryOnlyActionReleaseRollout extends ActionReleaseRolloutBase {
  readonly phase: typeof ActionReleaseRolloutPhase.RecoveryOnly;
  readonly admissionMode: "recovery_only";
  readonly recoveryFenceId: string;
  readonly recoveryFenceEpoch: bigint;
  readonly failureDigest: Sha256;
  readonly enteredAt: string;
  readonly recoveryAdmissionEffect: Readonly<RecoveryAdmissionCloseEffectCheckpoint>;
}

export type ActionReleaseRollout =
  | SteadyActionReleaseRollout
  | CandidateRegisteredActionReleaseRollout
  | OverlapStagedActionReleaseRollout
  | CanaryArmedActionReleaseRollout
  | CanaryVerifiedActionReleaseRollout
  | PromotionPreparedActionReleaseRollout
  | PromotingActionReleaseRollout
  | PromotionUncertainActionReleaseRollout
  | CandidateAbortedActionReleaseRollout
  | RecoveryOnlyActionReleaseRollout;

type RegisterableActionReleaseRollout =
  | SteadyActionReleaseRollout
  | RecoveryOnlyActionReleaseRollout
  | CandidateAbortedActionReleaseRollout;

type AbortableActionReleaseRollout =
  | CandidateRegisteredActionReleaseRollout
  | OverlapStagedActionReleaseRollout
  | CanaryArmedActionReleaseRollout
  | CanaryVerifiedActionReleaseRollout
  | PromotionPreparedActionReleaseRollout;

type RetainingActionReleaseRollout =
  | SteadyActionReleaseRollout
  | RecoveryOnlyActionReleaseRollout
  | CandidateAbortedActionReleaseRollout;

export function createSteadyActionReleaseRollout(input: {
  readonly primaryRef: ImmutableActionRef;
  readonly channelVersion: bigint;
  readonly aggregateVersion?: bigint;
}): SteadyActionReleaseRollout {
  assertImmutableActionRef(input.primaryRef);
  if (
    input.channelVersion < 1n ||
    (input.aggregateVersion !== undefined && input.aggregateVersion < 1n)
  )
    fail(ActionReleaseRolloutTransitionErrorCode.InvalidVersion);
  return Object.freeze({
    schemaVersion: 1,
    channel: ACTION_RELEASE_CHANNEL,
    phase: ActionReleaseRolloutPhase.Steady,
    aggregateVersion: input.aggregateVersion ?? 1n,
    channelVersion: input.channelVersion,
    primaryRef: input.primaryRef,
    admissionMode: "normal",
    recoveryAdmissionEffect: null,
    latestInventory: null,
    predecessorRetention: null,
    candidateDrainHolds: Object.freeze([]),
    usedCandidateAttemptIds: Object.freeze([]),
    lastCompletedPromotion: null,
  });
}

function validateCandidate(
  rollout: RegisterableActionReleaseRollout,
  input: {
    readonly attemptId: string;
    readonly candidateRelease: VerifiedActionReleaseV2;
    readonly policyRevision: bigint;
    readonly registeredAt: string;
  },
): Readonly<ActionReleaseCandidateAttempt> {
  const recoveryAdmission = rollout.recoveryAdmissionEffect;
  if (!IDENTIFIER_PATTERN.test(input.attemptId) || input.policyRevision < 1n)
    fail(ActionReleaseRolloutTransitionErrorCode.CandidateInvalid);
  if (
    (rollout.predecessorRetention?.admissionEffect ?? null) !== null ||
    (rollout.predecessorRetention?.removalEffect ?? null) !== null ||
    (rollout.admissionMode === "recovery_only" &&
      (!recoveryAdmission ||
        recoveryAdmission.operation !==
          ActionReleaseAdmissionEffectOperation.CloseRecovery ||
        recoveryAdmission.state !== ActionReleaseAdmissionEffectState.Verified))
  )
    fail(ActionReleaseRolloutTransitionErrorCode.AdmissionEffectInvalid);
  timestamp(input.registeredAt);
  if (rollout.usedCandidateAttemptIds.includes(input.attemptId))
    fail(ActionReleaseRolloutTransitionErrorCode.AttemptReplay);
  const release = assertVerifiedActionReleaseV2(input.candidateRelease);
  if (
    rollout.predecessorRetention &&
    !sameActionRef(
      release.actionRef,
      rollout.predecessorRetention.predecessorRef,
    )
  )
    fail(ActionReleaseRolloutTransitionErrorCode.PredecessorRetentionInvalid);
  if (!sameActionRepository(rollout.primaryRef, release.actionRef))
    fail(ActionReleaseRolloutTransitionErrorCode.ActionRepositoryMismatch);
  if (sameActionRef(rollout.primaryRef, release.actionRef))
    fail(ActionReleaseRolloutTransitionErrorCode.CandidateAlreadyPrimary);
  return Object.freeze({
    attemptId: input.attemptId,
    fromRelease: rollout.primaryRef,
    candidateRelease: release,
    policyRevision: input.policyRevision,
    registeredAt: input.registeredAt,
    originAdmissionMode: rollout.admissionMode,
    originRecoveryFence:
      rollout.phase === ActionReleaseRolloutPhase.RecoveryOnly
        ? Object.freeze({
            fenceId: rollout.recoveryFenceId,
            epoch: rollout.recoveryFenceEpoch,
          })
        : rollout.phase === ActionReleaseRolloutPhase.CandidateAborted &&
            rollout.admissionMode === "recovery_only"
          ? rollout.abortedCandidate.originRecoveryFence
          : null,
  });
}

export function registerActionReleaseCandidate(
  rollout: RegisterableActionReleaseRollout,
  input: {
    readonly attemptId: string;
    readonly candidateRelease: VerifiedActionReleaseV2;
    readonly policyRevision: bigint;
    readonly registeredAt: string;
  },
): CandidateRegisteredActionReleaseRollout {
  if (
    ![
      ActionReleaseRolloutPhase.Steady,
      ActionReleaseRolloutPhase.RecoveryOnly,
      ActionReleaseRolloutPhase.CandidateAborted,
    ].includes(rollout.phase)
  )
    fail(ActionReleaseRolloutTransitionErrorCode.InvalidPhase);
  return Object.freeze({
    schemaVersion: 1,
    channel: ACTION_RELEASE_CHANNEL,
    phase: ActionReleaseRolloutPhase.CandidateRegistered,
    aggregateVersion: nextRevision(rollout),
    channelVersion: rollout.channelVersion,
    primaryRef: rollout.primaryRef,
    admissionMode: rollout.admissionMode,
    recoveryAdmissionEffect: rollout.recoveryAdmissionEffect,
    latestInventory: rollout.latestInventory,
    predecessorRetention: rollout.predecessorRetention,
    candidateDrainHolds: rollout.candidateDrainHolds,
    usedCandidateAttemptIds: Object.freeze([
      ...rollout.usedCandidateAttemptIds,
      input.attemptId,
    ]),
    lastCompletedPromotion: rollout.lastCompletedPromotion,
    candidate: validateCandidate(rollout, input),
    overlapEffect: null,
  });
}

function assertCandidateAttempt(
  rollout: CandidateBearingActionReleaseRollout,
  attemptId: string,
): void {
  if (
    rollout.candidate.attemptId !== attemptId ||
    !sameActionRef(rollout.primaryRef, rollout.candidate.fromRelease)
  )
    fail(ActionReleaseRolloutTransitionErrorCode.CandidateBindingMismatch);
}

function allGeneralRefsEqual(
  configuration: ExactProductionActionConfiguration,
  ref: ImmutableActionRef,
): boolean {
  return [
    configuration.primaryRef,
    configuration.installerRef,
    configuration.reusableWorkflowRef,
    configuration.runtimeRef,
    configuration.refreshActionRef,
    configuration.interactionRuntimeRef,
  ].every((value) => sameActionRef(value, ref));
}

function sameInstallerIdentity(
  left: ExactActionInstallerIdentity,
  right: ExactActionInstallerIdentity,
): boolean {
  return (
    left.version === right.version &&
    left.url === right.url &&
    left.sha256 === right.sha256
  );
}

function canonicalRefSet(
  refs: readonly ImmutableActionRef[],
): readonly string[] {
  return refs.map((ref) => ref.canonical).sort();
}

function exactRefSetEquals(
  left: readonly ImmutableActionRef[],
  right: readonly ImmutableActionRef[],
): boolean {
  const canonicalLeft = canonicalRefSet(left);
  const canonicalRight = canonicalRefSet(right);
  return (
    canonicalLeft.length === canonicalRight.length &&
    canonicalLeft.every((value, index) => value === canonicalRight[index])
  );
}

function expectedKnownRefs(input: {
  readonly rollout: ActionReleaseRolloutBase;
  readonly candidateRef?: ImmutableActionRef;
  readonly inventoryRefs?: readonly ImmutableActionRef[];
}): readonly ImmutableActionRef[] {
  const refs = [
    input.rollout.primaryRef,
    ...input.rollout.candidateDrainHolds,
    ...(input.rollout.predecessorRetention
      ? [input.rollout.predecessorRetention.predecessorRef]
      : []),
    ...(input.inventoryRefs ?? input.rollout.latestInventory?.exactRefs ?? []),
    ...(input.candidateRef ? [input.candidateRef] : []),
  ];
  const unique = new Map<string, ImmutableActionRef>();
  for (const ref of refs) unique.set(ref.canonical, ref);
  return Object.freeze(
    [...unique.values()].sort((left, right) =>
      codeUnitCompare(left.canonical, right.canonical),
    ),
  );
}

function exactStringSetEquals(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((value, index) => value === sortedRight[index])
  );
}

function assertPreOverlapConfiguration(
  rollout: CandidateRegisteredActionReleaseRollout,
  configurationInput: ExactProductionActionConfiguration,
): ExactProductionActionConfiguration {
  const configuration =
    assertExactProductionActionConfiguration(configurationInput);
  const isolatedAttemptId = configuration.isolatedCandidateAttemptId;
  const hasNoIsolatedCandidate =
    isolatedAttemptId === null &&
    configuration.isolatedCandidateBindingDigest === null;
  const hasRetiredIsolatedCandidate =
    isolatedAttemptId !== null &&
    isolatedAttemptId !== rollout.candidate.attemptId &&
    rollout.usedCandidateAttemptIds.includes(isolatedAttemptId);
  if (
    !allGeneralRefsEqual(configuration, rollout.primaryRef) ||
    (!hasNoIsolatedCandidate && !hasRetiredIsolatedCandidate) ||
    !exactRefSetEquals(configuration.knownRefs, expectedKnownRefs({ rollout }))
  )
    fail(ActionReleaseRolloutTransitionErrorCode.OverlapInvalid);
  return configuration;
}

export function beginActionReleaseOverlapStaging(
  rollout: CandidateRegisteredActionReleaseRollout,
  input: {
    readonly attemptId: string;
    readonly expectedConfiguration: ExactProductionActionConfiguration;
    readonly effectId: string;
    readonly effectEpoch: bigint;
    readonly startedAt: string;
  },
): CandidateRegisteredActionReleaseRollout {
  if (rollout.phase !== ActionReleaseRolloutPhase.CandidateRegistered)
    fail(ActionReleaseRolloutTransitionErrorCode.InvalidPhase);
  assertCandidateAttempt(rollout, input.attemptId);
  if (
    rollout.overlapEffect !== null ||
    !IDENTIFIER_PATTERN.test(input.effectId) ||
    input.effectEpoch !== rollout.aggregateVersion + 1n
  )
    fail(ActionReleaseRolloutTransitionErrorCode.ReconcileOnly);
  timestamp(input.startedAt);
  const expectedConfiguration = assertPreOverlapConfiguration(
    rollout,
    input.expectedConfiguration,
  );
  return Object.freeze({
    ...rollout,
    aggregateVersion: nextRevision(rollout),
    overlapEffect: Object.freeze({
      effectId: input.effectId,
      ownerAttemptId: rollout.candidate.attemptId,
      epoch: input.effectEpoch,
      state: ActionReleaseOverlapEffectState.Dispatching,
      expectedConfiguration,
      observationDigest: null,
      updatedAt: input.startedAt,
    }),
  });
}

export function markActionReleaseOverlapUncertain(
  rollout: CandidateRegisteredActionReleaseRollout,
  input: {
    readonly attemptId: string;
    readonly observationDigest: Sha256;
    readonly observedAt: string;
  },
): CandidateRegisteredActionReleaseRollout {
  if (
    rollout.phase !== ActionReleaseRolloutPhase.CandidateRegistered ||
    rollout.overlapEffect === null ||
    rollout.overlapEffect.state === ActionReleaseOverlapEffectState.Verified
  )
    fail(ActionReleaseRolloutTransitionErrorCode.ReconcileOnly);
  assertCandidateAttempt(rollout, input.attemptId);
  sha256(input.observationDigest, "overlap_uncertain_observation_digest");
  if (timestamp(input.observedAt) < timestamp(rollout.overlapEffect.updatedAt))
    fail(ActionReleaseRolloutTransitionErrorCode.OverlapInvalid);
  return Object.freeze({
    ...rollout,
    aggregateVersion: nextRevision(rollout),
    overlapEffect: Object.freeze({
      ...rollout.overlapEffect,
      state: ActionReleaseOverlapEffectState.Uncertain,
      observationDigest: input.observationDigest,
      updatedAt: input.observedAt,
    }),
  });
}

export function clearActionReleaseOverlapAfterDefiniteNoEffect(
  rollout: CandidateRegisteredActionReleaseRollout,
  input: {
    readonly attemptId: string;
    readonly configuration: ExactProductionActionConfiguration;
    readonly clearedAt: string;
  },
): CandidateRegisteredActionReleaseRollout {
  if (
    rollout.phase !== ActionReleaseRolloutPhase.CandidateRegistered ||
    rollout.overlapEffect === null
  )
    fail(ActionReleaseRolloutTransitionErrorCode.ReconcileOnly);
  assertCandidateAttempt(rollout, input.attemptId);
  const configuration = assertPreOverlapConfiguration(
    rollout,
    input.configuration,
  );
  const expected = rollout.overlapEffect.expectedConfiguration;
  if (
    configuration.revision !== expected.revision ||
    !exactStringSetEquals(configuration.serviceIds, expected.serviceIds) ||
    !sameInstallerIdentity(configuration.installer, expected.installer) ||
    timestamp(input.clearedAt) < timestamp(rollout.overlapEffect.updatedAt)
  )
    fail(ActionReleaseRolloutTransitionErrorCode.OverlapInvalid);
  return Object.freeze({
    ...rollout,
    aggregateVersion: nextRevision(rollout),
    overlapEffect: null,
  });
}

export function stageActionReleaseOverlap(
  rollout: CandidateRegisteredActionReleaseRollout,
  input: {
    readonly attemptId: string;
    readonly configuration: ExactProductionActionConfiguration;
  },
): OverlapStagedActionReleaseRollout {
  if (
    rollout.phase !== ActionReleaseRolloutPhase.CandidateRegistered ||
    rollout.overlapEffect === null
  )
    fail(ActionReleaseRolloutTransitionErrorCode.ReconcileOnly);
  assertCandidateAttempt(rollout, input.attemptId);
  const configuration = assertExactProductionActionConfiguration(
    input.configuration,
  );
  const previousConfiguration = assertPreOverlapConfiguration(
    rollout,
    rollout.overlapEffect.expectedConfiguration,
  );
  if (
    rollout.overlapEffect.ownerAttemptId !== rollout.candidate.attemptId ||
    rollout.overlapEffect.epoch > rollout.aggregateVersion ||
    !exactStringSetEquals(
      previousConfiguration.serviceIds,
      configuration.serviceIds,
    ) ||
    !sameInstallerIdentity(
      previousConfiguration.installer,
      configuration.installer,
    ) ||
    configuration.revision <= previousConfiguration.revision ||
    timestamp(configuration.observedAt) <
      Math.max(
        timestamp(previousConfiguration.observedAt),
        timestamp(rollout.overlapEffect.updatedAt),
      )
  )
    fail(ActionReleaseRolloutTransitionErrorCode.OverlapInvalid);
  if (
    !allGeneralRefsEqual(configuration, rollout.primaryRef) ||
    !exactRefSetEquals(
      configuration.knownRefs,
      expectedKnownRefs({
        rollout,
        candidateRef: rollout.candidate.candidateRelease.actionRef,
      }),
    ) ||
    configuration.isolatedCandidateAttemptId !== rollout.candidate.attemptId
  )
    fail(ActionReleaseRolloutTransitionErrorCode.OverlapInvalid);
  return Object.freeze({
    ...rollout,
    phase: ActionReleaseRolloutPhase.OverlapStaged,
    aggregateVersion: nextRevision(rollout),
    predecessorRetention:
      rollout.predecessorRetention &&
      sameActionRef(
        rollout.predecessorRetention.predecessorRef,
        rollout.candidate.candidateRelease.actionRef,
      )
        ? null
        : rollout.predecessorRetention,
    overlapEffect: Object.freeze({
      ...rollout.overlapEffect,
      state: ActionReleaseOverlapEffectState.Verified,
      observationDigest: configuration.configurationDigest,
      updatedAt: configuration.observedAt,
    }),
    overlapConfiguration: configuration,
  });
}

export function armFixedActionReleaseCanary(
  rollout: OverlapStagedActionReleaseRollout,
  input: {
    readonly attemptId: string;
    readonly binding: FixedCanaryBindingInput;
  },
): CanaryArmedActionReleaseRollout {
  if (rollout.phase !== ActionReleaseRolloutPhase.OverlapStaged)
    fail(ActionReleaseRolloutTransitionErrorCode.InvalidPhase);
  assertCandidateAttempt(rollout, input.attemptId);
  let canary: Readonly<FixedCanaryBinding>;
  try {
    canary = fixedCanaryBinding(
      input.binding,
      rollout.candidate.candidateRelease.actionRef,
    );
  } catch {
    fail(ActionReleaseRolloutTransitionErrorCode.CanaryBindingInvalid);
  }
  const expectation = fixedTerminalCanaryExpectation({
    rolloutAttemptId: rollout.candidate.attemptId,
    challengeSha256: canary.challengeSha256,
    candidateReleaseProofDigest: rollout.candidate.candidateRelease.proofDigest,
    binding: canary,
  });
  if (
    rollout.overlapConfiguration.isolatedCandidateBindingDigest !== null &&
    rollout.overlapConfiguration.isolatedCandidateBindingDigest !==
      expectation.expectationDigest
  )
    fail(ActionReleaseRolloutTransitionErrorCode.CanaryBindingInvalid);
  return Object.freeze({
    ...rollout,
    phase: ActionReleaseRolloutPhase.CanaryArmed,
    aggregateVersion: nextRevision(rollout),
    canary,
    expectation,
    provisioning: Object.freeze({
      effectId: expectation.expectationDigest,
      epoch: rollout.aggregateVersion + 1n,
      state: "prepared" as const,
      eligibility: null,
      observationDigest: null,
      updatedAt: rollout.candidate.registeredAt,
    }),
    receiptVerification: null,
  });
}

export function authorizeFixedActionReleaseCanaryProvisioning(
  rollout: CanaryArmedActionReleaseRollout,
  input: {
    readonly eligibility: CandidateProvisioningEligibilitySnapshot;
    readonly authorizedAt: string;
  },
): CanaryArmedActionReleaseRollout {
  if (
    rollout.phase !== ActionReleaseRolloutPhase.CanaryArmed ||
    rollout.provisioning.state !== "prepared" ||
    rollout.receiptVerification !== null
  )
    fail(ActionReleaseRolloutTransitionErrorCode.CanaryBindingInvalid);
  if (
    input.eligibility.aggregateVersion !== rollout.aggregateVersion ||
    input.eligibility.phase !== rollout.phase ||
    input.eligibility.admissionMode !== rollout.admissionMode ||
    input.eligibility.policyRevision !== rollout.candidate.policyRevision ||
    input.eligibility.channelVersion !== rollout.channelVersion
  )
    fail(ActionReleaseRolloutTransitionErrorCode.CanaryBindingInvalid);
  sha256(input.eligibility.selectionDigest, "canary_selection_digest");
  sha256(input.eligibility.contextDigest, "canary_context_digest");
  sha256(input.eligibility.decisionDigest, "canary_decision_digest");
  if (timestamp(input.authorizedAt) < timestamp(rollout.provisioning.updatedAt))
    fail(ActionReleaseRolloutTransitionErrorCode.CanaryBindingInvalid);
  return Object.freeze({
    ...rollout,
    aggregateVersion: nextRevision(rollout),
    provisioning: Object.freeze({
      ...rollout.provisioning,
      epoch: rollout.aggregateVersion + 1n,
      state: "dispatching" as const,
      eligibility: Object.freeze({ ...input.eligibility }),
      observationDigest: null,
      updatedAt: input.authorizedAt,
    }),
  });
}

export function confirmFixedActionReleaseCanaryProvisioned(
  rollout: CanaryArmedActionReleaseRollout,
  input: {
    readonly expectationDigest: Sha256;
    readonly decisionDigest: Sha256;
    readonly confirmedAt: string;
  },
): CanaryArmedActionReleaseRollout {
  if (
    rollout.phase !== ActionReleaseRolloutPhase.CanaryArmed ||
    (rollout.provisioning.state !== "dispatching" &&
      rollout.provisioning.state !== "uncertain") ||
    input.expectationDigest !== rollout.expectation.expectationDigest ||
    rollout.provisioning.eligibility === null ||
    input.decisionDigest !== rollout.provisioning.eligibility.decisionDigest
  )
    fail(ActionReleaseRolloutTransitionErrorCode.CanaryBindingInvalid);
  sha256(input.decisionDigest, "canary_provisioning_decision_digest");
  if (timestamp(input.confirmedAt) < timestamp(rollout.provisioning.updatedAt))
    fail(ActionReleaseRolloutTransitionErrorCode.CanaryBindingInvalid);
  return Object.freeze({
    ...rollout,
    aggregateVersion: nextRevision(rollout),
    provisioning: Object.freeze({
      ...rollout.provisioning,
      state: "verified" as const,
      observationDigest: null,
      updatedAt: input.confirmedAt,
    }),
  });
}

export function markFixedActionReleaseCanaryProvisioningUncertain(
  rollout: CanaryArmedActionReleaseRollout,
  input: {
    readonly observationDigest: Sha256;
    readonly observedAt: string;
  },
): CanaryArmedActionReleaseRollout {
  if (
    rollout.phase !== ActionReleaseRolloutPhase.CanaryArmed ||
    (rollout.provisioning.state !== "dispatching" &&
      rollout.provisioning.state !== "uncertain")
  )
    fail(ActionReleaseRolloutTransitionErrorCode.CanaryBindingInvalid);
  sha256(input.observationDigest, "canary_provisioning_observation_digest");
  if (rollout.provisioning.eligibility === null)
    fail(ActionReleaseRolloutTransitionErrorCode.CanaryBindingInvalid);
  if (timestamp(input.observedAt) < timestamp(rollout.provisioning.updatedAt))
    fail(ActionReleaseRolloutTransitionErrorCode.CanaryBindingInvalid);
  return Object.freeze({
    ...rollout,
    aggregateVersion: nextRevision(rollout),
    provisioning: Object.freeze({
      ...rollout.provisioning,
      state: "uncertain" as const,
      observationDigest: input.observationDigest,
      updatedAt: input.observedAt,
    }),
  });
}

export function beginFixedTerminalCanaryReceiptVerification(
  rollout: CanaryArmedActionReleaseRollout,
  input: {
    readonly attemptId: string;
    readonly locator: ImmutableEvidenceArtifactLocator;
    readonly effectId: string;
    readonly effectEpoch: bigint;
    readonly startedAt: string;
    readonly leaseExpiresAt: string;
  },
): CanaryArmedActionReleaseRollout {
  if (
    rollout.phase !== ActionReleaseRolloutPhase.CanaryArmed ||
    rollout.provisioning.state !== "verified"
  )
    fail(ActionReleaseRolloutTransitionErrorCode.CanaryBindingInvalid);
  assertCandidateAttempt(rollout, input.attemptId);
  if (
    rollout.receiptVerification !== null ||
    !IDENTIFIER_PATTERN.test(input.effectId) ||
    input.effectEpoch !== rollout.aggregateVersion + 1n
  )
    fail(ActionReleaseRolloutTransitionErrorCode.ReconcileOnly);
  const startedAt = timestamp(input.startedAt);
  if (timestamp(input.leaseExpiresAt) <= startedAt)
    fail(ActionReleaseRolloutTransitionErrorCode.ReceiptInvalid);
  let locator: Readonly<ImmutableEvidenceArtifactLocator>;
  try {
    locator = immutableEvidenceArtifactLocator(input.locator);
  } catch {
    fail(ActionReleaseRolloutTransitionErrorCode.ReceiptInvalid);
  }
  return Object.freeze({
    ...rollout,
    aggregateVersion: nextRevision(rollout),
    receiptVerification: Object.freeze({
      effectId: input.effectId,
      ownerAttemptId: rollout.candidate.attemptId,
      epoch: input.effectEpoch,
      locator,
      expectationDigest: rollout.expectation.expectationDigest,
      state: FixedTerminalReceiptVerificationState.Dispatching,
      leaseExpiresAt: input.leaseExpiresAt,
      observationDigest: null,
      updatedAt: input.startedAt,
    }),
  });
}

export function markFixedTerminalCanaryReceiptVerificationUncertain(
  rollout: CanaryArmedActionReleaseRollout,
  input: {
    readonly attemptId: string;
    readonly observationDigest: Sha256;
    readonly observedAt: string;
  },
): CanaryArmedActionReleaseRollout {
  if (
    rollout.phase !== ActionReleaseRolloutPhase.CanaryArmed ||
    rollout.receiptVerification === null ||
    rollout.receiptVerification.state !==
      FixedTerminalReceiptVerificationState.Dispatching
  )
    fail(ActionReleaseRolloutTransitionErrorCode.ReconcileOnly);
  assertCandidateAttempt(rollout, input.attemptId);
  sha256(input.observationDigest, "receipt_verification_observation_digest");
  if (
    timestamp(input.observedAt) <
    timestamp(rollout.receiptVerification.updatedAt)
  )
    fail(ActionReleaseRolloutTransitionErrorCode.ReceiptInvalid);
  return Object.freeze({
    ...rollout,
    aggregateVersion: nextRevision(rollout),
    receiptVerification: Object.freeze({
      ...rollout.receiptVerification,
      state: FixedTerminalReceiptVerificationState.Uncertain,
      observationDigest: input.observationDigest,
      updatedAt: input.observedAt,
    }),
  });
}

export function resumeFixedTerminalCanaryReceiptVerification(
  rollout: CanaryArmedActionReleaseRollout,
  input: {
    readonly attemptId: string;
    readonly resumedAt: string;
    readonly leaseExpiresAt: string;
  },
): CanaryArmedActionReleaseRollout {
  if (
    rollout.phase !== ActionReleaseRolloutPhase.CanaryArmed ||
    rollout.receiptVerification === null ||
    rollout.receiptVerification.state ===
      FixedTerminalReceiptVerificationState.Verified
  )
    fail(ActionReleaseRolloutTransitionErrorCode.ReconcileOnly);
  assertCandidateAttempt(rollout, input.attemptId);
  const resumedAt = timestamp(input.resumedAt);
  if (
    (rollout.receiptVerification.state ===
      FixedTerminalReceiptVerificationState.Dispatching &&
      resumedAt < timestamp(rollout.receiptVerification.leaseExpiresAt)) ||
    resumedAt < timestamp(rollout.receiptVerification.updatedAt) ||
    timestamp(input.leaseExpiresAt) <= resumedAt
  )
    fail(ActionReleaseRolloutTransitionErrorCode.ReconcileOnly);
  return Object.freeze({
    ...rollout,
    aggregateVersion: nextRevision(rollout),
    receiptVerification: Object.freeze({
      ...rollout.receiptVerification,
      epoch: rollout.aggregateVersion + 1n,
      state: FixedTerminalReceiptVerificationState.Dispatching,
      leaseExpiresAt: input.leaseExpiresAt,
      observationDigest: null,
      updatedAt: input.resumedAt,
    }),
  });
}

export function acceptFixedTerminalCanaryReceipt(
  rollout: CanaryArmedActionReleaseRollout,
  input: {
    readonly attemptId: string;
    readonly receipt: VerifiedFixedTerminalCanaryReceiptV4;
  },
): CanaryVerifiedActionReleaseRollout {
  if (rollout.phase !== ActionReleaseRolloutPhase.CanaryArmed)
    fail(ActionReleaseRolloutTransitionErrorCode.InvalidPhase);
  if (
    rollout.provisioning.state !== "verified" ||
    rollout.receiptVerification === null ||
    rollout.receiptVerification.state !==
      FixedTerminalReceiptVerificationState.Dispatching ||
    rollout.receiptVerification.ownerAttemptId !==
      rollout.candidate.attemptId ||
    rollout.receiptVerification.expectationDigest !==
      rollout.expectation.expectationDigest ||
    rollout.receiptVerification.epoch > rollout.aggregateVersion
  )
    fail(ActionReleaseRolloutTransitionErrorCode.CanaryBindingInvalid);
  assertCandidateAttempt(rollout, input.attemptId);
  let receipt: VerifiedFixedTerminalCanaryReceiptV4;
  try {
    receipt = assertVerifiedFixedTerminalCanaryReceiptV4(
      input.receipt,
      rollout.expectation,
    );
  } catch {
    fail(ActionReleaseRolloutTransitionErrorCode.ReceiptInvalid);
  }
  if (
    !sameActionRef(
      receipt.candidateActionRef,
      rollout.candidate.candidateRelease.actionRef,
    ) ||
    receipt.artifactId !== rollout.receiptVerification.locator.artifactId ||
    receipt.artifactSha256 !==
      rollout.receiptVerification.locator.artifactSha256 ||
    timestamp(receipt.completedAt) < timestamp(rollout.provisioning.updatedAt)
  )
    fail(ActionReleaseRolloutTransitionErrorCode.ReceiptInvalid);
  return Object.freeze({
    ...rollout,
    phase: ActionReleaseRolloutPhase.CanaryVerified,
    aggregateVersion: nextRevision(rollout),
    provisioning: Object.freeze({
      ...rollout.provisioning,
      state: "verified" as const,
    }),
    receiptVerification: Object.freeze({
      ...rollout.receiptVerification,
      state: FixedTerminalReceiptVerificationState.Verified,
      observationDigest: null,
      updatedAt: receipt.completedAt,
    }),
    receipt,
  });
}

export function prepareActionReleasePromotion(
  rollout: CanaryVerifiedActionReleaseRollout,
  input: {
    readonly attemptId: string;
    readonly inventory: CompleteLiveActionReferenceInventoryV1;
    readonly configuration: ExactProductionActionConfiguration;
    readonly preparedAt: string;
    readonly validUntil: string;
  },
): PromotionPreparedActionReleaseRollout {
  if (rollout.phase !== ActionReleaseRolloutPhase.CanaryVerified)
    fail(ActionReleaseRolloutTransitionErrorCode.InvalidPhase);
  assertCandidateAttempt(rollout, input.attemptId);
  const inventory = assertCompleteLiveActionReferenceInventory(input.inventory);
  const configuration = assertExactProductionActionConfiguration(
    input.configuration,
  );
  const preparedAt = timestamp(input.preparedAt);
  const validUntil = timestamp(input.validUntil);
  const inventoryCapturedAt = timestamp(inventory.capturedAt);
  const inventoryDatabaseServerTime = timestamp(inventory.database.serverTime);
  const inventoryGithubProviderObservedAt = timestamp(
    inventory.github.providerObservedAt,
  );
  const configurationObservedAt = timestamp(configuration.observedAt);
  const receiptCompletedAt = timestamp(rollout.receipt.completedAt);
  const production = inventory.production;
  const inventoryRefs = exactInventoryActionRefs(inventory);
  const productionConfigurationMatches =
    exactStringSetEquals(production.serviceIds, configuration.serviceIds) &&
    sameActionRef(production.primaryRef, configuration.primaryRef) &&
    sameActionRef(production.installerRef, configuration.installerRef) &&
    sameActionRef(
      production.reusableWorkflowRef,
      configuration.reusableWorkflowRef,
    ) &&
    sameActionRef(production.runtimeRef, configuration.runtimeRef) &&
    sameActionRef(
      production.refreshActionRef,
      configuration.refreshActionRef,
    ) &&
    sameActionRef(
      production.interactionRuntimeRef,
      configuration.interactionRuntimeRef,
    ) &&
    sameInstallerIdentity(production.installer, configuration.installer) &&
    exactRefSetEquals(production.allowlistedRefs, configuration.knownRefs);
  const expectedKnown = expectedKnownRefs({
    rollout,
    candidateRef: rollout.candidate.candidateRelease.actionRef,
    inventoryRefs,
  });
  if (
    preparedAt >= validUntil ||
    inventoryCapturedAt > preparedAt ||
    inventoryDatabaseServerTime > preparedAt ||
    inventoryGithubProviderObservedAt > preparedAt ||
    configurationObservedAt > preparedAt ||
    inventoryCapturedAt < receiptCompletedAt ||
    inventoryDatabaseServerTime < receiptCompletedAt ||
    inventoryGithubProviderObservedAt < receiptCompletedAt ||
    configurationObservedAt < receiptCompletedAt ||
    inventory.policyRevision !== rollout.candidate.policyRevision ||
    !inventory.repositoryCohort.githubRepositoryIds.includes(
      rollout.canary.target.githubRepositoryId,
    ) ||
    inventory.github.appLogin !==
      rollout.canary.target.expectedGithubAppLogin ||
    !exactStringSetEquals(inventory.github.workflows, [
      rollout.canary.target.reviewWorkflowPath,
      rollout.canary.target.interactionWorkflowPath,
    ]) ||
    configuration.revision < rollout.overlapConfiguration.revision ||
    configurationObservedAt <
      timestamp(rollout.overlapConfiguration.observedAt) ||
    !exactStringSetEquals(
      configuration.serviceIds,
      rollout.overlapConfiguration.serviceIds,
    ) ||
    !allGeneralRefsEqual(configuration, rollout.primaryRef) ||
    configuration.isolatedCandidateAttemptId !== rollout.candidate.attemptId ||
    configuration.isolatedCandidateBindingDigest !==
      rollout.expectation.expectationDigest ||
    inventoryRefs.some(
      (ref) => !sameActionRepository(ref, rollout.primaryRef),
    ) ||
    production.allowlistedRefs.some(
      (ref) => !sameActionRepository(ref, rollout.primaryRef),
    ) ||
    !exactRefSetEquals(configuration.knownRefs, expectedKnown) ||
    !productionConfigurationMatches
  )
    fail(ActionReleaseRolloutTransitionErrorCode.PromotionPreparationInvalid);
  const inventoryIdentity = Object.freeze({
    inventoryDigest: inventory.inventoryDigest,
    inventoryScopeDigest: liveActionReferenceInventoryScopeDigest(inventory),
    capturedAt: inventory.capturedAt,
    repositoryCohortRevision: inventory.repositoryCohort.revision,
    repositoryCohortDigest: inventory.repositoryCohort.digest,
    githubRepositoryIds: inventory.repositoryCohort.githubRepositoryIds,
    policyRevision: inventory.policyRevision,
    exactRefs: inventoryRefs,
    maximumQueueLeaseWindowMs: inventory.maximumQueueLeaseWindowMs,
  });
  return Object.freeze({
    ...rollout,
    phase: ActionReleaseRolloutPhase.PromotionPrepared,
    aggregateVersion: nextRevision(rollout),
    latestInventory: inventoryIdentity,
    preparation: Object.freeze({
      inventory: inventoryIdentity,
      configuration,
      configurationDigest: configuration.configurationDigest,
      configurationRevision: configuration.revision,
      preparedAt: input.preparedAt,
      validUntil: input.validUntil,
    }),
  });
}

function assertReceiptReservation(
  rollout: PromotionPreparedActionReleaseRollout,
  reservation: PromotionReceiptReservation,
): void {
  if (
    !IDENTIFIER_PATTERN.test(reservation.reservationId) ||
    reservation.ownerAttemptId !== rollout.candidate.attemptId ||
    reservation.receiptId !== rollout.receipt.receiptId ||
    reservation.artifactId !== rollout.receipt.artifactId ||
    reservation.canonicalPayloadDigest !==
      rollout.receipt.canonicalPayloadDigest ||
    reservation.artifactSha256 !== rollout.receipt.artifactSha256 ||
    reservation.expectationDigest !== rollout.receipt.expectationDigest ||
    reservation.receiptIdentityDigest !==
      terminalCanaryReceiptIdentityDigest(rollout.receipt) ||
    reservation.epoch !== rollout.aggregateVersion + 1n
  )
    fail(ActionReleaseRolloutTransitionErrorCode.PromotionReservationInvalid);
  timestamp(reservation.reservedAt);
}

export function beginActionReleasePromotion(
  rollout: PromotionPreparedActionReleaseRollout,
  input: {
    readonly attemptId: string;
    readonly reservation: PromotionReceiptReservation;
    readonly effectId: string;
    readonly now: string;
  },
): PromotingActionReleaseRollout {
  if (rollout.phase !== ActionReleaseRolloutPhase.PromotionPrepared)
    fail(ActionReleaseRolloutTransitionErrorCode.InvalidPhase);
  assertCandidateAttempt(rollout, input.attemptId);
  assertReceiptReservation(rollout, input.reservation);
  const now = timestamp(input.now);
  const reservedAt = timestamp(input.reservation.reservedAt);
  if (
    now > timestamp(rollout.preparation.validUntil) ||
    reservedAt < timestamp(rollout.preparation.preparedAt) ||
    reservedAt > now ||
    !IDENTIFIER_PATTERN.test(input.effectId)
  )
    fail(ActionReleaseRolloutTransitionErrorCode.PromotionPreparationInvalid);
  return Object.freeze({
    ...rollout,
    phase: ActionReleaseRolloutPhase.Promoting,
    aggregateVersion: nextRevision(rollout),
    reservation: Object.freeze({ ...input.reservation }),
    effect: Object.freeze({
      effectId: input.effectId,
      ownerAttemptId: rollout.candidate.attemptId,
      epoch: input.reservation.epoch,
      state: ActionReleasePromotionEffectState.Dispatching,
      observationDigest: null,
      updatedAt: input.now,
    }),
  });
}

export function markActionReleasePromotionUncertain(
  rollout:
    | PromotingActionReleaseRollout
    | PromotionUncertainActionReleaseRollout,
  input: {
    readonly attemptId: string;
    readonly observationDigest: Sha256;
    readonly observedAt: string;
  },
): PromotionUncertainActionReleaseRollout {
  if (
    rollout.phase !== ActionReleaseRolloutPhase.Promoting &&
    rollout.phase !== ActionReleaseRolloutPhase.PromotionUncertain
  )
    fail(ActionReleaseRolloutTransitionErrorCode.InvalidPhase);
  assertCandidateAttempt(rollout, input.attemptId);
  sha256(input.observationDigest, "promotion_uncertain_observation_digest");
  if (timestamp(input.observedAt) < timestamp(rollout.effect.updatedAt))
    fail(ActionReleaseRolloutTransitionErrorCode.PromotionReadbackInvalid);
  return Object.freeze({
    ...rollout,
    phase: ActionReleaseRolloutPhase.PromotionUncertain,
    aggregateVersion: nextRevision(rollout),
    effect: Object.freeze({
      ...rollout.effect,
      state: ActionReleasePromotionEffectState.Uncertain,
      observationDigest: input.observationDigest,
      updatedAt: input.observedAt,
    }),
  });
}

type CompletingActionReleaseRollout =
  | PromotingActionReleaseRollout
  | PromotionUncertainActionReleaseRollout;

function assertPromotionCompletionConfiguration(
  rollout: CompletingActionReleaseRollout,
  input: {
    readonly attemptId: string;
    readonly configuration: ExactProductionActionConfiguration;
    readonly completedAt: string;
    readonly minimumObservedAt: string;
  },
): ExactProductionActionConfiguration {
  assertCandidateAttempt(rollout, input.attemptId);
  const configuration = assertExactProductionActionConfiguration(
    input.configuration,
  );
  const candidateRef = rollout.candidate.candidateRelease.actionRef;
  const completedAt = timestamp(input.completedAt);
  const configurationObservedAt = timestamp(configuration.observedAt);
  const expectedKnown = expectedKnownRefs({
    rollout,
    candidateRef,
    inventoryRefs: rollout.preparation.inventory.exactRefs,
  });
  if (
    configuration.revision <= rollout.preparation.configurationRevision ||
    configurationObservedAt < timestamp(input.minimumObservedAt) ||
    configurationObservedAt > completedAt ||
    !exactStringSetEquals(
      configuration.serviceIds,
      rollout.preparation.configuration.serviceIds,
    ) ||
    !allGeneralRefsEqual(configuration, candidateRef) ||
    !sameInstallerIdentity(
      configuration.installer,
      rollout.candidate.candidateRelease.installer,
    ) ||
    !exactRefSetEquals(configuration.knownRefs, expectedKnown) ||
    configuration.isolatedCandidateAttemptId !== null ||
    configuration.isolatedCandidateBindingDigest !== null
  )
    fail(ActionReleaseRolloutTransitionErrorCode.PromotionReadbackInvalid);
  return configuration;
}

function completedActionReleasePromotion(
  rollout: CompletingActionReleaseRollout,
  configuration: ExactProductionActionConfiguration,
  completedAt: string,
): SteadyActionReleaseRollout {
  timestamp(completedAt);
  const candidateRef = rollout.candidate.candidateRelease.actionRef;
  const completedPromotion = Object.freeze({
    attemptId: rollout.candidate.attemptId,
    fromRelease: rollout.primaryRef,
    toRelease: candidateRef,
    receiptId: rollout.receipt.receiptId,
    artifactId: rollout.receipt.artifactId,
    completedAt,
    configurationDigest: configuration.configurationDigest,
  });
  return Object.freeze({
    schemaVersion: 1,
    channel: ACTION_RELEASE_CHANNEL,
    phase: ActionReleaseRolloutPhase.Steady,
    aggregateVersion: nextRevision(rollout),
    channelVersion: rollout.channelVersion + 1n,
    primaryRef: candidateRef,
    admissionMode: "normal",
    recoveryAdmissionEffect: null,
    latestInventory: rollout.preparation.inventory,
    predecessorRetention: Object.freeze({
      predecessorRef: rollout.primaryRef,
      promotionAttemptId: rollout.candidate.attemptId,
      repositoryCohortRevision:
        rollout.preparation.inventory.repositoryCohortRevision,
      repositoryCohortDigest:
        rollout.preparation.inventory.repositoryCohortDigest,
      githubRepositoryIds: rollout.preparation.inventory.githubRepositoryIds,
      policyRevision: rollout.preparation.inventory.policyRevision,
      inventoryScopeDigest: rollout.preparation.inventory.inventoryScopeDigest,
      configurationDigest: configuration.configurationDigest,
      configurationRevision: configuration.revision,
      installer: configuration.installer,
      serviceIds: configuration.serviceIds,
      requiredWindowMs: rollout.preparation.inventory.maximumQueueLeaseWindowMs,
      authorityEstablishedAt: completedAt,
      admissionEffect: null,
      fence: null,
      firstZeroCapture: null,
      removalEffect: null,
    }),
    candidateDrainHolds: rollout.candidateDrainHolds,
    usedCandidateAttemptIds: rollout.usedCandidateAttemptIds,
    lastCompletedPromotion: completedPromotion,
  });
}

export function completeActionReleasePromotion(
  rollout:
    | PromotingActionReleaseRollout
    | PromotionUncertainActionReleaseRollout,
  input: {
    readonly attemptId: string;
    readonly configuration: ExactProductionActionConfiguration;
    readonly completedAt: string;
  },
): SteadyActionReleaseRollout {
  if (
    rollout.phase !== ActionReleaseRolloutPhase.Promoting &&
    rollout.phase !== ActionReleaseRolloutPhase.PromotionUncertain
  )
    fail(ActionReleaseRolloutTransitionErrorCode.InvalidPhase);
  if (
    rollout.candidate.originRecoveryFence !== null ||
    rollout.recoveryAdmissionEffect !== null
  )
    fail(ActionReleaseRolloutTransitionErrorCode.AdmissionEffectInvalid);
  const configuration = assertPromotionCompletionConfiguration(rollout, {
    ...input,
    minimumObservedAt: rollout.effect.updatedAt,
  });
  return completedActionReleasePromotion(
    rollout,
    configuration,
    input.completedAt,
  );
}

export function abortActionReleaseCandidate(
  rollout: AbortableActionReleaseRollout,
  input: {
    readonly attemptId: string;
    readonly abortedAt: string;
    readonly reasonDigest: Sha256;
  },
): CandidateAbortedActionReleaseRollout {
  if (
    ![
      ActionReleaseRolloutPhase.CandidateRegistered,
      ActionReleaseRolloutPhase.OverlapStaged,
      ActionReleaseRolloutPhase.CanaryArmed,
      ActionReleaseRolloutPhase.CanaryVerified,
      ActionReleaseRolloutPhase.PromotionPrepared,
    ].includes(rollout.phase)
  )
    fail(ActionReleaseRolloutTransitionErrorCode.AbortForbidden);
  if (
    rollout.phase === ActionReleaseRolloutPhase.CandidateRegistered &&
    rollout.overlapEffect !== null
  )
    fail(ActionReleaseRolloutTransitionErrorCode.ReconcileOnly);
  assertCandidateAttempt(rollout, input.attemptId);
  timestamp(input.abortedAt);
  sha256(input.reasonDigest, "candidate_abort_reason_digest");
  const receipt =
    "receipt" in rollout
      ? Object.freeze({
          receiptId: rollout.receipt.receiptId,
          artifactId: rollout.receipt.artifactId,
        })
      : null;
  const drainHolds = new Map(
    [
      ...rollout.candidateDrainHolds,
      ...(rollout.phase !== ActionReleaseRolloutPhase.CandidateRegistered
        ? [rollout.candidate.candidateRelease.actionRef]
        : []),
    ].map((ref) => [ref.canonical, ref] as const),
  );
  return Object.freeze({
    schemaVersion: 1,
    channel: ACTION_RELEASE_CHANNEL,
    phase: ActionReleaseRolloutPhase.CandidateAborted,
    aggregateVersion: nextRevision(rollout),
    channelVersion: rollout.channelVersion,
    primaryRef: rollout.primaryRef,
    admissionMode: rollout.admissionMode,
    recoveryAdmissionEffect: rollout.recoveryAdmissionEffect,
    latestInventory: rollout.latestInventory,
    predecessorRetention: rollout.predecessorRetention,
    candidateDrainHolds: Object.freeze(
      [...drainHolds.values()].sort((left, right) =>
        codeUnitCompare(left.canonical, right.canonical),
      ),
    ),
    usedCandidateAttemptIds: rollout.usedCandidateAttemptIds,
    lastCompletedPromotion: rollout.lastCompletedPromotion,
    abortedCandidate: rollout.candidate,
    abortedAt: input.abortedAt,
    abortReasonDigest: input.reasonDigest,
    receiptIdentity: receipt,
  });
}

export function enterActionReleaseRecoveryOnly(
  rollout: SteadyActionReleaseRollout,
  input: {
    readonly effectId: string;
    readonly effectEpoch: bigint;
    readonly recoveryFenceId: string;
    readonly recoveryFenceEpoch: bigint;
    readonly failureDigest: Sha256;
    readonly enteredAt: string;
  },
): RecoveryOnlyActionReleaseRollout {
  if (
    rollout.phase !== ActionReleaseRolloutPhase.Steady ||
    rollout.lastCompletedPromotion === null ||
    !sameActionRef(
      rollout.primaryRef,
      rollout.lastCompletedPromotion.toRelease,
    ) ||
    rollout.recoveryAdmissionEffect !== null ||
    rollout.predecessorRetention?.admissionEffect != null ||
    !IDENTIFIER_PATTERN.test(input.effectId) ||
    !IDENTIFIER_PATTERN.test(input.recoveryFenceId) ||
    input.recoveryFenceId !== input.effectId ||
    input.effectEpoch !== rollout.aggregateVersion + 1n ||
    input.recoveryFenceEpoch < 1n
  )
    fail(ActionReleaseRolloutTransitionErrorCode.RecoveryForbidden);
  timestamp(input.enteredAt);
  sha256(input.failureDigest, "recovery_failure_digest");
  return Object.freeze({
    ...rollout,
    phase: ActionReleaseRolloutPhase.RecoveryOnly,
    aggregateVersion: nextRevision(rollout),
    admissionMode: "recovery_only",
    recoveryAdmissionEffect: Object.freeze({
      operation: ActionReleaseAdmissionEffectOperation.CloseRecovery,
      effectId: input.effectId,
      epoch: input.effectEpoch,
      state: ActionReleaseAdmissionEffectState.Dispatching,
      currentPrimary: rollout.primaryRef,
      failureDigest: input.failureDigest,
      fenceId: input.recoveryFenceId,
      fenceEpoch: input.recoveryFenceEpoch,
      observationDigest: null,
      updatedAt: input.enteredAt,
    }),
    recoveryFenceId: input.recoveryFenceId,
    recoveryFenceEpoch: input.recoveryFenceEpoch,
    failureDigest: input.failureDigest,
    enteredAt: input.enteredAt,
  });
}

/**
 * Reconciliation may prove that B reached production and subsequently failed
 * without proving the complete healthy promotion postcondition. Recovery then
 * treats B as the only current authority, closes admission, and retains A only
 * as a drain hold. It deliberately does not create Steady(B) or increment the
 * channel version.
 */
export function assertUncertainPromotionReachedCandidate(
  rollout: PromotionUncertainActionReleaseRollout,
  promotedConfigurationInput: ExactProductionActionConfiguration,
): ExactProductionActionConfiguration {
  const promotedConfiguration = assertExactProductionActionConfiguration(
    promotedConfigurationInput,
  );
  const candidateRef = rollout.candidate.candidateRelease.actionRef;
  if (
    promotedConfiguration.revision <=
      rollout.preparation.configurationRevision ||
    timestamp(promotedConfiguration.observedAt) <
      timestamp(rollout.effect.updatedAt) ||
    !exactStringSetEquals(
      promotedConfiguration.serviceIds,
      rollout.preparation.configuration.serviceIds,
    ) ||
    !allGeneralRefsEqual(promotedConfiguration, candidateRef) ||
    !sameInstallerIdentity(
      promotedConfiguration.installer,
      rollout.candidate.candidateRelease.installer,
    ) ||
    !exactRefSetEquals(
      promotedConfiguration.knownRefs,
      expectedKnownRefs({
        rollout,
        candidateRef,
        inventoryRefs: rollout.preparation.inventory.exactRefs,
      }),
    ) ||
    promotedConfiguration.isolatedCandidateAttemptId !== null ||
    promotedConfiguration.isolatedCandidateBindingDigest !== null
  )
    fail(ActionReleaseRolloutTransitionErrorCode.RecoveryForbidden);
  return promotedConfiguration;
}

export function enterUncertainPromotionRecoveryOnly(
  rollout: PromotionUncertainActionReleaseRollout,
  input: {
    readonly effectId: string;
    readonly effectEpoch: bigint;
    readonly recoveryFenceId: string;
    readonly recoveryFenceEpoch: bigint;
    readonly failureDigest: Sha256;
    readonly promotedConfiguration: ExactProductionActionConfiguration;
    readonly enteredAt: string;
  },
): RecoveryOnlyActionReleaseRollout {
  if (
    rollout.phase !== ActionReleaseRolloutPhase.PromotionUncertain ||
    (rollout.recoveryAdmissionEffect !== null &&
      (rollout.recoveryAdmissionEffect.operation !==
        ActionReleaseAdmissionEffectOperation.CloseRecovery ||
        rollout.recoveryAdmissionEffect.state !==
          ActionReleaseAdmissionEffectState.Verified)) ||
    rollout.predecessorRetention?.admissionEffect != null ||
    !IDENTIFIER_PATTERN.test(input.effectId) ||
    !IDENTIFIER_PATTERN.test(input.recoveryFenceId) ||
    input.recoveryFenceId !== input.effectId ||
    input.effectEpoch !== rollout.aggregateVersion + 1n ||
    input.recoveryFenceEpoch < 1n
  )
    fail(ActionReleaseRolloutTransitionErrorCode.RecoveryForbidden);
  const enteredAt = timestamp(input.enteredAt);
  sha256(input.failureDigest, "recovery_failure_digest");
  const promotedConfiguration = assertUncertainPromotionReachedCandidate(
    rollout,
    input.promotedConfiguration,
  );
  if (enteredAt < timestamp(promotedConfiguration.observedAt))
    fail(ActionReleaseRolloutTransitionErrorCode.RecoveryForbidden);
  const candidateRef = rollout.candidate.candidateRelease.actionRef;
  return Object.freeze({
    schemaVersion: 1,
    channel: ACTION_RELEASE_CHANNEL,
    phase: ActionReleaseRolloutPhase.RecoveryOnly,
    aggregateVersion: nextRevision(rollout),
    channelVersion: rollout.channelVersion,
    primaryRef: candidateRef,
    admissionMode: "recovery_only",
    recoveryAdmissionEffect: Object.freeze({
      operation: ActionReleaseAdmissionEffectOperation.CloseRecovery,
      effectId: input.effectId,
      epoch: input.effectEpoch,
      state: ActionReleaseAdmissionEffectState.Dispatching,
      currentPrimary: candidateRef,
      failureDigest: input.failureDigest,
      fenceId: input.recoveryFenceId,
      fenceEpoch: input.recoveryFenceEpoch,
      observationDigest: null,
      updatedAt: input.enteredAt,
    }),
    latestInventory: rollout.preparation.inventory,
    predecessorRetention: Object.freeze({
      predecessorRef: rollout.primaryRef,
      promotionAttemptId: rollout.candidate.attemptId,
      repositoryCohortRevision:
        rollout.preparation.inventory.repositoryCohortRevision,
      repositoryCohortDigest:
        rollout.preparation.inventory.repositoryCohortDigest,
      githubRepositoryIds: rollout.preparation.inventory.githubRepositoryIds,
      policyRevision: rollout.preparation.inventory.policyRevision,
      inventoryScopeDigest: rollout.preparation.inventory.inventoryScopeDigest,
      configurationDigest: promotedConfiguration.configurationDigest,
      configurationRevision: promotedConfiguration.revision,
      installer: promotedConfiguration.installer,
      serviceIds: promotedConfiguration.serviceIds,
      requiredWindowMs: rollout.preparation.inventory.maximumQueueLeaseWindowMs,
      authorityEstablishedAt: input.enteredAt,
      admissionEffect: null,
      fence: null,
      firstZeroCapture: null,
      removalEffect: null,
    }),
    candidateDrainHolds: rollout.candidateDrainHolds,
    usedCandidateAttemptIds: rollout.usedCandidateAttemptIds,
    lastCompletedPromotion: null,
    recoveryFenceId: input.recoveryFenceId,
    recoveryFenceEpoch: input.recoveryFenceEpoch,
    failureDigest: input.failureDigest,
    enteredAt: input.enteredAt,
  });
}

export function confirmActionReleaseRecoveryAdmissionClosed(
  rollout: RecoveryOnlyActionReleaseRollout,
  input: {
    readonly effectId: string;
    readonly effectEpoch: bigint;
    readonly fenceId: string;
    readonly fenceEpoch: bigint;
    readonly currentPrimary: ImmutableActionRef;
    readonly failureDigest: Sha256;
    readonly confirmedAt: string;
  },
): RecoveryOnlyActionReleaseRollout {
  const effect = rollout.recoveryAdmissionEffect;
  if (
    rollout.phase !== ActionReleaseRolloutPhase.RecoveryOnly ||
    effect.operation !== ActionReleaseAdmissionEffectOperation.CloseRecovery ||
    effect.state === ActionReleaseAdmissionEffectState.Verified ||
    input.effectId !== effect.effectId ||
    input.effectEpoch !== effect.epoch ||
    input.fenceId !== effect.fenceId ||
    input.fenceEpoch !== effect.fenceEpoch ||
    !sameActionRef(input.currentPrimary, effect.currentPrimary) ||
    input.failureDigest !== effect.failureDigest ||
    timestamp(input.confirmedAt) < timestamp(effect.updatedAt)
  )
    fail(ActionReleaseRolloutTransitionErrorCode.AdmissionEffectInvalid);
  return Object.freeze({
    ...rollout,
    aggregateVersion: nextRevision(rollout),
    recoveryAdmissionEffect: Object.freeze({
      ...effect,
      state: ActionReleaseAdmissionEffectState.Verified,
      observationDigest: null,
      updatedAt: input.confirmedAt,
    }),
  });
}

export function markActionReleaseAdmissionEffectUncertain<
  T extends
    | RecoveryOnlyActionReleaseRollout
    | PromotionUncertainActionReleaseRollout,
>(
  rollout: T,
  input: {
    readonly effectId: string;
    readonly effectEpoch: bigint;
    readonly observationDigest: Sha256;
    readonly observedAt: string;
  },
): T {
  const effect = rollout.recoveryAdmissionEffect;
  if (
    !effect ||
    effect.state === ActionReleaseAdmissionEffectState.Verified ||
    effect.effectId !== input.effectId ||
    effect.epoch !== input.effectEpoch ||
    timestamp(input.observedAt) < timestamp(effect.updatedAt)
  )
    fail(ActionReleaseRolloutTransitionErrorCode.AdmissionEffectInvalid);
  sha256(input.observationDigest, "admission_effect_observation_digest");
  return Object.freeze({
    ...rollout,
    aggregateVersion: nextRevision(rollout),
    recoveryAdmissionEffect: Object.freeze({
      ...effect,
      state: ActionReleaseAdmissionEffectState.Uncertain,
      observationDigest: input.observationDigest,
      updatedAt: input.observedAt,
    }),
  }) as unknown as T;
}

export function beginActionReleaseRecoveryAdmissionReopen(
  rollout: CompletingActionReleaseRollout,
  input: {
    readonly attemptId: string;
    readonly configuration: ExactProductionActionConfiguration;
    readonly effectId: string;
    readonly effectEpoch: bigint;
    readonly observationDigest: Sha256;
    readonly startedAt: string;
  },
): PromotionUncertainActionReleaseRollout {
  const originFence = rollout.candidate.originRecoveryFence;
  const closeEffect = rollout.recoveryAdmissionEffect;
  if (
    !originFence ||
    !closeEffect ||
    closeEffect.operation !==
      ActionReleaseAdmissionEffectOperation.CloseRecovery ||
    closeEffect.state !== ActionReleaseAdmissionEffectState.Verified ||
    closeEffect.fenceId !== originFence.fenceId ||
    closeEffect.fenceEpoch !== originFence.epoch ||
    !sameActionRef(closeEffect.currentPrimary, rollout.primaryRef) ||
    !IDENTIFIER_PATTERN.test(input.effectId) ||
    input.effectEpoch !== rollout.aggregateVersion + 1n ||
    timestamp(input.startedAt) < timestamp(rollout.effect.updatedAt)
  )
    fail(ActionReleaseRolloutTransitionErrorCode.AdmissionEffectInvalid);
  sha256(input.observationDigest, "admission_reopen_observation_digest");
  const configuration = assertPromotionCompletionConfiguration(rollout, {
    attemptId: input.attemptId,
    configuration: input.configuration,
    completedAt: input.startedAt,
    minimumObservedAt: rollout.effect.updatedAt,
  });
  return Object.freeze({
    ...rollout,
    phase: ActionReleaseRolloutPhase.PromotionUncertain,
    aggregateVersion: nextRevision(rollout),
    effect: Object.freeze({
      ...rollout.effect,
      state: ActionReleasePromotionEffectState.Uncertain,
      observationDigest: input.observationDigest,
      updatedAt: input.startedAt,
    }),
    recoveryAdmissionEffect: Object.freeze({
      operation: ActionReleaseAdmissionEffectOperation.ReopenRecovery,
      effectId: input.effectId,
      epoch: input.effectEpoch,
      state: ActionReleaseAdmissionEffectState.Dispatching,
      ownerAttemptId: rollout.candidate.attemptId,
      fenceId: originFence.fenceId,
      fenceEpoch: originFence.epoch,
      promotedPrimary: rollout.candidate.candidateRelease.actionRef,
      promotedConfiguration: configuration,
      observationDigest: null,
      updatedAt: input.startedAt,
    }),
  });
}

export function completeActionReleaseRecoveryAdmissionReopen(
  rollout: PromotionUncertainActionReleaseRollout,
  input: {
    readonly effectId: string;
    readonly effectEpoch: bigint;
    readonly fenceId: string;
    readonly fenceEpoch: bigint;
    readonly ownerAttemptId: string;
    readonly promotedPrimary: ImmutableActionRef;
    readonly configurationDigest: Sha256;
    readonly openedEpoch: bigint;
    readonly completedAt: string;
  },
): SteadyActionReleaseRollout {
  const effect = rollout.recoveryAdmissionEffect;
  if (
    !effect ||
    effect.operation !== ActionReleaseAdmissionEffectOperation.ReopenRecovery ||
    effect.effectId !== input.effectId ||
    effect.epoch !== input.effectEpoch ||
    effect.fenceId !== input.fenceId ||
    effect.fenceEpoch !== input.fenceEpoch ||
    effect.ownerAttemptId !== input.ownerAttemptId ||
    !sameActionRef(effect.promotedPrimary, input.promotedPrimary) ||
    effect.promotedConfiguration.configurationDigest !==
      input.configurationDigest ||
    input.openedEpoch <= effect.fenceEpoch ||
    timestamp(input.completedAt) < timestamp(effect.updatedAt)
  )
    fail(ActionReleaseRolloutTransitionErrorCode.AdmissionEffectInvalid);
  const configuration = assertPromotionCompletionConfiguration(rollout, {
    attemptId: effect.ownerAttemptId,
    configuration: effect.promotedConfiguration,
    completedAt: input.completedAt,
    minimumObservedAt: rollout.reservation.reservedAt,
  });
  return completedActionReleasePromotion(
    rollout,
    configuration,
    input.completedAt,
  );
}

export interface IsolatedCandidateSelectionContext {
  readonly schemaVersion: 5;
  readonly rolloutAttemptId: string;
  readonly policyRevision: bigint;
  readonly githubRepositoryId: string;
  readonly githubRepositoryNodeId: string;
  readonly repositoryFullName: string;
  readonly providerInstanceId: string;
  readonly pullRequestNumber: number;
  readonly reviewedHeadSha: string;
  readonly namespaceId: string;
  readonly namespaceEpoch: bigint;
  readonly challengeSha256: Sha256;
  readonly reviewWorkflowPath: string;
  readonly interactionWorkflowPath: string;
  readonly reviewSource: Readonly<WorkflowSourceIdentity>;
  readonly interactionSource: Readonly<WorkflowSourceIdentity>;
  readonly bindingDigest: Sha256;
}

type CandidateSelectableRollout =
  | CanaryArmedActionReleaseRollout
  | CanaryVerifiedActionReleaseRollout
  | PromotionPreparedActionReleaseRollout;

export function resolveProductionPrimarySelection(
  rollout: ActionReleaseRollout,
): Extract<WorkflowActionSelection, { kind: "production_primary" }> {
  if (rollout.admissionMode === "recovery_only")
    fail(ActionReleaseRolloutTransitionErrorCode.AdmissionClosed);
  if (
    rollout.phase === ActionReleaseRolloutPhase.Promoting ||
    rollout.phase === ActionReleaseRolloutPhase.PromotionUncertain
  )
    fail(ActionReleaseRolloutTransitionErrorCode.ReconcileOnly);
  return productionPrimaryActionSelection({
    actionRef: rollout.primaryRef,
    channelVersion: rollout.channelVersion,
  });
}

export function resolveAttestedLiveNamespaceSelection(
  rollout: ActionReleaseRollout,
  input: {
    readonly actionRef: ImmutableActionRef;
    readonly namespaceId: string;
    readonly namespaceEpoch: bigint;
    readonly workflowSourceDigest: Sha256;
  },
): Extract<WorkflowActionSelection, { kind: "attested_live_namespace" }> {
  const isActiveCandidate =
    "candidate" in rollout &&
    sameActionRef(
      rollout.candidate.candidateRelease.actionRef,
      input.actionRef,
    );
  const isRetiredDrainHold = rollout.candidateDrainHolds.some((ref) =>
    sameActionRef(ref, input.actionRef),
  );
  if (
    (isActiveCandidate && !isRetiredDrainHold) ||
    !deriveKnownActionRefs(rollout).some((ref) =>
      sameActionRef(ref, input.actionRef),
    )
  )
    fail(ActionReleaseRolloutTransitionErrorCode.SelectionRejected);
  try {
    return attestedLiveNamespaceActionSelection(input);
  } catch {
    fail(ActionReleaseRolloutTransitionErrorCode.SelectionRejected);
  }
}

function sameWorkflowSourceIdentity(
  left: Readonly<WorkflowSourceIdentity>,
  right: Readonly<WorkflowSourceIdentity>,
): boolean {
  return (
    left.commitSha === right.commitSha &&
    left.blobSha === right.blobSha &&
    left.semanticSha256 === right.semanticSha256
  );
}

export function resolveIsolatedCandidateSelection(
  rollout: CandidateSelectableRollout,
  context: IsolatedCandidateSelectionContext,
): Extract<WorkflowActionSelection, { kind: "isolated_candidate" }> {
  if (
    ![
      ActionReleaseRolloutPhase.CanaryArmed,
      ActionReleaseRolloutPhase.CanaryVerified,
      ActionReleaseRolloutPhase.PromotionPrepared,
    ].includes(rollout.phase)
  )
    fail(ActionReleaseRolloutTransitionErrorCode.SelectionRejected);
  const expected = rollout.canary;
  if (
    context.schemaVersion !== 5 ||
    context.rolloutAttemptId !== rollout.candidate.attemptId ||
    context.policyRevision !== rollout.candidate.policyRevision ||
    context.githubRepositoryId !== expected.target.githubRepositoryId ||
    context.githubRepositoryNodeId !== expected.target.githubRepositoryNodeId ||
    context.repositoryFullName !== expected.target.repositoryFullName ||
    context.providerInstanceId !== expected.target.providerInstanceId ||
    context.pullRequestNumber !== expected.target.pullRequestNumber ||
    context.reviewedHeadSha !== expected.reviewedHeadSha ||
    context.namespaceId !== expected.namespaceId ||
    context.namespaceEpoch !== expected.namespaceEpoch ||
    context.challengeSha256 !== expected.challengeSha256 ||
    context.reviewWorkflowPath !== expected.target.reviewWorkflowPath ||
    context.interactionWorkflowPath !==
      expected.target.interactionWorkflowPath ||
    !sameWorkflowSourceIdentity(context.reviewSource, expected.reviewSource) ||
    !sameWorkflowSourceIdentity(
      context.interactionSource,
      expected.interactionSource,
    ) ||
    context.bindingDigest !== expected.bindingDigest
  )
    fail(ActionReleaseRolloutTransitionErrorCode.SelectionRejected);
  return isolatedCandidateActionSelection({
    rolloutAttemptId: rollout.candidate.attemptId,
    policyRevision: rollout.candidate.policyRevision,
    candidateRelease: rollout.candidate.candidateRelease,
    binding: expected,
  });
}

export function deriveKnownActionRefs(
  rollout: ActionReleaseRollout,
): readonly ImmutableActionRef[] {
  const candidateRef =
    "candidate" in rollout &&
    rollout.phase !== ActionReleaseRolloutPhase.CandidateRegistered
      ? rollout.candidate.candidateRelease.actionRef
      : undefined;
  return candidateRef
    ? expectedKnownRefs({ rollout, candidateRef })
    : expectedKnownRefs({ rollout });
}

export function beginPredecessorAdmissionClose<
  T extends RetainingActionReleaseRollout,
>(
  rollout: T,
  input: {
    readonly effectId: string;
    readonly effectEpoch: bigint;
    readonly fenceId: string;
    readonly fenceEpoch: bigint;
    readonly startedAt: string;
  },
): T {
  const retention = rollout.predecessorRetention;
  const recoveryAdmission = rollout.recoveryAdmissionEffect;
  if (
    !retention ||
    retention.admissionEffect ||
    retention.fence ||
    retention.removalEffect ||
    (recoveryAdmission !== null &&
      recoveryAdmission.state !== ActionReleaseAdmissionEffectState.Verified) ||
    !IDENTIFIER_PATTERN.test(input.effectId) ||
    !IDENTIFIER_PATTERN.test(input.fenceId) ||
    input.fenceId !== input.effectId ||
    input.effectEpoch !== rollout.aggregateVersion + 1n ||
    input.fenceEpoch < 1n
  )
    fail(ActionReleaseRolloutTransitionErrorCode.PredecessorRetentionInvalid);
  timestamp(input.startedAt);
  return Object.freeze({
    ...rollout,
    aggregateVersion: nextRevision(rollout),
    predecessorRetention: Object.freeze({
      ...retention,
      admissionEffect: Object.freeze({
        effectId: input.effectId,
        epoch: input.effectEpoch,
        state: ActionReleaseAdmissionEffectState.Dispatching,
        fenceId: input.fenceId,
        fenceEpoch: input.fenceEpoch,
        observationDigest: null,
        startedAt: input.startedAt,
        updatedAt: input.startedAt,
      }),
    }),
  }) as unknown as T;
}

export function markPredecessorAdmissionCloseUncertain<
  T extends RetainingActionReleaseRollout,
>(
  rollout: T,
  input: {
    readonly effectId: string;
    readonly effectEpoch: bigint;
    readonly observationDigest: Sha256;
    readonly observedAt: string;
  },
): T {
  const retention = rollout.predecessorRetention;
  const effect = retention?.admissionEffect;
  if (
    !retention ||
    !effect ||
    effect.effectId !== input.effectId ||
    effect.epoch !== input.effectEpoch ||
    timestamp(input.observedAt) < timestamp(effect.updatedAt)
  )
    fail(ActionReleaseRolloutTransitionErrorCode.PredecessorRetentionInvalid);
  sha256(input.observationDigest, "predecessor_admission_observation_digest");
  return Object.freeze({
    ...rollout,
    aggregateVersion: nextRevision(rollout),
    predecessorRetention: Object.freeze({
      ...retention,
      admissionEffect: Object.freeze({
        ...effect,
        state: ActionReleaseAdmissionEffectState.Uncertain,
        observationDigest: input.observationDigest,
        updatedAt: input.observedAt,
      }),
    }),
  }) as unknown as T;
}

export function recordPredecessorAdmissionFence<
  T extends RetainingActionReleaseRollout,
>(rollout: T, fenceInput: PredecessorAdmissionFence): T {
  const retention = rollout.predecessorRetention;
  const effect = retention?.admissionEffect;
  if (!retention || !effect || retention.fence || retention.removalEffect)
    fail(ActionReleaseRolloutTransitionErrorCode.PredecessorRetentionInvalid);
  const fence = predecessorAdmissionFence(fenceInput);
  if (
    fence.fenceId !== effect.fenceId ||
    fence.epoch !== effect.fenceEpoch ||
    timestamp(fence.closedAt) < timestamp(effect.startedAt) ||
    !sameActionRef(fence.predecessorRef, retention.predecessorRef) ||
    fence.repositoryCohortRevision !== retention.repositoryCohortRevision ||
    fence.repositoryCohortDigest !== retention.repositoryCohortDigest ||
    !exactStringSetEquals(
      fence.githubRepositoryIds,
      retention.githubRepositoryIds,
    ) ||
    fence.policyRevision !== retention.policyRevision ||
    fence.inventoryScopeDigest !== retention.inventoryScopeDigest ||
    fence.requiredWindowMs !== retention.requiredWindowMs ||
    fence.authorityEstablishedAt !== retention.authorityEstablishedAt
  )
    fail(ActionReleaseRolloutTransitionErrorCode.PredecessorRetentionInvalid);
  return Object.freeze({
    ...rollout,
    aggregateVersion: nextRevision(rollout),
    predecessorRetention: Object.freeze({
      ...retention,
      admissionEffect: null,
      fence,
    }),
  }) as unknown as T;
}

export function recordPredecessorZeroCapture<
  T extends RetainingActionReleaseRollout,
>(
  rollout: T,
  capture: Readonly<ZeroPredecessorReferenceCapture> | null,
  inventory?: CompleteLiveActionReferenceInventoryV1,
): T {
  const retention = rollout.predecessorRetention;
  if (!retention?.fence || retention.removalEffect)
    fail(ActionReleaseRolloutTransitionErrorCode.PredecessorRetentionInvalid);
  if (
    capture &&
    (capture.repositoryCohortRevision !== retention.repositoryCohortRevision ||
      capture.repositoryCohortDigest !== retention.repositoryCohortDigest ||
      !exactStringSetEquals(
        capture.githubRepositoryIds,
        retention.githubRepositoryIds,
      ) ||
      capture.policyRevision !== retention.policyRevision ||
      capture.inventoryScopeDigest !== retention.inventoryScopeDigest ||
      !sameActionRef(capture.successorRef, rollout.primaryRef) ||
      !sameInstallerIdentity(
        capture.productionInstaller,
        retention.installer,
      ) ||
      !exactStringSetEquals(capture.productionServiceIds, retention.serviceIds))
  )
    fail(ActionReleaseRolloutTransitionErrorCode.PredecessorRetentionInvalid);
  if (capture)
    try {
      assertZeroPredecessorReferenceCapture(capture, retention.fence);
    } catch {
      fail(ActionReleaseRolloutTransitionErrorCode.PredecessorRetentionInvalid);
    }
  const observedInventory = inventory
    ? assertCompleteLiveActionReferenceInventory(inventory)
    : null;
  if (
    capture &&
    observedInventory &&
    capture.inventoryDigest !== observedInventory.inventoryDigest
  )
    fail(ActionReleaseRolloutTransitionErrorCode.PredecessorRetentionInvalid);
  if (
    observedInventory &&
    (observedInventory.repositoryCohort.revision !==
      retention.repositoryCohortRevision ||
      observedInventory.repositoryCohort.digest !==
        retention.repositoryCohortDigest ||
      !exactStringSetEquals(
        observedInventory.repositoryCohort.githubRepositoryIds,
        retention.githubRepositoryIds,
      ) ||
      observedInventory.policyRevision !== retention.policyRevision ||
      liveActionReferenceInventoryScopeDigest(observedInventory) !==
        retention.inventoryScopeDigest)
  )
    fail(ActionReleaseRolloutTransitionErrorCode.PredecessorRetentionInvalid);
  const latestInventory = capture
    ? Object.freeze({
        inventoryDigest: capture.inventoryDigest,
        inventoryScopeDigest: capture.inventoryScopeDigest,
        capturedAt: capture.capturedAt,
        repositoryCohortRevision: capture.repositoryCohortRevision,
        repositoryCohortDigest: capture.repositoryCohortDigest,
        githubRepositoryIds: capture.githubRepositoryIds,
        policyRevision: capture.policyRevision,
        exactRefs: capture.exactRefs,
        maximumQueueLeaseWindowMs: capture.maximumQueueLeaseWindowMs,
      })
    : observedInventory
      ? Object.freeze({
          inventoryDigest: observedInventory.inventoryDigest,
          inventoryScopeDigest:
            liveActionReferenceInventoryScopeDigest(observedInventory),
          capturedAt: observedInventory.capturedAt,
          repositoryCohortRevision: observedInventory.repositoryCohort.revision,
          repositoryCohortDigest: observedInventory.repositoryCohort.digest,
          githubRepositoryIds:
            observedInventory.repositoryCohort.githubRepositoryIds,
          policyRevision: observedInventory.policyRevision,
          exactRefs: exactInventoryActionRefs(observedInventory),
          maximumQueueLeaseWindowMs:
            observedInventory.maximumQueueLeaseWindowMs,
        })
      : rollout.latestInventory;
  return Object.freeze({
    ...rollout,
    aggregateVersion: nextRevision(rollout),
    latestInventory,
    predecessorRetention: Object.freeze({
      ...retention,
      firstZeroCapture: capture,
    }),
  }) as unknown as T;
}

export function beginPredecessorRemoval<
  T extends RetainingActionReleaseRollout,
>(
  rollout: T,
  input: {
    readonly proof: PredecessorRemovalProof;
    readonly effectId: string;
    readonly effectEpoch: bigint;
    readonly startedAt: string;
  },
): T {
  const retention = rollout.predecessorRetention;
  if (
    !retention?.fence ||
    !retention.firstZeroCapture ||
    retention.removalEffect ||
    !IDENTIFIER_PATTERN.test(input.effectId) ||
    input.effectEpoch !== rollout.aggregateVersion + 1n
  )
    fail(ActionReleaseRolloutTransitionErrorCode.PredecessorRemovalNotReady);
  timestamp(input.startedAt);
  try {
    assertPredecessorRemovalProof(
      input.proof,
      retention.predecessorRef,
      rollout.primaryRef,
      retention.fence,
    );
  } catch {
    fail(ActionReleaseRolloutTransitionErrorCode.PredecessorRemovalNotReady);
  }
  if (
    input.proof.first.inventoryDigest !==
      retention.firstZeroCapture.inventoryDigest ||
    timestamp(input.startedAt) < timestamp(input.proof.second.capturedAt)
  )
    fail(ActionReleaseRolloutTransitionErrorCode.PredecessorRemovalNotReady);
  return Object.freeze({
    ...rollout,
    aggregateVersion: nextRevision(rollout),
    predecessorRetention: Object.freeze({
      ...retention,
      removalEffect: Object.freeze({
        effectId: input.effectId,
        epoch: input.effectEpoch,
        state: "dispatching",
        proof: input.proof,
        observationDigest: null,
        updatedAt: input.startedAt,
      }),
    }),
  }) as unknown as T;
}

export function markPredecessorRemovalUncertain<
  T extends RetainingActionReleaseRollout,
>(
  rollout: T,
  input: {
    readonly observationDigest: Sha256;
    readonly observedAt: string;
  },
): T {
  const retention = rollout.predecessorRetention;
  if (!retention?.removalEffect)
    fail(ActionReleaseRolloutTransitionErrorCode.PredecessorRetentionInvalid);
  if (
    timestamp(input.observedAt) < timestamp(retention.removalEffect.updatedAt)
  )
    fail(ActionReleaseRolloutTransitionErrorCode.PredecessorRetentionInvalid);
  sha256(input.observationDigest, "predecessor_removal_observation_digest");
  return Object.freeze({
    ...rollout,
    aggregateVersion: nextRevision(rollout),
    predecessorRetention: Object.freeze({
      ...retention,
      removalEffect: Object.freeze({
        ...retention.removalEffect,
        state: "uncertain",
        observationDigest: input.observationDigest,
        updatedAt: input.observedAt,
      }),
    }),
  }) as unknown as T;
}

export function completePredecessorRemoval<
  T extends RetainingActionReleaseRollout,
>(
  rollout: T,
  input: {
    readonly proof: PredecessorRemovalProof;
    readonly configuration: ExactProductionActionConfiguration;
  },
): T {
  const retention = rollout.predecessorRetention;
  if (!retention?.fence || !retention.removalEffect)
    fail(ActionReleaseRolloutTransitionErrorCode.PredecessorRemovalNotReady);
  try {
    assertPredecessorRemovalProof(
      input.proof,
      retention.predecessorRef,
      rollout.primaryRef,
      retention.fence,
    );
  } catch {
    fail(ActionReleaseRolloutTransitionErrorCode.PredecessorRemovalNotReady);
  }
  if (input.proof.proofDigest !== retention.removalEffect.proof.proofDigest)
    fail(ActionReleaseRolloutTransitionErrorCode.PredecessorRemovalNotReady);
  const configuration = assertExactProductionActionConfiguration(
    input.configuration,
  );
  const retainedCandidateDrainHolds = rollout.candidateDrainHolds.filter(
    (hold) =>
      input.proof.first.exactRefs.some((ref) => sameActionRef(ref, hold)) ||
      input.proof.second.exactRefs.some((ref) => sameActionRef(ref, hold)),
  );
  const expectedKnown = expectedKnownRefs({
    rollout: {
      ...rollout,
      predecessorRetention: null,
      candidateDrainHolds: retainedCandidateDrainHolds,
    },
    inventoryRefs: input.proof.second.exactRefs,
  });
  if (
    configuration.revision <= retention.configurationRevision ||
    !sameInstallerIdentity(configuration.installer, retention.installer) ||
    !allGeneralRefsEqual(configuration, rollout.primaryRef) ||
    !exactStringSetEquals(
      configuration.serviceIds,
      input.proof.second.productionServiceIds,
    ) ||
    configuration.isolatedCandidateAttemptId !== null ||
    configuration.isolatedCandidateBindingDigest !== null ||
    !exactRefSetEquals(configuration.knownRefs, expectedKnown) ||
    timestamp(configuration.observedAt) <
      timestamp(retention.removalEffect.updatedAt)
  )
    fail(ActionReleaseRolloutTransitionErrorCode.PredecessorRemovalNotReady);
  return Object.freeze({
    ...rollout,
    aggregateVersion: nextRevision(rollout),
    latestInventory: Object.freeze({
      inventoryDigest: input.proof.second.inventoryDigest,
      inventoryScopeDigest: input.proof.second.inventoryScopeDigest,
      capturedAt: input.proof.second.capturedAt,
      repositoryCohortRevision: input.proof.second.repositoryCohortRevision,
      repositoryCohortDigest: input.proof.second.repositoryCohortDigest,
      githubRepositoryIds: input.proof.second.githubRepositoryIds,
      policyRevision: input.proof.second.policyRevision,
      exactRefs: input.proof.second.exactRefs,
      maximumQueueLeaseWindowMs: input.proof.second.maximumQueueLeaseWindowMs,
    }),
    candidateDrainHolds: Object.freeze(retainedCandidateDrainHolds),
    predecessorRetention: null,
  }) as unknown as T;
}

/** Explicitly rejects the historical fromRelease rollback shortcut. */
export function assertNoImplicitActionReleaseRollback(
  rollout: ActionReleaseRollout,
  requestedPrimary: ImmutableActionRef,
): void {
  if (!sameActionRef(requestedPrimary, rollout.primaryRef))
    fail(ActionReleaseRolloutTransitionErrorCode.PromotionReadbackInvalid);
}
