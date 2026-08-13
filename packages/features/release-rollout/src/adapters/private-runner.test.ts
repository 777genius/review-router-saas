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
const ledger = () => ({
  persistProvisioningIntent: vi.fn().mockResolvedValue("created"),
  listProvisioningIntents: vi.fn().mockResolvedValue([]),
  recordProvisioningOutcome: vi.fn().mockResolvedValue(undefined),
  persistCreatedJob: vi.fn().mockResolvedValue(undefined),
  listOpenJobs: vi.fn().mockResolvedValue([]),
  currentRunner: vi.fn().mockRejectedValue(new Error("runner_missing")),
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
      .mockResolvedValueOnce("created")
      .mockResolvedValueOnce("existing");
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
      .mockResolvedValueOnce("created")
      .mockResolvedValueOnce("existing");
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
    jobLedger.persistProvisioningIntent.mockResolvedValue("existing");
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
      jobLedger.persistProvisioningIntent.mockResolvedValue("existing");
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
    },
  );

  it("directly proves cleanup and records reconciliation when created-job persistence fails", async () => {
    const jobLedger = ledger();
    jobLedger.persistCreatedJob.mockRejectedValue(new Error("write_lost"));
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
        witness(),
        providerWitness(),
        fetchImpl,
      ).provision(request),
    ).rejects.toThrow("render_runner_job_persistence_failed");
    expect(jobLedger.recordProvisioningOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: created.id,
        outcome: "persistence_failed_cleaned",
        observation: expect.any(Object),
      }),
    );
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
