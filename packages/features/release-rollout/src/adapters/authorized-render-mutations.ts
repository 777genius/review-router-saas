import { createHash } from "node:crypto";
import type { ProviderMutationAuthorityPort } from "../application/provider-mutation-authority";
import { AuthoritySerializedMutation } from "../application/provider-mutation-authority";
import type {
  ExpectedProviderState,
  ObservedProviderPostcondition,
  ProviderResourceIdentity,
  ProviderResourceKind,
} from "../domain/provider-mutation";
import {
  environmentKeysSha256,
  environmentSha256,
  sameNormalizedServicePostcondition,
  type NormalizedServicePostcondition,
} from "../domain/service-transition";
import {
  RenderApiAdapter,
  type RenderDeploy,
  type RenderJob,
  type RenderService,
} from "./render-api";
import { normalizeRenderServicePostcondition } from "./render-service-contract";

const activeDeployStatuses = new Set([
  "created",
  "queued",
  "build_in_progress",
  "update_in_progress",
  "pre_deploy_in_progress",
]);

export type RenderMutationContext = Readonly<{
  rolloutId: string;
  ownerId: string;
  operation: string;
}>;

/** Reconstructible across workers; never bind durable authority to a process UUID. */
export const stableRenderMutationOwnerId = (
  rolloutId: string,
  operation: string,
): string =>
  `rr-provider-${createHash("sha256")
    .update(`${rolloutId}\0${operation}`)
    .digest("hex")}`;

const fingerprint = (value: unknown): string =>
  `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
const state = (
  value: unknown,
  version: string | null = null,
): ExpectedProviderState => ({
  fingerprint: fingerprint(value),
  version,
});
const resource = (
  kind: ProviderResourceKind,
  id: string,
): ProviderResourceIdentity => ({
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
const environmentMatchesPatch = (
  environment: readonly { key: string; value: string }[],
  input: { set: Readonly<Record<string, string>>; remove: readonly string[] },
): boolean => {
  const values = new Map(environment.map(({ key, value }) => [key, value]));
  return (
    input.remove.every((key) => !values.has(key)) &&
    Object.entries(input.set).every(([key, value]) => values.get(key) === value)
  );
};
const patchedEnvironment = (
  environment: readonly { key: string; value: string }[],
  input: { set: Readonly<Record<string, string>>; remove: readonly string[] },
): readonly { key: string; value: string }[] => {
  const values = new Map(environment.map(({ key, value }) => [key, value]));
  for (const key of input.remove) values.delete(key);
  for (const [key, value] of Object.entries(input.set)) values.set(key, value);
  return [...values]
    .map(([key, value]) => ({ key, value }))
    .sort((left, right) => left.key.localeCompare(right.key));
};
const createdAfter = (createdAt: string | undefined, consumedAt: string) =>
  createdAt !== undefined &&
  Date.parse(createdAt) >= Date.parse(consumedAt) - 5_000;
const uniqueDeployAfter = (
  values: readonly RenderDeploy[],
  consumedAt: string,
  commitId?: string,
): RenderDeploy | undefined => {
  const candidates = values.filter(
    (item) =>
      createdAfter(item.createdAt, consumedAt) &&
      (commitId === undefined || item.commit?.id === commitId),
  );
  return candidates.length === 1 ? candidates[0] : undefined;
};
const uniqueJobAfter = (
  values: readonly RenderJob[],
  consumedAt: string,
  input: { startCommand: string; planId?: string },
): RenderJob | undefined => {
  const candidates = values.filter(
    (item) =>
      createdAfter(item.createdAt, consumedAt) &&
      item.startCommand === input.startCommand &&
      (item.planId ?? undefined) === input.planId,
  );
  return candidates.length === 1 ? candidates[0] : undefined;
};

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

  async resumeExact(
    context: RenderMutationContext,
    expectedSuspended: NormalizedServicePostcondition,
    expectedDeployment?: Readonly<{
      deployId: string;
      provenance:
        | Readonly<{ kind: "git"; commitSha: string }>
        | Readonly<{ kind: "image"; imageSha: string }>;
    }>,
  ): Promise<void> {
    if (!expectedSuspended.suspended)
      throw new Error("render_resume_postcondition_not_suspended");
    const serviceId = expectedSuspended.serviceId;
    const identity = resource("service", serviceId);
    const read = async (): Promise<{
      postcondition: NormalizedServicePostcondition;
      deployment?: Readonly<{
        deployId: string;
        provenance:
          | Readonly<{ kind: "git"; commitSha: string }>
          | Readonly<{ kind: "image"; imageSha: string }>;
      }>;
    }> => {
      const [service, environment, deploys] = await Promise.all([
        this.api.getService(serviceId),
        this.api.listAllEnv(serviceId),
        expectedDeployment
          ? this.api.listAllDeploys(serviceId)
          : Promise.resolve([]),
      ]);
      const live = deploys.find((deploy) => deploy.status === "live");
      if (
        expectedDeployment &&
        deploys.some((deploy) => activeDeployStatuses.has(deploy.status))
      )
        throw new Error("render_resume_active_deploy_present");
      const deployment = live
        ? live.commit
          ? {
              deployId: live.id,
              provenance: {
                kind: "git" as const,
                commitSha: live.commit.id,
              },
            }
          : live.image
            ? {
                deployId: live.id,
                provenance: {
                  kind: "image" as const,
                  imageSha: live.image.sha,
                },
              }
            : undefined
        : undefined;
      if (expectedDeployment && !deployment)
        throw new Error("render_resume_live_deploy_missing");
      return {
        postcondition: normalizeRenderServicePostcondition(
          service,
          environmentSha256(environment),
        ),
        ...(expectedDeployment ? { deployment: deployment! } : {}),
      };
    };
    const expectedOnline = Object.freeze({
      ...expectedSuspended,
      suspended: false,
    });
    let latest: Awaited<ReturnType<typeof read>> | undefined;
    let attempted = false;
    await this.serialized.execute({
      ...context,
      resource: identity,
      expected: state({
        postcondition: expectedSuspended,
        ...(expectedDeployment ? { deployment: expectedDeployment } : {}),
      }),
      expectedPostcondition: () =>
        latest !== undefined &&
        sameNormalizedServicePostcondition(
          latest.postcondition,
          expectedOnline,
        ) &&
        JSON.stringify(latest.deployment) ===
          JSON.stringify(expectedDeployment),
      observe: async () => {
        for (let poll = 0; poll < (attempted ? 30 : 1); poll += 1) {
          latest = await read();
          if (
            !attempted ||
            (sameNormalizedServicePostcondition(
              latest.postcondition,
              expectedOnline,
            ) &&
              JSON.stringify(latest.deployment) ===
                JSON.stringify(expectedDeployment))
          )
            break;
          await this.sleep(2_000);
        }
        return observed(identity, {
          postcondition: latest!.postcondition,
          ...(expectedDeployment ? { deployment: latest!.deployment } : {}),
        });
      },
      mutate: async () => {
        attempted = true;
        await this.api.resume(serviceId);
      },
    });
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
    const desiredEnvironmentSha256 = environmentSha256(
      patchedEnvironment(before, input),
    );
    const beforeState = {
      fingerprint: input.expectedBeforeSha256 ?? fingerprint(before),
      // The durable, non-secret postcondition hash makes restart observation
      // exact even though the environment payload is intentionally not stored.
      version: input.expectedAfterSha256 ?? desiredEnvironmentSha256,
    };
    let result:
      | Awaited<ReturnType<RenderApiAdapter["patchEnvPreservingAll"]>>
      | undefined;
    let latestEnvironment: readonly { key: string; value: string }[] = before;
    const outcome = await this.serialized.execute({
      ...context,
      ownerId: stableRenderMutationOwnerId(
        context.rolloutId,
        context.operation,
      ),
      resource: identity,
      expected: beforeState,
      expectedPostcondition: (observation) =>
        observation.resultIdentity?.kind === "environment",
      observe: async () => {
        const env = await this.api.listAllEnv(input.serviceId);
        latestEnvironment = env;
        return {
          ...observed(identity, env),
          state: {
            fingerprint: fingerprint(env),
            version: input.expectedAfterSha256 ?? desiredEnvironmentSha256,
          },
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
      identifyResult: (_observation, receipt) => {
        const env = latestEnvironment;
        if (
          !env ||
          !environmentMatchesPatch(env, input) ||
          environmentSha256(env) !== receipt.expected.version
        )
          return null;
        return {
          kind: "environment",
          environmentSha256: environmentSha256(env),
          environmentKeysSha256: environmentKeysSha256(env),
        };
      },
    });
    if (result?.status === "applied") return result;
    const replayIdentity = outcome.observation.resultIdentity;
    if (replayIdentity?.kind !== "environment")
      throw new Error("provider_mutation_typed_replay_missing");
    return {
      status: "applied",
      previousEnvironmentSha256: outcome.receipt.expected.fingerprint,
      environmentSha256: replayIdentity.environmentSha256,
      environmentKeysSha256: replayIdentity.environmentKeysSha256,
      replayed: true,
    };
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
    const outcome = await this.serialized.execute({
      ...context,
      ownerId: stableRenderMutationOwnerId(
        context.rolloutId,
        context.operation,
      ),
      resource: identity,
      expected: state(deployWitness(before)),
      expectedPostcondition: (observation) =>
        observation.resultIdentity?.kind === "deploy",
      observe: async () => {
        latest = await this.api.listAllDeploys(serviceId);
        return observed(identity, deployWitness(latest));
      },
      mutate: async () => {
        created = await this.api.createPinnedDeploy(serviceId, commitId);
      },
      identifyResult: (_observation, receipt) => {
        const match = created
          ? latest.find((item) => item.id === created?.id)
          : uniqueDeployAfter(latest, receipt.consumedAt, commitId);
        return match ? { kind: "deploy", id: match.id } : null;
      },
    });
    const replayId =
      outcome.observation.resultIdentity?.kind === "deploy"
        ? outcome.observation.resultIdentity.id
        : undefined;
    const replay = latest.find((item) => item.id === replayId);
    if (!replay) throw new Error("provider_mutation_typed_replay_missing");
    return replay;
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
    const outcome = await this.serialized.execute({
      ...context,
      ownerId: stableRenderMutationOwnerId(
        context.rolloutId,
        context.operation,
      ),
      resource: identity,
      expected: state(jobWitness(before)),
      expectedPostcondition: (observation) =>
        observation.resultIdentity?.kind === "job",
      observe: async () => {
        latest = await this.api.listAllJobs(serviceId);
        return observed(identity, jobWitness(latest));
      },
      mutate: async () => {
        created = await this.api.createJob(serviceId, input);
      },
      identifyResult: (_observation, receipt) => {
        const match = created
          ? latest.find((item) => item.id === created?.id)
          : uniqueJobAfter(latest, receipt.consumedAt, input);
        return match ? { kind: "job", id: match.id } : null;
      },
    });
    const replayId =
      outcome.observation.resultIdentity?.kind === "job"
        ? outcome.observation.resultIdentity.id
        : undefined;
    const replay = latest.find((item) => item.id === replayId);
    if (!replay) throw new Error("provider_mutation_typed_replay_missing");
    return replay;
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
      ownerId: stableRenderMutationOwnerId(
        context.rolloutId,
        context.operation,
      ),
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
