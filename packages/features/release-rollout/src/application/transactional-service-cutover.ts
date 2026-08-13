import { createHash } from "node:crypto";

const sha256 = (value: unknown): string =>
  `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
const digest = /^sha256:[a-f0-9]{64}$/u;
const commit = /^[a-f0-9]{40}$/u;
const image = /^ghcr\.io\/777genius\/review-router-saas-runtime@sha256:[a-f0-9]{64}$/u;

export type RenderServiceContract = Readonly<{
  serviceId: string;
  ownerId: string;
  type: "web_service" | "background_worker";
  runtime: "node";
  repository: string;
  branch: string;
  rootDir: string;
  sourceCommitSha: string;
  buildCommand: string;
  startCommand: string;
  preDeployCommand: string;
  healthCheckPath: string | null;
  region: string;
  plan: string;
  maxShutdownDelaySeconds: number;
  autoDeploy: "no";
  databaseEnvKey: string;
  databaseRole: string;
  sourceEnvSha256: string;
  serviceContractSha256: string;
}>;

export type SourceRecoveryManifest = Readonly<{
  schemaVersion: "reviewrouter.render-source-recovery.v1";
  rolloutId: string;
  services: readonly RenderServiceContract[];
  manifestSha256: string;
}>;

export type ProtectedSourceEnvironment = Readonly<{
  manifestSha256: string;
  services: readonly Readonly<{
    serviceId: string;
    values: readonly Readonly<{ key: string; value: string }>[];
  }>[];
}>;

export type TargetServiceContract = Readonly<{
  serviceId: string;
  imageUrl: string;
  environment: readonly Readonly<{ key: string; value: string }>[];
  environmentSha256: string;
  serviceContractSha256: string;
}>;

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

export interface ServiceTransitionLedger {
  begin(input: {
    rolloutId: string;
    manifestSha256: string;
    targetContractSha256: string;
    serviceIds: readonly string[];
  }): Promise<"created" | "existing">;
  append(
    checkpoint: Omit<ServiceTransitionCheckpoint, "sequence">,
  ): Promise<ServiceTransitionCheckpoint>;
  read(rolloutId: string): Promise<readonly ServiceTransitionCheckpoint[]>;
  complete(input: {
    rolloutId: string;
    outcome: "target_staged" | "source_recovered";
  }): Promise<void>;
}

export type ObservedRenderService = Readonly<{
  serviceId: string;
  suspended: boolean;
  serviceContractSha256: string;
  environmentSha256: string;
  provenance:
    | { kind: "git"; commitSha: string }
    | { kind: "image"; imageUrl: string; deployId: string };
}>;

export interface TransactionalRenderProvider {
  observe(serviceId: string): Promise<ObservedRenderService>;
  suspend(serviceId: string): Promise<void>;
  resume(serviceId: string): Promise<void>;
  configureTarget(contract: TargetServiceContract): Promise<void>;
  configureSource(contract: RenderServiceContract): Promise<void>;
  replaceEnvironment(
    serviceId: string,
    values: readonly Readonly<{ key: string; value: string }>[],
  ): Promise<string>;
  deployImage(serviceId: string, imageUrl: string): Promise<string>;
  deployCommit(serviceId: string, commitSha: string): Promise<string>;
  waitForDeploy(
    serviceId: string,
    deployId: string,
    expected:
      | { kind: "image"; imageUrl: string }
      | { kind: "git"; commitSha: string },
  ): Promise<void>;
  reconcileCommitDeploy(input: {
    serviceId: string;
    commitSha: string;
    intentAt: string;
  }): Promise<string | null>;
  quiesceDeploys(serviceId: string): Promise<void>;
}

const canonicalEnv = (
  values: readonly Readonly<{ key: string; value: string }>[],
): readonly Readonly<{ key: string; value: string }>[] => {
  const result = [...values].sort((a, b) => a.key.localeCompare(b.key));
  if (
    result.length === 0 ||
    result.some(
      (item, index) =>
        !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(item.key) ||
        (index > 0 && result[index - 1]?.key === item.key),
    )
  )
    throw new Error("service_transition_environment_invalid");
  return result;
};

export const environmentSha256 = (
  values: readonly Readonly<{ key: string; value: string }>[],
): string => sha256(canonicalEnv(values));

const withoutHash = <T extends Record<string, unknown>>(
  value: T,
  field: keyof T,
): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));

export const sourceServiceContractSha256 = (
  value: Omit<RenderServiceContract, "serviceContractSha256">,
): string => sha256({
  serviceId: value.serviceId,
  ownerId: value.ownerId,
  type: value.type,
  runtime: value.runtime,
  repository: value.repository,
  branch: value.branch,
  rootDir: value.rootDir,
  buildCommand: value.buildCommand,
  startCommand: value.startCommand,
  preDeployCommand: value.preDeployCommand,
  healthCheckPath: value.healthCheckPath,
  region: value.region,
  plan: value.plan,
  maxShutdownDelaySeconds: value.maxShutdownDelaySeconds,
  autoDeploy: value.autoDeploy,
});
export const targetServiceContractSha256 = (
  value: Omit<TargetServiceContract, "serviceContractSha256" | "environment">,
): string => sha256({
  serviceId: value.serviceId,
  runtime: "image",
  imageUrl: value.imageUrl,
  autoDeploy: "no",
  preDeployCommand: "",
});

export function validateServiceTransitionContracts(
  source: SourceRecoveryManifest,
  protectedEnvironment: ProtectedSourceEnvironment,
  target: readonly TargetServiceContract[],
): string {
  if (
    source.schemaVersion !== "reviewrouter.render-source-recovery.v1" ||
    !digest.test(source.manifestSha256) ||
    sha256(withoutHash(source as unknown as Record<string, unknown>, "manifestSha256")) !==
      source.manifestSha256 ||
    protectedEnvironment.manifestSha256 !== source.manifestSha256 ||
    source.services.length !== 3 ||
    target.length !== 3
  )
    throw new Error("service_transition_manifest_invalid");
  const sourceIds = source.services.map((item) => item.serviceId);
  if (new Set(sourceIds).size !== 3 || sourceIds.join("\0") !== target.map((item) => item.serviceId).join("\0"))
    throw new Error("service_transition_scope_invalid");
  for (const service of source.services) {
    const env = protectedEnvironment.services.find(
      (item) => item.serviceId === service.serviceId,
    );
    if (
      service.runtime !== "node" ||
      service.autoDeploy !== "no" ||
      !commit.test(service.sourceCommitSha) ||
      !digest.test(service.sourceEnvSha256) ||
      !digest.test(service.serviceContractSha256) ||
      sourceServiceContractSha256(
        withoutHash(service as unknown as Record<string, unknown>, "serviceContractSha256") as Omit<RenderServiceContract, "serviceContractSha256">,
      ) !==
        service.serviceContractSha256 ||
      !env ||
      environmentSha256(env.values) !== service.sourceEnvSha256
    )
      throw new Error("service_transition_source_contract_invalid");
  }
  if (protectedEnvironment.services.length !== 3)
    throw new Error("service_transition_source_environment_scope_invalid");
  for (const service of target) {
    if (
      !image.test(service.imageUrl) ||
      environmentSha256(service.environment) !== service.environmentSha256 ||
      targetServiceContractSha256({
        serviceId: service.serviceId,
        imageUrl: service.imageUrl,
        environmentSha256: service.environmentSha256,
      }) !==
        service.serviceContractSha256
    )
      throw new Error("service_transition_target_contract_invalid");
  }
  return sha256(target);
}

export class TransactionalServiceCutover {
  constructor(
    private readonly ledger: ServiceTransitionLedger,
    private readonly provider: TransactionalRenderProvider,
  ) {}

  async stage(input: {
    source: SourceRecoveryManifest;
    protectedEnvironment: ProtectedSourceEnvironment;
    target: readonly TargetServiceContract[];
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
      await this.recover({ ...input, targetContractSha256 });
      throw new Error("service_transition_interrupted_source_recovered");
    }
    for (const service of input.source.services) {
      const observed = await this.provider.observe(service.serviceId);
      if (
        !observed.suspended ||
        observed.serviceContractSha256 !== service.serviceContractSha256 ||
        observed.environmentSha256 !== service.sourceEnvSha256 ||
        observed.provenance.kind !== "git" ||
        observed.provenance.commitSha !== service.sourceCommitSha
      )
        throw new Error("service_transition_source_preflight_mismatch");
    }
    await this.ledger.begin({
      ...common,
      serviceIds: input.source.services.map((item) => item.serviceId),
    });
    await this.checkpoint(common, input.source.services[0]!.serviceId, "recovery_intent");
    const deployIds: string[] = [];
    try {
      for (const contract of input.target) {
        await this.checkpoint(common, contract.serviceId, "suspend_intent");
        await this.provider.suspend(contract.serviceId);
        await this.checkpoint(common, contract.serviceId, "suspended");
        await this.checkpoint(common, contract.serviceId, "target_config_intent");
        await this.provider.configureTarget(contract);
        await this.checkpoint(common, contract.serviceId, "target_configured");
        await this.checkpoint(common, contract.serviceId, "target_env_intent");
        const envHash = await this.provider.replaceEnvironment(
          contract.serviceId,
          contract.environment,
        );
        if (envHash !== contract.environmentSha256)
          throw new Error("service_transition_target_env_mismatch");
        await this.checkpoint(common, contract.serviceId, "target_env_applied", {
          observedEnvSha256: envHash,
        });
        await this.checkpoint(common, contract.serviceId, "target_deploy_intent");
        const deployId = await this.provider.deployImage(
          contract.serviceId,
          contract.imageUrl,
        );
        await this.provider.waitForDeploy(contract.serviceId, deployId, {
          kind: "image",
          imageUrl: contract.imageUrl,
        });
        await this.checkpoint(common, contract.serviceId, "target_deployed", {
          deployId,
        });
        const observed = await this.provider.observe(contract.serviceId);
        if (
          !observed.suspended ||
          observed.environmentSha256 !== contract.environmentSha256 ||
          observed.serviceContractSha256 !== contract.serviceContractSha256 ||
          observed.provenance.kind !== "image" ||
          observed.provenance.imageUrl !== contract.imageUrl ||
          observed.provenance.deployId !== deployId
        )
          throw new Error("service_transition_target_verification_failed");
        await this.checkpoint(common, contract.serviceId, "target_verified", {
          deployId,
          observedContractSha256: observed.serviceContractSha256,
          observedEnvSha256: observed.environmentSha256,
        });
        deployIds.push(deployId);
      }
      await this.ledger.complete({
        rolloutId: input.source.rolloutId,
        outcome: "target_staged",
      });
      return Object.freeze(deployIds);
    } catch (error) {
      await this.recover({ ...input, targetContractSha256 });
      throw error;
    }
  }

  async recover(input: {
    source: SourceRecoveryManifest;
    protectedEnvironment: ProtectedSourceEnvironment;
    target: readonly TargetServiceContract[];
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
    const checkpoints = await this.ledger.read(input.source.rolloutId);
    if (
      checkpoints.length === 0 ||
      checkpoints.some(
        (item) =>
          item.manifestSha256 !== common.manifestSha256 ||
          item.targetContractSha256 !== common.targetContractSha256,
      )
    )
      throw new Error("service_transition_recovery_checkpoint_invalid");
    for (const contract of [...input.source.services].reverse()) {
      const sourceEnv = input.protectedEnvironment.services.find(
        (item) => item.serviceId === contract.serviceId,
      );
      if (!sourceEnv)
        throw new Error("service_transition_source_environment_missing");
      await this.provider.suspend(contract.serviceId);
      await this.provider.quiesceDeploys(contract.serviceId);
      const beforeRestore = await this.provider.observe(contract.serviceId);
      if (!beforeRestore.suspended)
        throw new Error("service_transition_recovery_quiescence_unproven");
      await this.checkpoint(common, contract.serviceId, "restore_config_intent");
      await this.provider.configureSource(contract);
      await this.checkpoint(common, contract.serviceId, "source_config_restored");
      await this.checkpoint(common, contract.serviceId, "restore_env_intent");
      const envHash = await this.provider.replaceEnvironment(
        contract.serviceId,
        sourceEnv.values,
      );
      if (envHash !== contract.sourceEnvSha256)
        throw new Error("service_transition_source_env_restore_failed");
      await this.checkpoint(common, contract.serviceId, "source_env_restored", {
        observedEnvSha256: envHash,
      });
      const restoreIntentAt = new Date().toISOString();
      await this.checkpoint(common, contract.serviceId, "restore_deploy_intent", {
        intentAt: restoreIntentAt,
      });
      const persistedIntentAt = [...checkpoints]
        .reverse()
        .find(
          (item) =>
            item.serviceId === contract.serviceId &&
            item.step === "restore_deploy_intent",
        )?.intentAt;
      const persistedDeploy = [...checkpoints]
        .reverse()
        .find(
          (item) =>
            item.serviceId === contract.serviceId &&
            item.step === "source_deployed",
        )?.deployId;
      const deployId =
        persistedDeploy ??
        (await this.provider.reconcileCommitDeploy({
          serviceId: contract.serviceId,
          commitSha: contract.sourceCommitSha,
          intentAt: persistedIntentAt ?? restoreIntentAt,
        })) ??
        (await this.provider.deployCommit(contract.serviceId, contract.sourceCommitSha));
      await this.provider.waitForDeploy(contract.serviceId, deployId, {
        kind: "git",
        commitSha: contract.sourceCommitSha,
      });
      await this.checkpoint(common, contract.serviceId, "source_deployed", {
        deployId,
      });
      const observed = await this.provider.observe(contract.serviceId);
      if (
        !observed.suspended ||
        observed.serviceContractSha256 !== contract.serviceContractSha256 ||
        observed.environmentSha256 !== contract.sourceEnvSha256 ||
        observed.provenance.kind !== "git" ||
        observed.provenance.commitSha !== contract.sourceCommitSha
      )
        throw new Error("service_transition_source_restore_unproven");
      await this.checkpoint(common, contract.serviceId, "source_verified", {
        deployId,
        observedContractSha256: observed.serviceContractSha256,
        observedEnvSha256: observed.environmentSha256,
      });
    }
  }

  async finalizeAuthorizedSourceRecovery(input: {
    source: SourceRecoveryManifest;
    protectedEnvironment: ProtectedSourceEnvironment;
    target: readonly TargetServiceContract[];
    restoreSourceWritesAndVerify: () => Promise<void>;
  }): Promise<void> {
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
    const checkpoints = await this.ledger.read(input.source.rolloutId);
    for (const service of input.source.services) {
      if (
        !checkpoints.some(
          (item) =>
            item.serviceId === service.serviceId &&
            item.step === "source_verified",
        )
      )
        throw new Error("service_transition_source_restore_checkpoint_missing");
    }
    await input.restoreSourceWritesAndVerify();
    await this.checkpoint(
      common,
      input.source.services[0]!.serviceId,
      "source_acl_restored",
    );
    for (const service of input.source.services) {
      await this.provider.resume(service.serviceId);
      const observed = await this.provider.observe(service.serviceId);
      if (
        observed.suspended ||
        observed.serviceContractSha256 !== service.serviceContractSha256 ||
        observed.environmentSha256 !== service.sourceEnvSha256 ||
        observed.provenance.kind !== "git" ||
        observed.provenance.commitSha !== service.sourceCommitSha
      )
        throw new Error("service_transition_source_resume_unproven");
      await this.checkpoint(common, service.serviceId, "source_resumed");
    }
    await this.ledger.complete({
      rolloutId: input.source.rolloutId,
      outcome: "source_recovered",
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
}
