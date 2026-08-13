import {
  environmentKeysSha256,
  environmentSha256,
  sourceRecoveryManifestSha256,
  sourceServiceContractSha256,
  targetServiceContractSha256,
  type ObservedRenderService,
  type EnvironmentMutationOutcome,
  type RenderServiceContract,
  type TargetServiceContract,
  type ProtectedSourceEnvironment,
  type SourceRecoveryManifest,
  type TransactionalRenderProvider,
} from "../application/transactional-service-cutover";
import { RenderApiAdapter, type RenderFetch } from "./render-api";

const active = new Set([
  "created",
  "queued",
  "build_in_progress",
  "update_in_progress",
  "pre_deploy_in_progress",
]);
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const latestLive = <
  T extends { status: string; createdAt?: string; id: string },
>(
  deploys: readonly T[],
): T => {
  const live = deploys
    .filter(
      (item) =>
        item.status === "live" &&
        item.createdAt &&
        Number.isFinite(Date.parse(item.createdAt)),
    )
    .sort(
      (a, b) =>
        Date.parse(b.createdAt!) - Date.parse(a.createdAt!) ||
        b.id.localeCompare(a.id),
    );
  if (!live[0] || (live[1] && live[1].createdAt === live[0].createdAt))
    throw new Error("service_transition_current_live_deploy_ambiguous");
  return live[0];
};

export class RenderTransactionalServicesAdapter implements TransactionalRenderProvider {
  private readonly api: RenderApiAdapter;
  constructor(
    apiKey: string,
    fetchImpl: RenderFetch = fetch,
    private readonly sleep: (milliseconds: number) => Promise<void> = (
      milliseconds,
    ) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {
    this.api = new RenderApiAdapter(apiKey, fetchImpl);
  }

  async observe(serviceId: string): Promise<ObservedRenderService> {
    const [service, environment, deploys] = await Promise.all([
      this.api.getService(serviceId),
      this.api.listAllEnv(serviceId),
      this.api.listAllDeploys(serviceId),
    ]);
    if (deploys.some((item) => active.has(item.status)))
      throw new Error("service_transition_active_deploy_present");
    const live = latestLive(deploys);
    const details = record(service.serviceDetails);
    const specific = record(details.envSpecificDetails);
    const runtime = details.runtime ?? specific.runtime;
    const imagePath =
      service.imagePath ?? service.image?.imagePath ?? details.imagePath;
    const sourceContract = {
      serviceId: service.id,
      ownerId: service.ownerId,
      type: service.type,
      runtime,
      repository: service.repo,
      branch: service.branch,
      rootDir: service.rootDir ?? "",
      buildCommand: specific.buildCommand ?? details.buildCommand ?? "",
      startCommand: specific.startCommand ?? details.startCommand ?? "",
      preDeployCommand:
        specific.preDeployCommand ?? details.preDeployCommand ?? "",
      healthCheckPath:
        specific.healthCheckPath ?? details.healthCheckPath ?? null,
      region: details.region,
      plan: details.plan,
      maxShutdownDelaySeconds: details.maxShutdownDelaySeconds,
      autoDeploy: service.autoDeploy,
    };
    if (
      (runtime !== "node" && runtime !== "image") ||
      typeof details.region !== "string" ||
      typeof details.plan !== "string" ||
      typeof details.maxShutdownDelaySeconds !== "number"
    )
      throw new Error("service_transition_provider_contract_incomplete");
    if (
      runtime === "node" &&
      (![service.repo, service.branch].every(
        (item) => typeof item === "string",
      ) ||
        typeof specific.buildCommand !== "string" ||
        typeof specific.startCommand !== "string" ||
        typeof (specific.preDeployCommand ?? details.preDeployCommand) !==
          "string")
    )
      throw new Error("service_transition_native_contract_incomplete");
    const serviceContractSha256 =
      runtime === "image" && typeof imagePath === "string"
        ? targetServiceContractSha256({
            serviceId,
            imageUrl: imagePath,
            environmentSha256: environmentSha256(environment),
          })
        : sourceServiceContractSha256({
            ...(sourceContract as Omit<
              RenderServiceContract,
              "serviceContractSha256"
            >),
            sourceCommitSha: live.commit?.id ?? "",
            databaseEnvKey: "DATABASE_URL",
            databaseRole: "provider-observed-separately",
            sourceEnvSha256: environmentSha256(environment),
          });
    return {
      serviceId,
      suspended: service.suspended === "suspended",
      serviceContractSha256,
      environmentSha256: environmentSha256(environment),
      provenance:
        runtime === "image" && typeof imagePath === "string" && live.image
          ? { kind: "image", imageUrl: imagePath, deployId: live.id }
          : live.commit
            ? { kind: "git", commitSha: live.commit.id }
            : (() => {
                throw new Error("service_transition_provenance_unproven");
              })(),
    };
  }

  async suspend(serviceId: string): Promise<void> {
    const service = await this.api.getService(serviceId);
    if (service.suspended !== "suspended") await this.api.suspend(serviceId);
    await this.waitForSuspension(serviceId, true);
  }

  async resume(serviceId: string): Promise<void> {
    const service = await this.api.getService(serviceId);
    if (service.suspended !== "not_suspended") await this.api.resume(serviceId);
    await this.waitForSuspension(serviceId, false);
  }

  async configureTarget(contract: TargetServiceContract): Promise<void> {
    await this.api.patchService(contract.serviceId, {
      autoDeployTrigger: "off",
      image: { imagePath: contract.imageUrl },
      serviceDetails: { runtime: "image", preDeployCommand: "" },
    });
    await this.waitForTargetConfiguration(contract);
  }

  async configureSource(contract: RenderServiceContract): Promise<void> {
    await this.api.patchService(contract.serviceId, {
      autoDeployTrigger: "off",
      repo: contract.repository,
      branch: contract.branch,
      rootDir: contract.rootDir,
      serviceDetails: {
        runtime: "node",
        envSpecificDetails: {
          buildCommand: contract.buildCommand,
          startCommand: contract.startCommand,
        },
        preDeployCommand: contract.preDeployCommand,
        healthCheckPath: contract.healthCheckPath,
        region: contract.region,
        plan: contract.plan,
        maxShutdownDelaySeconds: contract.maxShutdownDelaySeconds,
      },
    });
    await this.waitForContract(
      contract.serviceId,
      contract.serviceContractSha256,
    );
  }

  async replaceEnvironment(
    serviceId: string,
    input: {
      set: Readonly<Record<string, string>>;
      remove: readonly string[];
      expectedBeforeSha256?: string;
      expectedAfterSha256: string;
    },
  ): Promise<EnvironmentMutationOutcome> {
    return this.api.patchEnvPreservingAll({ serviceId, ...input });
  }

  async planEnvironmentDelta(input: {
    serviceId: string;
    set: Readonly<Record<string, string>>;
    remove: readonly string[];
    expectedBeforeSha256: string;
  }): Promise<{ environmentSha256: string; environmentKeysSha256: string }> {
    const value = await this.api.planEnvPatch(input);
    return {
      environmentSha256: value.environmentSha256,
      environmentKeysSha256: value.keysSha256,
    };
  }

  async captureSourceManifest(input: {
    rolloutId: string;
    services: readonly Readonly<{
      serviceId: string;
      databaseEnvKey: string;
      databaseRole: string;
    }>[];
    protectedEnvironment: ProtectedSourceEnvironment;
  }): Promise<SourceRecoveryManifest> {
    if (input.services.length !== 3)
      throw new Error("service_transition_scope_invalid");
    const services: RenderServiceContract[] = [];
    for (const expected of input.services) {
      if (expected.databaseEnvKey !== "DATABASE_URL")
        throw new Error("service_transition_database_env_key_invalid");
      const [service, environment, deploys] = await Promise.all([
        this.api.getService(expected.serviceId),
        this.api.listAllEnv(expected.serviceId),
        this.api.listAllDeploys(expected.serviceId),
      ]);
      const live = latestLive(deploys);
      const env = new Map(environment.map(({ key, value }) => [key, value]));
      const protectedValues = input.protectedEnvironment[expected.serviceId];
      if (
        service.id !== expected.serviceId ||
        service.suspended !== "suspended" ||
        service.autoDeploy !== "no" ||
        deploys.some((item) => active.has(item.status)) ||
        !live?.commit?.id ||
        live.image ||
        !["web_service", "background_worker"].includes(service.type) ||
        !protectedValues ||
        env.get("DATABASE_URL") !== protectedValues.DATABASE_URL ||
        env.get("REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS") !==
          protectedValues.REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS ||
        env.get("REVIEW_ROUTER_EXPECTED_RECOVERY_WITNESS_SHA256") !==
          protectedValues.REVIEW_ROUTER_EXPECTED_RECOVERY_WITNESS_SHA256 ||
        (protectedValues.REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL !==
          undefined &&
          env.get("REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL") !==
            protectedValues.REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL) ||
        [
          "REVIEW_ROUTER_RUNTIME_RELEASE_COMMIT_SHA",
          "REVIEW_ROUTER_RUNTIME_ROLLOUT_ID",
          "REVIEW_ROUTER_RUNTIME_ROLLOUT_STARTED_AT",
        ].some((key) => env.has(key))
      )
        throw new Error("service_transition_source_capture_mismatch");
      const details = record(service.serviceDetails);
      const specific = record(details.envSpecificDetails);
      if (
        (details.runtime ?? specific.runtime) !== "node" ||
        typeof service.repo !== "string" ||
        typeof service.branch !== "string" ||
        typeof specific.buildCommand !== "string" ||
        typeof specific.startCommand !== "string" ||
        typeof (specific.preDeployCommand ?? details.preDeployCommand) !==
          "string" ||
        typeof details.region !== "string" ||
        typeof details.plan !== "string" ||
        typeof details.maxShutdownDelaySeconds !== "number"
      )
        throw new Error("service_transition_source_capture_incomplete");
      const value = {
        serviceId: service.id,
        ownerId: service.ownerId,
        type: service.type as RenderServiceContract["type"],
        runtime: "node" as const,
        repository: service.repo,
        branch: service.branch,
        rootDir: service.rootDir ?? "",
        sourceCommitSha: live.commit.id,
        buildCommand: specific.buildCommand,
        startCommand: specific.startCommand,
        preDeployCommand: (specific.preDeployCommand ??
          details.preDeployCommand) as string,
        healthCheckPath: (specific.healthCheckPath ??
          details.healthCheckPath ??
          null) as string | null,
        region: details.region,
        plan: details.plan,
        maxShutdownDelaySeconds: details.maxShutdownDelaySeconds,
        autoDeploy: "no" as const,
        databaseEnvKey: expected.databaseEnvKey,
        databaseRole: expected.databaseRole,
        sourceEnvSha256: environmentSha256(environment),
        sourceEnvKeysSha256: environmentKeysSha256(environment),
      };
      services.push({
        ...value,
        serviceContractSha256: sourceServiceContractSha256(value),
      });
    }
    const manifest = {
      schemaVersion: "reviewrouter.render-source-recovery.v1" as const,
      rolloutId: input.rolloutId,
      services: Object.freeze(services),
    };
    return {
      ...manifest,
      manifestSha256: sourceRecoveryManifestSha256(manifest),
    };
  }

  async deployImage(serviceId: string, imageUrl: string): Promise<string> {
    if (!imageUrl.includes("@sha256:"))
      throw new Error("service_transition_image_digest_invalid");
    const deploy = await this.api.createPinnedDeploy(serviceId);
    return deploy.id;
  }

  async deployCommit(serviceId: string, commitSha: string): Promise<string> {
    const deploy = await this.api.createPinnedDeploy(serviceId, commitSha);
    return deploy.id;
  }

  async waitForDeploy(
    serviceId: string,
    deployId: string,
    expected:
      | { kind: "image"; imageUrl: string }
      | { kind: "git"; commitSha: string },
  ): Promise<void> {
    for (let attempt = 0; attempt < 90; attempt += 1) {
      const selected = await this.api.getDeploy(serviceId, deployId);
      if (selected.status === "live") {
        if (expected.kind === "git") {
          if (selected.commit?.id !== expected.commitSha || selected.image)
            throw new Error("service_transition_deploy_provenance_mismatch");
        } else {
          const expectedDigest = expected.imageUrl.slice(
            expected.imageUrl.indexOf("sha256:") + 7,
          );
          const actualDigest = selected.image?.sha.replace(/^sha256:/u, "");
          if (
            actualDigest !== expectedDigest ||
            selected.commit ||
            (selected.image?.ref !== undefined &&
              selected.image.ref !== expected.imageUrl)
          )
            throw new Error("service_transition_deploy_provenance_mismatch");
        }
        return;
      }
      if (selected && !active.has(selected.status))
        throw new Error("service_transition_deploy_failed");
      await this.sleep(2_000);
    }
    throw new Error("service_transition_deploy_timeout");
  }

  async reconcileCommitDeploy(input: {
    serviceId: string;
    commitSha: string;
    intentAt: string;
  }): Promise<string | null> {
    const intentTime = Date.parse(input.intentAt);
    if (!Number.isFinite(intentTime))
      throw new Error("service_transition_deploy_intent_time_invalid");
    await this.quiesceDeploys(input.serviceId);
    const candidates = (await this.api.listAllDeploys(input.serviceId)).filter(
      (deploy) =>
        deploy.status === "live" &&
        deploy.commit?.id === input.commitSha &&
        !deploy.image &&
        typeof deploy.createdAt === "string" &&
        Date.parse(deploy.createdAt) >= intentTime - 1_000,
    );
    if (candidates.length > 1)
      throw new Error("service_transition_deploy_reconciliation_ambiguous");
    return candidates[0]?.id ?? null;
  }

  async quiesceDeploys(serviceId: string): Promise<void> {
    for (let attempt = 0; attempt < 90; attempt += 1) {
      const deploys = await this.api.listAllDeploys(serviceId);
      if (!deploys.some((deploy) => active.has(deploy.status))) return;
      await this.sleep(2_000);
    }
    throw new Error("service_transition_active_deploy_timeout");
  }

  private async waitForSuspension(
    serviceId: string,
    suspended: boolean,
  ): Promise<void> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const observed = await this.api.getService(serviceId);
      if ((observed.suspended === "suspended") === suspended) return;
      await this.sleep(2_000);
    }
    throw new Error("service_transition_suspension_unproven");
  }

  private async waitForContract(
    serviceId: string,
    expected: string,
  ): Promise<void> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        if ((await this.observe(serviceId)).serviceContractSha256 === expected)
          return;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.message !== "service_transition_active_deploy_present"
        )
          throw error;
      }
      await this.sleep(2_000);
    }
    throw new Error("service_transition_configuration_unproven");
  }

  private async waitForTargetConfiguration(
    contract: TargetServiceContract,
  ): Promise<void> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const service = await this.api.getService(contract.serviceId);
      const details = record(service.serviceDetails);
      const specific = record(details.envSpecificDetails);
      const runtime = details.runtime ?? specific.runtime;
      const imagePath =
        service.imagePath ?? service.image?.imagePath ?? details.imagePath;
      if (
        service.id === contract.serviceId &&
        service.autoDeploy === "no" &&
        runtime === "image" &&
        imagePath === contract.imageUrl &&
        (specific.preDeployCommand ?? details.preDeployCommand ?? "") === ""
      )
        return;
      await this.sleep(2_000);
    }
    throw new Error("service_transition_target_configuration_unproven");
  }
}
