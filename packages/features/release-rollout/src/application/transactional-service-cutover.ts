import type { ProviderStateWitness } from "./ports";
import { sourceWriterServiceIdsAreValid } from "../domain/source-writer-service-ids";
import type { RecoveryEffectAuthorityPort } from "./recovery-effect-protocol";
import { RecoveryEffectProtocol } from "./recovery-effect-protocol";
import {
  RecoveryEffectKind,
  RecoveryEffectState,
  type RecoveryEffectRecord,
} from "../domain/recovery-effect";
import {
  ServiceTransitionPolicy,
  type ProtectedSourceEnvironment,
  type SourceRecoveryManifest,
  type TargetServiceRelease,
} from "../domain/service-transition";
import type {
  EnvironmentMutationOutcome,
  TransactionalServiceProvider,
} from "./service-transition-ports";

export type ServiceTransitionCheckpoint = Readonly<{
  rolloutId: string;
  manifestSha256: string;
  targetContractSha256: string;
  serviceId: string;
  sequence: number;
  step:
    | "recovery_intent"
    | "suspend_intent"
    | "suspended"
    | "target_config_intent"
    | "target_configured"
    | "target_env_intent"
    | "target_env_applied"
    | "target_deploy_intent"
    | "target_deployed"
    | "target_verified"
    | "restore_config_intent"
    | "source_config_restored"
    | "restore_env_intent"
    | "source_env_restored"
    | "restore_deploy_intent"
    | "source_deployed"
    | "source_verified"
    | "source_acl_restored"
    | "source_resumed";
  deployId?: string;
  observedContractSha256?: string;
  observedEnvSha256?: string;
  intentAt?: string;
}>;

export interface ServiceTransitionLedger extends RecoveryEffectAuthorityPort {
  begin(input: {
    rolloutId: string;
    manifestSha256: string;
    targetContractSha256: string;
    serviceIds: readonly string[];
    sourceManifest: SourceRecoveryManifest;
    targetContracts: readonly Omit<TargetServiceRelease, "environmentDelta">[];
  }): Promise<"created" | "existing">;
  readContract(rolloutId: string): Promise<{
    sourceManifest: SourceRecoveryManifest;
    targetContracts: readonly Omit<TargetServiceRelease, "environmentDelta">[];
  } | null>;
  append(
    checkpoint: Omit<ServiceTransitionCheckpoint, "sequence">,
  ): Promise<ServiceTransitionCheckpoint>;
  read(rolloutId: string): Promise<readonly ServiceTransitionCheckpoint[]>;
  complete(input: {
    rolloutId: string;
    outcome: "target_staged" | "source_recovered";
  }): Promise<void>;
}

const transitionPolicy = new ServiceTransitionPolicy();

export const validateServiceTransitionContracts = (
  source: SourceRecoveryManifest,
  protectedEnvironment: ProtectedSourceEnvironment,
  target: readonly TargetServiceRelease[],
): string => transitionPolicy.validate(source, protectedEnvironment, target);

const requireAppliedEnvironment = (
  outcome: EnvironmentMutationOutcome,
): string => {
  if (outcome.status === "conflict")
    throw new Error("service_transition_environment_conflict");
  if (outcome.status === "ambiguous")
    throw new Error("service_transition_environment_ambiguous");
  return outcome.environmentSha256;
};

export class TransactionalServiceCutover {
  private readonly recoveryEffects: RecoveryEffectProtocol;
  constructor(
    private readonly ledger: ServiceTransitionLedger,
    private readonly provider: TransactionalServiceProvider,
    private readonly recoveryOwnerId: string,
  ) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(recoveryOwnerId))
      throw new Error("service_transition_recovery_owner_invalid");
    this.recoveryEffects = new RecoveryEffectProtocol(ledger);
  }

  async stage(input: {
    source: SourceRecoveryManifest;
    protectedEnvironment: ProtectedSourceEnvironment;
    target: readonly TargetServiceRelease[];
  }): Promise<readonly string[]> {
    const targetContractSha256 = validateServiceTransitionContracts(
      input.source,
      input.protectedEnvironment,
      input.target,
    );
    const common = {
      rolloutId: input.source.rolloutId,
      manifestSha256: input.source.manifestSha256,
      targetContractSha256,
    };
    const existing = await this.ledger.read(input.source.rolloutId);
    if (
      existing.some(
        (item) =>
          item.manifestSha256 !== common.manifestSha256 ||
          item.targetContractSha256 !== common.targetContractSha256,
      )
    )
      throw new Error("service_transition_foreign_checkpoint");
    if (existing.length > 0) {
      throw new Error("service_transition_interrupted_recovery_required");
    }
    for (const service of input.source.services) {
      const observed = await this.provider.observe(service.serviceId);
      if (
        !observed.suspended ||
        observed.configurationSha256 !== service.configuration.sha256 ||
        observed.environmentSha256 !== service.sourceEnvironmentSha256 ||
        observed.provenance.kind !== "source_revision" ||
        observed.provenance.revision !== service.sourceRevision
      )
        throw new Error("service_transition_source_preflight_mismatch");
    }
    const deployIds: string[] = [];
    const transition = await this.ledger.begin({
      ...common,
      serviceIds: input.source.services.map((item) => item.serviceId),
      sourceManifest: input.source,
      targetContracts: input.target.map((item) => ({
        serviceId: item.serviceId,
        artifact: item.artifact,
        removeKeys: item.removeKeys,
        environmentSha256: item.environmentSha256,
        configurationSha256: item.configurationSha256,
      })),
    });
    if (transition === "existing")
      throw new Error("service_transition_concurrent_or_interrupted");
    for (const contract of input.target) {
      await this.checkpoint(common, contract.serviceId, "suspend_intent");
      await this.provider.suspend(contract.serviceId);
      await this.checkpoint(common, contract.serviceId, "suspended");
      await this.checkpoint(common, contract.serviceId, "target_config_intent");
      await this.provider.configureTarget(contract);
      await this.checkpoint(common, contract.serviceId, "target_configured");
      await this.checkpoint(common, contract.serviceId, "target_env_intent");
      const source = input.source.services.find(
        (item) => item.serviceId === contract.serviceId,
      )!;
      const envMutation = await this.provider.replaceEnvironment(
        contract.serviceId,
        {
          set: contract.environmentDelta,
          remove: contract.removeKeys,
          expectedBeforeSha256: source.sourceEnvironmentSha256,
          expectedAfterSha256: contract.environmentSha256,
        },
      );
      const envHash = requireAppliedEnvironment(envMutation);
      if (envHash !== contract.environmentSha256)
        throw new Error("service_transition_target_env_mismatch");
      await this.checkpoint(common, contract.serviceId, "target_env_applied", {
        observedEnvSha256: envHash,
      });
      await this.checkpoint(common, contract.serviceId, "target_deploy_intent");
      const deployId = await this.provider.deployArtifact(
        contract.serviceId,
        contract.artifact.reference,
      );
      await this.provider.waitForDeployment(contract.serviceId, deployId, {
        kind: "container_image",
        reference: contract.artifact.reference,
      });
      await this.checkpoint(common, contract.serviceId, "target_deployed", {
        deployId,
      });
      const observed = await this.provider.observe(contract.serviceId);
      if (
        !observed.suspended ||
        observed.environmentSha256 !== contract.environmentSha256 ||
        observed.configurationSha256 !== contract.configurationSha256 ||
        observed.provenance.kind !== "container_image" ||
        observed.provenance.reference !== contract.artifact.reference ||
        observed.provenance.deploymentId !== deployId
      )
        throw new Error("service_transition_target_verification_failed");
      await this.checkpoint(common, contract.serviceId, "target_verified", {
        deployId,
        observedContractSha256: observed.configurationSha256,
        observedEnvSha256: observed.environmentSha256,
      });
      deployIds.push(deployId);
    }
    await this.ledger.complete({
      rolloutId: input.source.rolloutId,
      outcome: "target_staged",
    });
    return Object.freeze(deployIds);
  }

  async recover(input: {
    source: SourceRecoveryManifest;
    protectedEnvironment: ProtectedSourceEnvironment;
    target: readonly TargetServiceRelease[];
    targetContractSha256?: string;
  }): Promise<void> {
    const targetContractSha256 =
      input.targetContractSha256 ??
      validateServiceTransitionContracts(
        input.source,
        input.protectedEnvironment,
        input.target,
      );
    const common = {
      rolloutId: input.source.rolloutId,
      manifestSha256: input.source.manifestSha256,
      targetContractSha256,
    };
    const durableCheckpoints = await this.ledger.read(input.source.rolloutId);
    if (
      durableCheckpoints.length === 0 ||
      durableCheckpoints.some(
        (item) =>
          item.manifestSha256 !== common.manifestSha256 ||
          item.targetContractSha256 !== common.targetContractSha256,
      )
    )
      throw new Error("service_transition_recovery_checkpoint_invalid");
    for (const contract of [...input.source.services].reverse()) {
      const sourceEnv = input.protectedEnvironment[contract.serviceId];
      if (!sourceEnv)
        throw new Error("service_transition_source_environment_missing");
      await this.provider.suspend(contract.serviceId);
      await this.provider.quiesceDeployments(contract.serviceId);
      const beforeRestore = await this.provider.observe(contract.serviceId);
      if (!beforeRestore.suspended)
        throw new Error("service_transition_recovery_quiescence_unproven");
      const target = input.target.find(
        (item) => item.serviceId === contract.serviceId,
      )!;
      if (
        beforeRestore.environmentSha256 !== contract.sourceEnvironmentSha256 &&
        beforeRestore.environmentSha256 !== target.environmentSha256
      )
        throw new Error("service_transition_recovery_environment_ambiguous");
      await this.checkpoint(
        common,
        contract.serviceId,
        "restore_config_intent",
      );
      await this.requireCompletedRecoveryEffect(
        await this.recoveryEffects.execute({
          rolloutId: input.source.rolloutId,
          effectKey: `restore_service_config:${contract.serviceId}`,
          kind: RecoveryEffectKind.RestoreServiceConfig,
          serviceId: contract.serviceId,
          ownerId: this.recoveryOwnerId,
          effect: async () => {
            await this.provider.configureSource(contract);
            return this.provider.observe(contract.serviceId);
          },
          reconcileConsumed: async () => {
            const observed = await this.provider.observe(contract.serviceId);
            return observed.suspended &&
              observed.configurationSha256 === contract.configuration.sha256
              ? observed
              : null;
          },
          observe: async (observed) => ({
            serviceId: contract.serviceId,
            serviceContractSha256: observed.configurationSha256,
            suspended: observed.suspended,
          }),
        }),
      );
      await this.checkpoint(
        common,
        contract.serviceId,
        "source_config_restored",
      );
      await this.checkpoint(common, contract.serviceId, "restore_env_intent");
      const envEffect = await this.recoveryEffects.execute({
        rolloutId: input.source.rolloutId,
        effectKey: `restore_service_environment:${contract.serviceId}`,
        kind: RecoveryEffectKind.RestoreServiceEnvironment,
        serviceId: contract.serviceId,
        ownerId: this.recoveryOwnerId,
        effect: async () =>
          beforeRestore.environmentSha256 === contract.sourceEnvironmentSha256
            ? beforeRestore.environmentSha256
            : requireAppliedEnvironment(
                await this.provider.replaceEnvironment(contract.serviceId, {
                  set: sourceEnv,
                  remove: [
                    "REVIEW_ROUTER_RUNTIME_RELEASE_COMMIT_SHA",
                    "REVIEW_ROUTER_RUNTIME_ROLLOUT_ID",
                    "REVIEW_ROUTER_RUNTIME_ROLLOUT_STARTED_AT",
                  ],
                  expectedBeforeSha256: target.environmentSha256,
                  expectedAfterSha256: contract.sourceEnvironmentSha256,
                }),
              ),
        reconcileConsumed: async () => {
          const observed = await this.provider.observe(contract.serviceId);
          return observed.environmentSha256 === contract.sourceEnvironmentSha256
            ? observed.environmentSha256
            : null;
        },
        observe: async (environmentSha256) => ({
          serviceId: contract.serviceId,
          environmentSha256,
        }),
      });
      await this.requireCompletedRecoveryEffect(envEffect);
      const envObservation = envEffect.observation as {
        environmentSha256?: unknown;
      } | null;
      const envHash = envObservation?.environmentSha256;
      if (typeof envHash !== "string")
        throw new Error("service_transition_source_env_observation_missing");
      if (envHash !== contract.sourceEnvironmentSha256)
        throw new Error("service_transition_source_env_restore_failed");
      await this.checkpoint(common, contract.serviceId, "source_env_restored", {
        observedEnvSha256: envHash,
      });
      const persistedIntentAt = [...durableCheckpoints]
        .reverse()
        .find(
          (item) =>
            item.serviceId === contract.serviceId &&
            item.step === "restore_deploy_intent",
        )?.intentAt;
      const restoreIntentAt = persistedIntentAt ?? new Date().toISOString();
      if (!persistedIntentAt)
        await this.checkpoint(
          common,
          contract.serviceId,
          "restore_deploy_intent",
          { intentAt: restoreIntentAt },
        );
      const persistedDeploy = [...durableCheckpoints]
        .reverse()
        .find(
          (item) =>
            item.serviceId === contract.serviceId &&
            item.step === "source_deployed",
        )?.deployId;
      const deployEffect = await this.recoveryEffects.execute({
        rolloutId: input.source.rolloutId,
        effectKey: `restore_service_deploy:${contract.serviceId}`,
        kind: RecoveryEffectKind.RestoreServiceDeploy,
        serviceId: contract.serviceId,
        ownerId: this.recoveryOwnerId,
        effect: async () => {
          const deployId =
            persistedDeploy ??
            (await this.provider.reconcileSourceDeployment({
              serviceId: contract.serviceId,
              revision: contract.sourceRevision,
              intentAt: persistedIntentAt ?? restoreIntentAt,
            })) ??
            (await this.provider.deploySourceRevision(
              contract.serviceId,
              contract.sourceRevision,
            ));
          await this.provider.waitForDeployment(contract.serviceId, deployId, {
            kind: "source_revision",
            revision: contract.sourceRevision,
          });
          return deployId;
        },
        reconcileConsumed: async () => {
          const deployId = await this.provider.reconcileSourceDeployment({
            serviceId: contract.serviceId,
            revision: contract.sourceRevision,
            intentAt: persistedIntentAt ?? restoreIntentAt,
          });
          if (!deployId) return null;
          await this.provider.waitForDeployment(contract.serviceId, deployId, {
            kind: "source_revision",
            revision: contract.sourceRevision,
          });
          return deployId;
        },
        observe: async (deployId) => ({
          serviceId: contract.serviceId,
          deployId,
        }),
      });
      await this.requireCompletedRecoveryEffect(deployEffect);
      const deployId = this.deployIdFromRecoveryEffect(deployEffect);
      await this.checkpoint(common, contract.serviceId, "source_deployed", {
        deployId,
      });
      const observed = await this.provider.observe(contract.serviceId);
      if (
        !observed.suspended ||
        observed.configurationSha256 !== contract.configuration.sha256 ||
        observed.environmentSha256 !== contract.sourceEnvironmentSha256 ||
        observed.provenance.kind !== "source_revision" ||
        observed.provenance.revision !== contract.sourceRevision
      )
        throw new Error("service_transition_source_restore_unproven");
      await this.checkpoint(common, contract.serviceId, "source_verified", {
        deployId,
        observedContractSha256: observed.configurationSha256,
        observedEnvSha256: observed.environmentSha256,
      });
    }
  }

  async finalizeAuthorizedSourceRecovery(input: {
    source: SourceRecoveryManifest;
    protectedEnvironment: ProtectedSourceEnvironment;
    target: readonly TargetServiceRelease[];
    /** Exact authority-ledger IDs durably observed suspended by this rollout. */
    sourceWriterServiceIds: readonly string[];
    restoreSourceWritesAndVerify: () => Promise<void>;
  }): Promise<ProviderStateWitness> {
    const targetContractSha256 = validateServiceTransitionContracts(
      input.source,
      input.protectedEnvironment,
      input.target,
    );
    const common = {
      rolloutId: input.source.rolloutId,
      manifestSha256: input.source.manifestSha256,
      targetContractSha256,
    };
    if (
      !sourceWriterServiceIdsAreValid(input.sourceWriterServiceIds) ||
      input.sourceWriterServiceIds.some(
        (serviceId) =>
          !input.source.services.some(
            (service) => service.serviceId === serviceId,
          ),
      )
    )
      throw new Error("service_transition_recovery_scope_mismatch");
    const checkpoints = await this.ledger.read(input.source.rolloutId);
    const verifiedDeployIds = new Map<string, string>();
    for (const service of input.source.services) {
      const verified = [...checkpoints]
        .reverse()
        .find(
          (item) =>
            item.serviceId === service.serviceId &&
            item.step === "source_verified",
        );
      if (!verified)
        throw new Error("service_transition_source_restore_checkpoint_missing");
      if (verified.deployId)
        verifiedDeployIds.set(service.serviceId, verified.deployId);
    }
    for (const serviceId of input.sourceWriterServiceIds)
      if (!verifiedDeployIds.has(serviceId))
        throw new Error("service_transition_source_deploy_checkpoint_missing");
    await this.requireCompletedRecoveryEffect(
      await this.recoveryEffects.execute({
        rolloutId: input.source.rolloutId,
        effectKey: "restore_database_writes",
        kind: RecoveryEffectKind.RestoreDatabaseWrites,
        ownerId: this.recoveryOwnerId,
        effect: async () => {
          await input.restoreSourceWritesAndVerify();
          return { sourceWritesRestored: true as const };
        },
        observe: async (value) => ({
          ...value,
          observedAt: new Date().toISOString(),
        }),
      }),
    );
    await this.checkpoint(
      common,
      input.source.services[0]!.serviceId,
      "source_acl_restored",
    );
    const deployIds: string[] = [];
    for (const serviceId of input.sourceWriterServiceIds) {
      const service = input.source.services.find(
        (candidate) => candidate.serviceId === serviceId,
      )!;
      const resumeEffect = await this.recoveryEffects.execute({
        rolloutId: input.source.rolloutId,
        effectKey: `resume_source_service:${service.serviceId}`,
        kind: RecoveryEffectKind.ResumeSourceService,
        serviceId: service.serviceId,
        ownerId: this.recoveryOwnerId,
        effect: async () => {
          await this.provider.resume(service.serviceId);
          return this.provider.observe(service.serviceId);
        },
        reconcileConsumed: async () => {
          const observed = await this.provider.observe(service.serviceId);
          return observed.suspended ? null : observed;
        },
        observe: async (observed) => ({
          serviceId: service.serviceId,
          resumed: !observed.suspended,
          serviceContractSha256: observed.configurationSha256,
          environmentSha256: observed.environmentSha256,
        }),
      });
      await this.requireCompletedRecoveryEffect(resumeEffect);
      const observed = await this.provider.observe(service.serviceId);
      if (
        observed.suspended ||
        observed.configurationSha256 !== service.configuration.sha256 ||
        observed.environmentSha256 !== service.sourceEnvironmentSha256 ||
        observed.provenance.kind !== "source_revision" ||
        observed.provenance.revision !== service.sourceRevision
      )
        throw new Error("service_transition_source_resume_unproven");
      await this.checkpoint(common, service.serviceId, "source_resumed");
      deployIds.push(verifiedDeployIds.get(service.serviceId)!);
    }
    await this.ledger.complete({
      rolloutId: input.source.rolloutId,
      outcome: "source_recovered",
    });
    return Object.freeze({
      serviceIds: Object.freeze([...input.sourceWriterServiceIds]),
      deployIds: Object.freeze(deployIds),
      observedAt: new Date().toISOString(),
      resumed: true as const,
    });
  }

  private async checkpoint(
    common: {
      rolloutId: string;
      manifestSha256: string;
      targetContractSha256: string;
    },
    serviceId: string,
    step: ServiceTransitionCheckpoint["step"],
    facts: Partial<ServiceTransitionCheckpoint> = {},
  ): Promise<void> {
    await this.ledger.append({ ...common, serviceId, step, ...facts });
  }

  private async requireCompletedRecoveryEffect(
    record: RecoveryEffectRecord,
  ): Promise<void> {
    if (record.state === RecoveryEffectState.ForwardRepair)
      throw new Error("service_transition_recovery_forward_repair_required");
    if (record.state !== RecoveryEffectState.Completed)
      throw new Error("service_transition_recovery_effect_ambiguous");
  }

  private deployIdFromRecoveryEffect(record: RecoveryEffectRecord): string {
    const observation = record.observation as { deployId?: unknown } | null;
    if (
      !observation ||
      typeof observation.deployId !== "string" ||
      !observation.deployId
    )
      throw new Error("service_transition_source_deploy_observation_missing");
    return observation.deployId;
  }
}
