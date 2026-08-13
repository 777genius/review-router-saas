import {
  environmentSha256,
  sourceServiceContractSha256,
  targetServiceContractSha256,
  type ObservedRenderService,
  type RenderServiceContract,
  type TargetServiceContract,
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

export class RenderTransactionalServicesAdapter
  implements TransactionalRenderProvider
{
  private readonly api: RenderApiAdapter;
  private readonly expectedDeploys = new Map<
    string,
    { kind: "image"; imageUrl: string } | { kind: "git"; commitSha: string }
  >();
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
    const live = deploys.find((item) => item.status === "live");
    if (!live) throw new Error("service_transition_live_deploy_missing");
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
      (![service.repo, service.branch].every((item) => typeof item === "string") ||
        typeof specific.buildCommand !== "string" ||
        typeof specific.startCommand !== "string" ||
        typeof (specific.preDeployCommand ?? details.preDeployCommand) !== "string")
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
            ...(sourceContract as Omit<RenderServiceContract, "serviceContractSha256">),
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
      autoDeploy: "no",
      image: { imagePath: contract.imageUrl },
      serviceDetails: { runtime: "image", preDeployCommand: "" },
    });
  }

  async configureSource(contract: RenderServiceContract): Promise<void> {
    await this.api.patchService(contract.serviceId, {
      autoDeploy: "no",
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
  }

  async replaceEnvironment(
    serviceId: string,
    values: readonly { readonly key: string; readonly value: string }[],
  ): Promise<string> {
    return (await this.api.replaceEnvExact(serviceId, values)).afterSha256;
  }

  async deployImage(serviceId: string, imageUrl: string): Promise<string> {
    if (!imageUrl.includes("@sha256:"))
      throw new Error("service_transition_image_digest_invalid");
    const deploy = await this.api.createPinnedDeploy(serviceId);
    this.expectedDeploys.set(deploy.id, { kind: "image", imageUrl });
    return deploy.id;
  }

  async deployCommit(serviceId: string, commitSha: string): Promise<string> {
    const deploy = await this.api.createPinnedDeploy(serviceId, commitSha);
    this.expectedDeploys.set(deploy.id, { kind: "git", commitSha });
    return deploy.id;
  }

  async waitForDeploy(serviceId: string, deployId: string): Promise<void> {
    for (let attempt = 0; attempt < 90; attempt += 1) {
      const selected = await this.api.getDeploy(serviceId, deployId);
      if (selected.status === "live") {
        const expected = this.expectedDeploys.get(deployId);
        if (!expected) throw new Error("service_transition_deploy_expectation_missing");
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
}
