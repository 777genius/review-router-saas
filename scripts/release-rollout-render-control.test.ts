import { afterEach, describe, expect, it, vi } from "vitest";
import {
  reconcileWithBoundedBackoff,
  resolveWorkflowJobId,
} from "./release-rollout-render-control";
import { parseFreezeSourceWriterServiceIds } from "./release-rollout-render-control-config";
import { parseCompensationSourceWriterServiceIds } from "./reconcile-private-pg17-compensation-config";

const sha = "a".repeat(40);
const response = (jobs: object[], totalCount = jobs.length) =>
  new Response(JSON.stringify({ total_count: totalCount, jobs }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const job = (overrides: Record<string, unknown> = {}) => ({
  id: 41,
  name: "pg17-cutover-private",
  status: "queued",
  run_id: 101,
  run_attempt: 1,
  head_sha: sha,
  ...overrides,
});
const options = (request: typeof fetch) => ({
  runId: "101",
  runAttempt: "1",
  expectedSha: sha,
  attempts: 3,
  intervalMs: 1,
  request,
  sleep: vi.fn(async () => undefined),
});

describe("private PG17 target workflow job resolution", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("bounded-polls until the exact queued job exists", async () => {
    vi.stubEnv("GITHUB_REPOSITORY", "owner/repository");
    vi.stubEnv("GITHUB_CONTROL_READ_TOKEN", "token");
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response([job()]));
    const config = options(request);

    await expect(
      resolveWorkflowJobId("pg17-cutover-private", config),
    ).resolves.toBe("41");
    expect(request).toHaveBeenCalledTimes(2);
    expect(config.sleep).toHaveBeenCalledOnce();
    expect(String(request.mock.calls[0]?.[0])).toContain(
      "/actions/runs/101/attempts/1/jobs?filter=all&per_page=100",
    );
  });

  it.each([
    ["duplicate", [job(), job({ id: 42 })], "identity_ambiguous"],
    ["wrong SHA", [job({ head_sha: "b".repeat(40) })], "identity_ambiguous"],
    ["stale", [job({ status: "in_progress" })], "identity_stale"],
  ])("fails closed for %s target jobs", async (_label, jobs, error) => {
    vi.stubEnv("GITHUB_REPOSITORY", "owner/repository");
    vi.stubEnv("GITHUB_CONTROL_READ_TOKEN", "token");
    const request = vi.fn<typeof fetch>().mockResolvedValue(response(jobs));

    await expect(
      resolveWorkflowJobId("pg17-cutover-private", options(request)),
    ).rejects.toThrow(error);
    expect(request).toHaveBeenCalledOnce();
  });

  it("fails closed when the jobs response requires another page", async () => {
    vi.stubEnv("GITHUB_REPOSITORY", "owner/repository");
    vi.stubEnv("GITHUB_CONTROL_READ_TOKEN", "token");
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response([job()], 101));

    await expect(
      resolveWorkflowJobId("pg17-cutover-private", options(request)),
    ).rejects.toThrow("provider_http_response_invalid");
  });

  it("does not expose GitHub auth, headers, or malformed bodies", async () => {
    vi.stubEnv("GITHUB_REPOSITORY", "owner/repository");
    vi.stubEnv("GITHUB_CONTROL_READ_TOKEN", "github-control-token-canary");
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("github-control-body-canary{", {
        status: 200,
        headers: { "set-cookie": "github-control-cookie-canary" },
      }),
    );
    const error = await resolveWorkflowJobId(
      "pg17-cutover-private",
      options(request),
    ).catch((value: unknown) => value);
    const output = `${String(error)}${JSON.stringify(error)}`;
    expect(output.length).toBeLessThan(1_536);
    expect(output).not.toMatch(
      /github-control-token-canary|github-control-body-canary|github-control-cookie-canary/u,
    );
  });

  it("stops after the configured polling bound", async () => {
    vi.stubEnv("GITHUB_REPOSITORY", "owner/repository");
    vi.stubEnv("GITHUB_CONTROL_READ_TOKEN", "token");
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => response([]));
    const config = options(request);

    await expect(
      resolveWorkflowJobId("pg17-cutover-private", config),
    ).rejects.toThrow("target_job_identity_unavailable");
    expect(request).toHaveBeenCalledTimes(3);
    expect(config.sleep).toHaveBeenCalledTimes(2);
  });
});

describe("source writer service ID workflow contract", () => {
  it.each([
    parseFreezeSourceWriterServiceIds,
    parseCompensationSourceWriterServiceIds,
  ])("fails closed on malformed, duplicate, and unsafe values", (parse) => {
    for (const value of [
      "srv-api123,srv-worker456",
      '["srv-api123","srv-api123"]',
      '["srv-worker456","srv-api123"]',
      '["srv-api123","../../unsafe"]',
      '["srv-api123",42]',
      '{"serviceIds":["srv-api123"]}',
      '[ "srv-api123" ]',
      "[]",
    ])
      expect(() => parse(value)).toThrow(/source_writer_service_ids_/u);
  });
});

describe("completed-controller reconciliation redrive", () => {
  const report = (result: "clean" | "pending" | "blocked") => ({
    result,
    safeForCompensation: result === "clean",
    intentCount: 1,
    intents: [
      {
        id: "intent-role",
        state:
          result === "clean" ? ("cleaned" as const) : ("dispatching" as const),
        safeForCompensation: result === "clean",
      },
    ],
    observations: [],
  });

  it("redrives pending work with bounded exponential backoff until late completion is clean", async () => {
    const reconcile = vi
      .fn()
      .mockResolvedValueOnce(report("pending"))
      .mockResolvedValueOnce(report("pending"))
      .mockResolvedValueOnce(report("clean"));
    const sleep = vi.fn(async () => undefined);
    await expect(
      reconcileWithBoundedBackoff({
        attempts: 4,
        initialDelayMs: 10,
        maximumDelayMs: 15,
        reconcile,
        sleep,
      }),
    ).resolves.toMatchObject({ result: "clean", safeForCompensation: true });
    expect(sleep.mock.calls).toEqual([[10], [15]]);
    expect(reconcile).toHaveBeenCalledTimes(3);
  });

  it("stops immediately on an explicit block", async () => {
    const reconcile = vi.fn().mockResolvedValue(report("blocked"));
    const sleep = vi.fn(async () => undefined);
    await expect(
      reconcileWithBoundedBackoff({
        attempts: 4,
        initialDelayMs: 10,
        maximumDelayMs: 20,
        reconcile,
        sleep,
      }),
    ).resolves.toMatchObject({ result: "blocked", safeForCompensation: false });
    expect(reconcile).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("turns an exhausted pending redrive into a fail-closed timeout", async () => {
    const reconcile = vi.fn().mockResolvedValue(report("pending"));
    await expect(
      reconcileWithBoundedBackoff({
        attempts: 2,
        initialDelayMs: 1,
        maximumDelayMs: 1,
        reconcile,
        sleep: vi.fn(async () => undefined),
      }),
    ).resolves.toMatchObject({
      result: "blocked",
      reason: "timeout",
      safeForCompensation: false,
    });
    expect(reconcile).toHaveBeenCalledTimes(2);
  });
});
