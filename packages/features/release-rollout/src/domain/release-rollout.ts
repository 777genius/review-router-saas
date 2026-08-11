import { createHash } from "node:crypto";

export const RolloutPhase = Object.freeze({
  Planned: "planned",
  ProviderFrozen: "provider_frozen",
  RunnerProvisioned: "runner_provisioned",
  SourceBackupCaptured: "source_backup_captured",
  SourceQuiesced: "source_quiesced",
  GenerationCopied: "generation_copied",
  DataEquivalent: "data_equivalent",
  TargetRolesBootstrapped: "target_roles_bootstrapped",
  MigrationApplied: "migration_applied",
  TargetStaged: "target_staged",
  TargetActivated: "target_activated",
  RolloutVerified: "rollout_verified",
  RunnerCleaned: "runner_cleaned",
} as const);

export type RolloutPhase = (typeof RolloutPhase)[keyof typeof RolloutPhase];

export const RolloutStep = Object.freeze({
  FreezeProviderServices: "freeze_provider_services",
  ProvisionPrivateRunner: "provision_private_runner",
  CaptureSourceBackup: "capture_source_backup",
  QuiesceSource: "quiesce_source",
  CopyDatabaseGeneration: "copy_database_generation",
  VerifyDataEquivalence: "verify_data_equivalence",
  BootstrapTargetRoles: "bootstrap_target_roles",
  RunReleaseMigration: "run_release_migration",
  StageTargetServices: "stage_target_services",
  ActivateTargetGeneration: "activate_target_generation",
  VerifyTrustedRollout: "verify_trusted_rollout",
  CleanupEphemeralRunner: "cleanup_ephemeral_runner",
} as const);

export type RolloutStep = (typeof RolloutStep)[keyof typeof RolloutStep];

const orderedTransitions = Object.freeze([
  [
    RolloutPhase.Planned,
    RolloutStep.FreezeProviderServices,
    RolloutPhase.ProviderFrozen,
  ],
  [
    RolloutPhase.ProviderFrozen,
    RolloutStep.ProvisionPrivateRunner,
    RolloutPhase.RunnerProvisioned,
  ],
  [
    RolloutPhase.RunnerProvisioned,
    RolloutStep.CaptureSourceBackup,
    RolloutPhase.SourceBackupCaptured,
  ],
  [
    RolloutPhase.SourceBackupCaptured,
    RolloutStep.QuiesceSource,
    RolloutPhase.SourceQuiesced,
  ],
  [
    RolloutPhase.SourceQuiesced,
    RolloutStep.CopyDatabaseGeneration,
    RolloutPhase.GenerationCopied,
  ],
  [
    RolloutPhase.GenerationCopied,
    RolloutStep.VerifyDataEquivalence,
    RolloutPhase.DataEquivalent,
  ],
  [
    RolloutPhase.DataEquivalent,
    RolloutStep.BootstrapTargetRoles,
    RolloutPhase.TargetRolesBootstrapped,
  ],
  [
    RolloutPhase.TargetRolesBootstrapped,
    RolloutStep.RunReleaseMigration,
    RolloutPhase.MigrationApplied,
  ],
  [
    RolloutPhase.MigrationApplied,
    RolloutStep.StageTargetServices,
    RolloutPhase.TargetStaged,
  ],
  [
    RolloutPhase.TargetStaged,
    RolloutStep.ActivateTargetGeneration,
    RolloutPhase.TargetActivated,
  ],
  [
    RolloutPhase.TargetActivated,
    RolloutStep.VerifyTrustedRollout,
    RolloutPhase.RolloutVerified,
  ],
  [
    RolloutPhase.RolloutVerified,
    RolloutStep.CleanupEphemeralRunner,
    RolloutPhase.RunnerCleaned,
  ],
] as const);

const phaseValues = new Set<string>(Object.values(RolloutPhase));
const stepValues = new Set<string>(Object.values(RolloutStep));
const shaPattern = /^[a-f0-9]{40}$/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/u;
const systemIdentifierPattern = /^[0-9]+$/u;

export function parseRolloutPhase(value: unknown): RolloutPhase {
  if (typeof value !== "string" || !phaseValues.has(value))
    throw new Error("rollout_phase_unknown");
  return value as RolloutPhase;
}

export function parseRolloutStep(value: unknown): RolloutStep {
  if (typeof value !== "string" || !stepValues.has(value))
    throw new Error("rollout_step_unknown");
  return value as RolloutStep;
}

export interface DatabaseGenerationIdentity {
  readonly renderResourceId: string;
  readonly systemIdentifier: string;
  readonly majorVersion: 16 | 17;
  readonly recoveryWitnessSha256: string;
}

export interface RunnerIdentity {
  readonly repository: string;
  readonly runId: string;
  readonly runAttempt: number;
  readonly commitSha: string;
  readonly jitLabel: string;
  readonly runnerName: string;
  readonly renderJobId: string;
  readonly baseServiceId: string;
  readonly baseDeployId: string;
  readonly imageDigest: string;
}

export interface StepReceipt {
  readonly step: RolloutStep;
  readonly receiptId: string;
  readonly observedAt: string;
  readonly payloadSha256: string;
}

export interface ActivationReceipt extends StepReceipt {
  readonly step: typeof RolloutStep.ActivateTargetGeneration;
  readonly sourceSystemIdentifier: string;
  readonly targetSystemIdentifier: string;
  readonly canonicalPrivilegesSha256: string;
  readonly transactionId: string;
  readonly firstWriteBoundary: true;
}

export interface ReleaseRollout {
  readonly schemaVersion: 1;
  readonly rolloutId: string;
  readonly expectedCommitSha: string;
  readonly phase: RolloutPhase;
  readonly source: DatabaseGenerationIdentity;
  readonly target: DatabaseGenerationIdentity;
  readonly receipts: readonly StepReceipt[];
  readonly activated: boolean;
  readonly activationReceipt?: ActivationReceipt;
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function assertIdentifier(value: string, label: string): void {
  if (!identifierPattern.test(value)) throw new Error(`${label}_invalid`);
}

export function assertGenerationIdentity(
  value: DatabaseGenerationIdentity,
  expectedMajor: 16 | 17,
): void {
  assertIdentifier(value.renderResourceId, "render_resource_id");
  if (value.majorVersion !== expectedMajor)
    throw new Error("database_generation_major_version_mismatch");
  if (!systemIdentifierPattern.test(value.systemIdentifier))
    throw new Error("database_system_identifier_invalid");
  if (!/^[a-f0-9]{64}$/u.test(value.recoveryWitnessSha256))
    throw new Error("database_recovery_witness_invalid");
}

export function createReleaseRollout(
  input: Omit<
    ReleaseRollout,
    "schemaVersion" | "phase" | "receipts" | "activated"
  >,
): ReleaseRollout {
  assertIdentifier(input.rolloutId, "rollout_id");
  if (!shaPattern.test(input.expectedCommitSha))
    throw new Error("release_commit_invalid");
  assertGenerationIdentity(input.source, 16);
  assertGenerationIdentity(input.target, 17);
  if (
    input.source.renderResourceId === input.target.renderResourceId ||
    input.source.systemIdentifier === input.target.systemIdentifier
  ) {
    throw new Error("database_generations_not_distinct");
  }
  return Object.freeze({
    ...input,
    schemaVersion: 1,
    phase: RolloutPhase.Planned,
    receipts: Object.freeze([]),
    activated: false,
  });
}

function validateReceipt(receipt: StepReceipt): void {
  parseRolloutStep(receipt.step);
  assertIdentifier(receipt.receiptId, "receipt_id");
  if (!digestPattern.test(receipt.payloadSha256))
    throw new Error("receipt_payload_digest_invalid");
  if (new Date(receipt.observedAt).toISOString() !== receipt.observedAt)
    throw new Error("receipt_timestamp_invalid");
}

export function applyStepReceipt(
  rollout: ReleaseRollout,
  receipt: StepReceipt,
): ReleaseRollout {
  validateReceipt(receipt);
  const replay = rollout.receipts.find(
    (item) =>
      item.step === receipt.step || item.receiptId === receipt.receiptId,
  );
  if (replay) {
    if (canonicalJson(replay) === canonicalJson(receipt)) return rollout;
    throw new Error("rollout_receipt_conflicting_replay");
  }
  const transition = orderedTransitions.find(
    ([from, step]) => from === rollout.phase && step === receipt.step,
  );
  if (!transition) throw new Error("rollout_transition_stale_or_out_of_order");
  if (receipt.step === RolloutStep.ActivateTargetGeneration) {
    const activation = receipt as ActivationReceipt;
    if (
      !activation.firstWriteBoundary ||
      activation.sourceSystemIdentifier !== rollout.source.systemIdentifier ||
      activation.targetSystemIdentifier !== rollout.target.systemIdentifier ||
      !digestPattern.test(activation.canonicalPrivilegesSha256) ||
      !identifierPattern.test(activation.transactionId)
    ) {
      throw new Error("activation_receipt_invalid");
    }
  }
  const activationReceipt =
    receipt.step === RolloutStep.ActivateTargetGeneration
      ? (receipt as ActivationReceipt)
      : rollout.activationReceipt;
  return Object.freeze({
    ...rollout,
    phase: transition[2],
    receipts: Object.freeze([
      ...rollout.receipts,
      Object.freeze({ ...receipt }),
    ]),
    activated:
      rollout.activated ||
      receipt.step === RolloutStep.ActivateTargetGeneration,
    ...(activationReceipt ? { activationReceipt } : {}),
  });
}

export function assertRollbackTargetAllowed(
  rollout: ReleaseRollout,
  targetSystemIdentifier: string,
): void {
  if (
    rollout.activated &&
    targetSystemIdentifier === rollout.source.systemIdentifier
  )
    throw new Error("source_generation_promotion_forbidden_after_first_write");
  if (
    targetSystemIdentifier !== rollout.source.systemIdentifier &&
    targetSystemIdentifier !== rollout.target.systemIdentifier
  )
    throw new Error("rollback_generation_unknown");
}

export function assertRunnerIdentity(
  identity: RunnerIdentity,
  expected: {
    repository: string;
    runId: string;
    runAttempt: number;
    commitSha: string;
    jitLabel: string;
  },
): void {
  if (
    canonicalJson({
      repository: identity.repository,
      runId: identity.runId,
      runAttempt: identity.runAttempt,
      commitSha: identity.commitSha,
      jitLabel: identity.jitLabel,
    }) !== canonicalJson(expected)
  )
    throw new Error("runner_identity_mismatch");
  if (
    !shaPattern.test(identity.commitSha) ||
    !digestPattern.test(identity.imageDigest) ||
    !identifierPattern.test(identity.baseServiceId) ||
    !identifierPattern.test(identity.baseDeployId) ||
    !identifierPattern.test(identity.runnerName) ||
    !identifierPattern.test(identity.renderJobId)
  )
    throw new Error("runner_immutable_identity_invalid");
}
