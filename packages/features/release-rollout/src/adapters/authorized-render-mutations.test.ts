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
        expected: { fingerprint: sha("durable-pre-state"), version: null },
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
      previousEnvironmentSha256: sha("durable-pre-state"),
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
