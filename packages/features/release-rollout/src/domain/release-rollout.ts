import { createHash } from "node:crypto";
import { isNormalizedServicePostcondition } from "./service-transition";
import {
  assertReleaseMigrationTransitionIntegrity,
  TargetManifestPhase,
  type ReleaseMigrationPermit,
  type ReleaseMigrationTransitionV1,
} from "./release-migration-transition";

/** Authority-owned evidence captured before dispatching provider creation. */
export type ProviderCreationBoundary = Readonly<{
  providerCreationNotBefore: string;
}>;

export const RolloutPhase = Object.freeze({
  Planned: "planned",
  PreflightVerified: "preflight_verified",
  ProviderFrozen: "provider_frozen",
  RoleRunnerProvisioned: "role_runner_provisioned",
  SourceBackupCaptured: "source_backup_captured",
  SourceQuiesced: "source_quiesced",
  GenerationCopied: "generation_copied",
  DataEquivalent: "data_equivalent",
  TargetRolesBootstrapped: "target_roles_bootstrapped",
  RoleRunnerCleaned: "role_runner_cleaned",
  CutoverRunnerProvisioned: "cutover_runner_provisioned",
  MigrationApplied: "migration_applied",
  TargetStaged: "target_staged",
  TargetActivated: "target_activated",
  CutoverRunnerCleaned: "cutover_runner_cleaned",
  TargetServicesResumed: "target_services_resumed",
  LiveCanaryVerified: "live_canary_verified",
  RolloutVerified: "rollout_verified",
  PreActivationFailed: "pre_activation_failed",
  RecoveryCompensating: "recovery_compensating",
  RecoveryCompensated: "recovery_compensated",
  ActivationUncertain: "activation_uncertain",
  ForwardRepairRequired: "forward_repair_required",
} as const);

export type RolloutPhase = (typeof RolloutPhase)[keyof typeof RolloutPhase];

export const RolloutStep = Object.freeze({
  ClaimRollout: "claim_rollout",
  VerifyProtectedEnvironment: "verify_protected_environment",
  FreezeProviderServices: "freeze_provider_services",
  ProvisionRoleRunner: "provision_role_runner",
  CaptureSourceBackup: "capture_source_backup",
  QuiesceSource: "quiesce_source",
  CopyDatabaseGeneration: "copy_database_generation",
  VerifyDataEquivalence: "verify_data_equivalence",
  BootstrapTargetRoles: "bootstrap_target_roles",
  CleanupRoleRunner: "cleanup_role_runner",
  ProvisionCutoverRunner: "provision_cutover_runner",
  RunReleaseMigration: "run_release_migration",
  StageTargetServices: "stage_target_services",
  ActivateTargetGeneration: "activate_target_generation",
  CleanupCutoverRunner: "cleanup_cutover_runner",
  ResumeTargetServices: "resume_target_services",
  VerifyLiveCanary: "verify_live_canary",
  VerifyTrustedRollout: "verify_trusted_rollout",
  BeginCompensation: "begin_compensation",
  EffectCompensation: "effect_compensation",
  CompleteCompensation: "complete_compensation",
  MarkActivationUncertain: "mark_activation_uncertain",
  RequireForwardRepair: "require_forward_repair",
} as const);

export type RolloutStep = (typeof RolloutStep)[keyof typeof RolloutStep];

const orderedTransitions: ReadonlyArray<
  readonly [RolloutPhase, RolloutStep, RolloutPhase]
> = [
  [RolloutPhase.Planned, RolloutStep.ClaimRollout, RolloutPhase.Planned],
  [
    RolloutPhase.Planned,
    RolloutStep.VerifyProtectedEnvironment,
    RolloutPhase.PreflightVerified,
  ],
  [
    RolloutPhase.PreflightVerified,
    RolloutStep.FreezeProviderServices,
    RolloutPhase.ProviderFrozen,
  ],
  [
    RolloutPhase.ProviderFrozen,
    RolloutStep.ProvisionRoleRunner,
    RolloutPhase.RoleRunnerProvisioned,
  ],
  [
    RolloutPhase.RoleRunnerProvisioned,
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
    RolloutStep.BootstrapTargetRoles,
    RolloutPhase.TargetRolesBootstrapped,
  ],
  [
    RolloutPhase.TargetRolesBootstrapped,
    RolloutStep.VerifyDataEquivalence,
    RolloutPhase.DataEquivalent,
  ],
  [
    RolloutPhase.DataEquivalent,
    RolloutStep.CleanupRoleRunner,
    RolloutPhase.RoleRunnerCleaned,
  ],
  [
    RolloutPhase.RoleRunnerCleaned,
    RolloutStep.ProvisionCutoverRunner,
    RolloutPhase.CutoverRunnerProvisioned,
  ],
  [
    RolloutPhase.CutoverRunnerProvisioned,
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
    RolloutStep.CleanupCutoverRunner,
    RolloutPhase.CutoverRunnerCleaned,
  ],
  [
    RolloutPhase.CutoverRunnerCleaned,
    RolloutStep.ResumeTargetServices,
    RolloutPhase.TargetServicesResumed,
  ],
  [
    RolloutPhase.TargetServicesResumed,
    RolloutStep.VerifyLiveCanary,
    RolloutPhase.LiveCanaryVerified,
  ],
  [
    RolloutPhase.LiveCanaryVerified,
    RolloutStep.VerifyTrustedRollout,
    RolloutPhase.RolloutVerified,
  ],
  [
    RolloutPhase.PreActivationFailed,
    RolloutStep.BeginCompensation,
    RolloutPhase.RecoveryCompensating,
  ],
  [
    RolloutPhase.RecoveryCompensating,
    RolloutStep.EffectCompensation,
    RolloutPhase.RecoveryCompensating,
  ],
  [
    RolloutPhase.RecoveryCompensating,
    RolloutStep.CompleteCompensation,
    RolloutPhase.RecoveryCompensated,
  ],
];

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const shaPattern = /^[a-f0-9]{40}$/u;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{2,511}$/u;
const phaseValues = new Set<string>(Object.values(RolloutPhase));
const stepValues = new Set<string>(Object.values(RolloutStep));

export interface DatabaseGenerationIdentity {
  readonly renderResourceId: string;
  readonly internalHostname: string;
  readonly databaseName: string;
  readonly systemIdentifier: string;
  readonly majorVersion: 16 | 17;
  readonly recoveryWitnessSha256: string;
}

export interface ReleaseExecutionIdentity {
  readonly organization: string;
  readonly controlRepository: string;
  readonly workflowPath: string;
  readonly workflowRef: string;
  readonly event: "workflow_dispatch";
  readonly actor: string;
  readonly runId: string;
  readonly runAttempt: number;
  readonly roleJobName: string;
  readonly cutoverJobName: string;
}

export type RunnerProvenance =
  | {
      readonly kind: "git";
      readonly deployId: string;
      readonly commitSha: string;
    }
  | {
      readonly kind: "image";
      readonly deployId: string;
      readonly imageSha: string;
    };

export interface RunnerIdentity {
  readonly organization: string;
  readonly repository: string;
  readonly workflowPath: string;
  readonly workflowRef: string;
  readonly event: "workflow_dispatch";
  readonly actor: string;
  readonly runId: string;
  readonly runAttempt: number;
  readonly workflowJobId: string;
  readonly workflowJobName: string;
  readonly commitSha: string;
  readonly runnerName: string;
  readonly cleanupCanary: string;
  readonly renderJobId: string;
  readonly baseServiceId: string;
  readonly runnerGroupId: number;
  readonly runnerGroupName: string;
  readonly githubRunnerId?: number;
  readonly githubRunnerLabels?: readonly string[];
  readonly uniqueRunnerLabel: string;
  readonly workFolder: string;
  readonly planId?: string;
  readonly provenance: RunnerProvenance;
  readonly imageAttestation?: {
    readonly subjectDigest: string;
    readonly sourceCommitSha: string;
    readonly statementSha256: string;
    readonly builderId: string;
  };
}

export interface StepObservation<T = unknown> {
  readonly step: RolloutStep;
  readonly observedAt: string;
  readonly facts: T;
  readonly provider?: {
    readonly renderJobId?: string;
    readonly renderDeployId?: string;
    readonly renderDeployIds?: readonly string[];
    readonly renderServiceIds?: readonly string[];
    /** Services with rollout-owned suspension evidence, not the full inventory. */
    readonly renderMutatedServiceIds?: readonly string[];
    readonly githubWorkflowJobId?: string;
    readonly targetSwitchFenceNonce?: string;
    readonly targetSwitchFenceVersion?: number;
    readonly serviceRecoveryManifestSha256?: string;
    readonly targetServiceContractSha256?: string;
  };
}

export interface StepReceipt {
  readonly step: RolloutStep;
  readonly receiptId: string;
  readonly observedAt: string;
  readonly rolloutId: string;
  readonly expectedCommitSha: string;
  readonly runId: string;
  readonly runAttempt: number;
  readonly sourceSystemIdentifier: string;
  readonly targetSystemIdentifier: string;
  readonly provider: StepObservation["provider"];
  readonly observationSha256: string;
  readonly previousReceiptSha256: string;
  readonly receiptSha256: string;
}

export interface ActivationReceipt extends StepReceipt {
  readonly step: typeof RolloutStep.ActivateTargetGeneration;
  readonly canonicalPrivilegesSha256: string;
  readonly catalogFactsSha256: string;
  readonly preactivationCatalogPolicySha256: string;
  readonly activatedCatalogPolicySha256: string;
  readonly transactionId: string;
  readonly firstWriteReceiptSha256: string;
  readonly firstWriteBoundary: true;
  readonly postgresMajor: 17;
  readonly migrationChecksum: string;
  readonly transitionSha256: string;
  readonly postManifestIdentity: string;
  readonly permitEpoch: number;
  readonly permitNonce: string;
  readonly targetDeployIds: readonly string[];
  readonly beforePrincipalInventorySha256: string;
  readonly beforePrincipalPolicySha256: string;
  readonly activatedPrincipalInventorySha256: string;
  readonly activatedPrincipalPolicySha256: string;
}

export interface ReleaseMigrationReceipt extends StepReceipt {
  readonly step: typeof RolloutStep.RunReleaseMigration;
  readonly migrationChecksum: string;
  readonly transitionSha256: string;
  readonly migrationArtifactDigest: string;
  readonly migrationBundleSha256: string;
  readonly preManifestIdentity: string;
  readonly postManifestIdentity: string;
  readonly postCatalogDigest: string;
  readonly permitEpoch: number;
  readonly permitNonce: string;
}

export interface ActivationAuthorization {
  readonly rolloutId: string;
  readonly expectedCommitSha: string;
  readonly postgresMajor: 17;
  readonly migrationChecksum: string;
  readonly transitionSha256: string;
  readonly postManifestIdentity: string;
  readonly epoch: number;
  readonly nonce: string;
  readonly sourceSystemIdentifier: string;
  readonly targetSystemIdentifier: string;
  readonly previousReceiptSha256: string;
  readonly targetDeployIds: readonly string[];
  readonly authorizedAt: string;
}

export interface TargetSwitchFence {
  readonly schemaVersion: 1;
  readonly rolloutId: string;
  readonly expectedCommitSha: string;
  readonly runId: string;
  readonly runAttempt: number;
  readonly sourceSystemIdentifier: string;
  readonly targetSystemIdentifier: string;
  readonly previousReceiptSha256: string;
  readonly nonce: string;
  readonly version: number;
  readonly fencedAt: string;
}

export interface ReleaseRollout {
  readonly schemaVersion: 3;
  readonly rolloutId: string;
  readonly expectedCommitSha: string;
  readonly execution: ReleaseExecutionIdentity;
  readonly phase: RolloutPhase;
  readonly source: DatabaseGenerationIdentity;
  readonly target: DatabaseGenerationIdentity;
  readonly migrationTransition: ReleaseMigrationTransitionV1;
  readonly targetManifestPhase: TargetManifestPhase;
  readonly migrationPermit?: ReleaseMigrationPermit;
  readonly receipts: readonly StepReceipt[];
  readonly activated: boolean;
  readonly activationUncertain: boolean;
  readonly sourcePermanentlyIneligible: boolean;
  readonly activationReceipt?: ActivationReceipt;
}

export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function assertIdentifier(value: string, label: string): void {
  if (!identifierPattern.test(value)) throw new Error(`${label}_invalid`);
}

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

export function assertGenerationIdentity(
  value: DatabaseGenerationIdentity,
  major: 16 | 17,
): void {
  assertIdentifier(value.renderResourceId, "render_resource_id");
  if (!/^[a-z0-9.-]+\.internal$/u.test(value.internalHostname))
    throw new Error("database_internal_hostname_invalid");
  assertIdentifier(value.databaseName, "database_name");
  if (!/^[0-9]+$/u.test(value.systemIdentifier))
    throw new Error("database_system_identifier_invalid");
  if (value.majorVersion !== major)
    throw new Error("database_generation_major_version_mismatch");
  if (!/^[a-f0-9]{64}$/u.test(value.recoveryWitnessSha256))
    throw new Error("database_recovery_witness_invalid");
}

function assertExecution(value: ReleaseExecutionIdentity, sha: string): void {
  assertIdentifier(value.organization, "release_organization");
  if (
    value.controlRepository !==
    `${value.organization}/${value.controlRepository.split("/")[1] ?? ""}`
  )
    throw new Error("release_control_repository_not_organization_owned");
  if (
    !/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/u.test(value.workflowPath)
  )
    throw new Error("release_workflow_path_invalid");
  if (
    value.workflowRef !== `refs/heads/main` ||
    value.event !== "workflow_dispatch"
  )
    throw new Error("release_workflow_source_invalid");
  if (
    !/^[1-9][0-9]*$/u.test(value.runId) ||
    !Number.isSafeInteger(value.runAttempt) ||
    value.runAttempt !== 1
  )
    throw new Error("release_run_retry_forbidden");
  assertIdentifier(value.actor, "release_actor");
  assertIdentifier(value.roleJobName, "release_role_job_name");
  assertIdentifier(value.cutoverJobName, "release_cutover_job_name");
  if (value.roleJobName === value.cutoverJobName)
    throw new Error("release_runner_jobs_not_distinct");
  if (!shaPattern.test(sha)) throw new Error("release_commit_invalid");
}

export function createReleaseRollout(
  input: Omit<
    ReleaseRollout,
    | "schemaVersion"
    | "phase"
    | "receipts"
    | "activated"
    | "activationUncertain"
    | "sourcePermanentlyIneligible"
    | "targetManifestPhase"
    | "migrationPermit"
  >,
): ReleaseRollout {
  assertIdentifier(input.rolloutId, "rollout_id");
  assertExecution(input.execution, input.expectedCommitSha);
  assertGenerationIdentity(input.source, 16);
  assertGenerationIdentity(input.target, 17);
  if (
    input.source.renderResourceId === input.target.renderResourceId ||
    input.source.systemIdentifier === input.target.systemIdentifier
  )
    throw new Error("database_generations_not_distinct");
  assertReleaseMigrationTransitionIntegrity(input.migrationTransition);
  if (input.migrationTransition.commitSha !== input.expectedCommitSha)
    throw new Error("release_migration_transition_commit_mismatch");
  return Object.freeze({
    ...input,
    schemaVersion: 3,
    phase: RolloutPhase.Planned,
    receipts: Object.freeze([]),
    activated: false,
    activationUncertain: false,
    sourcePermanentlyIneligible: false,
    targetManifestPhase: TargetManifestPhase.PreMigration,
  });
}

function receiptDigest(receipt: Omit<StepReceipt, "receiptSha256">): string {
  return `sha256:${sha256Canonical(receipt)}`;
}

function record(value: unknown, error: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(error);
  return value as Record<string, unknown>;
}

function array(value: unknown, error: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(error);
  return value;
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function assertDigest(value: unknown, error: string): void {
  if (!digestPattern.test(String(value))) throw new Error(error);
}

function assertStepFacts(
  rollout: ReleaseRollout,
  observation: StepObservation,
): void {
  const facts =
    observation.step === RolloutStep.StageTargetServices ||
    observation.step === RolloutStep.ResumeTargetServices
      ? {}
      : record(observation.facts, "rollout_observation_facts_invalid");
  switch (observation.step) {
    case RolloutStep.ClaimRollout:
      if (facts.durableClaim !== true)
        throw new Error("rollout_durable_claim_unproven");
      break;
    case RolloutStep.VerifyProtectedEnvironment:
      if (
        facts.organization !== rollout.execution.organization ||
        facts.repository !== rollout.execution.controlRepository ||
        facts.workflowPath !== rollout.execution.workflowPath ||
        facts.workflowRef !== rollout.execution.workflowRef ||
        facts.sha !== rollout.expectedCommitSha ||
        facts.event !== rollout.execution.event ||
        facts.actor !== rollout.execution.actor ||
        facts.runId !== rollout.execution.runId ||
        facts.runAttempt !== 1 ||
        !Array.isArray(facts.environments) ||
        facts.environments.length < 1 ||
        facts.environments.some((item) => {
          const environment = record(
            item,
            "protected_environment_observation_invalid",
          );
          return (
            typeof environment.name !== "string" ||
            !Number.isSafeInteger(environment.requiredReviewerCount) ||
            Number(environment.requiredReviewerCount) < 1 ||
            environment.preventSelfReview !== true ||
            environment.protectedBranchesOnly !== true
          );
        }) ||
        !Number.isSafeInteger(facts.runnerGroupId) ||
        Number(facts.runnerGroupId) < 1
      )
        throw new Error("protected_environment_observation_invalid");
      assertDigest(
        facts.observationSha256,
        "protected_environment_observation_invalid",
      );
      break;
    case RolloutStep.FreezeProviderServices: {
      const services = array(
        facts.services,
        "source_writer_suspension_observation_invalid",
      );
      if (
        facts.complete !== true ||
        facts.discoveryScope !==
          "provider_hint_only_database_fence_authoritative" ||
        services.length === 0 ||
        services.some((item) => {
          const service = record(
            item,
            "source_writer_suspension_observation_invalid",
          );
          return (
            typeof service.serviceId !== "string" ||
            service.suspended !== true ||
            !validTimestamp(service.observedAt) ||
            typeof service.latestSuccessfulDeployId !== "string"
          );
        }) ||
        canonicalJson(observation.provider?.renderServiceIds) !==
          canonicalJson(
            services.map(
              (item) =>
                record(item, "source_writer_suspension_observation_invalid")
                  .serviceId,
            ),
          ) ||
        canonicalJson(observation.provider?.renderDeployIds) !==
          canonicalJson(
            services.map(
              (item) =>
                record(item, "source_writer_suspension_observation_invalid")
                  .latestSuccessfulDeployId,
            ),
          ) ||
        !Array.isArray(observation.provider?.renderMutatedServiceIds) ||
        observation.provider.renderMutatedServiceIds.some(
          (serviceId) =>
            !services.some(
              (item) =>
                record(item, "source_writer_suspension_observation_invalid")
                  .serviceId === serviceId,
            ),
        ) ||
        new Set(observation.provider.renderMutatedServiceIds).size !==
          observation.provider.renderMutatedServiceIds.length
      )
        throw new Error("source_writer_suspension_observation_invalid");
      break;
    }
    case RolloutStep.ProvisionRoleRunner:
    case RolloutStep.ProvisionCutoverRunner: {
      const lifecycle =
        observation.step === RolloutStep.ProvisionRoleRunner
          ? "role"
          : "cutover";
      const identity = facts as unknown as RunnerIdentity;
      assertRunnerIdentity(identity, rollout, lifecycle);
      if (
        observation.provider?.renderJobId !== identity.renderJobId ||
        observation.provider?.renderDeployId !== identity.provenance.deployId ||
        observation.provider?.githubWorkflowJobId !== identity.workflowJobId
      )
        throw new Error("runner_provider_binding_invalid");
      break;
    }
    case RolloutStep.CaptureSourceBackup: {
      const backup = record(facts.backup, "source_backup_observation_invalid");
      if (
        backup.renderResourceId !== rollout.source.renderResourceId ||
        backup.internalHostname !== rollout.source.internalHostname ||
        backup.databaseName !== rollout.source.databaseName ||
        backup.systemIdentifier !== rollout.source.systemIdentifier ||
        facts.dumpSha256 !== backup.dumpSha256 ||
        !validTimestamp(backup.capturedAt) ||
        typeof backup.lsn !== "string" ||
        backup.recoveryStatus !== "AVAILABLE"
      )
        throw new Error("source_backup_observation_invalid");
      assertDigest(facts.dumpSha256, "source_backup_observation_invalid");
      assertDigest(
        backup.externalWitnessSha256,
        "source_backup_observation_invalid",
      );
      break;
    }
    case RolloutStep.QuiesceSource: {
      const services = array(
        facts.writerServices,
        "source_quiescence_observation_invalid",
      );
      const series = array(
        facts.stabilizationSeries,
        "source_quiescence_observation_invalid",
      );
      const denied = array(
        facts.reconnectDeniedRoles,
        "source_quiescence_observation_invalid",
      );
      const fence = record(
        facts.fence,
        "source_quiescence_observation_invalid",
      );
      if (
        facts.complete !== true ||
        services.length === 0 ||
        services.some(
          (item) =>
            record(item, "source_quiescence_observation_invalid").suspended !==
            true,
        ) ||
        series.length < 3 ||
        series.some((count) => count !== 0) ||
        denied.length === 0 ||
        denied.some((role) => typeof role !== "string") ||
        new Set(denied).size !== denied.length ||
        fence.version !== 1 ||
        fence.lifecycle !== "active" ||
        fence.sourceSystemIdentifier !== rollout.source.systemIdentifier ||
        typeof fence.fenceId !== "string" ||
        typeof fence.rolloutId !== "string" ||
        fence.rolloutId !== rollout.rolloutId ||
        typeof fence.authorityPrincipal !== "string" ||
        !validTimestamp(fence.observedAt)
      )
        throw new Error("source_quiescence_observation_invalid");
      assertDigest(facts.aclSha256, "source_quiescence_observation_invalid");
      for (const key of [
        "beforeInventorySha256",
        "fencedInventorySha256",
        "beforePolicySha256",
        "fencedPolicySha256",
        "priorConnectAclSha256",
      ])
        assertDigest(fence[key], "source_quiescence_observation_invalid");
      break;
    }
    case RolloutStep.CopyDatabaseGeneration:
      if (
        facts.ownershipRestored !== false ||
        facts.privilegesRestored !== false
      )
        throw new Error("database_copy_observation_invalid");
      assertDigest(facts.dumpSha256, "database_copy_observation_invalid");
      break;
    case RolloutStep.VerifyDataEquivalence: {
      const tables = array(
        facts.tables,
        "database_equivalence_observation_invalid",
      );
      const catalogs = record(
        facts.catalogSha256,
        "database_equivalence_observation_invalid",
      );
      const principals = record(
        facts.effectivePrincipals,
        "database_equivalence_observation_invalid",
      );
      if (
        facts.equivalent !== true ||
        facts.streamingHash !== true ||
        Number(facts.maxProcessBufferBytes) > 8 * 1024 * 1024 ||
        tables.length === 0 ||
        tables.some((item) => {
          const table = record(
            item,
            "database_equivalence_observation_invalid",
          );
          return (
            table.sourceRows !== table.targetRows ||
            table.sourceSha256 !== table.targetSha256 ||
            !digestPattern.test(String(table.sourceSha256))
          );
        }) ||
        Object.keys(catalogs).length !== 7 ||
        Object.values(catalogs).some(
          (value) => !digestPattern.test(String(value)),
        ) ||
        principals.stable !== true
      )
        throw new Error("database_equivalence_observation_invalid");
      for (const key of [
        "sourceInventorySha256",
        "sourcePolicySha256",
        "targetInventorySha256",
        "targetPolicySha256",
      ])
        assertDigest(
          principals[key],
          "database_equivalence_observation_invalid",
        );
      break;
    }
    case RolloutStep.BootstrapTargetRoles:
      if (
        facts.version !== 2 ||
        facts.status !== "succeeded" ||
        facts.commit !== rollout.expectedCommitSha ||
        facts.imageDigest !== rollout.migrationTransition.releaseImageDigest ||
        !Array.isArray(facts.roles) ||
        facts.roles.length < 4
      )
        throw new Error("target_role_bootstrap_observation_invalid");
      assertDigest(
        facts.imageDigest,
        "target_role_bootstrap_observation_invalid",
      );
      break;
    case RolloutStep.CleanupRoleRunner:
    case RolloutStep.CleanupCutoverRunner: {
      const provider = record(
        facts.provider,
        "runner_cleanup_observation_invalid",
      );
      const runner = record(facts.runner, "runner_cleanup_observation_invalid");
      if (
        !["succeeded", "failed", "canceled"].includes(
          String(provider.status),
        ) ||
        provider.id !== observation.provider?.renderJobId ||
        runner.listenerStopped !== true ||
        runner.workspaceRemoved !== true ||
        runner.credentialProcessGone !== true ||
        typeof runner.canary !== "string" ||
        !String(runner.canary).startsWith(`rr-cleanup:${rollout.rolloutId}:`) ||
        !validTimestamp(runner.observedAt)
      )
        throw new Error("runner_cleanup_observation_invalid");
      break;
    }
    case RolloutStep.RunReleaseMigration:
      if (
        rollout.targetManifestPhase !== TargetManifestPhase.Migrating ||
        !rollout.migrationPermit ||
        facts.version !== 3 ||
        facts.status !== "succeeded" ||
        facts.migrationStatus !== "succeeded" ||
        facts.preflightStatus !== "passed" ||
        facts.aclGateState !== "closed" ||
        facts.commit !== rollout.expectedCommitSha ||
        facts.transitionSha256 !==
          rollout.migrationTransition.transitionSha256 ||
        facts.migrationArtifactDigest !==
          rollout.migrationTransition.migrationArtifactDigest ||
        facts.migrationBundleSha256 !==
          rollout.migrationTransition.migrationBundleSha256 ||
        facts.preManifestIdentity !==
          rollout.migrationTransition.preManifestIdentity ||
        facts.postManifestIdentity !==
          rollout.migrationTransition.postManifestIdentity ||
        facts.postCatalogDigest !==
          rollout.migrationTransition.postCatalogDigest ||
        facts.permitEpoch !== rollout.migrationPermit.epoch ||
        facts.permitNonce !== rollout.migrationPermit.nonce ||
        facts.targetSystemIdentifier !== rollout.target.systemIdentifier ||
        facts.targetRecoveryWitnessSha256 !==
          rollout.target.recoveryWitnessSha256 ||
        !Array.isArray(facts.roles) ||
        facts.roles.length < 4
      )
        throw new Error("release_migration_observation_invalid");
      assertDigest(facts.imageDigest, "release_migration_observation_invalid");
      break;
    case RolloutStep.StageTargetServices: {
      const services = array(
        observation.facts,
        "target_stage_observation_invalid",
      );
      if (
        services.length === 0 ||
        services.some((item) => {
          const service = record(item, "target_stage_observation_invalid");
          const provenance = record(
            service.provenance,
            "target_stage_observation_invalid",
          );
          const postcondition = service.servicePostcondition;
          return (
            service.suspended !== true ||
            typeof service.deployId !== "string" ||
            !digestPattern.test(String(service.envSha256)) ||
            !/^[a-f0-9]{64}$/u.test(String(service.recoveryWitnessSha256)) ||
            !isNormalizedServicePostcondition(postcondition) ||
            postcondition.serviceId !== service.serviceId ||
            postcondition.suspended !== true ||
            postcondition.environmentSha256 !== service.envSha256 ||
            (provenance.kind === "git"
              ? provenance.commitSha !== rollout.expectedCommitSha
              : provenance.kind !== "image" ||
                !digestPattern.test(String(provenance.imageSha)))
          );
        }) ||
        canonicalJson(observation.provider?.renderServiceIds) !==
          canonicalJson(
            services.map(
              (item) =>
                record(item, "target_stage_observation_invalid").serviceId,
            ),
          ) ||
        canonicalJson(observation.provider?.renderDeployIds) !==
          canonicalJson(
            services.map(
              (item) =>
                record(item, "target_stage_observation_invalid").deployId,
            ),
          ) ||
        !digestPattern.test(
          String(observation.provider?.serviceRecoveryManifestSha256),
        ) ||
        !digestPattern.test(
          String(observation.provider?.targetServiceContractSha256),
        )
      )
        throw new Error("target_stage_observation_invalid");
      break;
    }
    case RolloutStep.ActivateTargetGeneration:
      if (
        facts.rolloutId !== rollout.rolloutId ||
        facts.sourceSystemIdentifier !== rollout.source.systemIdentifier ||
        facts.targetSystemIdentifier !== rollout.target.systemIdentifier ||
        facts.firstWriteBoundary !== true ||
        !/^[0-9]+$/u.test(String(facts.transactionId))
      )
        throw new Error("activation_observation_invalid");
      for (const key of [
        "canonicalPrivilegesSha256",
        "catalogFactsSha256",
        "preactivationCatalogPolicySha256",
        "activatedCatalogPolicySha256",
        "firstWriteReceiptSha256",
        "observationSha256",
        "beforePrincipalInventorySha256",
        "beforePrincipalPolicySha256",
        "activatedPrincipalInventorySha256",
        "activatedPrincipalPolicySha256",
      ])
        assertDigest(facts[key], "activation_observation_invalid");
      break;
    case RolloutStep.ResumeTargetServices: {
      const services = array(
        observation.facts,
        "target_resume_observation_invalid",
      );
      if (
        services.length === 0 ||
        services.some((item) => {
          const service = record(item, "target_resume_observation_invalid");
          const postcondition = service.servicePostcondition;
          return (
            service.resumed !== true ||
            typeof service.deployId !== "string" ||
            !isNormalizedServicePostcondition(postcondition) ||
            postcondition.serviceId !== service.serviceId ||
            postcondition.suspended !== false
          );
        }) ||
        canonicalJson(observation.provider?.renderServiceIds) !==
          canonicalJson(
            services.map(
              (item) =>
                record(item, "target_resume_observation_invalid").serviceId,
            ),
          ) ||
        canonicalJson(observation.provider?.renderDeployIds) !==
          canonicalJson(
            services.map(
              (item) =>
                record(item, "target_resume_observation_invalid").deployId,
            ),
          )
      )
        throw new Error("target_resume_observation_invalid");
      break;
    }
    case RolloutStep.VerifyLiveCanary:
      {
        const proofs = Array.isArray(facts.runtimeWitnessProofs)
          ? facts.runtimeWitnessProofs
          : [];
        const serviceFacts = Array.isArray(facts.serviceFacts)
          ? facts.serviceFacts
          : [];
        const requestedAt = Date.parse(String(facts.requestedAt));
        const observedAt = Date.parse(String(facts.observedAt));
        const generation = record(
          facts.expectedGeneration,
          "live_canary_observation_invalid",
        );
        if (
          facts.commitSha !== rollout.expectedCommitSha ||
          facts.databaseSystemIdentifier !== rollout.target.systemIdentifier ||
          !/^[a-f0-9]{64}$/u.test(String(facts.recoveryWitnessSha256)) ||
          !/^[a-f0-9]{48}$/u.test(String(facts.nonce)) ||
          !Number.isFinite(requestedAt) ||
          !Number.isFinite(observedAt) ||
          observedAt < requestedAt ||
          observedAt > requestedAt + 10_000 ||
          proofs.length !== 3 ||
          serviceFacts.length !== 3 ||
          generation.systemIdentifier !== rollout.target.systemIdentifier ||
          generation.recoveryWitnessSha256 !== facts.recoveryWitnessSha256 ||
          proofs.some((item, index) => {
            const proof = record(item, "live_canary_observation_invalid");
            const service = record(
              serviceFacts[index],
              "live_canary_observation_invalid",
            );
            const provedAt = Date.parse(String(proof.provedAt));
            return (
              proof.runtimeRole !== ["api", "web", "worker"][index] ||
              proof.databaseRole !==
                `reviewrouter_${["api", "web", "worker"][index]}` ||
              service.runtimeRole !== ["api", "web", "worker"][index] ||
              typeof service.deployId !== "string" ||
              !/^[a-f0-9]{40,64}$/u.test(
                String(service.deploymentProvenance),
              ) ||
              !digestPattern.test(String(service.servicePostconditionSha256)) ||
              proof.nonce !== facts.nonce ||
              proof.requestedAt !== facts.requestedAt ||
              proof.serviceId !== service.serviceId ||
              proof.deployId !== service.deployId ||
              proof.deploymentProvenance !== service.deploymentProvenance ||
              proof.servicePostconditionSha256 !==
                service.servicePostconditionSha256 ||
              proof.systemIdentifier !== rollout.target.systemIdentifier ||
              proof.releaseCommitSha !== rollout.expectedCommitSha ||
              proof.recoveryWitnessSha256 !== facts.recoveryWitnessSha256 ||
              !Number.isFinite(provedAt) ||
              provedAt < requestedAt ||
              provedAt > requestedAt + 10_000
            );
          }) ||
          facts.writeReadRoundTrip !== true
        )
          throw new Error("live_canary_observation_invalid");
      }
      break;
    case RolloutStep.VerifyTrustedRollout:
      assertDigest(
        facts.evidenceSha256,
        "trusted_evidence_observation_invalid",
      );
      break;
    case RolloutStep.BeginCompensation:
      if (
        facts.activationBoundary !== "before" ||
        facts.sourceSystemIdentifier !== rollout.source.systemIdentifier
      )
        throw new Error("compensation_begin_observation_invalid");
      break;
    case RolloutStep.EffectCompensation: {
      const database = record(
        facts.databaseWitness,
        "compensation_effect_observation_invalid",
      );
      const provider = record(
        facts.providerWitness,
        "compensation_effect_observation_invalid",
      );
      if (
        database.systemIdentifier !== rollout.source.systemIdentifier ||
        database.sourceWritesRestored !== true ||
        provider.resumed !== true ||
        !Array.isArray(provider.serviceIds) ||
        provider.serviceIds.length === 0
      )
        throw new Error("compensation_effect_observation_invalid");
      assertDigest(
        database.aclSha256,
        "compensation_effect_observation_invalid",
      );
      break;
    }
    case RolloutStep.CompleteCompensation:
      if (
        facts.independentWitnesses !== true ||
        facts.activationBoundary !== "before"
      )
        throw new Error("compensation_complete_observation_invalid");
      break;
    default:
      throw new Error("rollout_observation_step_not_authorized");
  }
}

function assertObservation(
  rollout: ReleaseRollout,
  observation: StepObservation,
): void {
  parseRolloutStep(observation.step);
  if (new Date(observation.observedAt).toISOString() !== observation.observedAt)
    throw new Error("rollout_observation_timestamp_invalid");
  const serialized = canonicalJson(observation.facts);
  if (
    /postgres(?:ql)?:\/\/|BEGIN [A-Z ]*PRIVATE KEY|gh[opsu]_[A-Za-z0-9]/u.test(
      serialized,
    )
  )
    throw new Error("rollout_observation_contains_secret");
  assertStepFacts(rollout, observation);
}

/** Domain policy entry point. Application use cases are the only production callers. */
export function transitionFromObservation(
  rollout: ReleaseRollout,
  observation: StepObservation,
): ReleaseRollout {
  assertObservation(rollout, observation);
  const replay = rollout.receipts.find(
    (item) => item.step === observation.step,
  );
  if (replay) throw new Error("rollout_receipt_replay_forbidden");
  const transition = orderedTransitions.find(
    ([from, step]) => from === rollout.phase && step === observation.step,
  );
  if (!transition) throw new Error("rollout_transition_stale_or_out_of_order");
  const observationSha256 = `sha256:${sha256Canonical(observation.facts)}`;
  const previousReceiptSha256 =
    rollout.receipts.at(-1)?.receiptSha256 ?? `sha256:${"0".repeat(64)}`;
  const base: Omit<StepReceipt, "receiptSha256"> = {
    step: observation.step,
    receiptId: `${rollout.rolloutId}:${observation.step}:${rollout.receipts.length + 1}`,
    observedAt: observation.observedAt,
    rolloutId: rollout.rolloutId,
    expectedCommitSha: rollout.expectedCommitSha,
    runId: rollout.execution.runId,
    runAttempt: rollout.execution.runAttempt,
    sourceSystemIdentifier: rollout.source.systemIdentifier,
    targetSystemIdentifier: rollout.target.systemIdentifier,
    provider: observation.provider,
    observationSha256,
    previousReceiptSha256,
  };
  let receipt: StepReceipt;
  if (observation.step === RolloutStep.RunReleaseMigration) {
    const facts = observation.facts as Record<string, unknown>;
    const migrationBase = {
      ...base,
      step: RolloutStep.RunReleaseMigration,
      migrationChecksum: rollout.migrationTransition.postManifestIdentity,
      transitionSha256: String(facts.transitionSha256),
      migrationArtifactDigest: String(facts.migrationArtifactDigest),
      migrationBundleSha256: String(facts.migrationBundleSha256),
      preManifestIdentity: String(facts.preManifestIdentity),
      postManifestIdentity: String(facts.postManifestIdentity),
      postCatalogDigest: String(facts.postCatalogDigest),
      permitEpoch: Number(facts.permitEpoch),
      permitNonce: String(facts.permitNonce),
    };
    receipt = {
      ...migrationBase,
      receiptSha256: `sha256:${sha256Canonical(migrationBase)}`,
    } as ReleaseMigrationReceipt;
  } else if (observation.step === RolloutStep.ActivateTargetGeneration) {
    const facts = observation.facts as Record<string, unknown>;
    if (
      facts.firstWriteBoundary !== true ||
      !digestPattern.test(String(facts.canonicalPrivilegesSha256)) ||
      !digestPattern.test(String(facts.catalogFactsSha256)) ||
      !digestPattern.test(String(facts.preactivationCatalogPolicySha256)) ||
      !digestPattern.test(String(facts.activatedCatalogPolicySha256)) ||
      !digestPattern.test(String(facts.firstWriteReceiptSha256)) ||
      !/^[0-9]+$/u.test(String(facts.transactionId)) ||
      facts.postgresMajor !== 17 ||
      !digestPattern.test(String(facts.migrationChecksum)) ||
      !digestPattern.test(String(facts.transitionSha256)) ||
      !digestPattern.test(String(facts.postManifestIdentity)) ||
      !Number.isSafeInteger(facts.permitEpoch) ||
      Number(facts.permitEpoch) < 1 ||
      !/^[a-f0-9]{32}$/u.test(String(facts.permitNonce)) ||
      !Array.isArray(facts.targetDeployIds) ||
      facts.targetDeployIds.length < 1
    )
      throw new Error("activation_observation_invalid");
    const activationBase = {
      ...base,
      step: RolloutStep.ActivateTargetGeneration,
      canonicalPrivilegesSha256: String(facts.canonicalPrivilegesSha256),
      catalogFactsSha256: String(facts.catalogFactsSha256),
      preactivationCatalogPolicySha256: String(
        facts.preactivationCatalogPolicySha256,
      ),
      activatedCatalogPolicySha256: String(facts.activatedCatalogPolicySha256),
      transactionId: String(facts.transactionId),
      firstWriteReceiptSha256: String(facts.firstWriteReceiptSha256),
      firstWriteBoundary: true as const,
      postgresMajor: 17 as const,
      migrationChecksum: String(facts.migrationChecksum),
      transitionSha256: String(facts.transitionSha256),
      postManifestIdentity: String(facts.postManifestIdentity),
      permitEpoch: Number(facts.permitEpoch),
      permitNonce: String(facts.permitNonce),
      targetDeployIds: Object.freeze(
        (facts.targetDeployIds as unknown[]).map(String),
      ),
      beforePrincipalInventorySha256: String(
        facts.beforePrincipalInventorySha256,
      ),
      beforePrincipalPolicySha256: String(facts.beforePrincipalPolicySha256),
      activatedPrincipalInventorySha256: String(
        facts.activatedPrincipalInventorySha256,
      ),
      activatedPrincipalPolicySha256: String(
        facts.activatedPrincipalPolicySha256,
      ),
    };
    receipt = {
      ...activationBase,
      receiptSha256: `sha256:${sha256Canonical(activationBase)}`,
    } as ActivationReceipt;
  } else receipt = { ...base, receiptSha256: receiptDigest(base) };
  const activation = observation.step === RolloutStep.ActivateTargetGeneration;
  return Object.freeze({
    ...rollout,
    phase: transition[2],
    receipts: Object.freeze([...rollout.receipts, Object.freeze(receipt)]),
    activated: rollout.activated || activation,
    sourcePermanentlyIneligible:
      rollout.sourcePermanentlyIneligible || activation,
    targetManifestPhase:
      observation.step === RolloutStep.RunReleaseMigration
        ? TargetManifestPhase.PostMigration
        : rollout.targetManifestPhase,
    ...(activation ? { activationReceipt: receipt as ActivationReceipt } : {}),
  });
}

export function beginReleaseMigrationAttempt(
  rollout: ReleaseRollout,
  permit: ReleaseMigrationPermit,
): ReleaseRollout {
  const previousReceiptSha256 =
    rollout.receipts.at(-1)?.receiptSha256 ?? `sha256:${"0".repeat(64)}`;
  if (
    rollout.phase !== RolloutPhase.CutoverRunnerProvisioned ||
    (rollout.targetManifestPhase !== TargetManifestPhase.PreMigration &&
      rollout.targetManifestPhase !== TargetManifestPhase.Migrating) ||
    permit.schemaVersion !== 1 ||
    permit.rolloutId !== rollout.rolloutId ||
    permit.runId !== rollout.execution.runId ||
    permit.runAttempt !== rollout.execution.runAttempt ||
    permit.targetSystemIdentifier !== rollout.target.systemIdentifier ||
    permit.targetRecoveryWitnessSha256 !==
      rollout.target.recoveryWitnessSha256 ||
    permit.transitionSha256 !== rollout.migrationTransition.transitionSha256 ||
    permit.expectedPreviousReceiptSha256 !== previousReceiptSha256 ||
    !Number.isSafeInteger(permit.epoch) ||
    permit.epoch < 1 ||
    !/^[a-f0-9]{32}$/u.test(permit.nonce)
  )
    throw new Error("release_migration_permit_invalid");
  if (
    rollout.migrationPermit &&
    canonicalJson(rollout.migrationPermit) !== canonicalJson(permit)
  )
    throw new Error("release_migration_permit_replay_conflict");
  return Object.freeze({
    ...rollout,
    targetManifestPhase: TargetManifestPhase.Migrating,
    migrationPermit: Object.freeze({ ...permit }),
  });
}

export function recoverCompletedReleaseMigration(
  rollout: ReleaseRollout,
  permit: ReleaseMigrationPermit,
  receipt: ReleaseMigrationReceipt,
): ReleaseRollout {
  const migrating = beginReleaseMigrationAttempt(rollout, permit);
  const previousReceiptSha256 =
    rollout.receipts.at(-1)?.receiptSha256 ?? `sha256:${"0".repeat(64)}`;
  const { receiptSha256, ...unsigned } = receipt;
  if (
    receipt.step !== RolloutStep.RunReleaseMigration ||
    receipt.rolloutId !== rollout.rolloutId ||
    receipt.expectedCommitSha !== rollout.expectedCommitSha ||
    receipt.runId !== rollout.execution.runId ||
    receipt.runAttempt !== rollout.execution.runAttempt ||
    receipt.sourceSystemIdentifier !== rollout.source.systemIdentifier ||
    receipt.targetSystemIdentifier !== rollout.target.systemIdentifier ||
    receipt.previousReceiptSha256 !== previousReceiptSha256 ||
    receipt.transitionSha256 !== rollout.migrationTransition.transitionSha256 ||
    receipt.migrationChecksum !==
      rollout.migrationTransition.postManifestIdentity ||
    receipt.migrationArtifactDigest !==
      rollout.migrationTransition.migrationArtifactDigest ||
    receipt.migrationBundleSha256 !==
      rollout.migrationTransition.migrationBundleSha256 ||
    receipt.preManifestIdentity !==
      rollout.migrationTransition.preManifestIdentity ||
    receipt.postManifestIdentity !==
      rollout.migrationTransition.postManifestIdentity ||
    receipt.postCatalogDigest !==
      rollout.migrationTransition.postCatalogDigest ||
    receipt.permitEpoch !== permit.epoch ||
    receipt.permitNonce !== permit.nonce ||
    receiptSha256 !== `sha256:${sha256Canonical(unsigned)}`
  )
    throw new Error("release_migration_receipt_recovery_invalid");
  return Object.freeze({
    ...migrating,
    phase: RolloutPhase.MigrationApplied,
    targetManifestPhase: TargetManifestPhase.PostMigration,
    receipts: Object.freeze([...rollout.receipts, Object.freeze(receipt)]),
  });
}

export function transitionFailure(
  rollout: ReleaseRollout,
  kind: "definite_pre_activation" | "activation_uncertain",
): ReleaseRollout {
  if (kind === "activation_uncertain" || rollout.activated)
    return Object.freeze({
      ...rollout,
      phase: RolloutPhase.ActivationUncertain,
      activationUncertain: true,
      sourcePermanentlyIneligible: true,
    });
  return Object.freeze({
    ...rollout,
    phase: RolloutPhase.PreActivationFailed,
    targetManifestPhase:
      rollout.targetManifestPhase === TargetManifestPhase.Migrating
        ? TargetManifestPhase.Quarantined
        : rollout.targetManifestPhase,
  });
}

export function beginCompensation(rollout: ReleaseRollout): ReleaseRollout {
  if (
    rollout.phase !== RolloutPhase.PreActivationFailed ||
    rollout.sourcePermanentlyIneligible
  )
    throw new Error("source_compensation_forbidden");
  return Object.freeze({
    ...rollout,
    phase: RolloutPhase.RecoveryCompensating,
  });
}

export function completeCompensation(rollout: ReleaseRollout): ReleaseRollout {
  if (rollout.phase !== RolloutPhase.RecoveryCompensating)
    throw new Error("source_compensation_not_started");
  return Object.freeze({ ...rollout, phase: RolloutPhase.RecoveryCompensated });
}

export function assertPromotionAllowed(
  rollout: ReleaseRollout,
  systemIdentifier: string,
): void {
  if (
    systemIdentifier === rollout.source.systemIdentifier &&
    (rollout.sourcePermanentlyIneligible || rollout.activationUncertain)
  )
    throw new Error("source_generation_permanently_ineligible");
  if (
    ![
      rollout.source.systemIdentifier,
      rollout.target.systemIdentifier,
    ].includes(systemIdentifier)
  )
    throw new Error("promotion_generation_unknown");
}

export const assertRollbackTargetAllowed = assertPromotionAllowed;

export function assertRunnerIdentity(
  identity: RunnerIdentity,
  rollout: ReleaseRollout,
  lifecycle: "role" | "cutover",
): void {
  const expected = rollout.execution;
  if (
    identity.organization !== expected.organization ||
    identity.repository !== expected.controlRepository ||
    identity.workflowPath !== expected.workflowPath ||
    identity.workflowRef !== expected.workflowRef ||
    identity.event !== expected.event ||
    identity.actor !== expected.actor ||
    identity.runId !== expected.runId ||
    identity.runAttempt !== expected.runAttempt ||
    identity.workflowJobName !==
      (lifecycle === "role" ? expected.roleJobName : expected.cutoverJobName) ||
    identity.commitSha !== rollout.expectedCommitSha
  )
    throw new Error("runner_identity_mismatch");
  if (
    !/^[1-9][0-9]*$/u.test(identity.workflowJobId) ||
    !Number.isSafeInteger(identity.runnerGroupId) ||
    identity.runnerGroupId < 1 ||
    !identifierPattern.test(identity.runnerGroupName) ||
    !/^rr-[A-Za-z0-9_-]+$/u.test(identity.uniqueRunnerLabel) ||
    identity.uniqueRunnerLabel !== identity.runnerName ||
    identity.workFolder !== `_work/${identity.runnerName}` ||
    (identity.githubRunnerId !== undefined &&
      (!Number.isSafeInteger(identity.githubRunnerId) ||
        identity.githubRunnerId < 1)) ||
    (identity.githubRunnerLabels !== undefined &&
      (!identity.githubRunnerLabels.includes(identity.uniqueRunnerLabel) ||
        new Set(identity.githubRunnerLabels).size !==
          identity.githubRunnerLabels.length)) ||
    !identifierPattern.test(identity.renderJobId) ||
    !identifierPattern.test(identity.baseServiceId) ||
    identity.cleanupCanary !==
      `rr-cleanup:${rollout.rolloutId}:${identity.runnerName}`
  )
    throw new Error("runner_immutable_identity_invalid");
  if (
    identity.provenance.kind === "git"
      ? identity.provenance.commitSha !== rollout.expectedCommitSha
      : !digestPattern.test(identity.provenance.imageSha) ||
        identity.imageAttestation?.subjectDigest !==
          identity.provenance.imageSha ||
        identity.imageAttestation.sourceCommitSha !==
          rollout.expectedCommitSha ||
        !digestPattern.test(identity.imageAttestation.statementSha256) ||
        !identifierPattern.test(identity.imageAttestation.builderId)
  )
    throw new Error("runner_provenance_invalid");
}

export interface AuthoritativeGenerationLedger {
  claim(input: {
    rolloutId: string;
    expectedCommitSha: string;
    runId: string;
    runAttempt: number;
    sourceSystemIdentifier: string;
    targetSystemIdentifier: string;
    targetRecoveryWitnessSha256: string;
    migrationTransition: ReleaseMigrationTransitionV1;
  }): Promise<"claimed" | "duplicate">;
  beginReleaseMigration?(input: {
    rolloutId: string;
    expectedCommitSha: string;
    runId: string;
    runAttempt: number;
    sourceSystemIdentifier: string;
    targetSystemIdentifier: string;
    targetRecoveryWitnessSha256: string;
    transitionSha256: string;
    expectedPreviousReceiptSha256: string;
  }): Promise<ReleaseMigrationPermit>;
  completeReleaseMigration?(input: {
    permit: ReleaseMigrationPermit;
    receipt: ReleaseMigrationReceipt;
  }): Promise<ReleaseMigrationReceipt>;
  failReleaseMigration?(input: {
    permit: ReleaseMigrationPermit;
    reasonSha256: string;
  }): Promise<void>;
  loadReleaseMigrationCheckpoint?(input: {
    rolloutId: string;
    targetSystemIdentifier: string;
  }): Promise<{
    targetManifestPhase: TargetManifestPhase;
    permit: ReleaseMigrationPermit | null;
    receipt: ReleaseMigrationReceipt | null;
  }>;
  compareAndSet(input: {
    rolloutId: string;
    expectedCommitSha: string;
    runId: string;
    runAttempt: number;
    sourceSystemIdentifier: string;
    targetSystemIdentifier: string;
    step: RolloutStep;
    provider: StepObservation["provider"];
    expectedReceiptSha256: string;
    nextReceiptSha256: string;
    authoritativeSystemIdentifier: string;
    expectedActivationBoundary: "before" | "activated" | "uncertain";
    nextActivationBoundary: "before" | "activated" | "uncertain";
  }): Promise<boolean>;
  markActivationUncertain(input: {
    rolloutId: string;
    expectedCommitSha: string;
    runId: string;
    runAttempt: number;
    sourceSystemIdentifier: string;
    targetSystemIdentifier: string;
  }): Promise<void>;
  fenceTargetSwitch(input: {
    rolloutId: string;
    expectedCommitSha: string;
    runId: string;
    runAttempt: number;
    sourceSystemIdentifier: string;
    targetSystemIdentifier: string;
    previousReceiptSha256: string;
  }): Promise<TargetSwitchFence | null>;
  authorizeActivation(input: {
    rolloutId: string;
    expectedCommitSha: string;
    runId: string;
    jobId: string;
    runAttempt: number;
    sourceSystemIdentifier: string;
    targetSystemIdentifier: string;
    previousReceiptSha256: string;
    targetDeployIds: readonly string[];
    postgresMajor: 17;
    migrationChecksum: string;
    transitionSha256: string;
    postManifestIdentity: string;
  }): Promise<ActivationAuthorization>;
  finalizeActivation(input: {
    authorization: ActivationAuthorization;
    provider: StepObservation["provider"];
    nextReceiptSha256: string;
    activationReceipt: ActivationReceipt;
  }): Promise<boolean>;
  observeActivationState(input: {
    rolloutId: string;
    sourceSystemIdentifier: string;
    targetSystemIdentifier: string;
  }): Promise<"before" | "uncertain" | "activated">;
  verifyFinalAuthority(input: {
    rolloutId: string;
    expectedCommitSha: string;
    runId: string;
    runAttempt: number;
    sourceSystemIdentifier: string;
    targetSystemIdentifier: string;
    expectedReceiptSha256: string;
    activationReceipt: ActivationReceipt;
  }): Promise<boolean>;
}
