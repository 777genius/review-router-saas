/**
 * Provider-neutral authorization policy for every irreversible namespace edge.
 * Adapters own locking and persistence; this policy owns the exact fence and
 * deadline decision made from the rows reloaded under that lock.
 */
export type ProviderSecretMutationFence = Readonly<{
  owner: "setup" | "runtime" | "recovery" | null;
  ownerId: string | null;
  epoch: bigint;
}>;

export type ProviderSecretTransitionAuthorization = Readonly<{
  expectedOwner: "setup" | "runtime";
  expectedOwnerId: string;
  expectedEpoch: bigint;
  actualFence: ProviderSecretMutationFence;
  authorizationExpiresAt: Date;
  now: Date;
}>;

/**
 * A provider PUT may consume the full transport timeout before its response is
 * durably confirmed. Never create dispatch authority from the last few
 * milliseconds of a runtime lease.
 */
export const runtimeVersionedMinimumEffectConfirmationWindowMs = 30_000;

/** Bound one dispatcher claim even when the surrounding runtime lease is long. */
export const runtimeVersionedExecutorLeaseTtlMs = 5 * 60_000;

export type RuntimeVersionedWritebackIdentity = Readonly<{
  providerInstanceId: string;
  mutationOwner: "setup" | "runtime" | "recovery" | null;
  mutationOwnerId: string | null;
  mutationEpoch: bigint;
  namespaceId: string;
  generation: number;
  latestGenerationHash: string;
  accountIdentityHash: string | null;
}>;

/**
 * Reserves and returns the persisted executor deadline. At the exact minimum
 * boundary dispatch is permitted; one millisecond less fails closed.
 */
export function reserveRuntimeVersionedEffectConfirmationWindow(
  input: Readonly<{ now: Date; authorizationExpiresAt: Date }>,
): Date {
  const nowMs = input.now.getTime();
  const authorizationExpiresAtMs = input.authorizationExpiresAt.getTime();
  if (!Number.isFinite(nowMs) || !Number.isFinite(authorizationExpiresAtMs)) {
    throw new Error("runtime_versioned_effect_window_clock_invalid");
  }
  if (
    authorizationExpiresAtMs - nowMs <
    runtimeVersionedMinimumEffectConfirmationWindowMs
  ) {
    throw new Error("runtime_versioned_effect_confirmation_window_unavailable");
  }
  return new Date(
    Math.min(
      authorizationExpiresAtMs,
      nowMs + runtimeVersionedExecutorLeaseTtlMs,
    ),
  );
}

/**
 * Authorizes only the destructive retirement edge. In particular, expiry of
 * the executor lease is intentionally not an error here, while every persisted
 * effect identity must still match the current provider mutation fence.
 */
export function assertRuntimeVersionedAmbiguousRetirementAuthorized(
  input: Readonly<{
    expected: RuntimeVersionedWritebackIdentity;
    actual: RuntimeVersionedWritebackIdentity;
    executorLeaseExpiresAt: Date;
    now: Date;
  }>,
): void {
  if (
    !Number.isFinite(input.executorLeaseExpiresAt.getTime()) ||
    !Number.isFinite(input.now.getTime())
  ) {
    throw new Error("runtime_versioned_retirement_clock_invalid");
  }
  assertSameRuntimeVersionedWritebackIdentity({
    expected: input.expected,
    actual: input.actual,
  });
}

export function assertSameRuntimeVersionedWritebackIdentity(
  input: Readonly<{
    expected: RuntimeVersionedWritebackIdentity;
    actual: RuntimeVersionedWritebackIdentity;
  }>,
): void {
  if (
    input.actual.providerInstanceId !== input.expected.providerInstanceId ||
    input.actual.mutationOwner !== input.expected.mutationOwner ||
    input.actual.mutationOwnerId !== input.expected.mutationOwnerId ||
    input.actual.mutationEpoch !== input.expected.mutationEpoch ||
    input.actual.namespaceId !== input.expected.namespaceId ||
    input.actual.generation !== input.expected.generation ||
    input.actual.latestGenerationHash !== input.expected.latestGenerationHash ||
    input.actual.accountIdentityHash !== input.expected.accountIdentityHash
  ) {
    throw new Error("runtime_versioned_retirement_identity_stale");
  }
}

export function assertProviderSecretAuthorizationUnexpired(
  input: Readonly<{
    authorizationExpiresAt: Date;
    now: Date;
  }>,
): void {
  if (!Number.isFinite(input.now.getTime())) {
    throw new Error("provider_secret_transition_clock_invalid");
  }
  if (input.authorizationExpiresAt.getTime() <= input.now.getTime()) {
    throw new Error("provider_secret_transition_authorization_expired");
  }
}

export function assertProviderSecretTransitionAuthorized(
  input: ProviderSecretTransitionAuthorization,
): void {
  assertProviderSecretAuthorizationUnexpired(input);
  if (
    input.actualFence.owner !== input.expectedOwner ||
    input.actualFence.ownerId !== input.expectedOwnerId ||
    input.actualFence.epoch !== input.expectedEpoch
  ) {
    throw new Error("provider_secret_transition_fence_stale");
  }
}

export enum RuntimeVersionedDurableMarker {
  DispatchAuthorizedV1 = "runtime_versioned_dispatch_authorized_v1",
  ProviderPreDispatchFailedV1 = "versioned_provider_pre_dispatch_failed_v1",
  ProviderConfirmedV1 = "runtime_versioned_provider_confirmed_v1",
  InterruptedAttemptRecoveredV1 = "versioned_interrupted_attempt_recovered_v1",
  ProviderPutOutcomeUnknown = "versioned_provider_put_outcome_unknown",
  ProviderConfirmationOutcomeUnknown = "versioned_provider_confirmation_outcome_unknown",
  WorkflowOrActivationOutcomeUnknown = "versioned_workflow_or_activation_outcome_unknown",
}

/** Provider-neutral facts about the operator-managed recovery witness. */
export enum ExternalRecoveryWitnessRelation {
  NoPersistedEvidence = "no_persisted_evidence",
  Matching = "matching",
  Mismatched = "mismatched",
}

export type ExternalRecoveryWitnessTransition =
  | "automatic_runtime"
  | "forced_operator_recovery";

export function classifyExternalRecoveryWitnessRelation(
  input: Readonly<{
    persistedFingerprint: string | null | undefined;
    currentFingerprint: string;
  }>,
): ExternalRecoveryWitnessRelation {
  if (!input.persistedFingerprint) {
    return ExternalRecoveryWitnessRelation.NoPersistedEvidence;
  }
  return input.persistedFingerprint === input.currentFingerprint
    ? ExternalRecoveryWitnessRelation.Matching
    : ExternalRecoveryWitnessRelation.Mismatched;
}

/**
 * Domain admission for restored/promoted database state. Automatic work may
 * never cross a witness generation. Only the already acknowledged forced
 * operator transition may retire the old namespace generation.
 */
export function assertExternalRecoveryWitnessAdmission(
  input: Readonly<{
    transition: ExternalRecoveryWitnessTransition;
    relation: ExternalRecoveryWitnessRelation;
  }>,
): void {
  if (
    input.relation === ExternalRecoveryWitnessRelation.Mismatched &&
    input.transition !== "forced_operator_recovery"
  ) {
    throw new Error("codex_rotating_database_recovery_witness_mismatch");
  }
}

export function isRuntimeVersionedDurableMarker(
  marker: string | null | undefined,
): marker is RuntimeVersionedDurableMarker {
  return Object.values(RuntimeVersionedDurableMarker).includes(
    marker as RuntimeVersionedDurableMarker,
  );
}

/**
 * Fingerprint of an operator-managed, never-reused writer-generation witness.
 * The witness itself is never persisted. Operators must rotate it before a
 * restored snapshot or promoted writer accepts traffic.
 */
export function fingerprintDatabaseRecoveryWitness(witness: string): string {
  const value = witness.trim();
  if (!/^[A-Za-z0-9_-]{43,256}$/.test(value)) {
    throw new Error("codex_rotating_database_recovery_witness_unproven");
  }
  return createHash("sha256").update(value, "utf8").digest("hex");
}
import { createHash } from "node:crypto";
