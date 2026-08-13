import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  requestJitConfiguration,
  runOneJobRunner,
  workflowEnvironment,
  type JitApiContext,
} from "./github-jit-bootstrap";
import { assertSafeProcessBoundary } from "./process-command";
import { RenderBackupIdentityAdapter } from "./render-backup-identity";
import {
  RenderPrivateRunnerAdapter,
  type RenderRunnerRequest,
} from "./render-private-runner";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
const request: RenderRunnerRequest = {
  rolloutId: "rollout-1",
  lifecycle: "role",
  ownerId: "tea-owner",
  organization: "rr-control",
  repository: "rr-control/releases",
  workflowPath: ".github/workflows/private-network-pg17-rollout.yml",
  workflowRef: "refs/heads/main",
  event: "workflow_dispatch",
  actor: "operator",
  runId: "123",
  runAttempt: 1,
  workflowJobId: "456",
  workflowJobName: "private-job",
  commitSha: "a".repeat(40),
  runnerName: "rr-123-private",
  runnerGroupId: 17,
  runnerGroupName: "private-pg17",
  baseServiceId: "srv-runner-base",
  expectedProvenance: {
    kind: "image",
    deployId: "dep-pinned",
    imageSha: `sha256:${"b".repeat(64)}`,
  },
  imageAttestation: {
    subjectDigest: `sha256:${"b".repeat(64)}`,
    sourceCommitSha: "a".repeat(40),
    statementSha256: `sha256:${"c".repeat(64)}`,
    builderId: "reviewrouter-private-runner-build-v1",
  },
  planId: "starter-plus",
  apiKey: "redacted",
};
function startCommandForIntent(intent: string): string {
  const context = Buffer.from(
    JSON.stringify({
      organization: request.organization,
      repository: request.repository,
      workflowPath: request.workflowPath,
      workflowRef: request.workflowRef,
      event: request.event,
      actor: request.actor,
      runId: request.runId,
      runAttempt: request.runAttempt,
      commitSha: request.commitSha,
      workflowJobId: request.workflowJobId,
      workflowJobName: request.workflowJobName,
      runnerGroupId: request.runnerGroupId,
      runnerGroupName: request.runnerGroupName,
      runnerName: request.runnerName,
      uniqueRunnerLabel: request.runnerName,
      workFolder: `_work/${request.runnerName}`,
      rolloutId: request.rolloutId,
      lifecycle: request.lifecycle,
      provisioningIntentId: intent,
      cleanupCanary: `rr-cleanup:${request.rolloutId}:${request.runnerName}`,
    }),
  ).toString("base64url");
  return `node /runner/bootstrap.mjs --intent ${intent} --context ${context}`;
}
const service = {
  id: request.baseServiceId,
  ownerId: request.ownerId,
  type: "private_service",
  suspended: "not_suspended",
  autoDeploy: "no",
  serviceDetails: { runtime: "node" },
  additive: true,
};
const deploys = [
  {
    deploy: {
      id: "dep-pinned",
      status: "live",
      image: { sha: `sha256:${"b".repeat(64)}` },
      createdAt: "2026-08-12T00:00:00.000Z",
    },
    cursor: null,
  },
];
const created = {
  id: "job-123",
  serviceId: request.baseServiceId,
  startCommand: "",
  planId: request.planId,
  status: "pending",
  createdAt: "2026-08-12T00:00:01.000Z",
  additive: true,
};
const preparedEffect = (ownerId: string) => ({
  state: "prepared" as const,
  ownerId,
  epoch: 0,
  providerId: null,
  safeForCompensation: false,
});
const dispatchingEffect = {
  state: "dispatching" as const,
  ownerId: "rrc-00000000-0000-4000-8000-000000000000",
  epoch: 1,
  providerId: null,
  safeForCompensation: false,
};
const ledger = () => ({
  persistProvisioningIntent: vi
    .fn()
    .mockImplementation(async (value) =>
      preparedEffect(value.creationLeaseOwner),
    ),
  listProvisioningIntents: vi.fn().mockResolvedValue([]),
  acquireProviderDispatchPermit: vi.fn().mockImplementation(async (value) => ({
    ...dispatchingEffect,
    ownerId: value.claimantId,
    epoch: value.expectedEpoch + 1,
  })),
  abandonPreparedEffect: vi.fn().mockImplementation(async (value) => ({
    ...preparedEffect(value.claimantId),
    state: "abandoned" as const,
    safeForCompensation: true,
  })),
  reconcileProvisioningEffect: vi
    .fn()
    .mockImplementation(async (value) =>
      value.reconciliation.result === "clean"
        ? { ...dispatchingEffect, state: "cleaned", safeForCompensation: true }
        : value.reconciliation.result === "blocked"
          ? { ...dispatchingEffect, state: "blocked" }
          : value.jobId
            ? { ...dispatchingEffect, state: "bound", providerId: value.jobId }
            : dispatchingEffect,
    ),
  persistCreatedJob: vi.fn().mockResolvedValue(undefined),
  listOpenJobs: vi.fn().mockResolvedValue([]),
  currentRunner: vi.fn().mockRejectedValue(new Error("runner_missing")),
  cleanupObservation: vi
    .fn()
    .mockRejectedValue(new Error("cleanup_observation_missing")),
  markTerminal: vi.fn().mockResolvedValue(undefined),
  persistValidatedIdentity: vi.fn().mockResolvedValue(undefined),
});
const witness = () => ({
  observe: vi.fn().mockResolvedValue({
    listenerStopped: true,
    workspaceRemoved: true,
    credentialProcessGone: true,
    canary: "rr-cleanup:rollout-1:rr-123-private",
    observedAt: "2026-08-12T00:10:00.000Z",
  }),
});
const providerWitness = () => ({
  observe: vi.fn().mockResolvedValue(undefined),
});

describe("Render private runner contract", () => {
  it("accepts additive documented fields, compute planId, and an attested image digest", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(service))
      .mockResolvedValueOnce(json(deploys))
      .mockImplementationOnce(async (_url, init) =>
        json(
          {
            ...created,
            startCommand: JSON.parse(String(init?.body)).startCommand,
          },
          201,
        ),
      )
      .mockResolvedValueOnce(json(deploys));
    const result = await new RenderPrivateRunnerAdapter(
      ledger(),
      witness(),
      providerWitness(),
      fetchImpl,
    ).provision(request);
    expect(result.identity.provenance).toEqual(request.expectedProvenance);
    expect(JSON.parse(String(fetchImpl.mock.calls[2]?.[1]?.body))).toEqual({
      startCommand: expect.stringMatching(
        /^node \/runner\/bootstrap\.mjs --intent rri-[a-f0-9]{64} --context [A-Za-z0-9_-]+$/u,
      ),
      planId: "starter-plus",
    });
  });

  it("persists provider job identity immediately even when later response validation fails", async () => {
    const jobLedger = ledger();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(service))
      .mockResolvedValueOnce(json(deploys))
      .mockImplementationOnce(async (_url, init) =>
        json(
          {
            ...created,
            serviceId: "srv-attacker",
            startCommand: JSON.parse(String(init?.body)).startCommand,
          },
          201,
        ),
      );
    await expect(
      new RenderPrivateRunnerAdapter(
        jobLedger,
        witness(),
        providerWitness(),
        fetchImpl,
      ).provision(request),
    ).rejects.toThrow("render_runner_create_response_mismatch");
    expect(jobLedger.persistCreatedJob).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "job-123" }),
    );
  });

  it("persists provisioning intent before create and never creates when intent durability fails", async () => {
    const jobLedger = ledger();
    jobLedger.persistProvisioningIntent.mockRejectedValue(
      new Error("ledger_unavailable"),
    );
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(service))
      .mockResolvedValueOnce(json(deploys));
    await expect(
      new RenderPrivateRunnerAdapter(
        jobLedger,
        witness(),
        providerWitness(),
        fetchImpl,
      ).provision(request),
    ).rejects.toThrow("ledger_unavailable");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns the current bound runner on controller replay without another provider create", async () => {
    const jobLedger = ledger();
    jobLedger.persistProvisioningIntent
      .mockImplementationOnce(async (value) =>
        preparedEffect(value.creationLeaseOwner),
      )
      .mockResolvedValueOnce({
        ...dispatchingEffect,
        state: "bound",
        providerId: created.id,
      });
    let current: { identity: object; observation: object } | undefined;
    jobLedger.persistValidatedIdentity.mockImplementation(
      async (_jobId, identity, observation) => {
        current = { identity, observation };
      },
    );
    jobLedger.currentRunner.mockImplementation(async () => {
      if (!current) throw new Error("runner_missing");
      return current;
    });
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith(`/services/${request.baseServiceId}`))
        return json(service);
      if (url.includes("/deploys")) return json(deploys);
      if (init?.method === "POST")
        return json(
          {
            ...created,
            startCommand: JSON.parse(String(init.body)).startCommand,
          },
          201,
        );
      throw new Error(`unexpected_render_call:${url}`);
    });
    const adapter = new RenderPrivateRunnerAdapter(
      jobLedger,
      witness(),
      providerWitness(),
      fetchImpl,
    );
    const first = await adapter.provision(request);
    await expect(adapter.provision(request)).resolves.toEqual(first);
    expect(
      fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
  });

  it("reconciles the deterministic provider job after create response loss", async () => {
    const jobLedger = ledger();
    jobLedger.persistProvisioningIntent
      .mockImplementationOnce(async (value) =>
        preparedEffect(value.creationLeaseOwner),
      )
      .mockResolvedValueOnce(dispatchingEffect);
    let lostStartCommand = "";
    const firstFetch = vi
      .fn()
      .mockResolvedValueOnce(json(service))
      .mockResolvedValueOnce(json(deploys))
      .mockImplementationOnce(async (_url, init) => {
        lostStartCommand = JSON.parse(String(init?.body)).startCommand;
        throw new Error("connection_lost_after_create");
      });
    const adapter = new RenderPrivateRunnerAdapter(
      jobLedger,
      witness(),
      providerWitness(),
      firstFetch,
    );
    await expect(adapter.provision(request)).rejects.toThrow(
      "connection_lost_after_create",
    );

    const replayFetch = vi
      .fn()
      .mockResolvedValueOnce(json(service))
      .mockResolvedValueOnce(json(deploys))
      .mockResolvedValueOnce(
        json([
          {
            job: { ...created, startCommand: lostStartCommand },
            cursor: null,
          },
        ]),
      )
      .mockResolvedValueOnce(json(deploys));
    const result = await new RenderPrivateRunnerAdapter(
      jobLedger,
      witness(),
      providerWitness(),
      replayFetch,
    ).provision(request);
    expect(result.jobId).toBe(created.id);
    expect(jobLedger.persistCreatedJob).toHaveBeenCalledTimes(1);
    expect(
      replayFetch.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(0);
  });

  it("reuses an existing ledger-bound active job without listing or creating jobs", async () => {
    const jobLedger = ledger();
    jobLedger.persistProvisioningIntent.mockResolvedValue({
      ...dispatchingEffect,
      state: "bound",
      providerId: created.id,
    });
    jobLedger.listOpenJobs.mockImplementation(async () => [
      {
        rolloutId: request.rolloutId,
        serviceId: request.baseServiceId,
        jobId: created.id,
        observedAt: created.createdAt,
        cleanupCanary: `rr-cleanup:${request.rolloutId}:${request.runnerName}`,
        lifecycle: request.lifecycle,
        provisioningIntentId: String(
          jobLedger.persistProvisioningIntent.mock.calls[0]?.[0].id,
        ),
      },
    ]);
    let expectedCommand = "";
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith(`/services/${request.baseServiceId}`))
        return json(service);
      if (url.includes("/deploys")) return json(deploys);
      if (url.endsWith(`/jobs/${created.id}`)) {
        const intent =
          jobLedger.persistProvisioningIntent.mock.calls[0]?.[0].id;
        expectedCommand = startCommandForIntent(String(intent));
        return json({ ...created, startCommand: expectedCommand });
      }
      throw new Error(`unexpected_render_call:${url}:${init?.method ?? "GET"}`);
    });
    const result = await new RenderPrivateRunnerAdapter(
      jobLedger,
      witness(),
      providerWitness(),
      fetchImpl,
    ).provision(request);
    expect(result.jobId).toBe(created.id);
    expect(result.identity.renderJobId).toBe(created.id);
    expect(expectedCommand).not.toBe("");
    expect(jobLedger.persistCreatedJob).not.toHaveBeenCalled();
    expect(
      fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(0);
  });

  it.each([
    ["no", []],
    [
      "multiple",
      [
        { ...created, id: "job-duplicate-1" },
        { ...created, id: "job-duplicate-2" },
      ],
    ],
  ])(
    "fails closed when an existing intent has %s reconcilable provider jobs",
    async (_case, jobs) => {
      const jobLedger = ledger();
      jobLedger.persistProvisioningIntent.mockResolvedValue(dispatchingEffect);
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(json(service))
        .mockResolvedValueOnce(json(deploys))
        .mockImplementationOnce(async () => {
          const intent = jobLedger.persistProvisioningIntent.mock.calls[0]?.[0];
          return json(
            jobs.map((job) => ({
              job: { ...job, startCommand: startCommandForIntent(intent.id) },
              cursor: null,
            })),
          );
        });
      await expect(
        new RenderPrivateRunnerAdapter(
          jobLedger,
          witness(),
          providerWitness(),
          fetchImpl,
        ).provision(request),
      ).rejects.toThrow(
        jobs.length === 0
          ? "render_runner_intent_reconciliation_pending"
          : "render_runner_intent_multiple_provider_jobs",
      );
      expect(
        fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST"),
      ).toHaveLength(0);
      expect(jobLedger.reconcileProvisioningEffect).toHaveBeenCalledWith(
        expect.objectContaining({
          reconciliation:
            jobs.length > 1
              ? {
                  result: "blocked",
                  safeForCompensation: false,
                  reason: "duplicate",
                }
              : { result: "pending", safeForCompensation: false },
        }),
      );
    },
  );

  it("lets the owner of a redriven prepared lease dispatch exactly once", async () => {
    const jobLedger = ledger();
    jobLedger.persistProvisioningIntent.mockImplementation(async (value) =>
      preparedEffect(value.creationLeaseOwner),
    );
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(service))
      .mockResolvedValueOnce(json(deploys))
      .mockImplementationOnce(async (_url, init) =>
        json(
          {
            ...created,
            startCommand: JSON.parse(String(init?.body)).startCommand,
          },
          201,
        ),
      )
      .mockResolvedValueOnce(json(deploys));

    await expect(
      new RenderPrivateRunnerAdapter(
        jobLedger,
        witness(),
        providerWitness(),
        fetchImpl,
      ).provision(request),
    ).resolves.toMatchObject({ jobId: created.id });
    expect(jobLedger.acquireProviderDispatchPermit).toHaveBeenCalledWith(
      expect.objectContaining({
        startCommandSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        leaseSeconds: 120,
        expectedEpoch: 0,
      }),
    );
    expect(
      fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
  });

  it.each(["dispatching", "bound", "blocked"] as const)(
    "does not POST when the atomic dispatch permit returns %s without this controller's permit",
    async (state) => {
      const jobLedger = ledger();
      jobLedger.acquireProviderDispatchPermit.mockResolvedValue({
        ...dispatchingEffect,
        state,
        providerId: state === "bound" ? created.id : null,
      });
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(json(service))
        .mockResolvedValueOnce(json(deploys))
        .mockResolvedValueOnce(json([]));

      await expect(
        new RenderPrivateRunnerAdapter(
          jobLedger,
          witness(),
          providerWitness(),
          fetchImpl,
        ).provision(request),
      ).rejects.toThrow(
        state === "dispatching"
          ? "render_runner_intent_reconciliation_pending"
          : `render_runner_effect_${state}`,
      );
      expect(
        fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST"),
      ).toHaveLength(0);
    },
  );

  it("durably blocks without invoking cleanup witnesses when created-job persistence fails", async () => {
    const jobLedger = ledger();
    jobLedger.persistCreatedJob.mockRejectedValue(new Error("write_lost"));
    const cleanup = witness();
    const provider = providerWitness();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(service))
      .mockResolvedValueOnce(json(deploys))
      .mockImplementationOnce(async (_url, init) =>
        json(
          {
            ...created,
            startCommand: JSON.parse(String(init?.body)).startCommand,
          },
          201,
        ),
      )
      .mockResolvedValueOnce(
        json({
          ...created,
          startCommand: "bound",
          status: "succeeded",
          finishedAt: "2026-08-12T00:02:00.000Z",
        }),
      )
      .mockResolvedValueOnce(json(service))
      .mockResolvedValueOnce(
        json({
          logs: [
            {
              id: "log-persistence-cleanup",
              message: JSON.stringify({
                canary: "rr-cleanup:rollout-1:rr-123-private",
                cleanup: {
                  removedPaths: ["/runner/_work/rr-123-private"],
                  remainingPaths: [],
                },
              }),
              timestamp: "2026-08-12T00:02:01.000Z",
            },
          ],
        }),
      );
    await expect(
      new RenderPrivateRunnerAdapter(
        jobLedger,
        cleanup,
        provider,
        fetchImpl,
      ).provision(request),
    ).rejects.toThrow("render_runner_job_persistence_failed");
    expect(jobLedger.reconcileProvisioningEffect).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: created.id,
        reconciliation: {
          result: "blocked",
          safeForCompensation: false,
          reason: "unknown",
        },
      }),
    );
    expect(provider.observe).not.toHaveBeenCalled();
    expect(cleanup.observe).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["auto deploy", { ...service, autoDeploy: "yes" }, deploys],
    [
      "active deploy",
      service,
      [
        {
          deploy: {
            id: "dep-race",
            status: "build_in_progress",
            image: { sha: `sha256:${"b".repeat(64)}` },
          },
        },
      ],
    ],
    [
      "ambiguous provenance",
      service,
      [
        {
          deploy: {
            id: "dep-pinned",
            status: "live",
            commit: { id: request.commitSha },
            image: { sha: `sha256:${"b".repeat(64)}` },
          },
        },
      ],
    ],
  ])("fails closed on %s", async (_name, observedService, observedDeploys) => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(observedService))
      .mockResolvedValueOnce(json(observedDeploys));
    await expect(
      new RenderPrivateRunnerAdapter(
        ledger(),
        witness(),
        providerWitness(),
        fetchImpl,
      ).provision(request),
    ).rejects.toThrow();
  });

  it("requires both documented terminal provider state and launcher cleanup canary", async () => {
    const cleanupReceipt = JSON.stringify({
      canary: "rr-cleanup:rollout-1:rr-123-private",
      cleanup: {
        removedPaths: ["/runner/_work/rr-123-private"],
        remainingPaths: [],
      },
    });
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/logs?"))
        return json({
          logs: [
            {
              id: "log-cleanup-1",
              message: cleanupReceipt,
              timestamp: "2026-08-12T00:09:01.000Z",
            },
          ],
        });
      if (url.endsWith(`/services/${request.baseServiceId}`))
        return json(service);
      return json({
        ...created,
        startCommand: "node /runner/bootstrap.mjs --context encoded",
        status: "succeeded",
        finishedAt: "2026-08-12T00:09:00.000Z",
      });
    });
    const independentWitness = providerWitness();
    expect(
      (
        await new RenderPrivateRunnerAdapter(
          ledger(),
          witness(),
          independentWitness,
          fetchImpl,
        ).cleanup({
          apiKey: request.apiKey,
          baseServiceId: request.baseServiceId,
          jobId: "job-123",
          cleanupCanary: "rr-cleanup:rollout-1:rr-123-private",
          lifecycle: "role",
        })
      ).facts,
    ).toMatchObject({ runner: { credentialProcessGone: true } });
    expect(independentWitness.observe).toHaveBeenCalledWith("job-123");
    const badWitness = witness();
    badWitness.observe.mockResolvedValue({
      listenerStopped: true,
      workspaceRemoved: true,
      credentialProcessGone: true,
      canary: "forged",
      observedAt: "2026-08-12T00:10:00.000Z",
    });
    await expect(
      new RenderPrivateRunnerAdapter(
        ledger(),
        badWitness,
        providerWitness(),
        fetchImpl,
      ).cleanup({
        apiKey: request.apiKey,
        baseServiceId: request.baseServiceId,
        jobId: "job-123",
        cleanupCanary: "rr-cleanup:rollout-1:rr-123-private",
        lifecycle: "role",
      }),
    ).rejects.toThrow("render_runner_cleanup_canary_invalid");
  });

  const reconciliationHarness = (providerJobs: readonly object[]) => {
    const intentId = "rri-reconciliation-test";
    const events: string[] = [];
    const open: Array<Record<string, unknown>> = [];
    const terminal = new Set<string>();
    let effect: Record<string, unknown> = {
      ...dispatchingEffect,
      reconciliation: { result: "pending", safeForCompensation: false },
    };
    const intent = () => ({
      id: intentId,
      rolloutId: request.rolloutId,
      serviceId: request.baseServiceId,
      lifecycle: request.lifecycle,
      workflowJobId: request.workflowJobId,
      runnerName: request.runnerName,
      createdAt: "2026-08-12T00:00:00.000Z",
      startCommandSha256: `sha256:${"d".repeat(64)}`,
      creationLeaseOwner: dispatchingEffect.ownerId,
      creationLeaseExpiresAt: null,
      effect,
    });
    const jobLedger = ledger();
    jobLedger.listProvisioningIntents.mockImplementation(async () => [
      intent(),
    ]);
    jobLedger.listOpenJobs.mockImplementation(async () => [...open] as never);
    jobLedger.persistCreatedJob.mockImplementation(async (value) => {
      events.push(`persist:${value.jobId}`);
      if (
        !terminal.has(value.jobId) &&
        !open.some((entry) => entry.jobId === value.jobId)
      )
        open.push(value);
    });
    jobLedger.reconcileProvisioningEffect.mockImplementation(async (value) => {
      events.push(`${value.reconciliation.result}:${value.jobId ?? "none"}`);
      if (value.reconciliation.result === "blocked")
        effect = {
          ...effect,
          state: "blocked",
          safeForCompensation: false,
          reconciliation: value.reconciliation,
        };
      else if (value.reconciliation.result === "clean") {
        if (effect.state !== "blocked")
          effect = {
            ...effect,
            state: "cleaned",
            providerId: value.jobId,
            safeForCompensation: true,
            reconciliation: value.reconciliation,
          };
      } else if (value.jobId)
        effect = {
          ...effect,
          state: "bound",
          providerId: value.jobId,
          safeForCompensation: false,
          reconciliation: value.reconciliation,
        };
      return effect as never;
    });
    jobLedger.markTerminal.mockImplementation(async (jobId) => {
      events.push(`terminal:${jobId}`);
      const index = open.findIndex((entry) => entry.jobId === jobId);
      if (index >= 0) open.splice(index, 1);
      terminal.add(jobId);
      if (effect.state === "bound" && effect.providerId === jobId)
        effect = {
          ...effect,
          state: "cleaned",
          safeForCompensation: true,
          reconciliation: { result: "clean", safeForCompensation: true },
        };
    });
    const cleanup = witness();
    cleanup.observe.mockImplementation(async (jobId) => {
      events.push(`cleanup-witness:${jobId}`);
      return {
        listenerStopped: true,
        workspaceRemoved: true,
        credentialProcessGone: true,
        canary: `rr-cleanup:${request.rolloutId}:${request.runnerName}`,
        observedAt: "2026-08-12T00:10:00.000Z",
      };
    });
    const provider = providerWitness();
    provider.observe.mockImplementation(async (jobId) => {
      events.push(`provider-witness:${jobId}`);
    });
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      const path = String(url);
      if (path.endsWith(`/services/${request.baseServiceId}/jobs`))
        return json(providerJobs.map((job) => ({ job, cursor: null })));
      const providerJob = providerJobs.find(
        (job) =>
          typeof job === "object" &&
          job !== null &&
          path.endsWith(`/jobs/${String((job as { id?: string }).id)}`),
      );
      if (providerJob) return json(providerJob);
      throw new Error(`unexpected_render_request:${path}`);
    });
    return {
      intentId,
      events,
      open,
      terminal,
      effect: () => effect,
      setEffect: (value: Record<string, unknown>) => {
        effect = value;
      },
      jobLedger,
      cleanup,
      provider,
      fetchImpl,
      adapter: new RenderPrivateRunnerAdapter(
        jobLedger,
        cleanup,
        provider,
        fetchImpl,
      ),
    };
  };

  const reconciledJob = (intentId: string, id: string) => ({
    id,
    serviceId: request.baseServiceId,
    startCommand: `node /runner/bootstrap.mjs --intent ${intentId} --context opaque`,
    status: "succeeded",
    createdAt: "2026-08-12T00:00:01.000Z",
    finishedAt: "2026-08-12T00:02:00.000Z",
  });

  it("persists and binds a late lost-response job before either cleanup witness", async () => {
    const intentId = "rri-reconciliation-test";
    const harness = reconciliationHarness([
      reconciledJob(intentId, "job-late"),
    ]);

    await expect(
      harness.adapter.reconcileOrphans(request.rolloutId, request.apiKey),
    ).resolves.toMatchObject({ result: "clean", safeForCompensation: true });
    expect(harness.events).toEqual([
      "persist:job-late",
      "pending:job-late",
      "provider-witness:job-late",
      "cleanup-witness:job-late",
      "terminal:job-late",
    ]);
    expect(
      harness.jobLedger.reconcileProvisioningEffect,
    ).not.toHaveBeenCalledWith(
      expect.objectContaining({
        reconciliation: { result: "clean", safeForCompensation: true },
      }),
    );
    expect(harness.open).toEqual([]);
  });

  it("persists every duplicate before blocking and safely cleans the complete set", async () => {
    const intentId = "rri-reconciliation-test";
    const harness = reconciliationHarness([
      reconciledJob(intentId, "job-duplicate-a"),
      reconciledJob(intentId, "job-duplicate-b"),
    ]);

    await expect(
      harness.adapter.reconcileOrphans(request.rolloutId, request.apiKey),
    ).resolves.toMatchObject({
      result: "blocked",
      reason: "duplicate",
      safeForCompensation: false,
    });
    expect(harness.events.slice(0, 3)).toEqual([
      "persist:job-duplicate-a",
      "persist:job-duplicate-b",
      "blocked:none",
    ]);
    expect(harness.jobLedger.markTerminal).toHaveBeenCalledTimes(2);
    expect(harness.open).toEqual([]);
  });

  it("replays durable cleanup without a provider POST and leaves no stranded open job", async () => {
    const intentId = "rri-reconciliation-test";
    const harness = reconciliationHarness([
      reconciledJob(intentId, "job-replay"),
    ]);
    harness.cleanup.observe.mockRejectedValueOnce(new Error("witness_late"));

    await expect(
      harness.adapter.reconcileOrphans(request.rolloutId, request.apiKey),
    ).resolves.toMatchObject({ result: "blocked", safeForCompensation: false });
    expect(harness.open).toHaveLength(1);
    await expect(
      harness.adapter.reconcileOrphans(request.rolloutId, request.apiKey),
    ).resolves.toMatchObject({ result: "blocked", safeForCompensation: false });
    expect(harness.open).toEqual([]);
    expect(harness.jobLedger.persistCreatedJob).toHaveBeenCalledOnce();
  });

  it("durably blocks a job appearing after clean before witnessing it", async () => {
    const intentId = "rri-reconciliation-test";
    const original = reconciledJob(intentId, "job-original");
    const late = reconciledJob(intentId, "job-after-clean");
    const harness = reconciliationHarness([original, late]);
    harness.setEffect({
      ...dispatchingEffect,
      state: "cleaned",
      providerId: "job-original",
      safeForCompensation: true,
      reconciliation: { result: "clean", safeForCompensation: true },
    });
    harness.jobLedger.persistCreatedJob.mockImplementation(async (value) => {
      harness.events.push(`persist:${value.jobId}`);
      if (
        !harness.terminal.has(value.jobId) &&
        !harness.open.some((entry) => entry.jobId === value.jobId)
      )
        harness.open.push(value);
      if (value.jobId === "job-after-clean")
        harness.setEffect({
          ...harness.effect(),
          state: "blocked",
          safeForCompensation: false,
          reconciliation: {
            result: "blocked",
            safeForCompensation: false,
            reason: "duplicate",
          },
        });
    });

    for (let attempt = 0; attempt < 2; attempt += 1)
      await expect(
        harness.adapter.reconcileOrphans(request.rolloutId, request.apiKey),
      ).resolves.toMatchObject({
        result: "blocked",
        reason: "duplicate",
        safeForCompensation: false,
      });
    expect(harness.jobLedger.persistCreatedJob).toHaveBeenCalledTimes(2);
    expect(harness.events.indexOf("persist:job-after-clean")).toBeLessThan(
      harness.events.indexOf("provider-witness:job-after-clean"),
    );
    expect(
      harness.fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(0);
    expect(harness.open).toEqual([]);
  });
});

const jit: JitApiContext = {
  organization: "rr-control",
  repository: "rr-control/releases",
  workflowPath: ".github/workflows/private-network-pg17-rollout.yml",
  workflowRef: "refs/heads/main",
  event: "workflow_dispatch",
  runId: "123",
  runAttempt: 1,
  commitSha: "a".repeat(40),
  actor: "operator",
  workflowJobId: "456",
  workflowJobName: "private-job",
  runnerGroupId: 17,
  runnerGroupName: "private-pg17",
  runnerName: "rr-123-private",
  uniqueRunnerLabel: "rr-123-private",
  workFolder: "_work/rr-123-private",
};
function jitFetch(
  overrides: Partial<{
    group: object;
    repo: object;
    run: object;
    jobs: object;
  }> = {},
) {
  const responses = [
    { login: jit.organization, type: "Organization" },
    overrides.repo ?? {
      full_name: jit.repository,
      private: true,
      owner: { login: jit.organization, type: "Organization" },
    },
    overrides.group ?? {
      id: 17,
      name: jit.runnerGroupName,
      visibility: "selected",
      allows_public_repositories: false,
      restricted_to_workflows: true,
      selected_workflows: [
        `${jit.repository}/${jit.workflowPath}@${jit.workflowRef}`,
      ],
    },
    { total_count: 1, repositories: [{ full_name: jit.repository }] },
    overrides.run ?? {
      id: 123,
      run_attempt: 1,
      head_sha: jit.commitSha,
      head_branch: "main",
      event: "workflow_dispatch",
      path: `${jit.workflowPath}@${jit.workflowRef}`,
      actor: { login: jit.actor },
    },
    overrides.jobs ?? {
      jobs: [
        {
          id: 456,
          name: jit.workflowJobName,
          run_id: 123,
          run_attempt: 1,
          head_sha: jit.commitSha,
          status: "queued",
          runner_id: null,
          runner_name: null,
          runner_group_id: 17,
          runner_group_name: jit.runnerGroupName,
          labels: ["self-hosted", jit.uniqueRunnerLabel],
        },
      ],
    },
    {
      encoded_jit_config: "encoded-configuration",
      runner: {
        id: 99,
        name: jit.runnerName,
        status: "offline",
        busy: false,
        runner_group_id: 17,
        labels: [{ name: jit.uniqueRunnerLabel }],
      },
    },
    {
      id: 99,
      name: jit.runnerName,
      status: "offline",
      busy: false,
      labels: [{ name: jit.uniqueRunnerLabel }],
    },
    { id: 17, name: jit.runnerGroupName },
  ];
  return vi.fn(async (input: string, init?: RequestInit) => {
    void input;
    void init;
    return json(responses.shift());
  });
}

describe("organization-scoped JIT isolation", () => {
  it("validates exact org, selected repository/workflow group, run, attempt, and queued target job", async () => {
    const fetchImpl = jitFetch();
    await expect(
      requestJitConfiguration(
        jit,
        "installation-token",
        fetchImpl as typeof fetch,
      ),
    ).resolves.toMatchObject({
      encodedJitConfig: "encoded-configuration",
      runnerId: 99,
      runnerGroupId: 17,
      labels: [jit.uniqueRunnerLabel],
    });
    const generationCall = fetchImpl.mock.calls.find(([url]) =>
      String(url).includes("generate-jitconfig"),
    );
    expect(String(generationCall?.[0])).toContain(
      `/orgs/${jit.organization}/actions/runners/generate-jitconfig`,
    );
    expect(JSON.parse(String(generationCall?.[1]?.body))).toEqual({
      name: jit.runnerName,
      runner_group_id: 17,
      labels: [jit.uniqueRunnerLabel],
      work_folder: jit.workFolder,
    });
  });
  it.each([
    [
      "personal repository",
      {
        repo: {
          full_name: jit.repository,
          private: true,
          owner: { login: jit.organization, type: "User" },
        },
      },
    ],
    [
      "extra selected workflow",
      {
        group: {
          id: 17,
          name: jit.runnerGroupName,
          visibility: "selected",
          allows_public_repositories: false,
          restricted_to_workflows: true,
          selected_workflows: [
            `${jit.repository}/${jit.workflowPath}@${jit.workflowRef}`,
            "evil/repo/.github/workflows/pwn.yml@refs/heads/main",
          ],
        },
      },
    ],
    [
      "wrong SHA",
      {
        run: {
          id: 123,
          run_attempt: 1,
          head_sha: "b".repeat(40),
          head_branch: "main",
          event: "workflow_dispatch",
          path: `${jit.workflowPath}@${jit.workflowRef}`,
          actor: { login: jit.actor },
        },
      },
    ],
    [
      "captured job",
      {
        jobs: {
          jobs: [
            {
              id: 456,
              name: jit.workflowJobName,
              run_id: 123,
              run_attempt: 1,
              head_sha: jit.commitSha,
              status: "queued",
              runner_id: 999,
              runner_name: "attacker",
            },
          ],
        },
      },
    ],
  ])("rejects %s before generating config", async (_name, override) => {
    await expect(
      requestJitConfiguration(jit, "token", jitFetch(override) as typeof fetch),
    ).rejects.toThrow();
  });
});

describe("process and runner secret boundary", () => {
  it("allowlists the child environment and rejects URLs/passwords in argv/env", () => {
    expect(
      workflowEnvironment({
        PATH: "/bin",
        DATABASE_URL: "postgresql://u:p@h/d",
        GITHUB_TOKEN: "secret",
      }),
    ).toEqual({ PATH: "/bin" });
    expect(() =>
      assertSafeProcessBoundary("psql", ["postgresql://u:p@h/d"], {
        PATH: "/bin",
      }),
    ).toThrow("release_rollout_secret_in_argv");
    expect(() =>
      assertSafeProcessBoundary("psql", [], {
        PATH: "/bin",
        PGPASSWORD: "secret",
      }),
    ).toThrow("release_rollout_broad_child_environment");
  });
  it("invokes only Runner.Listener run --jitconfig", async () => {
    const child = {
      once: vi.fn((event: string, callback: (code: number) => void) => {
        if (event === "exit") callback(0);
        return child;
      }),
      kill: vi.fn(),
    } as never;
    const spawnImpl = vi.fn(() => child) as never;
    await runOneJobRunner({
      runnerPath: "/runner/bin/Runner.Listener",
      jitConfig: "encoded",
      timeoutMs: 1000,
      spawnImpl,
      environment: { PATH: "/bin" },
    });
    expect(spawnImpl).toHaveBeenCalledWith(
      "/runner/bin/Runner.Listener",
      ["run", "--jitconfig", "encoded"],
      expect.anything(),
    );
  });

  it("cancels only the no-job timer when assignment begins", async () => {
    vi.useFakeTimers();
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
      pid?: number;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    const running = runOneJobRunner({
      runnerPath: "/runner/bin/Runner.Listener",
      jitConfig: "encoded",
      timeoutMs: 1000,
      spawnImpl: vi.fn(() => child) as never,
      environment: { PATH: "/bin" },
    });
    await vi.advanceTimersByTimeAsync(900);
    child.stdout.write("2026-08-12: Running job: private-cutover\n");
    await vi.advanceTimersByTimeAsync(10_000);
    child.emit("exit", 0);
    await expect(running).resolves.toBeUndefined();
    expect(child.kill).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("terminates an unassigned listener after the bounded acquisition timeout", async () => {
    vi.useFakeTimers();
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
      pid?: number;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    const running = runOneJobRunner({
      runnerPath: "/runner/bin/Runner.Listener",
      jitConfig: "encoded",
      timeoutMs: 1000,
      spawnImpl: vi.fn(() => child) as never,
      environment: { PATH: "/bin" },
    });
    await vi.advanceTimersByTimeAsync(1000);
    child.emit("exit", null);
    await expect(running).rejects.toThrow("github_jit_no_job_timeout");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    vi.useRealTimers();
  });
});

describe("Render recovery plus external backup witness", () => {
  it("uses only documented recovery status and binds the authenticated export witness", async () => {
    const externalWitness = {
      witnessSha256: `sha256:${"a".repeat(64)}`,
      sourceResourceId: "dpg-source",
      internalHostname: "source.internal",
      databaseName: "reviewrouter",
      systemIdentifier: "100",
      lsn: "0/16B6C50",
      capturedAt: "2026-08-12T00:00:00.000Z",
      recoveryWindowEndsAt: "2026-08-13T00:00:00.000Z",
      dumpSha256: `sha256:${"b".repeat(64)}`,
    };
    const fetchImpl = vi.fn().mockResolvedValue(
      json({
        recoveryStatus: "AVAILABLE",
        startsAt: "2026-08-11T00:00:00.000Z",
        additive: true,
      }),
    );
    expect(
      await new RenderBackupIdentityAdapter(fetchImpl).capture({
        apiKey: "redacted",
        sourceDatabaseId: "dpg-source",
        externalWitness,
      }),
    ).toMatchObject({
      lsn: externalWitness.lsn,
      externalWitnessSha256: externalWitness.witnessSha256,
    });
    expect(
      String(fetchImpl.mock.calls[0]?.[0]).endsWith(
        "/postgres/dpg-source/recovery",
      ),
    ).toBe(true);
  });
});
