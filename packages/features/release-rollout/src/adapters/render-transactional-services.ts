import {
  environmentKeysSha256,
  environmentSha256,
  targetServiceConfigurationSha256,
  type ObservedServiceState,
  type TargetServiceRelease,
  type ProtectedSourceEnvironment,
  type SourceRecoveryManifest,
  type SourceServiceSnapshot,
} from "../domain/service-transition";
import type {
  EnvironmentMutationOutcome,
  ExpectedSourceDeployment,
  TransactionalServiceProvider,
} from "../application/service-transition-ports";
import {
  RENDER_SOURCE_CONFIGURATION_FORMAT,
  RENDER_SOURCE_RECOVERY_FORMAT,
  fromRenderSourceRecoveryManifestV1,
  renderSourceRecoveryManifestSha256,
  renderSourceConfigurationV1,
  renderSourceServiceContractSha256,
  type RenderSourceServiceContractV1,
} from "./render-service-transition-compatibility";
import { RenderApiAdapter, type RenderFetch } from "./render-api";
import type { ProviderMutationAuthorityPort } from "../application/provider-mutation-authority";
import { AuthorizedRenderMutations } from "./authorized-render-mutations";
import {
  normalizeRenderServicePostcondition,
  RenderServiceContractMatcher,
} from "./render-service-contract";

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

export class RenderTransactionalServicesAdapter implements TransactionalServiceProvider {
  private readonly api: RenderApiAdapter;
  private readonly mutations: AuthorizedRenderMutations | undefined;
  constructor(
    apiKey: string,
    fetchImpl: RenderFetch = fetch,
    private readonly sleep: (milliseconds: number) => Promise<void> = (
      milliseconds,
    ) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    mutationAuthority?: ProviderMutationAuthorityPort,
    private readonly mutationContext?: Readonly<{
      rolloutId: string;
      ownerId: string;
    }>,
  ) {
    this.api = new RenderApiAdapter(apiKey, fetchImpl);
    this.mutations = mutationAuthority
      ? new AuthorizedRenderMutations(this.api, mutationAuthority, this.sleep)
      : undefined;
  }

  private mutation(operation: string) {
    if (!this.mutations || !this.mutationContext)
      throw new Error("render_mutation_authority_missing");
    return {
      mutations: this.mutations,
      context: { ...this.mutationContext, operation },
    };
  }

  async observe(serviceId: string): Promise<ObservedServiceState> {
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
      numInstances: details.numInstances,
      autoDeploy: service.autoDeploy,
    };
    if (
      (runtime !== "node" && runtime !== "image") ||
      typeof details.region !== "string" ||
      typeof details.plan !== "string" ||
      typeof details.maxShutdownDelaySeconds !== "number" ||
      typeof details.numInstances !== "number" ||
      service.autoDeployTrigger !== "off"
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
          "string" ||
        ![specific.healthCheckPath ?? details.healthCheckPath].every(
          (item) => item === null || typeof item === "string",
        ))
    )
      throw new Error("service_transition_native_contract_incomplete");
    const observedContract =
      runtime === "image" && typeof imagePath === "string"
        ? new RenderServiceContractMatcher({
            serviceId,
            ownerId: service.ownerId,
            serviceType: service.type,
            runtime,
            imagePath,
            autoDeploy: "no",
            autoDeployTrigger: "off",
            preDeployCommand: String(sourceContract.preDeployCommand),
            region: String(sourceContract.region),
            plan: String(sourceContract.plan),
            maxShutdownDelaySeconds: Number(
              sourceContract.maxShutdownDelaySeconds,
            ),
            numInstances: Number(sourceContract.numInstances),
          })
        : runtime === "node"
          ? new RenderServiceContractMatcher({
              serviceId,
              ownerId: service.ownerId,
              serviceType: service.type,
              runtime,
              imagePath: null,
              repository: String(sourceContract.repository),
              branch: String(sourceContract.branch),
              rootDir: String(sourceContract.rootDir),
              buildCommand: String(sourceContract.buildCommand),
              startCommand: String(sourceContract.startCommand),
              preDeployCommand: String(sourceContract.preDeployCommand),
              healthCheckPath: sourceContract.healthCheckPath as string | null,
              region: String(sourceContract.region),
              plan: String(sourceContract.plan),
              maxShutdownDelaySeconds: Number(
                sourceContract.maxShutdownDelaySeconds,
              ),
              numInstances: Number(sourceContract.numInstances),
              autoDeploy: "no",
              autoDeployTrigger: "off",
            })
          : undefined;
    if (!observedContract?.matches(service))
      throw new Error("service_transition_provider_contract_incomplete");
    const configurationSha256 =
      runtime === "image" && typeof imagePath === "string"
        ? targetServiceConfigurationSha256({
            serviceId,
            artifact: { kind: "container_image", reference: imagePath },
            environmentSha256: environmentSha256(environment),
          })
        : renderSourceServiceContractSha256({
            ...(sourceContract as Omit<
              RenderSourceServiceContractV1,
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
      configurationSha256,
      environmentSha256: environmentSha256(environment),
      postcondition: normalizeRenderServicePostcondition(
        service,
        environmentSha256(environment),
      ),
      provenance:
        runtime === "image" && typeof imagePath === "string" && live.image
          ? {
              kind: "container_image",
              reference: imagePath,
              deploymentId: live.id,
            }
          : live.commit
            ? {
                kind: "source_revision",
                revision: live.commit.id,
                deploymentId: live.id,
              }
            : (() => {
                throw new Error("service_transition_provenance_unproven");
              })(),
    };
  }

  async suspend(serviceId: string): Promise<void> {
    const service = await this.api.getService(serviceId);
    if (service.suspended !== "suspended") {
      const { mutations, context } = this.mutation(
        `service_suspend:${serviceId}`,
      );
      await mutations.suspend(context, serviceId);
    }
    await this.waitForSuspension(serviceId, true);
  }

  async resume(
    serviceId: string,
    expected: ObservedServiceState,
    expectedDeployment: ExpectedSourceDeployment,
  ): Promise<void> {
    if (
      expected.serviceId !== serviceId ||
      !expected.suspended ||
      !expected.postcondition ||
      !expected.postcondition.suspended
    )
      throw new Error("service_transition_resume_postcondition_invalid");
    if (
      expected.provenance.kind !== "source_revision" ||
      expectedDeployment.provenance.kind !== "source_revision" ||
      expected.provenance.deploymentId !== expectedDeployment.deploymentId ||
      expected.provenance.revision !== expectedDeployment.provenance.revision
    )
      throw new Error("service_transition_resume_deployment_invalid");
    const { mutations, context } = this.mutation(`service_resume:${serviceId}`);
    await mutations.resumeExact(context, expected.postcondition, {
      deployId: expectedDeployment.deploymentId,
      provenance: {
        kind: "git",
        commitSha: expectedDeployment.provenance.revision,
      },
    });
    const after = await this.observe(serviceId);
    if (
      !after.postcondition ||
      after.postcondition.suspended ||
      JSON.stringify(after.postcondition) !==
        JSON.stringify({ ...expected.postcondition, suspended: false })
    )
      throw new Error("service_transition_resume_postcondition_unproven");
  }

  async configureTarget(contract: TargetServiceRelease): Promise<void> {
    const current = await this.api.getService(contract.serviceId);
    const currentDetails = record(current.serviceDetails);
    if (
      typeof currentDetails.region !== "string" ||
      typeof currentDetails.plan !== "string" ||
      typeof currentDetails.maxShutdownDelaySeconds !== "number" ||
      typeof currentDetails.numInstances !== "number"
    )
      throw new Error("service_transition_operational_contract_incomplete");
    const expected = new RenderServiceContractMatcher({
      serviceId: contract.serviceId,
      ownerId: current.ownerId,
      serviceType: current.type,
      runtime: "image",
      imagePath: contract.artifact.reference,
      autoDeploy: "no",
      autoDeployTrigger: "off",
      preDeployCommand: "",
      region: currentDetails.region,
      plan: currentDetails.plan,
      maxShutdownDelaySeconds: currentDetails.maxShutdownDelaySeconds,
      numInstances: currentDetails.numInstances,
    });
    const { mutations, context } = this.mutation(
      `configure_target:${contract.serviceId}`,
    );
    await mutations.patchService(
      context,
      contract.serviceId,
      {
        autoDeployTrigger: "off",
        image: { imagePath: contract.artifact.reference },
        serviceDetails: {
          runtime: "image",
          preDeployCommand: "",
          region: currentDetails.region,
          plan: currentDetails.plan,
          maxShutdownDelaySeconds: currentDetails.maxShutdownDelaySeconds,
          numInstances: currentDetails.numInstances,
        },
      },
      (service) => expected.matches(service),
    );
    await this.waitForServiceContract(
      expected,
      "service_transition_target_configuration_unproven",
    );
  }

  async configureSource(contract: SourceServiceSnapshot): Promise<void> {
    if (contract.configuration.format !== RENDER_SOURCE_CONFIGURATION_FORMAT)
      throw new Error("render_service_transition_configuration_format_invalid");
    const configuration = renderSourceConfigurationV1(contract);
    let numInstances = configuration.numInstances;
    if (numInstances === undefined) {
      const current = await this.api.getService(contract.serviceId);
      const currentDetails = record(current.serviceDetails);
      if (typeof currentDetails.numInstances !== "number")
        throw new Error("service_transition_instance_count_unobserved");
      numInstances = currentDetails.numInstances;
    }
    const expected = new RenderServiceContractMatcher({
      serviceId: contract.serviceId,
      ownerId: configuration.ownerId,
      serviceType: configuration.type,
      runtime: "node",
      imagePath: null,
      repository: configuration.repository,
      branch: configuration.branch,
      rootDir: configuration.rootDir,
      buildCommand: configuration.buildCommand,
      startCommand: configuration.startCommand,
      preDeployCommand: configuration.preDeployCommand,
      healthCheckPath: configuration.healthCheckPath,
      region: configuration.region,
      plan: configuration.plan,
      maxShutdownDelaySeconds: configuration.maxShutdownDelaySeconds,
      numInstances,
      autoDeploy: "no",
      autoDeployTrigger: "off",
    });
    const { mutations, context } = this.mutation(
      `configure_source:${contract.serviceId}`,
    );
    await mutations.patchService(
      context,
      contract.serviceId,
      {
        autoDeployTrigger: "off",
        repo: String(configuration.repository),
        branch: String(configuration.branch),
        rootDir: String(configuration.rootDir),
        serviceDetails: {
          runtime: "node",
          envSpecificDetails: {
            buildCommand: String(configuration.buildCommand),
            startCommand: String(configuration.startCommand),
          },
          preDeployCommand: String(configuration.preDeployCommand),
          healthCheckPath: configuration.healthCheckPath as string | null,
          region: String(configuration.region),
          plan: String(configuration.plan),
          maxShutdownDelaySeconds: Number(
            configuration.maxShutdownDelaySeconds,
          ),
          ...(configuration.numInstances === undefined
            ? {}
            : { numInstances: Number(configuration.numInstances) }),
        },
      },
      (service) => expected.matches(service),
    );
    await this.waitForServiceContract(
      expected,
      "service_transition_configuration_unproven",
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
    const { mutations, context } = this.mutation(
      `replace_environment:${serviceId}:${input.expectedAfterSha256}`,
    );
    return mutations.replaceEnvironment(context, { serviceId, ...input });
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
    const services: RenderSourceServiceContractV1[] = [];
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
          "REVIEW_ROUTER_RUNTIME_SERVICE_ID",
          "REVIEW_ROUTER_RUNTIME_DEPLOYMENT_PROVENANCE",
        ].some((key) => env.has(key))
      )
        throw new Error("service_transition_source_capture_mismatch");
      const details = record(service.serviceDetails);
      const specific = record(details.envSpecificDetails);
      if (
        (details.runtime ?? specific.runtime) !== "node" ||
        typeof service.repo !== "string" ||
        typeof service.branch !== "string" ||
        typeof service.rootDir !== "string" ||
        typeof specific.buildCommand !== "string" ||
        typeof specific.startCommand !== "string" ||
        typeof (specific.preDeployCommand ?? details.preDeployCommand) !==
          "string" ||
        ![specific.healthCheckPath ?? details.healthCheckPath].every(
          (item) => item === null || typeof item === "string",
        ) ||
        typeof details.region !== "string" ||
        typeof details.plan !== "string" ||
        typeof details.maxShutdownDelaySeconds !== "number" ||
        typeof details.numInstances !== "number" ||
        service.autoDeployTrigger !== "off"
      )
        throw new Error("service_transition_source_capture_incomplete");
      const value = {
        serviceId: service.id,
        ownerId: service.ownerId,
        type: service.type as RenderSourceServiceContractV1["type"],
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
        numInstances: details.numInstances,
        autoDeploy: "no" as const,
        databaseEnvKey: expected.databaseEnvKey,
        databaseRole: expected.databaseRole,
        sourceEnvSha256: environmentSha256(environment),
        sourceEnvKeysSha256: environmentKeysSha256(environment),
      };
      services.push({
        ...value,
        serviceContractSha256: renderSourceServiceContractSha256(value),
      });
    }
    const manifest: Omit<
      import("./render-service-transition-compatibility").RenderSourceRecoveryManifestV1,
      "manifestSha256"
    > = {
      schemaVersion: RENDER_SOURCE_RECOVERY_FORMAT,
      rolloutId: input.rolloutId,
      services: Object.freeze(services),
    };
    return fromRenderSourceRecoveryManifestV1({
      ...manifest,
      manifestSha256: renderSourceRecoveryManifestSha256(manifest),
    });
  }

  async deployArtifact(serviceId: string, reference: string): Promise<string> {
    if (!reference.includes("@sha256:"))
      throw new Error("service_transition_image_digest_invalid");
    const { mutations, context } = this.mutation(
      `deploy_artifact:${serviceId}`,
    );
    const deploy = await mutations.createDeploy(context, serviceId);
    return deploy.id;
  }

  async deploySourceRevision(
    serviceId: string,
    revision: string,
  ): Promise<string> {
    const { mutations, context } = this.mutation(
      `deploy_source:${serviceId}:${revision}`,
    );
    const deploy = await mutations.createDeploy(context, serviceId, revision);
    return deploy.id;
  }

  async waitForDeployment(
    serviceId: string,
    deployId: string,
    expected:
      | { kind: "container_image"; reference: string }
      | { kind: "source_revision"; revision: string },
  ): Promise<void> {
    for (let attempt = 0; attempt < 90; attempt += 1) {
      const selected = await this.api.getDeploy(serviceId, deployId);
      if (selected.status === "live") {
        if (expected.kind === "source_revision") {
          if (selected.commit?.id !== expected.revision || selected.image)
            throw new Error("service_transition_deploy_provenance_mismatch");
        } else {
          const expectedDigest = expected.reference.slice(
            expected.reference.indexOf("sha256:") + 7,
          );
          const actualDigest = selected.image?.sha.replace(/^sha256:/u, "");
          if (
            actualDigest !== expectedDigest ||
            selected.commit ||
            (selected.image?.ref !== undefined &&
              selected.image.ref !== expected.reference)
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

  async reconcileSourceDeployment(input: {
    serviceId: string;
    revision: string;
    intentAt: string;
  }): Promise<string | null> {
    const intentTime = Date.parse(input.intentAt);
    if (!Number.isFinite(intentTime))
      throw new Error("service_transition_deploy_intent_time_invalid");
    await this.quiesceDeployments(input.serviceId);
    const candidates = (await this.api.listAllDeploys(input.serviceId)).filter(
      (deploy) =>
        deploy.status === "live" &&
        deploy.commit?.id === input.revision &&
        !deploy.image &&
        typeof deploy.createdAt === "string" &&
        Date.parse(deploy.createdAt) >= intentTime - 1_000,
    );
    if (candidates.length > 1)
      throw new Error("service_transition_deploy_reconciliation_ambiguous");
    return candidates[0]?.id ?? null;
  }

  async quiesceDeployments(serviceId: string): Promise<void> {
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

  private async waitForServiceContract(
    expected: RenderServiceContractMatcher,
    error: string,
  ): Promise<void> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const service = await this.api.getService(expected.value.serviceId);
      if (expected.matches(service)) return;
      await this.sleep(2_000);
    }
    throw new Error(error);
  }
}
