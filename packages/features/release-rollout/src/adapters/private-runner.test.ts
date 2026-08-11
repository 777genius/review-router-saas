import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  cleanupRunnerWorkspace,
  requestJitConfiguration,
  runOneJobRunner,
  workflowEnvironment,
} from "./github-jit-bootstrap";
import {
  RenderPrivateRunnerAdapter,
  type RenderRunnerRequest,
} from "./render-private-runner";
import { RenderProviderFreezeAdapter } from "./render-provider-freeze";
import { RenderTargetServicesAdapter } from "./render-target-services";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
const request: RenderRunnerRequest = {
  ownerId: "tea-owner",
  repository: "777genius/review-router",
  runId: "123",
  runAttempt: 2,
  commitSha: "a".repeat(40),
  jitLabel: "rr-123-2-aabbcc",
  baseServiceId: "srv-runner-base",
  baseDeployId: "dep-pinned-1",
  imageDigest: `sha256:${"b".repeat(64)}`,
  apiKey: "not-logged",
};
const service = {
  id: request.baseServiceId,
  ownerId: request.ownerId,
  serviceDetails: { runtime: "image", deployId: request.baseDeployId },
  image: { digest: request.imageDigest },
};
const created = {
  id: "job-123",
  serviceId: request.baseServiceId,
  status: "pending",
  startCommand: `node /runner/bootstrap.mjs --repository ${request.repository} --run-id ${request.runId} --run-attempt ${request.runAttempt} --sha ${request.commitSha} --label ${request.jitLabel}`,
  deployId: request.baseDeployId,
  imageDigest: request.imageDigest,
};

describe("Render private runner adapter", () => {
  it("pins the base deploy and resolved image in the provision receipt", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(service))
      .mockResolvedValueOnce(json(created));
    const result = await new RenderPrivateRunnerAdapter(fetchImpl).provision(
      request,
    );
    expect(result.identity).toMatchObject({
      baseDeployId: request.baseDeployId,
      imageDigest: request.imageDigest,
      jitLabel: request.jitLabel,
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual({
      startCommand: created.startCommand,
      planId: request.baseDeployId,
    });
  });

  it("rejects a mutable artifact before calling Render", async () => {
    const fetchImpl = vi.fn();
    await expect(
      new RenderPrivateRunnerAdapter(fetchImpl).provision({
        ...request,
        imageDigest: "latest",
      }),
    ).rejects.toThrow("render_runner_mutable_artifact_rejected");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [
      "wrong base deploy",
      {
        ...service,
        serviceDetails: { ...service.serviceDetails, deployId: "dep-new" },
      },
    ],
    [
      "wrong image",
      { ...service, image: { digest: `sha256:${"c".repeat(64)}` } },
    ],
    ["API response drift", { ...service, unexpected: true }],
  ])("fails closed on %s", async (_name, observation) => {
    await expect(
      new RenderPrivateRunnerAdapter(
        vi.fn().mockResolvedValue(json(observation)),
      ).provision(request),
    ).rejects.toThrow("render_runner_base_artifact_mismatch");
  });

  it("rejects malicious start-command input", async () => {
    const fetchImpl = vi.fn();
    await expect(
      new RenderPrivateRunnerAdapter(fetchImpl).provision({
        ...request,
        repository: "owner/repo;curl attacker",
      }),
    ).rejects.toThrow("render_runner_repository_invalid");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requires terminal cleanup and explicit cleanup proof", async () => {
    const adapter = new RenderPrivateRunnerAdapter(
      vi.fn().mockResolvedValue(
        json({
          id: "job-123",
          serviceId: request.baseServiceId,
          status: "succeeded",
          cleanupVerified: true,
        }),
      ),
    );
    await expect(
      adapter.cleanup({
        apiKey: request.apiKey,
        baseServiceId: request.baseServiceId,
        jobId: "job-123",
      }),
    ).resolves.toMatchObject({ step: "cleanup_ephemeral_runner" });
    const interrupted = new RenderPrivateRunnerAdapter(
      vi.fn().mockResolvedValue(
        json({
          id: "job-123",
          serviceId: request.baseServiceId,
          status: "running",
          cleanupVerified: false,
        }),
      ),
    );
    await expect(
      interrupted.cleanup({
        apiKey: request.apiKey,
        baseServiceId: request.baseServiceId,
        jobId: "job-123",
      }),
    ).rejects.toThrow("render_runner_cleanup_unproven");
  });
});

describe("Render provider freeze adapter", () => {
  const frozen = {
    id: "srv-api",
    ownerId: "tea-owner",
    autoDeployTrigger: "off",
    serviceDetails: { envSpecificDetails: { preDeployCommand: "" } },
  };

  it("proves the independent freeze without selecting a database", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(frozen))
      .mockResolvedValueOnce(json([{ id: "dep-old", status: "live" }]));
    await expect(
      new RenderProviderFreezeAdapter(fetchImpl).freezeAndObserve({
        serviceIds: ["srv-api"],
        ownerId: "tea-owner",
        apiKey: "secret",
      }),
    ).resolves.toMatchObject({ step: "freeze_provider_services" });
  });

  it.each([
    [
      "auto-deploy",
      { ...frozen, autoDeployTrigger: "commit" },
      [{ id: "dep-old", status: "live" }],
    ],
    [
      "nested pre-deploy",
      {
        ...frozen,
        serviceDetails: {
          envSpecificDetails: { preDeployCommand: "pnpm migrate" },
        },
      },
      [{ id: "dep-old", status: "live" }],
    ],
    [
      "active deploy",
      frozen,
      [{ id: "dep-new", status: "update_in_progress" }],
    ],
    [
      "response drift",
      { ...frozen, newField: true },
      [{ id: "dep-old", status: "live" }],
    ],
  ])("fails closed for %s", async (_name, observedService, deploys) => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(observedService))
      .mockResolvedValueOnce(json(deploys));
    await expect(
      new RenderProviderFreezeAdapter(fetchImpl).freezeAndObserve({
        serviceIds: ["srv-api"],
        ownerId: "tea-owner",
        apiKey: "secret",
      }),
    ).rejects.toThrow(/render_service_/u);
  });
});

describe("Render target staging adapter", () => {
  const expectation = {
    serviceId: "srv-target-api",
    deployId: "dep-target-api",
    imageDigest: `sha256:${"d".repeat(64)}`,
  };
  const observed = {
    id: expectation.serviceId,
    suspended: "suspended",
    serviceDetails: {
      deployId: expectation.deployId,
      imageDigest: expectation.imageDigest,
      commitSha: "a".repeat(40),
      envSpecificDetails: {
        databaseResourceId: "dpg-target-pg17",
        preDeployCommand: "",
      },
    },
  };

  it("requires the exact suspended deploy image commit and PG17 resource", async () => {
    await expect(
      new RenderTargetServicesAdapter(
        vi.fn().mockResolvedValue(json(observed)),
      ).stage({
        apiKey: "secret",
        targetDatabaseResourceId: "dpg-target-pg17",
        releaseCommitSha: "a".repeat(40),
        services: [expectation],
      }),
    ).resolves.toMatchObject({ step: "stage_target_services" });
  });

  it.each([
    [
      "wrong database",
      {
        ...observed,
        serviceDetails: {
          ...observed.serviceDetails,
          envSpecificDetails: {
            ...observed.serviceDetails.envSpecificDetails,
            databaseResourceId: "dpg-source-pg16",
          },
        },
      },
    ],
    [
      "wrong deploy",
      {
        ...observed,
        serviceDetails: { ...observed.serviceDetails, deployId: "dep-mutable" },
      },
    ],
    ["API drift", { ...observed, extra: true }],
  ])("fails closed on %s", async (_name, response) => {
    await expect(
      new RenderTargetServicesAdapter(
        vi.fn().mockResolvedValue(json(response)),
      ).stage({
        apiKey: "secret",
        targetDatabaseResourceId: "dpg-target-pg17",
        releaseCommitSha: "a".repeat(40),
        services: [expectation],
      }),
    ).rejects.toThrow("render_target_stage_observation_mismatch");
  });
});

describe("GitHub JIT bootstrap", () => {
  it("removes every bootstrap credential from a real workflow subprocess", async () => {
    const directory = mkdtempSync(join(tmpdir(), "rr-runner-proof-"));
    const executable = join(directory, "runner-proof.sh");
    writeFileSync(
      executable,
      '#!/bin/sh\n[ -z "$REVIEW_ROUTER_RUNNER_GITHUB_APP_ID" ] && [ -z "$REVIEW_ROUTER_RUNNER_GITHUB_APP_INSTALLATION_ID" ] && [ -z "$REVIEW_ROUTER_RUNNER_GITHUB_APP_PRIVATE_KEY" ] && [ -z "$GITHUB_TOKEN" ] && [ -z "$GH_TOKEN" ]\n',
    );
    chmodSync(executable, 0o700);
    await expect(
      runOneJobRunner({
        runnerPath: executable,
        jitConfig: "opaque-jit-config-value",
        timeoutMs: 5_000,
        environment: {
          REVIEW_ROUTER_RUNNER_GITHUB_APP_ID: "secret",
          REVIEW_ROUTER_RUNNER_GITHUB_APP_INSTALLATION_ID: "secret",
          REVIEW_ROUTER_RUNNER_GITHUB_APP_PRIVATE_KEY: "secret",
          GITHUB_TOKEN: "secret",
          GH_TOKEN: "secret",
          SAFE_VALUE: "kept",
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("scrubs without mutating caller environment", () => {
    const source = {
      REVIEW_ROUTER_RUNNER_GITHUB_APP_PRIVATE_KEY: "secret",
      SAFE: "yes",
    };
    expect(workflowEnvironment(source)).toEqual({ SAFE: "yes" });
    expect(source.REVIEW_ROUTER_RUNNER_GITHUB_APP_PRIVATE_KEY).toBe("secret");
  });

  it("kills a runner that never accepts its one job", async () => {
    const directory = mkdtempSync(join(tmpdir(), "rr-runner-timeout-"));
    const executable = join(directory, "runner-sleep.sh");
    writeFileSync(executable, "#!/bin/sh\nexec sleep 30\n");
    chmodSync(executable, 0o700);
    await expect(
      runOneJobRunner({
        runnerPath: executable,
        jitConfig: "opaque-jit-config-value",
        timeoutMs: 1_000,
        environment: {},
      }),
    ).rejects.toThrow("github_jit_no_job_timeout");
  });

  it("rejects unsafe interrupted-cleanup paths", async () => {
    await expect(
      cleanupRunnerWorkspace(["/runner/_work/safe", "/etc"]),
    ).rejects.toThrow("github_jit_cleanup_failed:unsafe_path");
  });

  it("verifies exact run identity and rejects reused/drifting JIT responses", async () => {
    const context = {
      repository: "777genius/review-router",
      runId: "123",
      runAttempt: 2,
      commitSha: "a".repeat(40),
      actor: "release-operator",
      label: "rr-123-2-aabbcc",
      runnerName: "rr-123-2",
    };
    const run = {
      id: 123,
      run_attempt: 2,
      head_sha: context.commitSha,
      actor: { login: context.actor },
      path: ".github/workflows/release.yml",
    };
    const good = vi
      .fn()
      .mockResolvedValueOnce(json(run))
      .mockResolvedValueOnce(
        json({
          encoded_jit_config: "opaque-jit-configuration",
          runner: { name: context.runnerName, status: "offline", busy: false },
        }),
      );
    await expect(requestJitConfiguration(context, "token", good)).resolves.toBe(
      "opaque-jit-configuration",
    );
    const wrongSha = vi
      .fn()
      .mockResolvedValue(json({ ...run, head_sha: "b".repeat(40) }));
    await expect(
      requestJitConfiguration(context, "token", wrongSha),
    ).rejects.toThrow("github_jit_run_identity_mismatch");
    const reused = vi
      .fn()
      .mockResolvedValueOnce(json(run))
      .mockResolvedValueOnce(
        json({
          encoded_jit_config: "opaque-jit-configuration",
          runner: { name: context.runnerName, status: "online", busy: true },
        }),
      );
    await expect(
      requestJitConfiguration(context, "token", reused),
    ).rejects.toThrow("github_jit_response_invalid");
    const drift = vi
      .fn()
      .mockResolvedValueOnce(json(run))
      .mockResolvedValueOnce(
        json({
          encoded_jit_config: "opaque-jit-configuration",
          runner: { name: context.runnerName, status: "offline", busy: false },
          newField: true,
        }),
      );
    await expect(
      requestJitConfiguration(context, "token", drift),
    ).rejects.toThrow("github_jit_response_invalid");
  });
});
