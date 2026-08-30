import {
  assertVerifiedFixedTerminalCanaryReceiptV4,
  exactActionInstallerIdentity,
  fixedCanaryBinding,
  fixedTerminalCanaryExpectation,
  hydrateImmutableActionRef,
  hydrateVerifiedActionReleaseV2,
  immutableEvidenceArtifactLocator,
  sameActionRef,
  sameActionRepository,
  sha256,
  terminalCanaryReceiptIdentityDigest,
  type ExactActionInstallerIdentity,
  type FixedCanaryBinding,
  type FixedCanaryBindingInput,
  type FixedTerminalCanaryExpectation,
  type ImmutableActionRef,
  type Sha256,
  type VerifiedActionReleaseV2,
  type VerifiedFixedTerminalCanaryReceiptV4,
} from "./action-release-identity";
import {
  ACTION_RELEASE_CHANNEL,
  ActionReleaseAdmissionEffectOperation,
  ActionReleaseAdmissionEffectState,
  ActionReleaseOverlapEffectState,
  ActionReleasePromotionEffectState,
  ActionReleaseRolloutPhase,
  FixedTerminalReceiptVerificationState,
  exactProductionActionConfiguration,
  type ActionReleaseCandidateAttempt,
  type ActionReleaseInventoryIdentity,
  type ActionReleasePredecessorRetention,
  type ActionReleaseRollout,
  type CandidateProvisioningCheckpoint,
  type CompletedActionReleasePromotion,
  type ExactProductionActionConfiguration,
  type FixedTerminalReceiptVerificationCheckpoint,
  type PromotionReceiptReservation,
} from "./action-release-rollout";
import {
  hydratePredecessorRemovalProof,
  hydrateZeroPredecessorReferenceCapture,
  predecessorAdmissionFence,
  type PredecessorAdmissionFence,
} from "./live-action-reference-inventory";

type UnknownRecord = Record<string, unknown>;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,511}$/u;
const NUMERIC_ID_PATTERN = /^[1-9][0-9]*$/u;

const BASE_KEYS = Object.freeze([
  "schemaVersion",
  "channel",
  "phase",
  "aggregateVersion",
  "channelVersion",
  "primaryRef",
  "admissionMode",
  "recoveryAdmissionEffect",
  "latestInventory",
  "predecessorRetention",
  "candidateDrainHolds",
  "usedCandidateAttemptIds",
  "lastCompletedPromotion",
]);

function record(value: unknown, label: string): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label}_invalid`);
  return value as UnknownRecord;
}

function exactKeys(
  value: UnknownRecord,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const exact = [...expected].sort();
  if (
    actual.length !== exact.length ||
    actual.some((key, index) => key !== exact[index])
  )
    throw new Error(`${label}_keys_invalid`);
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value))
    throw new Error(`${label}_invalid`);
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  )
    throw new Error(`${label}_invalid`);
  return value;
}

function positiveBigint(value: unknown, label: string): bigint {
  if (typeof value !== "bigint" || value < 1n)
    throw new Error(`${label}_invalid`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new Error(`${label}_invalid`);
  return value as number;
}

function optionalDigest(value: unknown, label: string): Sha256 | null {
  return value === null ? null : sha256(value as string, label);
}

function stringArray(
  value: unknown,
  label: string,
  options: { readonly numeric?: boolean; readonly allowEmpty?: boolean } = {},
): readonly string[] {
  if (
    !Array.isArray(value) ||
    (!options.allowEmpty && value.length === 0) ||
    value.some(
      (item) =>
        typeof item !== "string" ||
        item.length === 0 ||
        (options.numeric === true && !NUMERIC_ID_PATTERN.test(item)),
    ) ||
    new Set(value).size !== value.length
  )
    throw new Error(`${label}_invalid`);
  return Object.freeze([...value] as string[]);
}

function refArray(
  value: unknown,
  label: string,
): readonly ImmutableActionRef[] {
  if (!Array.isArray(value)) throw new Error(`${label}_invalid`);
  const refs = value.map((item) =>
    hydrateImmutableActionRef(item as ImmutableActionRef),
  );
  if (new Set(refs.map((ref) => ref.canonical)).size !== refs.length)
    throw new Error(`${label}_duplicate`);
  return Object.freeze(refs);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value))
    return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function sameStringSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return (
    leftSorted.length === rightSorted.length &&
    leftSorted.every((value, index) => value === rightSorted[index])
  );
}

function sameRefSet(
  left: readonly ImmutableActionRef[],
  right: readonly ImmutableActionRef[],
): boolean {
  return sameStringSet(
    left.map((ref) => ref.canonical),
    right.map((ref) => ref.canonical),
  );
}

function sameInstallerIdentity(
  left: Readonly<ExactActionInstallerIdentity>,
  right: Readonly<ExactActionInstallerIdentity>,
): boolean {
  return (
    left.version === right.version &&
    left.url === right.url &&
    left.sha256 === right.sha256
  );
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

function expectedKnownRefs(input: {
  readonly primaryRef: ImmutableActionRef;
  readonly candidateDrainHolds: readonly ImmutableActionRef[];
  readonly predecessorRetention: Readonly<ActionReleasePredecessorRetention> | null;
  readonly latestInventory: Readonly<ActionReleaseInventoryIdentity> | null;
  readonly candidateRef?: ImmutableActionRef;
  readonly inventoryRefs?: readonly ImmutableActionRef[];
}): readonly ImmutableActionRef[] {
  const refs = [
    input.primaryRef,
    ...input.candidateDrainHolds,
    ...(input.predecessorRetention
      ? [input.predecessorRetention.predecessorRef]
      : []),
    ...(input.inventoryRefs ?? input.latestInventory?.exactRefs ?? []),
    ...(input.candidateRef ? [input.candidateRef] : []),
  ];
  return [...new Map(refs.map((ref) => [ref.canonical, ref])).values()];
}

function sameInventoryIdentity(
  left: Readonly<ActionReleaseInventoryIdentity>,
  right: Readonly<ActionReleaseInventoryIdentity>,
): boolean {
  return (
    left.inventoryDigest === right.inventoryDigest &&
    left.inventoryScopeDigest === right.inventoryScopeDigest &&
    left.capturedAt === right.capturedAt &&
    left.repositoryCohortRevision === right.repositoryCohortRevision &&
    left.repositoryCohortDigest === right.repositoryCohortDigest &&
    sameStringSet(left.githubRepositoryIds, right.githubRepositoryIds) &&
    left.policyRevision === right.policyRevision &&
    sameRefSet(left.exactRefs, right.exactRefs) &&
    left.maximumQueueLeaseWindowMs === right.maximumQueueLeaseWindowMs
  );
}

function observationMatchesState(
  state: string,
  observationDigest: Sha256 | null,
  uncertainState = "uncertain",
): boolean {
  return state === uncertainState
    ? observationDigest !== null
    : observationDigest === null;
}

function assertCandidateAdmissionBinding(input: {
  readonly candidate: Readonly<ActionReleaseCandidateAttempt>;
  readonly admissionMode: "normal" | "recovery_only";
  readonly recoveryAdmissionEffect: ActionReleaseRollout["recoveryAdmissionEffect"];
  readonly allowReopen: boolean;
}): void {
  const { candidate, admissionMode, recoveryAdmissionEffect } = input;
  if (
    candidate.originAdmissionMode !== admissionMode ||
    (admissionMode === "normal" && recoveryAdmissionEffect !== null) ||
    (admissionMode === "recovery_only" &&
      (candidate.originRecoveryFence === null ||
        recoveryAdmissionEffect === null))
  )
    throw new Error("persisted_candidate_admission_binding_invalid");
  if (admissionMode === "normal") return;
  const originFence = candidate.originRecoveryFence!;
  if (
    recoveryAdmissionEffect!.fenceId !== originFence.fenceId ||
    recoveryAdmissionEffect!.fenceEpoch !== originFence.epoch ||
    (recoveryAdmissionEffect!.operation ===
    ActionReleaseAdmissionEffectOperation.CloseRecovery
      ? recoveryAdmissionEffect!.state !==
        ActionReleaseAdmissionEffectState.Verified
      : !input.allowReopen)
  )
    throw new Error("persisted_candidate_recovery_fence_mismatch");
}

function hydrateConfiguration(
  value: unknown,
): ExactProductionActionConfiguration {
  const raw = record(value, "persisted_action_configuration");
  exactKeys(
    raw,
    [
      "schemaVersion",
      "revision",
      "observedAt",
      "serviceIds",
      "primaryRef",
      "installerRef",
      "installer",
      "reusableWorkflowRef",
      "runtimeRef",
      "refreshActionRef",
      "interactionRuntimeRef",
      "knownRefs",
      "isolatedCandidateAttemptId",
      "isolatedCandidateBindingDigest",
      "configurationDigest",
    ],
    "persisted_action_configuration",
  );
  const rebuilt = exactProductionActionConfiguration({
    schemaVersion: raw.schemaVersion as 1,
    revision: raw.revision as bigint,
    observedAt: raw.observedAt as string,
    serviceIds: raw.serviceIds as readonly string[],
    primaryRef: hydrateImmutableActionRef(raw.primaryRef as ImmutableActionRef),
    installerRef: hydrateImmutableActionRef(
      raw.installerRef as ImmutableActionRef,
    ),
    installer: raw.installer as ExactProductionActionConfiguration["installer"],
    reusableWorkflowRef: hydrateImmutableActionRef(
      raw.reusableWorkflowRef as ImmutableActionRef,
    ),
    runtimeRef: hydrateImmutableActionRef(raw.runtimeRef as ImmutableActionRef),
    refreshActionRef: hydrateImmutableActionRef(
      raw.refreshActionRef as ImmutableActionRef,
    ),
    interactionRuntimeRef: hydrateImmutableActionRef(
      raw.interactionRuntimeRef as ImmutableActionRef,
    ),
    knownRefs: refArray(raw.knownRefs, "persisted_configuration_known_refs"),
    isolatedCandidateAttemptId: raw.isolatedCandidateAttemptId as string | null,
    isolatedCandidateBindingDigest:
      raw.isolatedCandidateBindingDigest as Sha256 | null,
  });
  if (raw.configurationDigest !== rebuilt.configurationDigest)
    throw new Error("persisted_action_configuration_digest_mismatch");
  return rebuilt;
}

function hydrateCandidate(
  value: unknown,
  primaryRef: ImmutableActionRef,
): Readonly<ActionReleaseCandidateAttempt> {
  const raw = record(value, "persisted_action_candidate");
  exactKeys(
    raw,
    [
      "attemptId",
      "fromRelease",
      "candidateRelease",
      "policyRevision",
      "registeredAt",
      "originAdmissionMode",
      "originRecoveryFence",
    ],
    "persisted_action_candidate",
  );
  const fromRelease = hydrateImmutableActionRef(
    raw.fromRelease as ImmutableActionRef,
  );
  const candidateRelease = hydrateVerifiedActionReleaseV2(
    raw.candidateRelease as VerifiedActionReleaseV2,
  );
  if (
    !sameActionRef(fromRelease, primaryRef) ||
    !sameActionRepository(fromRelease, candidateRelease.actionRef) ||
    sameActionRef(fromRelease, candidateRelease.actionRef)
  )
    throw new Error("persisted_action_candidate_ref_mismatch");
  const originAdmissionMode = raw.originAdmissionMode;
  if (
    originAdmissionMode !== "normal" &&
    originAdmissionMode !== "recovery_only"
  )
    throw new Error("persisted_action_candidate_admission_invalid");
  let originRecoveryFence: Readonly<{ fenceId: string; epoch: bigint }> | null =
    null;
  if (raw.originRecoveryFence !== null) {
    const fence = record(
      raw.originRecoveryFence,
      "persisted_candidate_recovery_fence",
    );
    exactKeys(
      fence,
      ["fenceId", "epoch"],
      "persisted_candidate_recovery_fence",
    );
    originRecoveryFence = Object.freeze({
      fenceId: identifier(fence.fenceId, "persisted_candidate_fence_id"),
      epoch: positiveBigint(fence.epoch, "persisted_candidate_fence_epoch"),
    });
  }
  if (
    (originAdmissionMode === "normal" && originRecoveryFence !== null) ||
    (originAdmissionMode === "recovery_only" && originRecoveryFence === null)
  )
    throw new Error("persisted_action_candidate_recovery_origin_mismatch");
  return Object.freeze({
    attemptId: identifier(raw.attemptId, "persisted_candidate_attempt_id"),
    fromRelease,
    candidateRelease,
    policyRevision: positiveBigint(
      raw.policyRevision,
      "persisted_candidate_policy_revision",
    ),
    registeredAt: timestamp(
      raw.registeredAt,
      "persisted_candidate_registered_at",
    ),
    originAdmissionMode,
    originRecoveryFence,
  });
}

function hydrateInventoryIdentity(
  value: unknown,
): Readonly<ActionReleaseInventoryIdentity> {
  const raw = record(value, "persisted_inventory_identity");
  exactKeys(
    raw,
    [
      "inventoryDigest",
      "inventoryScopeDigest",
      "capturedAt",
      "repositoryCohortRevision",
      "repositoryCohortDigest",
      "githubRepositoryIds",
      "policyRevision",
      "exactRefs",
      "maximumQueueLeaseWindowMs",
    ],
    "persisted_inventory_identity",
  );
  return Object.freeze({
    inventoryDigest: sha256(
      raw.inventoryDigest as string,
      "persisted_inventory_digest",
    ),
    inventoryScopeDigest: sha256(
      raw.inventoryScopeDigest as string,
      "persisted_inventory_scope_digest",
    ),
    capturedAt: timestamp(raw.capturedAt, "persisted_inventory_captured_at"),
    repositoryCohortRevision: positiveBigint(
      raw.repositoryCohortRevision,
      "persisted_inventory_cohort_revision",
    ),
    repositoryCohortDigest: sha256(
      raw.repositoryCohortDigest as string,
      "persisted_inventory_cohort_digest",
    ),
    githubRepositoryIds: stringArray(
      raw.githubRepositoryIds,
      "persisted_inventory_repository_ids",
      { numeric: true },
    ),
    policyRevision: positiveBigint(
      raw.policyRevision,
      "persisted_inventory_policy_revision",
    ),
    exactRefs: refArray(raw.exactRefs, "persisted_inventory_exact_refs"),
    maximumQueueLeaseWindowMs: positiveInteger(
      raw.maximumQueueLeaseWindowMs,
      "persisted_inventory_queue_lease_window",
    ),
  });
}

function hydrateLastPromotion(
  value: unknown,
): Readonly<CompletedActionReleasePromotion> {
  const raw = record(value, "persisted_completed_promotion");
  exactKeys(
    raw,
    [
      "attemptId",
      "fromRelease",
      "toRelease",
      "receiptId",
      "artifactId",
      "completedAt",
      "configurationDigest",
    ],
    "persisted_completed_promotion",
  );
  const fromRelease = hydrateImmutableActionRef(
    raw.fromRelease as ImmutableActionRef,
  );
  const toRelease = hydrateImmutableActionRef(
    raw.toRelease as ImmutableActionRef,
  );
  if (
    sameActionRef(fromRelease, toRelease) ||
    !sameActionRepository(fromRelease, toRelease)
  )
    throw new Error("persisted_completed_promotion_ref_mismatch");
  return Object.freeze({
    attemptId: identifier(raw.attemptId, "persisted_promotion_attempt_id"),
    fromRelease,
    toRelease,
    receiptId: identifier(raw.receiptId, "persisted_promotion_receipt_id"),
    artifactId: identifier(raw.artifactId, "persisted_promotion_artifact_id"),
    completedAt: timestamp(raw.completedAt, "persisted_promotion_completed_at"),
    configurationDigest: sha256(
      raw.configurationDigest as string,
      "persisted_promotion_configuration_digest",
    ),
  });
}

function hydrateRecoveryAdmissionEffect(
  value: unknown,
): ActionReleaseRollout["recoveryAdmissionEffect"] {
  if (value === null) return null;
  const raw = record(value, "persisted_recovery_admission_effect");
  if (raw.operation === ActionReleaseAdmissionEffectOperation.CloseRecovery) {
    exactKeys(
      raw,
      [
        "operation",
        "effectId",
        "epoch",
        "state",
        "currentPrimary",
        "failureDigest",
        "fenceId",
        "fenceEpoch",
        "observationDigest",
        "updatedAt",
      ],
      "persisted_recovery_close_effect",
    );
    if (
      !Object.values(ActionReleaseAdmissionEffectState).includes(
        raw.state as never,
      )
    )
      throw new Error("persisted_recovery_close_state_invalid");
    return Object.freeze({
      operation: ActionReleaseAdmissionEffectOperation.CloseRecovery,
      effectId: identifier(raw.effectId, "persisted_recovery_effect_id"),
      epoch: positiveBigint(raw.epoch, "persisted_recovery_effect_epoch"),
      state:
        raw.state as (typeof ActionReleaseAdmissionEffectState)[keyof typeof ActionReleaseAdmissionEffectState],
      currentPrimary: hydrateImmutableActionRef(
        raw.currentPrimary as ImmutableActionRef,
      ),
      failureDigest: sha256(
        raw.failureDigest as string,
        "persisted_recovery_failure_digest",
      ),
      fenceId: identifier(raw.fenceId, "persisted_recovery_fence_id"),
      fenceEpoch: positiveBigint(
        raw.fenceEpoch,
        "persisted_recovery_fence_epoch",
      ),
      observationDigest: optionalDigest(
        raw.observationDigest,
        "persisted_recovery_observation_digest",
      ),
      updatedAt: timestamp(raw.updatedAt, "persisted_recovery_updated_at"),
    });
  }
  if (raw.operation === ActionReleaseAdmissionEffectOperation.ReopenRecovery) {
    exactKeys(
      raw,
      [
        "operation",
        "effectId",
        "epoch",
        "state",
        "ownerAttemptId",
        "fenceId",
        "fenceEpoch",
        "promotedPrimary",
        "promotedConfiguration",
        "observationDigest",
        "updatedAt",
      ],
      "persisted_recovery_reopen_effect",
    );
    if (
      raw.state !== ActionReleaseAdmissionEffectState.Dispatching &&
      raw.state !== ActionReleaseAdmissionEffectState.Uncertain
    )
      throw new Error("persisted_recovery_reopen_state_invalid");
    const promotedPrimary = hydrateImmutableActionRef(
      raw.promotedPrimary as ImmutableActionRef,
    );
    const promotedConfiguration = hydrateConfiguration(
      raw.promotedConfiguration,
    );
    if (!sameActionRef(promotedPrimary, promotedConfiguration.primaryRef))
      throw new Error("persisted_recovery_reopen_configuration_mismatch");
    return Object.freeze({
      operation: ActionReleaseAdmissionEffectOperation.ReopenRecovery,
      effectId: identifier(raw.effectId, "persisted_recovery_effect_id"),
      epoch: positiveBigint(raw.epoch, "persisted_recovery_effect_epoch"),
      state: raw.state,
      ownerAttemptId: identifier(
        raw.ownerAttemptId,
        "persisted_recovery_owner_attempt_id",
      ),
      fenceId: identifier(raw.fenceId, "persisted_recovery_fence_id"),
      fenceEpoch: positiveBigint(
        raw.fenceEpoch,
        "persisted_recovery_fence_epoch",
      ),
      promotedPrimary,
      promotedConfiguration,
      observationDigest: optionalDigest(
        raw.observationDigest,
        "persisted_recovery_observation_digest",
      ),
      updatedAt: timestamp(raw.updatedAt, "persisted_recovery_updated_at"),
    });
  }
  throw new Error("persisted_recovery_effect_operation_invalid");
}

function hydratePredecessorRetention(
  value: unknown,
  primaryRef: ImmutableActionRef,
  aggregateVersion: bigint,
): Readonly<ActionReleasePredecessorRetention> {
  const raw = record(value, "persisted_predecessor_retention");
  exactKeys(
    raw,
    [
      "predecessorRef",
      "promotionAttemptId",
      "repositoryCohortRevision",
      "repositoryCohortDigest",
      "githubRepositoryIds",
      "policyRevision",
      "inventoryScopeDigest",
      "configurationDigest",
      "configurationRevision",
      "installer",
      "serviceIds",
      "requiredWindowMs",
      "authorityEstablishedAt",
      "admissionEffect",
      "fence",
      "firstZeroCapture",
      "removalEffect",
    ],
    "persisted_predecessor_retention",
  );
  const predecessorRef = hydrateImmutableActionRef(
    raw.predecessorRef as ImmutableActionRef,
  );
  if (
    sameActionRef(predecessorRef, primaryRef) ||
    !sameActionRepository(predecessorRef, primaryRef)
  )
    throw new Error("persisted_predecessor_ref_mismatch");
  const githubRepositoryIds = stringArray(
    raw.githubRepositoryIds,
    "persisted_predecessor_repository_ids",
    { numeric: true },
  );
  const serviceIds = stringArray(
    raw.serviceIds,
    "persisted_predecessor_service_ids",
  );
  const repositoryCohortRevision = positiveBigint(
    raw.repositoryCohortRevision,
    "persisted_predecessor_cohort_revision",
  );
  const repositoryCohortDigest = sha256(
    raw.repositoryCohortDigest as string,
    "persisted_predecessor_cohort_digest",
  );
  const policyRevision = positiveBigint(
    raw.policyRevision,
    "persisted_predecessor_policy_revision",
  );
  const inventoryScopeDigest = sha256(
    raw.inventoryScopeDigest as string,
    "persisted_predecessor_scope_digest",
  );
  const requiredWindowMs = positiveInteger(
    raw.requiredWindowMs,
    "persisted_predecessor_required_window",
  );
  const authorityEstablishedAt = timestamp(
    raw.authorityEstablishedAt,
    "persisted_predecessor_authority_time",
  );
  const installer = exactActionInstallerIdentity(
    raw.installer as ActionReleasePredecessorRetention["installer"],
    primaryRef,
  );

  let admissionEffect: ActionReleasePredecessorRetention["admissionEffect"] =
    null;
  if (raw.admissionEffect !== null) {
    const effect = record(
      raw.admissionEffect,
      "persisted_predecessor_admission_effect",
    );
    exactKeys(
      effect,
      [
        "effectId",
        "epoch",
        "state",
        "fenceId",
        "fenceEpoch",
        "observationDigest",
        "startedAt",
        "updatedAt",
      ],
      "persisted_predecessor_admission_effect",
    );
    if (
      effect.state !== ActionReleaseAdmissionEffectState.Dispatching &&
      effect.state !== ActionReleaseAdmissionEffectState.Uncertain
    )
      throw new Error("persisted_predecessor_admission_state_invalid");
    admissionEffect = Object.freeze({
      effectId: identifier(
        effect.effectId,
        "persisted_predecessor_admission_effect_id",
      ),
      epoch: positiveBigint(
        effect.epoch,
        "persisted_predecessor_admission_epoch",
      ),
      state: effect.state,
      fenceId: identifier(
        effect.fenceId,
        "persisted_predecessor_admission_fence_id",
      ),
      fenceEpoch: positiveBigint(
        effect.fenceEpoch,
        "persisted_predecessor_admission_fence_epoch",
      ),
      observationDigest: optionalDigest(
        effect.observationDigest,
        "persisted_predecessor_admission_observation",
      ),
      startedAt: timestamp(
        effect.startedAt,
        "persisted_predecessor_admission_started_at",
      ),
      updatedAt: timestamp(
        effect.updatedAt,
        "persisted_predecessor_admission_updated_at",
      ),
    });
    if (
      admissionEffect.effectId !== admissionEffect.fenceId ||
      admissionEffect.epoch > aggregateVersion ||
      Date.parse(admissionEffect.startedAt) >
        Date.parse(admissionEffect.updatedAt) ||
      !observationMatchesState(
        admissionEffect.state,
        admissionEffect.observationDigest,
      )
    )
      throw new Error("persisted_predecessor_admission_binding_invalid");
  }

  let fence: Readonly<PredecessorAdmissionFence> | null = null;
  if (raw.fence !== null) {
    const persistedFence = record(raw.fence, "persisted_predecessor_fence");
    fence = predecessorAdmissionFence({
      ...(persistedFence as unknown as PredecessorAdmissionFence),
      predecessorRef,
    });
    if (
      fence.repositoryCohortRevision !== repositoryCohortRevision ||
      fence.repositoryCohortDigest !== repositoryCohortDigest ||
      fence.githubRepositoryIds.join("\n") !== githubRepositoryIds.join("\n") ||
      fence.policyRevision !== policyRevision ||
      fence.inventoryScopeDigest !== inventoryScopeDigest ||
      fence.requiredWindowMs !== requiredWindowMs ||
      fence.authorityEstablishedAt !== authorityEstablishedAt
    )
      throw new Error("persisted_predecessor_fence_binding_mismatch");
  }
  if (admissionEffect !== null && fence !== null)
    throw new Error("persisted_predecessor_admission_overlap");

  const firstZeroCapture =
    raw.firstZeroCapture === null
      ? null
      : fence === null
        ? (() => {
            throw new Error("persisted_predecessor_capture_without_fence");
          })()
        : hydrateZeroPredecessorReferenceCapture(
            raw.firstZeroCapture as never,
            fence,
          );
  if (
    firstZeroCapture !== null &&
    (!sameInstallerIdentity(firstZeroCapture.productionInstaller, installer) ||
      !sameStringSet(firstZeroCapture.productionServiceIds, serviceIds))
  )
    throw new Error("persisted_predecessor_capture_retention_mismatch");

  let removalEffect: ActionReleasePredecessorRetention["removalEffect"] = null;
  if (raw.removalEffect !== null) {
    if (fence === null || firstZeroCapture === null)
      throw new Error("persisted_predecessor_removal_without_capture");
    const effect = record(
      raw.removalEffect,
      "persisted_predecessor_removal_effect",
    );
    exactKeys(
      effect,
      ["effectId", "epoch", "state", "proof", "observationDigest", "updatedAt"],
      "persisted_predecessor_removal_effect",
    );
    if (effect.state !== "dispatching" && effect.state !== "uncertain")
      throw new Error("persisted_predecessor_removal_state_invalid");
    const proof = hydratePredecessorRemovalProof(
      effect.proof as never,
      predecessorRef,
      primaryRef,
      fence,
    );
    if (proof.first.captureDigest !== firstZeroCapture.captureDigest)
      throw new Error("persisted_predecessor_first_capture_mismatch");
    removalEffect = Object.freeze({
      effectId: identifier(
        effect.effectId,
        "persisted_predecessor_removal_effect_id",
      ),
      epoch: positiveBigint(
        effect.epoch,
        "persisted_predecessor_removal_epoch",
      ),
      state: effect.state,
      proof,
      observationDigest: optionalDigest(
        effect.observationDigest,
        "persisted_predecessor_removal_observation",
      ),
      updatedAt: timestamp(
        effect.updatedAt,
        "persisted_predecessor_removal_updated_at",
      ),
    });
    if (
      removalEffect.epoch > aggregateVersion ||
      Date.parse(removalEffect.updatedAt) <
        Date.parse(removalEffect.proof.second.capturedAt) ||
      !observationMatchesState(
        removalEffect.state,
        removalEffect.observationDigest,
      )
    )
      throw new Error("persisted_predecessor_removal_binding_invalid");
  }

  return Object.freeze({
    predecessorRef,
    promotionAttemptId: identifier(
      raw.promotionAttemptId,
      "persisted_predecessor_promotion_attempt_id",
    ),
    repositoryCohortRevision,
    repositoryCohortDigest,
    githubRepositoryIds,
    policyRevision,
    inventoryScopeDigest,
    configurationDigest: sha256(
      raw.configurationDigest as string,
      "persisted_predecessor_configuration_digest",
    ),
    configurationRevision: positiveBigint(
      raw.configurationRevision,
      "persisted_predecessor_configuration_revision",
    ),
    installer,
    serviceIds,
    requiredWindowMs,
    authorityEstablishedAt,
    admissionEffect,
    fence,
    firstZeroCapture,
    removalEffect,
  });
}

function hydrateOverlapEffect(value: unknown) {
  if (value === null) return null;
  const raw = record(value, "persisted_overlap_effect");
  exactKeys(
    raw,
    [
      "effectId",
      "ownerAttemptId",
      "epoch",
      "state",
      "expectedConfiguration",
      "observationDigest",
      "updatedAt",
    ],
    "persisted_overlap_effect",
  );
  if (
    !Object.values(ActionReleaseOverlapEffectState).includes(raw.state as never)
  )
    throw new Error("persisted_overlap_effect_state_invalid");
  return Object.freeze({
    effectId: identifier(raw.effectId, "persisted_overlap_effect_id"),
    ownerAttemptId: identifier(
      raw.ownerAttemptId,
      "persisted_overlap_owner_attempt_id",
    ),
    epoch: positiveBigint(raw.epoch, "persisted_overlap_effect_epoch"),
    state: raw.state,
    expectedConfiguration: hydrateConfiguration(raw.expectedConfiguration),
    observationDigest: optionalDigest(
      raw.observationDigest,
      "persisted_overlap_observation_digest",
    ),
    updatedAt: timestamp(raw.updatedAt, "persisted_overlap_updated_at"),
  });
}

function hydrateCanaryBinding(
  value: unknown,
  candidateRelease: VerifiedActionReleaseV2,
): Readonly<FixedCanaryBinding> {
  const raw = record(value, "persisted_canary_binding");
  const rebuilt = fixedCanaryBinding(
    {
      ...(raw as unknown as FixedCanaryBindingInput),
      reusableWorkflowRef: hydrateImmutableActionRef(
        raw.reusableWorkflowRef as ImmutableActionRef,
      ),
      runtimeRef: hydrateImmutableActionRef(
        raw.runtimeRef as ImmutableActionRef,
      ),
      refreshActionRef: hydrateImmutableActionRef(
        raw.refreshActionRef as ImmutableActionRef,
      ),
      interactionRuntimeRef: hydrateImmutableActionRef(
        raw.interactionRuntimeRef as ImmutableActionRef,
      ),
    },
    candidateRelease.actionRef,
  );
  if (raw.bindingDigest !== rebuilt.bindingDigest)
    throw new Error("persisted_canary_binding_digest_mismatch");
  return rebuilt;
}

function hydrateExpectation(
  value: unknown,
  candidate: Readonly<ActionReleaseCandidateAttempt>,
  binding: Readonly<FixedCanaryBinding>,
): Readonly<FixedTerminalCanaryExpectation> {
  const raw = record(value, "persisted_canary_expectation");
  exactKeys(
    raw,
    [
      "schemaVersion",
      "rolloutAttemptId",
      "challengeSha256",
      "candidateReleaseProofDigest",
      "binding",
      "expectationDigest",
    ],
    "persisted_canary_expectation",
  );
  const rebuilt = fixedTerminalCanaryExpectation({
    rolloutAttemptId: candidate.attemptId,
    challengeSha256: binding.challengeSha256,
    candidateReleaseProofDigest: candidate.candidateRelease.proofDigest,
    binding,
  });
  if (
    raw.schemaVersion !== rebuilt.schemaVersion ||
    raw.rolloutAttemptId !== rebuilt.rolloutAttemptId ||
    raw.challengeSha256 !== rebuilt.challengeSha256 ||
    raw.candidateReleaseProofDigest !== rebuilt.candidateReleaseProofDigest ||
    record(raw.binding, "persisted_expectation_binding").bindingDigest !==
      binding.bindingDigest ||
    raw.expectationDigest !== rebuilt.expectationDigest
  )
    throw new Error("persisted_canary_expectation_mismatch");
  return rebuilt;
}

function hydrateProvisioningCheckpoint(
  value: unknown,
): Readonly<CandidateProvisioningCheckpoint> {
  const raw = record(value, "persisted_provisioning_checkpoint");
  exactKeys(
    raw,
    [
      "effectId",
      "epoch",
      "state",
      "eligibility",
      "observationDigest",
      "updatedAt",
    ],
    "persisted_provisioning_checkpoint",
  );
  if (
    raw.state !== "prepared" &&
    raw.state !== "dispatching" &&
    raw.state !== "verified" &&
    raw.state !== "uncertain"
  )
    throw new Error("persisted_provisioning_state_invalid");
  let eligibility: CandidateProvisioningCheckpoint["eligibility"] = null;
  if (raw.eligibility !== null) {
    const persisted = record(
      raw.eligibility,
      "persisted_provisioning_eligibility",
    );
    exactKeys(
      persisted,
      [
        "aggregateVersion",
        "phase",
        "admissionMode",
        "policyRevision",
        "channelVersion",
        "selectionDigest",
        "contextDigest",
        "decisionDigest",
      ],
      "persisted_provisioning_eligibility",
    );
    if (
      persisted.phase !== ActionReleaseRolloutPhase.CanaryArmed ||
      (persisted.admissionMode !== "normal" &&
        persisted.admissionMode !== "recovery_only")
    )
      throw new Error("persisted_provisioning_eligibility_fence_invalid");
    eligibility = Object.freeze({
      aggregateVersion: positiveBigint(
        persisted.aggregateVersion,
        "persisted_provisioning_authorization_version",
      ),
      phase: ActionReleaseRolloutPhase.CanaryArmed,
      admissionMode: persisted.admissionMode,
      policyRevision: positiveBigint(
        persisted.policyRevision,
        "persisted_provisioning_policy_revision",
      ),
      channelVersion: positiveBigint(
        persisted.channelVersion,
        "persisted_provisioning_channel_version",
      ),
      selectionDigest: sha256(
        persisted.selectionDigest as string,
        "persisted_provisioning_selection_digest",
      ),
      contextDigest: sha256(
        persisted.contextDigest as string,
        "persisted_provisioning_context_digest",
      ),
      decisionDigest: sha256(
        persisted.decisionDigest as string,
        "persisted_provisioning_decision_digest",
      ),
    });
  }
  if (
    (raw.state === "prepared") !== (eligibility === null) ||
    (raw.state === "uncertain") !== (raw.observationDigest !== null)
  )
    throw new Error("persisted_provisioning_eligibility_state_mismatch");
  return Object.freeze({
    effectId: sha256(
      raw.effectId as string,
      "persisted_provisioning_effect_id",
    ),
    epoch: positiveBigint(raw.epoch, "persisted_provisioning_effect_epoch"),
    state: raw.state,
    eligibility,
    observationDigest: optionalDigest(
      raw.observationDigest,
      "persisted_provisioning_observation_digest",
    ),
    updatedAt: timestamp(raw.updatedAt, "persisted_provisioning_updated_at"),
  });
}

function hydrateReceiptVerification(
  value: unknown,
): Readonly<FixedTerminalReceiptVerificationCheckpoint> | null {
  if (value === null) return null;
  const raw = record(value, "persisted_receipt_verification");
  exactKeys(
    raw,
    [
      "effectId",
      "ownerAttemptId",
      "epoch",
      "locator",
      "expectationDigest",
      "state",
      "leaseExpiresAt",
      "observationDigest",
      "updatedAt",
    ],
    "persisted_receipt_verification",
  );
  if (
    !Object.values(FixedTerminalReceiptVerificationState).includes(
      raw.state as never,
    ) ||
    (raw.state === FixedTerminalReceiptVerificationState.Uncertain) !==
      (raw.observationDigest !== null)
  )
    throw new Error("persisted_receipt_verification_state_invalid");
  return Object.freeze({
    effectId: identifier(raw.effectId, "persisted_receipt_effect_id"),
    ownerAttemptId: identifier(
      raw.ownerAttemptId,
      "persisted_receipt_owner_attempt_id",
    ),
    epoch: positiveBigint(raw.epoch, "persisted_receipt_effect_epoch"),
    locator: immutableEvidenceArtifactLocator(raw.locator as never),
    expectationDigest: sha256(
      raw.expectationDigest as string,
      "persisted_receipt_expectation_digest",
    ),
    state:
      raw.state as (typeof FixedTerminalReceiptVerificationState)[keyof typeof FixedTerminalReceiptVerificationState],
    leaseExpiresAt: timestamp(
      raw.leaseExpiresAt,
      "persisted_receipt_lease_expiry",
    ),
    observationDigest: optionalDigest(
      raw.observationDigest,
      "persisted_receipt_observation_digest",
    ),
    updatedAt: timestamp(raw.updatedAt, "persisted_receipt_updated_at"),
  });
}

function hydrateReceipt(
  value: unknown,
  expectation: FixedTerminalCanaryExpectation,
): VerifiedFixedTerminalCanaryReceiptV4 {
  const raw = record(value, "persisted_terminal_receipt");
  exactKeys(
    raw,
    [
      "schemaVersion",
      "receiptId",
      "canonicalPayloadDigest",
      "artifactId",
      "artifactSha256",
      "expectationDigest",
      "rolloutAttemptId",
      "candidateActionRef",
      "challengeSha256",
      "runId",
      "runAttempt",
      "completedAt",
    ],
    "persisted_terminal_receipt",
  );
  const receipt = Object.freeze({
    ...(raw as unknown as VerifiedFixedTerminalCanaryReceiptV4),
    candidateActionRef: hydrateImmutableActionRef(
      raw.candidateActionRef as ImmutableActionRef,
    ),
  });
  return assertVerifiedFixedTerminalCanaryReceiptV4(receipt, expectation);
}

function hydratePreparation(value: unknown) {
  const raw = record(value, "persisted_promotion_preparation");
  exactKeys(
    raw,
    [
      "inventory",
      "configuration",
      "configurationDigest",
      "configurationRevision",
      "preparedAt",
      "validUntil",
    ],
    "persisted_promotion_preparation",
  );
  const inventory = hydrateInventoryIdentity(raw.inventory);
  const configuration = hydrateConfiguration(raw.configuration);
  const preparedAt = timestamp(
    raw.preparedAt,
    "persisted_promotion_prepared_at",
  );
  const validUntil = timestamp(
    raw.validUntil,
    "persisted_promotion_valid_until",
  );
  if (
    raw.configurationDigest !== configuration.configurationDigest ||
    raw.configurationRevision !== configuration.revision ||
    Date.parse(validUntil) <= Date.parse(preparedAt)
  )
    throw new Error("persisted_promotion_preparation_mismatch");
  return Object.freeze({
    inventory,
    configuration,
    configurationDigest: configuration.configurationDigest,
    configurationRevision: configuration.revision,
    preparedAt,
    validUntil,
  });
}

function hydrateReservation(
  value: unknown,
): Readonly<PromotionReceiptReservation> {
  const raw = record(value, "persisted_promotion_reservation");
  exactKeys(
    raw,
    [
      "reservationId",
      "ownerAttemptId",
      "receiptId",
      "artifactId",
      "canonicalPayloadDigest",
      "artifactSha256",
      "expectationDigest",
      "receiptIdentityDigest",
      "reservedAt",
      "epoch",
    ],
    "persisted_promotion_reservation",
  );
  return Object.freeze({
    reservationId: identifier(
      raw.reservationId,
      "persisted_promotion_reservation_id",
    ),
    ownerAttemptId: identifier(
      raw.ownerAttemptId,
      "persisted_promotion_reservation_owner",
    ),
    receiptId: identifier(
      raw.receiptId,
      "persisted_promotion_reservation_receipt",
    ),
    artifactId: identifier(
      raw.artifactId,
      "persisted_promotion_reservation_artifact",
    ),
    canonicalPayloadDigest: sha256(
      raw.canonicalPayloadDigest as string,
      "persisted_promotion_payload_digest",
    ),
    artifactSha256: sha256(
      raw.artifactSha256 as string,
      "persisted_promotion_artifact_digest",
    ),
    expectationDigest: sha256(
      raw.expectationDigest as string,
      "persisted_promotion_expectation_digest",
    ),
    receiptIdentityDigest: sha256(
      raw.receiptIdentityDigest as string,
      "persisted_promotion_receipt_identity_digest",
    ),
    reservedAt: timestamp(raw.reservedAt, "persisted_promotion_reserved_at"),
    epoch: positiveBigint(raw.epoch, "persisted_promotion_reservation_epoch"),
  });
}

function hydratePromotionEffect(value: unknown) {
  const raw = record(value, "persisted_promotion_effect");
  exactKeys(
    raw,
    [
      "effectId",
      "ownerAttemptId",
      "epoch",
      "state",
      "observationDigest",
      "updatedAt",
    ],
    "persisted_promotion_effect",
  );
  if (
    raw.state !== ActionReleasePromotionEffectState.Dispatching &&
    raw.state !== ActionReleasePromotionEffectState.Uncertain
  )
    throw new Error("persisted_promotion_effect_state_invalid");
  return Object.freeze({
    effectId: identifier(raw.effectId, "persisted_promotion_effect_id"),
    ownerAttemptId: identifier(
      raw.ownerAttemptId,
      "persisted_promotion_effect_owner",
    ),
    epoch: positiveBigint(raw.epoch, "persisted_promotion_effect_epoch"),
    state: raw.state,
    observationDigest: optionalDigest(
      raw.observationDigest,
      "persisted_promotion_effect_observation",
    ),
    updatedAt: timestamp(
      raw.updatedAt,
      "persisted_promotion_effect_updated_at",
    ),
  });
}

function topLevelKeys(extra: readonly string[]): readonly string[] {
  return [...BASE_KEYS, ...extra];
}

/**
 * Reconstitutes a rollout loaded from trusted durable storage. Persistence
 * adapters must restore bigint columns before calling this boundary. The
 * input is never mutated or rebranded in place.
 */
export function hydrateActionReleaseRollout(
  snapshot: unknown,
): ActionReleaseRollout {
  const raw = record(snapshot, "persisted_action_release_rollout");
  if (raw.schemaVersion !== 1 || raw.channel !== ACTION_RELEASE_CHANNEL)
    throw new Error("persisted_action_release_schema_invalid");
  if (!Object.values(ActionReleaseRolloutPhase).includes(raw.phase as never))
    throw new Error("persisted_action_release_phase_invalid");
  const phase = raw.phase as ActionReleaseRollout["phase"];
  const phaseKeys: Readonly<
    Record<ActionReleaseRollout["phase"], readonly string[]>
  > = {
    [ActionReleaseRolloutPhase.Steady]: [],
    [ActionReleaseRolloutPhase.CandidateRegistered]: [
      "candidate",
      "overlapEffect",
    ],
    [ActionReleaseRolloutPhase.OverlapStaged]: [
      "candidate",
      "overlapEffect",
      "overlapConfiguration",
    ],
    [ActionReleaseRolloutPhase.CanaryArmed]: [
      "candidate",
      "overlapEffect",
      "overlapConfiguration",
      "canary",
      "expectation",
      "provisioning",
      "receiptVerification",
    ],
    [ActionReleaseRolloutPhase.CanaryVerified]: [
      "candidate",
      "overlapEffect",
      "overlapConfiguration",
      "canary",
      "expectation",
      "provisioning",
      "receiptVerification",
      "receipt",
    ],
    [ActionReleaseRolloutPhase.PromotionPrepared]: [
      "candidate",
      "overlapEffect",
      "overlapConfiguration",
      "canary",
      "expectation",
      "provisioning",
      "receiptVerification",
      "receipt",
      "preparation",
    ],
    [ActionReleaseRolloutPhase.Promoting]: [
      "candidate",
      "overlapEffect",
      "overlapConfiguration",
      "canary",
      "expectation",
      "provisioning",
      "receiptVerification",
      "receipt",
      "preparation",
      "reservation",
      "effect",
    ],
    [ActionReleaseRolloutPhase.PromotionUncertain]: [
      "candidate",
      "overlapEffect",
      "overlapConfiguration",
      "canary",
      "expectation",
      "provisioning",
      "receiptVerification",
      "receipt",
      "preparation",
      "reservation",
      "effect",
    ],
    [ActionReleaseRolloutPhase.CandidateAborted]: [
      "abortedCandidate",
      "abortedAt",
      "abortReasonDigest",
      "receiptIdentity",
    ],
    [ActionReleaseRolloutPhase.RecoveryOnly]: [
      "recoveryFenceId",
      "recoveryFenceEpoch",
      "failureDigest",
      "enteredAt",
    ],
  };
  exactKeys(
    raw,
    topLevelKeys(phaseKeys[phase]),
    "persisted_action_release_rollout",
  );

  const aggregateVersion = positiveBigint(
    raw.aggregateVersion,
    "persisted_action_release_aggregate_version",
  );
  const channelVersion = positiveBigint(
    raw.channelVersion,
    "persisted_action_release_channel_version",
  );
  const primaryRef = hydrateImmutableActionRef(
    raw.primaryRef as ImmutableActionRef,
  );
  if (raw.admissionMode !== "normal" && raw.admissionMode !== "recovery_only")
    throw new Error("persisted_action_release_admission_mode_invalid");
  const admissionMode = raw.admissionMode;
  const recoveryAdmissionEffect = hydrateRecoveryAdmissionEffect(
    raw.recoveryAdmissionEffect,
  );
  const latestInventory =
    raw.latestInventory === null
      ? null
      : hydrateInventoryIdentity(raw.latestInventory);
  const predecessorRetention =
    raw.predecessorRetention === null
      ? null
      : hydratePredecessorRetention(
          raw.predecessorRetention,
          primaryRef,
          aggregateVersion,
        );
  const candidateDrainHolds = refArray(
    raw.candidateDrainHolds,
    "persisted_candidate_drain_holds",
  );
  const usedCandidateAttemptIds = stringArray(
    raw.usedCandidateAttemptIds,
    "persisted_used_candidate_attempt_ids",
    { allowEmpty: true },
  );
  if (
    usedCandidateAttemptIds.some(
      (attemptId) => !IDENTIFIER_PATTERN.test(attemptId),
    )
  )
    throw new Error("persisted_used_candidate_attempt_id_invalid");
  const lastCompletedPromotion =
    raw.lastCompletedPromotion === null
      ? null
      : hydrateLastPromotion(raw.lastCompletedPromotion);
  if (
    recoveryAdmissionEffect !== null &&
    (recoveryAdmissionEffect.epoch > aggregateVersion ||
      !observationMatchesState(
        recoveryAdmissionEffect.state,
        recoveryAdmissionEffect.observationDigest,
      ) ||
      (recoveryAdmissionEffect.operation ===
        ActionReleaseAdmissionEffectOperation.CloseRecovery &&
        (recoveryAdmissionEffect.effectId !== recoveryAdmissionEffect.fenceId ||
          !sameActionRef(recoveryAdmissionEffect.currentPrimary, primaryRef))))
  )
    throw new Error("persisted_recovery_effect_binding_invalid");
  if (
    lastCompletedPromotion !== null &&
    (!sameActionRef(lastCompletedPromotion.toRelease, primaryRef) ||
      !usedCandidateAttemptIds.includes(lastCompletedPromotion.attemptId))
  )
    throw new Error("persisted_completed_promotion_binding_invalid");
  if (
    predecessorRetention !== null &&
    lastCompletedPromotion !== null &&
    (!sameActionRef(
      predecessorRetention.predecessorRef,
      lastCompletedPromotion.fromRelease,
    ) ||
      predecessorRetention.promotionAttemptId !==
        lastCompletedPromotion.attemptId ||
      predecessorRetention.configurationDigest !==
        lastCompletedPromotion.configurationDigest ||
      predecessorRetention.authorityEstablishedAt !==
        lastCompletedPromotion.completedAt)
  )
    throw new Error("persisted_predecessor_promotion_binding_invalid");
  if (
    predecessorRetention?.firstZeroCapture !== null &&
    predecessorRetention?.firstZeroCapture !== undefined &&
    (latestInventory === null ||
      !sameInventoryIdentity(latestInventory, {
        inventoryDigest: predecessorRetention.firstZeroCapture.inventoryDigest,
        inventoryScopeDigest:
          predecessorRetention.firstZeroCapture.inventoryScopeDigest,
        capturedAt: predecessorRetention.firstZeroCapture.capturedAt,
        repositoryCohortRevision:
          predecessorRetention.firstZeroCapture.repositoryCohortRevision,
        repositoryCohortDigest:
          predecessorRetention.firstZeroCapture.repositoryCohortDigest,
        githubRepositoryIds:
          predecessorRetention.firstZeroCapture.githubRepositoryIds,
        policyRevision: predecessorRetention.firstZeroCapture.policyRevision,
        exactRefs: predecessorRetention.firstZeroCapture.exactRefs,
        maximumQueueLeaseWindowMs:
          predecessorRetention.firstZeroCapture.maximumQueueLeaseWindowMs,
      }))
  )
    throw new Error("persisted_predecessor_latest_inventory_mismatch");

  const base = {
    schemaVersion: 1 as const,
    channel: ACTION_RELEASE_CHANNEL,
    phase,
    aggregateVersion,
    channelVersion,
    primaryRef,
    admissionMode,
    recoveryAdmissionEffect,
    latestInventory,
    predecessorRetention,
    candidateDrainHolds,
    usedCandidateAttemptIds,
    lastCompletedPromotion,
  };

  if (phase === ActionReleaseRolloutPhase.Steady) {
    if (admissionMode !== "normal" || recoveryAdmissionEffect !== null)
      throw new Error("persisted_steady_admission_invalid");
    return deepFreeze({
      ...base,
      phase,
      admissionMode,
    }) as ActionReleaseRollout;
  }

  if (phase === ActionReleaseRolloutPhase.RecoveryOnly) {
    const enteredAt = timestamp(
      raw.enteredAt,
      "persisted_recovery_rollout_entered_at",
    );
    if (
      admissionMode !== "recovery_only" ||
      recoveryAdmissionEffect?.operation !==
        ActionReleaseAdmissionEffectOperation.CloseRecovery ||
      raw.recoveryFenceId !== recoveryAdmissionEffect.fenceId ||
      raw.recoveryFenceEpoch !== recoveryAdmissionEffect.fenceEpoch ||
      raw.failureDigest !== recoveryAdmissionEffect.failureDigest ||
      Date.parse(recoveryAdmissionEffect.updatedAt) < Date.parse(enteredAt)
    )
      throw new Error("persisted_recovery_rollout_binding_invalid");
    return deepFreeze({
      ...base,
      phase,
      admissionMode,
      recoveryAdmissionEffect,
      recoveryFenceId: identifier(
        raw.recoveryFenceId,
        "persisted_recovery_rollout_fence_id",
      ),
      recoveryFenceEpoch: positiveBigint(
        raw.recoveryFenceEpoch,
        "persisted_recovery_rollout_fence_epoch",
      ),
      failureDigest: sha256(
        raw.failureDigest as string,
        "persisted_recovery_rollout_failure_digest",
      ),
      enteredAt,
    }) as ActionReleaseRollout;
  }

  if (phase === ActionReleaseRolloutPhase.CandidateAborted) {
    const abortedCandidate = hydrateCandidate(raw.abortedCandidate, primaryRef);
    if (!usedCandidateAttemptIds.includes(abortedCandidate.attemptId))
      throw new Error("persisted_aborted_candidate_audit_mismatch");
    assertCandidateAdmissionBinding({
      candidate: abortedCandidate,
      admissionMode,
      recoveryAdmissionEffect,
      allowReopen: false,
    });
    let receiptIdentity: Readonly<{
      receiptId: string;
      artifactId: string;
    }> | null = null;
    if (raw.receiptIdentity !== null) {
      const receipt = record(raw.receiptIdentity, "persisted_aborted_receipt");
      exactKeys(
        receipt,
        ["receiptId", "artifactId"],
        "persisted_aborted_receipt",
      );
      receiptIdentity = Object.freeze({
        receiptId: identifier(
          receipt.receiptId,
          "persisted_aborted_receipt_id",
        ),
        artifactId: identifier(
          receipt.artifactId,
          "persisted_aborted_artifact_id",
        ),
      });
    }
    return deepFreeze({
      ...base,
      phase,
      abortedCandidate,
      abortedAt: timestamp(raw.abortedAt, "persisted_candidate_aborted_at"),
      abortReasonDigest: sha256(
        raw.abortReasonDigest as string,
        "persisted_candidate_abort_reason",
      ),
      receiptIdentity,
    }) as ActionReleaseRollout;
  }

  const candidate = hydrateCandidate(raw.candidate, primaryRef);
  if (!usedCandidateAttemptIds.includes(candidate.attemptId))
    throw new Error("persisted_candidate_audit_mismatch");
  if (
    predecessorRetention?.admissionEffect !== null &&
    predecessorRetention?.admissionEffect !== undefined
  )
    throw new Error("persisted_candidate_predecessor_effect_overlap");
  if (
    predecessorRetention?.removalEffect !== null &&
    predecessorRetention?.removalEffect !== undefined
  )
    throw new Error("persisted_candidate_predecessor_effect_overlap");
  if (
    predecessorRetention !== null &&
    !sameActionRef(
      candidate.candidateRelease.actionRef,
      predecessorRetention.predecessorRef,
    )
  )
    throw new Error("persisted_candidate_predecessor_mismatch");
  assertCandidateAdmissionBinding({
    candidate,
    admissionMode,
    recoveryAdmissionEffect,
    allowReopen: phase === ActionReleaseRolloutPhase.PromotionUncertain,
  });
  const overlapEffect = hydrateOverlapEffect(raw.overlapEffect);
  if (
    overlapEffect !== null &&
    (overlapEffect.ownerAttemptId !== candidate.attemptId ||
      overlapEffect.epoch > aggregateVersion ||
      (overlapEffect.state === ActionReleaseOverlapEffectState.Dispatching
        ? overlapEffect.observationDigest !== null
        : overlapEffect.observationDigest === null))
  )
    throw new Error("persisted_overlap_effect_binding_mismatch");
  if (overlapEffect !== null) {
    const expectedKnown = expectedKnownRefs({
      primaryRef,
      candidateDrainHolds,
      predecessorRetention,
      latestInventory,
    });
    const expectedKnownWithRetainedCandidate = expectedKnownRefs({
      primaryRef,
      candidateDrainHolds,
      predecessorRetention,
      latestInventory,
      candidateRef: candidate.candidateRelease.actionRef,
    });
    const isolatedAttemptId =
      overlapEffect.expectedConfiguration.isolatedCandidateAttemptId;
    if (
      !allGeneralRefsEqual(overlapEffect.expectedConfiguration, primaryRef) ||
      !(
        sameRefSet(
          overlapEffect.expectedConfiguration.knownRefs,
          expectedKnown,
        ) ||
        (phase !== ActionReleaseRolloutPhase.CandidateRegistered &&
          sameRefSet(
            overlapEffect.expectedConfiguration.knownRefs,
            expectedKnownWithRetainedCandidate,
          ))
      ) ||
      (isolatedAttemptId !== null &&
        (isolatedAttemptId === candidate.attemptId ||
          !usedCandidateAttemptIds.includes(isolatedAttemptId)))
    )
      throw new Error("persisted_pre_overlap_configuration_invalid");
  }
  const candidateBase = { ...base, candidate, overlapEffect };

  if (phase === ActionReleaseRolloutPhase.CandidateRegistered) {
    if (overlapEffect?.state === ActionReleaseOverlapEffectState.Verified)
      throw new Error("persisted_candidate_overlap_effect_state_invalid");
    return deepFreeze({ ...candidateBase, phase }) as ActionReleaseRollout;
  }

  const overlapConfiguration = hydrateConfiguration(raw.overlapConfiguration);
  if (
    overlapEffect === null ||
    overlapEffect.state !== ActionReleaseOverlapEffectState.Verified ||
    overlapEffect.epoch >= aggregateVersion ||
    overlapEffect.observationDigest !==
      overlapConfiguration.configurationDigest ||
    overlapEffect.updatedAt !== overlapConfiguration.observedAt ||
    overlapConfiguration.revision <=
      overlapEffect.expectedConfiguration.revision ||
    Date.parse(overlapConfiguration.observedAt) <
      Date.parse(overlapEffect.expectedConfiguration.observedAt) ||
    !sameStringSet(
      overlapConfiguration.serviceIds,
      overlapEffect.expectedConfiguration.serviceIds,
    ) ||
    !sameInstallerIdentity(
      overlapConfiguration.installer,
      overlapEffect.expectedConfiguration.installer,
    ) ||
    !allGeneralRefsEqual(overlapConfiguration, primaryRef) ||
    overlapConfiguration.isolatedCandidateAttemptId !== candidate.attemptId ||
    !sameRefSet(
      overlapConfiguration.knownRefs,
      expectedKnownRefs({
        primaryRef,
        candidateDrainHolds,
        predecessorRetention,
        latestInventory,
        candidateRef: candidate.candidateRelease.actionRef,
      }),
    ) ||
    !overlapConfiguration.knownRefs.some((ref) =>
      sameActionRef(ref, candidate.candidateRelease.actionRef),
    )
  )
    throw new Error("persisted_overlap_configuration_candidate_mismatch");
  const overlapBase = {
    ...candidateBase,
    overlapConfiguration,
  };
  if (phase === ActionReleaseRolloutPhase.OverlapStaged)
    return deepFreeze({ ...overlapBase, phase }) as ActionReleaseRollout;

  const canary = hydrateCanaryBinding(raw.canary, candidate.candidateRelease);
  const expectation = hydrateExpectation(raw.expectation, candidate, canary);
  if (
    overlapConfiguration.isolatedCandidateBindingDigest !== null &&
    overlapConfiguration.isolatedCandidateBindingDigest !==
      expectation.expectationDigest
  )
    throw new Error("persisted_canary_overlap_binding_mismatch");
  const provisioning = hydrateProvisioningCheckpoint(raw.provisioning);
  if (
    provisioning.effectId !== expectation.expectationDigest ||
    provisioning.epoch > aggregateVersion ||
    (provisioning.state === "prepared" &&
      (phase !== ActionReleaseRolloutPhase.CanaryArmed ||
        provisioning.epoch !== aggregateVersion ||
        provisioning.updatedAt !== candidate.registeredAt)) ||
    (provisioning.state !== "prepared" &&
      Date.parse(provisioning.updatedAt) <
        Date.parse(candidate.registeredAt)) ||
    (provisioning.eligibility !== null &&
      (provisioning.eligibility.policyRevision !== candidate.policyRevision ||
        provisioning.eligibility.channelVersion !== channelVersion ||
        provisioning.eligibility.admissionMode !== admissionMode ||
        provisioning.eligibility.aggregateVersion + 1n !== provisioning.epoch))
  )
    throw new Error("persisted_provisioning_authorization_fence_mismatch");
  const receiptVerification = hydrateReceiptVerification(
    raw.receiptVerification,
  );
  if (
    receiptVerification !== null &&
    (provisioning.state !== "verified" ||
      receiptVerification.ownerAttemptId !== candidate.attemptId ||
      receiptVerification.expectationDigest !== expectation.expectationDigest ||
      receiptVerification.epoch > aggregateVersion ||
      (phase === ActionReleaseRolloutPhase.CanaryArmed &&
        receiptVerification.state ===
          FixedTerminalReceiptVerificationState.Verified) ||
      (receiptVerification.state ===
        FixedTerminalReceiptVerificationState.Dispatching &&
        Date.parse(receiptVerification.leaseExpiresAt) <=
          Date.parse(receiptVerification.updatedAt)))
  )
    throw new Error("persisted_receipt_verification_binding_mismatch");
  const canaryBase = {
    ...overlapBase,
    canary,
    expectation,
    provisioning,
    receiptVerification,
  };
  if (phase === ActionReleaseRolloutPhase.CanaryArmed)
    return deepFreeze({ ...canaryBase, phase }) as ActionReleaseRollout;

  if (
    provisioning.state !== "verified" ||
    receiptVerification?.state !==
      FixedTerminalReceiptVerificationState.Verified
  )
    throw new Error("persisted_verified_canary_checkpoint_invalid");
  const receipt = hydrateReceipt(raw.receipt, expectation);
  if (
    receiptVerification.locator.artifactId !== receipt.artifactId ||
    receiptVerification.locator.artifactSha256 !== receipt.artifactSha256 ||
    receiptVerification.epoch >= aggregateVersion ||
    receiptVerification.updatedAt !== receipt.completedAt ||
    Date.parse(receipt.completedAt) < Date.parse(provisioning.updatedAt)
  )
    throw new Error("persisted_verified_receipt_locator_mismatch");
  const verifiedBase = {
    ...canaryBase,
    provisioning,
    receiptVerification,
    receipt,
  };
  if (phase === ActionReleaseRolloutPhase.CanaryVerified)
    return deepFreeze({ ...verifiedBase, phase }) as ActionReleaseRollout;

  const preparation = hydratePreparation(raw.preparation);
  if (
    latestInventory === null ||
    !sameInventoryIdentity(latestInventory, preparation.inventory) ||
    preparation.inventory.policyRevision !== candidate.policyRevision ||
    !preparation.inventory.githubRepositoryIds.includes(
      canary.target.githubRepositoryId,
    ) ||
    Date.parse(preparation.inventory.capturedAt) >
      Date.parse(preparation.preparedAt) ||
    Date.parse(preparation.inventory.capturedAt) <
      Date.parse(receipt.completedAt) ||
    Date.parse(preparation.configuration.observedAt) >
      Date.parse(preparation.preparedAt) ||
    Date.parse(preparation.configuration.observedAt) <
      Date.parse(receipt.completedAt) ||
    preparation.configuration.revision < overlapConfiguration.revision ||
    Date.parse(preparation.configuration.observedAt) <
      Date.parse(overlapConfiguration.observedAt) ||
    !sameStringSet(
      preparation.configuration.serviceIds,
      overlapConfiguration.serviceIds,
    ) ||
    !allGeneralRefsEqual(preparation.configuration, primaryRef) ||
    preparation.configuration.isolatedCandidateAttemptId !==
      candidate.attemptId ||
    preparation.configuration.isolatedCandidateBindingDigest !==
      expectation.expectationDigest ||
    preparation.inventory.exactRefs.some(
      (ref) => !sameActionRepository(ref, primaryRef),
    ) ||
    !sameRefSet(
      preparation.configuration.knownRefs,
      expectedKnownRefs({
        primaryRef,
        candidateDrainHolds,
        predecessorRetention,
        latestInventory,
        candidateRef: candidate.candidateRelease.actionRef,
        inventoryRefs: preparation.inventory.exactRefs,
      }),
    )
  )
    throw new Error("persisted_promotion_preparation_binding_invalid");
  const preparedBase = { ...verifiedBase, preparation };
  if (phase === ActionReleaseRolloutPhase.PromotionPrepared)
    return deepFreeze({ ...preparedBase, phase }) as ActionReleaseRollout;

  const reservation = hydrateReservation(raw.reservation);
  const effect = hydratePromotionEffect(raw.effect);
  if (
    reservation.ownerAttemptId !== candidate.attemptId ||
    reservation.receiptId !== receipt.receiptId ||
    reservation.artifactId !== receipt.artifactId ||
    reservation.canonicalPayloadDigest !== receipt.canonicalPayloadDigest ||
    reservation.artifactSha256 !== receipt.artifactSha256 ||
    reservation.expectationDigest !== receipt.expectationDigest ||
    reservation.receiptIdentityDigest !==
      terminalCanaryReceiptIdentityDigest(receipt) ||
    reservation.epoch !== effect.epoch ||
    Date.parse(reservation.reservedAt) < Date.parse(preparation.preparedAt) ||
    Date.parse(reservation.reservedAt) > Date.parse(preparation.validUntil) ||
    effect.ownerAttemptId !== candidate.attemptId ||
    Date.parse(effect.updatedAt) < Date.parse(reservation.reservedAt) ||
    (phase === ActionReleaseRolloutPhase.Promoting &&
      (effect.state !== ActionReleasePromotionEffectState.Dispatching ||
        effect.observationDigest !== null ||
        effect.epoch !== aggregateVersion ||
        Date.parse(effect.updatedAt) > Date.parse(preparation.validUntil))) ||
    (phase === ActionReleaseRolloutPhase.PromotionUncertain &&
      (effect.state !== ActionReleasePromotionEffectState.Uncertain ||
        effect.observationDigest === null ||
        effect.epoch >= aggregateVersion))
  )
    throw new Error("persisted_promotion_effect_binding_invalid");
  if (
    recoveryAdmissionEffect?.operation ===
      ActionReleaseAdmissionEffectOperation.ReopenRecovery &&
    (recoveryAdmissionEffect.ownerAttemptId !== candidate.attemptId ||
      !sameActionRef(
        recoveryAdmissionEffect.promotedPrimary,
        candidate.candidateRelease.actionRef,
      ) ||
      recoveryAdmissionEffect.promotedConfiguration.revision <=
        preparation.configurationRevision ||
      Date.parse(recoveryAdmissionEffect.promotedConfiguration.observedAt) >
        Date.parse(effect.updatedAt) ||
      !sameStringSet(
        recoveryAdmissionEffect.promotedConfiguration.serviceIds,
        preparation.configuration.serviceIds,
      ) ||
      !allGeneralRefsEqual(
        recoveryAdmissionEffect.promotedConfiguration,
        candidate.candidateRelease.actionRef,
      ) ||
      !sameInstallerIdentity(
        recoveryAdmissionEffect.promotedConfiguration.installer,
        candidate.candidateRelease.installer,
      ) ||
      recoveryAdmissionEffect.promotedConfiguration
        .isolatedCandidateAttemptId !== null ||
      recoveryAdmissionEffect.promotedConfiguration
        .isolatedCandidateBindingDigest !== null ||
      !sameRefSet(
        recoveryAdmissionEffect.promotedConfiguration.knownRefs,
        expectedKnownRefs({
          primaryRef,
          candidateDrainHolds,
          predecessorRetention,
          latestInventory,
          candidateRef: candidate.candidateRelease.actionRef,
          inventoryRefs: preparation.inventory.exactRefs,
        }),
      ))
  )
    throw new Error("persisted_recovery_reopen_binding_invalid");
  return deepFreeze({
    ...preparedBase,
    phase,
    reservation,
    effect,
  }) as ActionReleaseRollout;
}
