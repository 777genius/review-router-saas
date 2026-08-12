import { createHash } from "node:crypto";

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
    readonly githubWorkflowJobId?: string;
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
  readonly transactionId: string;
  readonly firstWriteReceiptSha256: string;
  readonly firstWriteBoundary: true;
  readonly fenceNonce: string;
  readonly fenceVersion: number;
}

export interface ActivationFence {
  readonly schemaVersion: 1;
  readonly rolloutId: string;
  readonly expectedCommitSha: string;
  readonly runId: string;
  readonly jobId: string;
  readonly runAttempt: number;
  readonly sourceSystemIdentifier: string;
  readonly targetSystemIdentifier: string;
  readonly previousReceiptSha256: string;
  readonly nonce: string;
  readonly version: number;
  readonly fencedAt: string;
}

export interface ReleaseRollout {
  readonly schemaVersion: 2;
  readonly rolloutId: string;
  readonly expectedCommitSha: string;
  readonly execution: ReleaseExecutionIdentity;
  readonly phase: RolloutPhase;
  readonly source: DatabaseGenerationIdentity;
  readonly target: DatabaseGenerationIdentity;
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
  return Object.freeze({
    ...input,
    schemaVersion: 2,
    phase: RolloutPhase.Planned,
    receipts: Object.freeze([]),
    activated: false,
    activationUncertain: false,
    sourcePermanentlyIneligible: false,
  });
}

function receiptDigest(receipt: Omit<StepReceipt, "receiptSha256">): string {
  return `sha256:${sha256Canonical(receipt)}`;
}

const runtimeRoles = Object.freeze([
  "reviewrouter_api",
  "reviewrouter_web",
  "reviewrouter_worker",
  "reviewrouter_codex_effect_authority",
]);

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
          )
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
        [...denied].sort().join(",") !== [...runtimeRoles].sort().join(",")
      )
        throw new Error("source_quiescence_observation_invalid");
      assertDigest(facts.aclSha256, "source_quiescence_observation_invalid");
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
        )
      )
        throw new Error("database_equivalence_observation_invalid");
      break;
    }
    case RolloutStep.BootstrapTargetRoles:
      if (
        facts.version !== 2 ||
        facts.status !== "succeeded" ||
        facts.commit !== rollout.expectedCommitSha ||
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
        facts.version !== 3 ||
        facts.status !== "succeeded" ||
        facts.migrationStatus !== "succeeded" ||
        facts.preflightStatus !== "passed" ||
        facts.aclGateState !== "closed" ||
        facts.commit !== rollout.expectedCommitSha ||
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
          return (
            service.suspended !== true ||
            typeof service.deployId !== "string" ||
            !digestPattern.test(String(service.envSha256)) ||
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
        "firstWriteReceiptSha256",
        "observationSha256",
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
          return (
            service.resumed !== true || typeof service.deployId !== "string"
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
      if (
        facts.commitSha !== rollout.expectedCommitSha ||
        facts.databaseSystemIdentifier !== rollout.target.systemIdentifier ||
        facts.writeReadRoundTrip !== true
      )
        throw new Error("live_canary_observation_invalid");
      break;
    case RolloutStep.VerifyTrustedRollout:
      assertDigest(
        facts.evidenceSha256,
        "trusted_evidence_observation_invalid",
      );
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
  if (observation.step === RolloutStep.ActivateTargetGeneration) {
    const facts = observation.facts as Record<string, unknown>;
    if (
      facts.firstWriteBoundary !== true ||
      !digestPattern.test(String(facts.canonicalPrivilegesSha256)) ||
      !digestPattern.test(String(facts.catalogFactsSha256)) ||
      !digestPattern.test(String(facts.firstWriteReceiptSha256)) ||
      !/^[0-9]+$/u.test(String(facts.transactionId)) ||
      !/^[a-f0-9]{32}$/u.test(String(facts.fenceNonce)) ||
      !Number.isSafeInteger(facts.fenceVersion) ||
      Number(facts.fenceVersion) < 1
    )
      throw new Error("activation_observation_invalid");
    const activationBase = {
      ...base,
      step: RolloutStep.ActivateTargetGeneration,
      canonicalPrivilegesSha256: String(facts.canonicalPrivilegesSha256),
      catalogFactsSha256: String(facts.catalogFactsSha256),
      transactionId: String(facts.transactionId),
      firstWriteReceiptSha256: String(facts.firstWriteReceiptSha256),
      firstWriteBoundary: true as const,
      fenceNonce: String(facts.fenceNonce),
      fenceVersion: Number(facts.fenceVersion),
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
    ...(activation ? { activationReceipt: receipt as ActivationReceipt } : {}),
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
  return Object.freeze({ ...rollout, phase: RolloutPhase.PreActivationFailed });
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
      : !digestPattern.test(identity.provenance.imageSha)
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
  }): Promise<"claimed" | "duplicate">;
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
    activationBoundary: "before" | "activated" | "uncertain";
  }): Promise<boolean>;
  markActivationUncertain(input: {
    rolloutId: string;
    expectedCommitSha: string;
    runId: string;
    runAttempt: number;
    sourceSystemIdentifier: string;
    targetSystemIdentifier: string;
  }): Promise<void>;
  fenceActivation(input: {
    rolloutId: string;
    expectedCommitSha: string;
    runId: string;
    jobId: string;
    runAttempt: number;
    sourceSystemIdentifier: string;
    targetSystemIdentifier: string;
    previousReceiptSha256: string;
  }): Promise<ActivationFence | null>;
  finalizeActivation(input: {
    fence: ActivationFence;
    provider: StepObservation["provider"];
    nextReceiptSha256: string;
    activationReceipt: ActivationReceipt;
  }): Promise<boolean>;
  observeActivationState(input: {
    rolloutId: string;
    sourceSystemIdentifier: string;
    targetSystemIdentifier: string;
  }): Promise<"before" | "uncertain" | "activated">;
}
