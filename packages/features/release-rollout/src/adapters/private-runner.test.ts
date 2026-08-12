import { describe, expect, it, vi } from "vitest";
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
  baseServiceId: "srv-runner-base",
  expectedProvenance: {
    kind: "git",
    deployId: "dep-pinned",
    commitSha: "a".repeat(40),
  },
  planId: "starter-plus",
  apiKey: "redacted",
};
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
      commit: { id: request.commitSha },
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
  persistCreatedJob: vi.fn().mockResolvedValue(undefined),
  listOpenJobs: vi.fn().mockResolvedValue([]),
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

describe("Render private runner contract", () => {
  it("accepts additive documented fields, compute planId, and race-free git provenance", async () => {
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
      fetchImpl,
    ).provision(request);
    expect(result.identity.provenance).toEqual(request.expectedProvenance);
    expect(JSON.parse(String(fetchImpl.mock.calls[2]?.[1]?.body))).toEqual({
      startCommand: expect.stringMatching(
        /^node \/runner\/bootstrap\.mjs --context [A-Za-z0-9_-]+$/u,
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
      new RenderPrivateRunnerAdapter(jobLedger, witness(), fetchImpl).provision(
        request,
      ),
    ).rejects.toThrow("render_runner_create_response_mismatch");
    expect(jobLedger.persistCreatedJob).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "job-123" }),
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
            commit: { id: request.commitSha },
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
      new RenderPrivateRunnerAdapter(ledger(), witness(), fetchImpl).provision(
        request,
      ),
    ).rejects.toThrow();
  });

  it("requires both documented terminal provider state and launcher cleanup canary", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () =>
      json({
        ...created,
        startCommand: "node /runner/bootstrap.mjs --context encoded",
        status: "succeeded",
        finishedAt: "2026-08-12T00:09:00.000Z",
      }),
    );
    expect(
      (
        await new RenderPrivateRunnerAdapter(
          ledger(),
          witness(),
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
    const badWitness = witness();
    badWitness.observe.mockResolvedValue({
      listenerStopped: true,
      workspaceRemoved: true,
      credentialProcessGone: true,
      canary: "forged",
      observedAt: "2026-08-12T00:10:00.000Z",
    });
    await expect(
      new RenderPrivateRunnerAdapter(ledger(), badWitness, fetchImpl).cleanup({
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
  runnerName: "rr-123-private",
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
      owner: { login: jit.organization, type: "Organization" },
    },
    overrides.group ?? {
      id: 17,
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
        },
      ],
    },
    {
      encoded_jit_config: "encoded-configuration",
      runner: { name: jit.runnerName, status: "offline", busy: false },
    },
  ];
  return vi.fn(async () => json(responses.shift()));
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
    ).resolves.toBe("encoded-configuration");
    expect(String(fetchImpl.mock.calls.at(-1)?.[0])).toContain(
      `/orgs/${jit.organization}/actions/runners/generate-jitconfig`,
    );
    expect(JSON.parse(String(fetchImpl.mock.calls.at(-1)?.[1]?.body))).toEqual({
      name: jit.runnerName,
      runner_group_id: 17,
      labels: [],
      work_folder: "_work",
    });
  });
  it.each([
    [
      "personal repository",
      {
        repo: {
          full_name: jit.repository,
          owner: { login: jit.organization, type: "User" },
        },
      },
    ],
    [
      "extra selected workflow",
      {
        group: {
          id: 17,
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
        recoveryStatus: "available",
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
