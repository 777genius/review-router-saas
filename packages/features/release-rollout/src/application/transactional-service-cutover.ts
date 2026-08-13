import { createHash } from "node:crypto";
import type { ProviderStateWitness } from "./ports";
import { sourceWriterServiceIdsAreValid } from "../domain/source-writer-service-ids";
import type { RecoveryEffectAuthorityPort } from "./recovery-effect-protocol";
import { RecoveryEffectProtocol } from "./recovery-effect-protocol";
import {
  RecoveryEffectKind,
  RecoveryEffectState,
  type RecoveryEffectRecord,
} from "../domain/recovery-effect";

const sha256 = (value: unknown): string =>
  `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
const digest = /^sha256:[a-f0-9]{64}$/u;
const rawSha256 = /^[a-f0-9]{64}$/u;
const witness = /^[A-Za-z0-9_-]{43,256}$/u;
const witnessSha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");
const commit = /^[a-f0-9]{40}$/u;
const image =
  /^ghcr\.io\/777genius\/review-router-saas-runtime@sha256:[a-f0-9]{64}$/u;

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
  sourceEnvKeysSha256: string;
  serviceContractSha256: string;
}>;

export type SourceRecoveryManifest = Readonly<{
  schemaVersion: "reviewrouter.render-source-recovery.v1";
  rolloutId: string;
  services: readonly RenderServiceContract[];
  manifestSha256: string;
}>;

export type ProtectedSourceEnvironment = Readonly<
  Record<
    string,
    Readonly<{
      DATABASE_URL: string;
      REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS: string;
      REVIEW_ROUTER_EXPECTED_RECOVERY_WITNESS_SHA256: string;
      REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL?: string;
    }>
  >
>;

export type TargetServiceContract = Readonly<{
  serviceId: string;
  imageUrl: string;
  environmentDelta: Readonly<Record<string, string>>;
  removeKeys: readonly string[];
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

export interface ServiceTransitionLedger extends RecoveryEffectAuthorityPort {
  begin(input: {
    rolloutId: string;
    manifestSha256: string;
    targetContractSha256: string;
    serviceIds: readonly string[];
    sourceManifest: SourceRecoveryManifest;
    targetContracts: readonly Omit<TargetServiceContract, "environmentDelta">[];
  }): Promise<"created" | "existing">;
  readContract(rolloutId: string): Promise<{
    sourceManifest: SourceRecoveryManifest;
    targetContracts: readonly Omit<TargetServiceContract, "environmentDelta">[];
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
    input: {
      set: Readonly<Record<string, string>>;
      remove: readonly string[];
      expectedBeforeSha256?: string;
    },
  ): Promise<string>;
  captureSourceManifest(input: {
    rolloutId: string;
    services: readonly Readonly<{
      serviceId: string;
      databaseEnvKey: string;
      databaseRole: string;
    }>[];
    protectedEnvironment: ProtectedSourceEnvironment;
  }): Promise<SourceRecoveryManifest>;
  planEnvironmentDelta(input: {
    serviceId: string;
    set: Readonly<Record<string, string>>;
    remove: readonly string[];
    expectedBeforeSha256: string;
  }): Promise<{ environmentSha256: string; environmentKeysSha256: string }>;
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
export const environmentKeysSha256 = (
  values: readonly Readonly<{ key: string; value: string }>[],
): string => sha256(canonicalEnv(values).map(({ key }) => key));

export const sourceRecoveryManifestSha256 = (
  value: Omit<SourceRecoveryManifest, "manifestSha256">,
): string => sha256(value);

const withoutHash = <T extends Record<string, unknown>>(
  value: T,
  field: keyof T,
): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));

export const sourceServiceContractSha256 = (
  value: Omit<RenderServiceContract, "serviceContractSha256">,
): string =>
  sha256({
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
  value: Pick<
    TargetServiceContract,
    "serviceId" | "imageUrl" | "environmentSha256"
  >,
): string =>
  sha256({
    serviceId: value.serviceId,
    runtime: "image",
    imageUrl: value.imageUrl,
    environmentSha256: value.environmentSha256,
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
    sha256(
      withoutHash(
        source as unknown as Record<string, unknown>,
        "manifestSha256",
      ),
    ) !== source.manifestSha256 ||
    source.services.length !== 3 ||
    target.length !== 3
  )
    throw new Error("service_transition_manifest_invalid");
  const sourceIds = source.services.map((item) => item.serviceId);
  if (
    new Set(sourceIds).size !== 3 ||
    sourceIds.join("\0") !== target.map((item) => item.serviceId).join("\0")
  )
    throw new Error("service_transition_scope_invalid");
  for (const service of source.services) {
    const originals = protectedEnvironment[service.serviceId];
    const requiresEffectAuthority =
      service.databaseRole === "reviewrouter_api" ||
      service.databaseRole === "reviewrouter_web";
    const expectedProtectedKeys = [
      "DATABASE_URL",
      "REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS",
      "REVIEW_ROUTER_EXPECTED_RECOVERY_WITNESS_SHA256",
      ...(requiresEffectAuthority
        ? ["REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL"]
        : []),
    ].sort();
    if (
      service.runtime !== "node" ||
      service.autoDeploy !== "no" ||
      !commit.test(service.sourceCommitSha) ||
      !digest.test(service.sourceEnvSha256) ||
      !digest.test(service.sourceEnvKeysSha256) ||
      !digest.test(service.serviceContractSha256) ||
      sourceServiceContractSha256(
        withoutHash(
          service as unknown as Record<string, unknown>,
          "serviceContractSha256",
        ) as Omit<RenderServiceContract, "serviceContractSha256">,
      ) !== service.serviceContractSha256 ||
      !originals ||
      typeof originals.DATABASE_URL !== "string" ||
      typeof originals.REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS !== "string" ||
      !witness.test(originals.REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS) ||
      !rawSha256.test(
        originals.REVIEW_ROUTER_EXPECTED_RECOVERY_WITNESS_SHA256,
      ) ||
      (requiresEffectAuthority &&
        typeof originals.REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL !==
          "string") ||
      witnessSha256(originals.REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS) !==
        originals.REVIEW_ROUTER_EXPECTED_RECOVERY_WITNESS_SHA256 ||
      Object.keys(originals).sort().join("\0") !==
        expectedProtectedKeys.join("\0")
    )
      throw new Error("service_transition_source_contract_invalid");
  }
  for (const service of target) {
    const sourceService = source.services.find(
      (item) => item.serviceId === service.serviceId,
    )!;
    const requiresEffectAuthority =
      sourceService.databaseRole === "reviewrouter_api" ||
      sourceService.databaseRole === "reviewrouter_web";
    const expectedSet = [
      "DATABASE_URL",
      "REVIEW_ROUTER_EXPECTED_RECOVERY_WITNESS_SHA256",
      "REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS",
      "REVIEW_ROUTER_RUNTIME_RELEASE_COMMIT_SHA",
      "REVIEW_ROUTER_RUNTIME_ROLLOUT_ID",
      "REVIEW_ROUTER_RUNTIME_ROLLOUT_STARTED_AT",
      ...(requiresEffectAuthority
        ? ["REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL"]
        : []),
    ];
    if (
      !image.test(service.imageUrl) ||
      !digest.test(service.environmentSha256) ||
      Object.keys(service.environmentDelta).sort().join("\0") !==
        expectedSet.sort().join("\0") ||
      !rawSha256.test(
        service.environmentDelta[
          "REVIEW_ROUTER_EXPECTED_RECOVERY_WITNESS_SHA256"
        ] ?? "",
      ) ||
      !witness.test(
        service.environmentDelta["REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS"] ??
          "",
      ) ||
      witnessSha256(
        service.environmentDelta["REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS"] ??
          "",
      ) !==
        service.environmentDelta[
          "REVIEW_ROUTER_EXPECTED_RECOVERY_WITNESS_SHA256"
        ] ||
      service.removeKeys.length !== 0 ||
      targetServiceContractSha256({
        serviceId: service.serviceId,
        imageUrl: service.imageUrl,
        environmentSha256: service.environmentSha256,
      }) !== service.serviceContractSha256
    )
      throw new Error("service_transition_target_contract_invalid");
  }
  return sha256(
    target.map(
      ({ serviceId, imageUrl, environmentSha256, serviceContractSha256 }) => ({
        serviceId,
        imageUrl,
        environmentSha256,
        serviceContractSha256,
      }),
    ),
  );
}

export class TransactionalServiceCutover {
  private readonly recoveryEffects: RecoveryEffectProtocol;
  constructor(
    private readonly ledger: ServiceTransitionLedger,
    private readonly provider: TransactionalRenderProvider,
    private readonly recoveryOwnerId: string,
  ) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(recoveryOwnerId))
      throw new Error("service_transition_recovery_owner_invalid");
    this.recoveryEffects = new RecoveryEffectProtocol(ledger);
  }

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
      throw new Error("service_transition_interrupted_recovery_required");
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
    const deployIds: string[] = [];
    const transition = await this.ledger.begin({
      ...common,
      serviceIds: input.source.services.map((item) => item.serviceId),
      sourceManifest: input.source,
      targetContracts: input.target.map((item) => ({
        serviceId: item.serviceId,
        imageUrl: item.imageUrl,
        removeKeys: item.removeKeys,
        environmentSha256: item.environmentSha256,
        serviceContractSha256: item.serviceContractSha256,
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
      const envHash = await this.provider.replaceEnvironment(
        contract.serviceId,
        {
          set: contract.environmentDelta,
          remove: contract.removeKeys,
          expectedBeforeSha256: source.sourceEnvSha256,
        },
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
      await this.provider.quiesceDeploys(contract.serviceId);
      const beforeRestore = await this.provider.observe(contract.serviceId);
      if (!beforeRestore.suspended)
        throw new Error("service_transition_recovery_quiescence_unproven");
      const target = input.target.find(
        (item) => item.serviceId === contract.serviceId,
      )!;
      if (
        beforeRestore.environmentSha256 !== contract.sourceEnvSha256 &&
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
              observed.serviceContractSha256 === contract.serviceContractSha256
              ? observed
              : null;
          },
          observe: async (observed) => ({
            serviceId: contract.serviceId,
            serviceContractSha256: observed.serviceContractSha256,
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
          beforeRestore.environmentSha256 === contract.sourceEnvSha256
            ? contract.sourceEnvSha256
            : await this.provider.replaceEnvironment(contract.serviceId, {
                set: sourceEnv,
                remove: [
                  "REVIEW_ROUTER_RUNTIME_RELEASE_COMMIT_SHA",
                  "REVIEW_ROUTER_RUNTIME_ROLLOUT_ID",
                  "REVIEW_ROUTER_RUNTIME_ROLLOUT_STARTED_AT",
                ],
                expectedBeforeSha256: target.environmentSha256,
              }),
        reconcileConsumed: async () => {
          const observed = await this.provider.observe(contract.serviceId);
          return observed.environmentSha256 === contract.sourceEnvSha256
            ? observed.environmentSha256
            : null;
        },
        observe: async (environmentSha256) => ({
          serviceId: contract.serviceId,
          environmentSha256,
        }),
      });
      await this.requireCompletedRecoveryEffect(envEffect);
      const envHash = contract.sourceEnvSha256;
      if (envHash !== contract.sourceEnvSha256)
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
            (await this.provider.reconcileCommitDeploy({
              serviceId: contract.serviceId,
              commitSha: contract.sourceCommitSha,
              intentAt: persistedIntentAt ?? restoreIntentAt,
            })) ??
            (await this.provider.deployCommit(
              contract.serviceId,
              contract.sourceCommitSha,
            ));
          await this.provider.waitForDeploy(contract.serviceId, deployId, {
            kind: "git",
            commitSha: contract.sourceCommitSha,
          });
          return deployId;
        },
        reconcileConsumed: async () => {
          const deployId = await this.provider.reconcileCommitDeploy({
            serviceId: contract.serviceId,
            commitSha: contract.sourceCommitSha,
            intentAt: persistedIntentAt ?? restoreIntentAt,
          });
          if (!deployId) return null;
          await this.provider.waitForDeploy(contract.serviceId, deployId, {
            kind: "git",
            commitSha: contract.sourceCommitSha,
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
          serviceContractSha256: observed.serviceContractSha256,
          environmentSha256: observed.environmentSha256,
        }),
      });
      await this.requireCompletedRecoveryEffect(resumeEffect);
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
      const deployId = [...checkpoints]
        .reverse()
        .find(
          (item) =>
            item.serviceId === service.serviceId &&
            item.step === "source_verified",
        )?.deployId;
      if (!deployId)
        throw new Error("service_transition_source_deploy_checkpoint_missing");
      deployIds.push(deployId);
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
