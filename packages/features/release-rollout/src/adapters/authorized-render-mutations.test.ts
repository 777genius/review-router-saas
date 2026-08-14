import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ProviderMutationAuthorityPort } from "../application/provider-mutation-authority";
import type {
  ObservedProviderPostcondition,
  ProviderMutationResultIdentity,
} from "../domain/provider-mutation";
import {
  AuthorizedRenderMutations,
  stableRenderMutationOwnerId,
} from "./authorized-render-mutations";
import type { RenderApiAdapter, RenderDeploy, RenderJob } from "./render-api";
import { normalizeRenderServicePostcondition } from "./render-service-contract";
import { environmentSha256 } from "../domain/service-transition";

const sha = (value: unknown) =>
  `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;

const terminalAuthority = (
  resultIdentity: ProviderMutationResultIdentity,
): {
  authority: ProviderMutationAuthorityPort;
  recover: ReturnType<typeof vi.fn>;
} => {
  const recover = vi.fn(async (input) => {
    const observation: ObservedProviderPostcondition = {
      resource: input.resource,
      state: { fingerprint: sha("post-state"), version: null },
      observedAt: "2026-08-14T00:00:02.000Z",
      resultIdentity,
    };
    return {
      status: "terminal" as const,
      outcome: {
        status: "terminal" as const,
        result: "exact_postcondition" as const,
        rolloutId: input.rolloutId,
        operation: input.operation,
        resource: input.resource,
        ownerId: input.ownerId,
        epoch: 1,
        permitId: "a".repeat(64),
        receiptId: "b".repeat(64),
        expected: input.expected,
        consumedAt: "2026-08-14T00:00:01.000Z",
        observation,
        completedAt: "2026-08-14T00:00:02.000Z",
      },
    };
  });
  return {
    recover,
    authority: {
      recover,
      issue: vi.fn(),
      consume: vi.fn(),
      validateExecution: vi.fn(),
      complete: vi.fn(),
      reconcile: vi.fn(),
    },
  };
};

describe("authorized Render typed replay", () => {
  const context = {
    rolloutId: "rollout-one",
    operation: "create-resource",
    ownerId: "process-local-random-owner",
  };

  it("binds every restart to a reconstructible rollout/operation owner", async () => {
    const deploy: RenderDeploy = {
      id: "dep-one",
      status: "created",
      createdAt: "2026-08-14T00:00:01.500Z",
    };
    const { authority, recover } = terminalAuthority({
      kind: "deploy",
      id: deploy.id,
    });
    const api = {
      listAllDeploys: vi.fn().mockResolvedValue([deploy]),
    } as unknown as RenderApiAdapter;
    await new AuthorizedRenderMutations(api, authority).createDeploy(
      context,
      "srv-one",
    );
    expect(recover.mock.calls[0]?.[0].ownerId).toBe(
      stableRenderMutationOwnerId(context.rolloutId, context.operation),
    );
    expect(recover.mock.calls[0]?.[0].ownerId).not.toBe(context.ownerId);
  });

  it("reconstructs environment, deploy, and job values from safe terminal identities", async () => {
    const environment = [{ key: "SAFE", value: "value" }];
    const environmentSha256 = sha(environment);
    const environmentKeysSha256 = sha(["SAFE"]);
    const envAuthority = terminalAuthority({
      kind: "environment",
      environmentSha256,
      environmentKeysSha256,
    });
    const envApi = {
      listAllEnv: vi.fn().mockResolvedValue(environment),
      patchEnvPreservingAll: vi.fn(),
    } as unknown as RenderApiAdapter;
    await expect(
      new AuthorizedRenderMutations(
        envApi,
        envAuthority.authority,
      ).replaceEnvironment(context, {
        serviceId: "srv-one",
        set: { SAFE: "value" },
        remove: [],
        expectedBeforeSha256: sha("before"),
      }),
    ).resolves.toEqual({
      status: "applied",
      previousEnvironmentSha256: sha("before"),
      environmentSha256,
      environmentKeysSha256,
      replayed: true,
    });
    expect(envApi.patchEnvPreservingAll).not.toHaveBeenCalled();

    const deploy: RenderDeploy = { id: "dep-one", status: "created" };
    const deployAuthority = terminalAuthority({
      kind: "deploy",
      id: deploy.id,
    });
    const deployApi = {
      listAllDeploys: vi.fn().mockResolvedValue([deploy]),
      createPinnedDeploy: vi.fn(),
    } as unknown as RenderApiAdapter;
    await expect(
      new AuthorizedRenderMutations(
        deployApi,
        deployAuthority.authority,
      ).createDeploy(context, "srv-one"),
    ).resolves.toEqual(deploy);
    expect(deployApi.createPinnedDeploy).not.toHaveBeenCalled();

    const job: RenderJob = {
      id: "job-one",
      serviceId: "srv-one",
      startCommand: "run-safe-job",
      status: "pending",
    };
    const jobAuthority = terminalAuthority({ kind: "job", id: job.id });
    const jobApi = {
      listAllJobs: vi.fn().mockResolvedValue([job]),
      createJob: vi.fn(),
    } as unknown as RenderApiAdapter;
    await expect(
      new AuthorizedRenderMutations(jobApi, jobAuthority.authority).createJob(
        context,
        "srv-one",
        "intent-one",
        { startCommand: job.startCommand },
      ),
    ).resolves.toEqual(job);
    expect(jobApi.createJob).not.toHaveBeenCalled();
  });

  it("reconciles a lost job-create response after process restart without replay", async () => {
    const ownerId = stableRenderMutationOwnerId(
      context.rolloutId,
      context.operation,
    );
    const job: RenderJob = {
      id: "job-after-lost-response",
      serviceId: "srv-one",
      startCommand: "run-safe-job",
      status: "pending",
      createdAt: "2026-08-14T00:00:02.000Z",
    };
    const reconcile = vi.fn();
    const authority: ProviderMutationAuthorityPort = {
      recover: vi.fn(async (input) => ({
        status: "receipt" as const,
        phase: "executing" as const,
        reconciliationOnly: true,
        receipt: {
          rolloutId: input.rolloutId,
          operation: input.operation,
          resource: input.resource,
          ownerId,
          epoch: 1,
          permitId: "a".repeat(64),
          receiptId: "b".repeat(64),
          expected: { fingerprint: sha("before"), version: null },
          consumedAt: "2026-08-14T00:00:01.000Z",
        },
      })),
      issue: vi.fn(),
      consume: vi.fn(),
      validateExecution: vi.fn(),
      complete: vi.fn(),
      reconcile,
    };
    const api = {
      listAllJobs: vi.fn().mockResolvedValue([job]),
      createJob: vi.fn(),
    } as unknown as RenderApiAdapter;
    await expect(
      new AuthorizedRenderMutations(api, authority).createJob(
        context,
        "srv-one",
        "intent-one",
        { startCommand: job.startCommand },
      ),
    ).resolves.toEqual(job);
    expect(api.createJob).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        result: "exact_postcondition",
        observation: expect.objectContaining({
          resultIdentity: { kind: "job", id: job.id },
        }),
      }),
    );
  });
});

describe("authorized Render exact resume recovery", () => {
  const context = {
    rolloutId: "rollout-resume",
    operation: "service_resume:srv-one",
    ownerId: "random-process-owner",
  };
  const environment = [{ key: "SAFE", value: "value" }];
  const service = (suspended: "suspended" | "not_suspended") => ({
    id: "srv-one",
    ownerId: "team-one",
    type: "web_service",
    suspended,
    autoDeploy: "no" as const,
    autoDeployTrigger: "off" as const,
    repo: "https://example.test/repo.git",
    branch: "main",
    rootDir: "apps/api",
    serviceDetails: {
      runtime: "node",
      region: "oregon",
      plan: "starter",
      maxShutdownDelaySeconds: 30,
      numInstances: 1,
      preDeployCommand: "",
      envSpecificDetails: {
        buildCommand: "pnpm build",
        startCommand: "pnpm start",
        healthCheckPath: "/health",
      },
    },
  });
  const expected = normalizeRenderServicePostcondition(
    service("suspended"),
    environmentSha256(environment),
  );
  const deployment = {
    deployId: "dep-expected",
    provenance: { kind: "git" as const, commitSha: "a".repeat(40) },
  };
  const onlineApi = (
    deployId = deployment.deployId,
    revision = deployment.provenance.commitSha,
  ) =>
    ({
      getService: vi.fn().mockResolvedValue(service("not_suspended")),
      listAllEnv: vi.fn().mockResolvedValue(environment),
      listAllDeploys: vi
        .fn()
        .mockResolvedValue([
          { id: deployId, status: "live", commit: { id: revision } },
        ]),
      resume: vi.fn(),
    }) as unknown as RenderApiAdapter;

  it("uses the stable owner and validates an already-online terminal replay", async () => {
    const { authority, recover } = terminalAuthority({
      kind: "service",
      id: "srv-one",
    });
    const api = onlineApi();

    await expect(
      new AuthorizedRenderMutations(api, authority).resumeExact(
        context,
        expected,
        deployment,
      ),
    ).resolves.toBeUndefined();
    expect(recover.mock.calls[0]?.[0].ownerId).toBe(
      stableRenderMutationOwnerId(context.rolloutId, context.operation),
    );
    expect(api.resume).not.toHaveBeenCalled();
  });

  it.each([
    [
      "same-revision replacement",
      "dep-replacement",
      deployment.provenance.commitSha,
    ],
    ["wrong revision", deployment.deployId, "b".repeat(40)],
  ])("rejects terminal replay after %s", async (_name, deployId, revision) => {
    const { authority } = terminalAuthority({ kind: "service", id: "srv-one" });
    await expect(
      new AuthorizedRenderMutations(
        onlineApi(deployId, revision),
        authority,
      ).resumeExact(context, expected, deployment),
    ).rejects.toThrow("provider_mutation_terminal_observation_unproven");
  });

  it("freshly reconciles an executing replay with exact deployment identity", async () => {
    const reconcile = vi.fn();
    const authority: ProviderMutationAuthorityPort = {
      recover: vi.fn(async (input) => ({
        status: "receipt" as const,
        phase: "executing" as const,
        reconciliationOnly: true,
        receipt: {
          rolloutId: input.rolloutId,
          operation: input.operation,
          resource: input.resource,
          ownerId: input.ownerId,
          epoch: 1,
          permitId: "a".repeat(64),
          receiptId: "b".repeat(64),
          expected: input.expected,
          consumedAt: "2026-08-14T00:00:01.000Z",
        },
      })),
      issue: vi.fn(),
      consume: vi.fn(),
      validateExecution: vi.fn(),
      complete: vi.fn(),
      reconcile,
    };
    const api = onlineApi();
    await new AuthorizedRenderMutations(api, authority).resumeExact(
      context,
      expected,
      deployment,
    );
    expect(reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        result: "exact_postcondition",
        observation: expect.objectContaining({
          resultIdentity: { kind: "service", id: "srv-one" },
        }),
      }),
    );
    expect(api.resume).not.toHaveBeenCalled();
  });
});
