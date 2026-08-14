import { createHash } from "node:crypto";
import type { ProviderMutationAuthorityPort } from "../application/provider-mutation-authority";
import { AuthoritySerializedMutation } from "../application/provider-mutation-authority";
import type {
  ExpectedProviderState,
  ObservedProviderPostcondition,
  ProviderResourceIdentity,
} from "../domain/provider-mutation";
import {
  RenderApiAdapter,
  type RenderDeploy,
  type RenderJob,
  type RenderService,
} from "./render-api";

export type RenderMutationContext = Readonly<{
  rolloutId: string;
  ownerId: string;
  operation: string;
}>;

const fingerprint = (value: unknown): string =>
  `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
const state = (
  value: unknown,
  version: string | null = null,
): ExpectedProviderState => ({
  fingerprint: fingerprint(value),
  version,
});
const resource = (kind: string, id: string): ProviderResourceIdentity => ({
  provider: "render",
  kind,
  id,
});
const observed = (
  identity: ProviderResourceIdentity,
  value: unknown,
  version: string | null = null,
): ObservedProviderPostcondition => ({
  resource: identity,
  state: state(value, version),
  observedAt: new Date().toISOString(),
});
const serviceWitness = (value: RenderService) => ({
  id: value.id,
  ownerId: value.ownerId,
  type: value.type,
  suspended: value.suspended,
  autoDeploy: value.autoDeploy,
  autoDeployTrigger: value.autoDeployTrigger ?? null,
  repo: value.repo ?? null,
  branch: value.branch ?? null,
  rootDir: value.rootDir ?? null,
  imagePath: value.imagePath ?? value.image?.imagePath ?? null,
  serviceDetails: value.serviceDetails,
});
const deployWitness = (values: readonly RenderDeploy[]) =>
  [...values]
    .map((item) => ({
      id: item.id,
      status: item.status,
      commit: item.commit ?? null,
      image: item.image ?? null,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
const jobWitness = (values: readonly RenderJob[]) =>
  [...values]
    .map((item) => ({
      id: item.id,
      serviceId: item.serviceId,
      startCommand: item.startCommand,
      planId: item.planId ?? null,
      status: item.status,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

/** The sole Render write gateway. It provides authority serialization and witnesses, not native CAS. */
export class AuthorizedRenderMutations {
  private readonly serialized: AuthoritySerializedMutation;
  constructor(
    private readonly api: RenderApiAdapter,
    authority: ProviderMutationAuthorityPort,
    private readonly sleep: (milliseconds: number) => Promise<void> = (
      milliseconds,
    ) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {
    this.serialized = new AuthoritySerializedMutation(authority);
  }

  async suspend(
    context: RenderMutationContext,
    serviceId: string,
  ): Promise<void> {
    await this.serviceMutation(
      context,
      serviceId,
      { suspended: "suspended" },
      () => this.api.suspend(serviceId),
    );
  }

  async resume(
    context: RenderMutationContext,
    serviceId: string,
  ): Promise<void> {
    await this.serviceMutation(
      context,
      serviceId,
      { suspended: "not_suspended" },
      () => this.api.resume(serviceId),
    );
  }

  async patchService(
    context: RenderMutationContext,
    serviceId: string,
    patch: Readonly<Record<string, unknown>>,
    postcondition: (service: RenderService) => boolean,
  ): Promise<void> {
    await this.serviceMutation(context, serviceId, postcondition, () =>
      this.api.patchService(serviceId, patch),
    );
  }

  async replaceEnvironment(
    context: RenderMutationContext,
    input: Parameters<RenderApiAdapter["patchEnvPreservingAll"]>[0],
  ): ReturnType<RenderApiAdapter["patchEnvPreservingAll"]> {
    const identity = resource("service_environment", input.serviceId);
    const before = await this.api.listAllEnv(input.serviceId);
    const beforeState = state(before);
    let result:
      | Awaited<ReturnType<RenderApiAdapter["patchEnvPreservingAll"]>>
      | undefined;
    await this.serialized.execute({
      ...context,
      resource: identity,
      expected: beforeState,
      expectedPostcondition: (observation) =>
        result?.status === "applied" &&
        observation.state.fingerprint === result.environmentSha256,
      observe: async () => {
        const env = await this.api.listAllEnv(input.serviceId);
        return {
          ...observed(identity, env),
          state: { fingerprint: fingerprint(env), version: null },
        };
      },
      mutate: async () => {
        result = await this.api.patchEnvPreservingAll({
          ...input,
          expectedBeforeSha256: beforeState.fingerprint,
        });
        if (result.status !== "applied")
          throw new Error(`render_environment_${result.status}`);
      },
    });
    return result!;
  }

  async createDeploy(
    context: RenderMutationContext,
    serviceId: string,
    commitId?: string,
  ): Promise<RenderDeploy> {
    const identity = resource("deploy_creation_slot", serviceId);
    const before = await this.api.listAllDeploys(serviceId);
    let created: RenderDeploy | undefined;
    let latest: readonly RenderDeploy[] = before;
    await this.serialized.execute({
      ...context,
      resource: identity,
      expected: state(deployWitness(before)),
      expectedPostcondition: () =>
        created !== undefined && latest.some((item) => item.id === created!.id),
      observe: async () => {
        latest = await this.api.listAllDeploys(serviceId);
        return observed(identity, deployWitness(latest));
      },
      mutate: async () => {
        created = await this.api.createPinnedDeploy(serviceId, commitId);
      },
    });
    return created!;
  }

  async createJob(
    context: RenderMutationContext,
    serviceId: string,
    intentId: string,
    input: Parameters<RenderApiAdapter["createJob"]>[1],
  ): Promise<RenderJob> {
    const identity = resource(
      "job_creation_intent",
      `${serviceId}:${intentId}`,
    );
    const before = await this.api.listAllJobs(serviceId);
    let created: RenderJob | undefined;
    let latest: readonly RenderJob[] = before;
    await this.serialized.execute({
      ...context,
      resource: identity,
      expected: state(jobWitness(before)),
      expectedPostcondition: () =>
        created !== undefined && latest.some((item) => item.id === created!.id),
      observe: async () => {
        latest = await this.api.listAllJobs(serviceId);
        return observed(identity, jobWitness(latest));
      },
      mutate: async () => {
        created = await this.api.createJob(serviceId, input);
      },
    });
    return created!;
  }

  private async serviceMutation(
    context: RenderMutationContext,
    serviceId: string,
    desired: Partial<RenderService> | ((service: RenderService) => boolean),
    mutate: () => Promise<void>,
  ): Promise<void> {
    const identity = resource("service", serviceId);
    const before = await this.api.getService(serviceId);
    const matches =
      typeof desired === "function"
        ? desired
        : (service: RenderService) =>
            Object.entries(desired).every(
              ([key, value]) => service[key as keyof RenderService] === value,
            );
    let latest: RenderService | undefined;
    let mutationAttempted = false;
    await this.serialized.execute({
      ...context,
      resource: identity,
      expected: state(serviceWitness(before)),
      expectedPostcondition: () => latest !== undefined && matches(latest),
      observe: async () => {
        for (
          let attempt = 0;
          attempt < (mutationAttempted ? 30 : 1);
          attempt += 1
        ) {
          latest = await this.api.getService(serviceId);
          if (matches(latest) || !mutationAttempted) break;
          await this.sleep(2_000);
        }
        return observed(identity, serviceWitness(latest!));
      },
      mutate: async () => {
        mutationAttempted = true;
        await mutate();
      },
    });
  }
}
