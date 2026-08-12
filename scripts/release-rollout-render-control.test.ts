import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveWorkflowJobId } from "./release-rollout-render-control";

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
    ).rejects.toThrow("target_job_list_ambiguous");
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
