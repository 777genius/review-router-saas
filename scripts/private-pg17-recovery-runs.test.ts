import { describe, expect, it, vi } from "vitest";
import {
  discoverPrivatePg17RecoveryRuns,
  dispatchPrivatePg17RecoveryContinuation,
  parsePrivatePg17RecoveryCheckpoint,
  selectPrivatePg17RecoveryRuns,
  type RecoverySweepCheckpoint,
} from "./private-pg17-recovery-runs";

const workflowPath = ".github/workflows/private-network-pg17-rollout.yml";
const scanStartedAt = "2026-08-13T12:00:00Z";
const run = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  display_title: `private-pg17:rollout-${id}`,
  event: "workflow_dispatch",
  head_sha: String(id % 10).repeat(40),
  head_branch: "main",
  path: `${workflowPath}@refs/heads/main`,
  run_attempt: 1,
  ...overrides,
});
const descendingRuns = (highest: number, count: number) =>
  Array.from({ length: count }, (_, index) => run(highest - index));
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("private PG17 scheduled recovery discovery", () => {
  it("selects only exact first-attempt main workflow dispatches and deterministically deduplicates", () => {
    expect(
      selectPrivatePg17RecoveryRuns({
        workflowPath,
        runs: [
          run(12),
          run(12),
          run(11, { run_attempt: 2 }),
          run(10, { path: ".github/workflows/other.yml@refs/heads/main" }),
          run(9, { display_title: "untrusted" }),
        ],
      }),
    ).toEqual([{ run_id: "12", run_attempt: "1", head_sha: "2".repeat(40) }]);
  });

  it("recovers 201 retained runs through bounded, exact restart checkpoints", async () => {
    const firstRequest = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({ total_count: 201, workflow_runs: descendingRuns(500, 100) }),
      )
      .mockResolvedValueOnce(
        response({ total_count: 201, workflow_runs: descendingRuns(400, 100) }),
      );
    const first = await discoverPrivatePg17RecoveryRuns({
      repository: "owner/repository",
      workflowPath,
      token: "token",
      maximumPages: 2,
      scanStartedAt,
      request: firstRequest,
    });
    expect(first.complete).toBe(false);
    expect(first.runs).toHaveLength(200);
    expect(first.checkpoint).toEqual({
      version: 1,
      repository: "owner/repository",
      workflow_path: workflowPath,
      created_through: scanStartedAt,
      total_count: 201,
      next_page: 3,
      last_run_id: "301",
    });
    expect(firstRequest.mock.calls[0]?.[0]).toContain(
      "created=%3C%3D2026-08-13T12%3A00%3A00Z",
    );

    const resumeRequest = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response({ total_count: 201, workflow_runs: [run(300)] }),
      );
    const resumed = await discoverPrivatePg17RecoveryRuns({
      repository: "owner/repository",
      workflowPath,
      token: "token",
      maximumPages: 2,
      checkpoint: JSON.stringify(first.checkpoint),
      request: resumeRequest,
    });
    expect(resumed).toEqual({
      runs: [{ run_id: "300", run_attempt: "1", head_sha: "0".repeat(40) }],
      complete: true,
    });
    expect(resumeRequest.mock.calls[0]?.[0]).toContain("page=3");
    expect(resumeRequest.mock.calls[0]?.[0]).toContain(
      "created=%3C%3D2026-08-13T12%3A00%3A00Z",
    );
  });

  it("keeps each sweep window below the matrix resource cap", async () => {
    await expect(
      discoverPrivatePg17RecoveryRuns({
        repository: "owner/repository",
        workflowPath,
        token: "token",
        maximumPages: 3,
        request: vi.fn<typeof fetch>(),
      }),
    ).rejects.toThrow("recovery_discovery_input_invalid");
  });

  it("rejects malformed, out-of-scope, and skip-ahead checkpoints", async () => {
    const valid: RecoverySweepCheckpoint = {
      version: 1,
      repository: "owner/repository",
      workflow_path: workflowPath,
      created_through: scanStartedAt,
      total_count: 201,
      next_page: 3,
      last_run_id: "301",
    };
    expect(() =>
      parsePrivatePg17RecoveryCheckpoint(
        JSON.stringify({ ...valid, next_page: 4 }),
      ),
    ).toThrow("recovery_checkpoint_invalid");
    await expect(
      discoverPrivatePg17RecoveryRuns({
        repository: "other/repository",
        workflowPath,
        token: "token",
        maximumPages: 2,
        checkpoint: JSON.stringify(valid),
        request: vi.fn<typeof fetch>(),
      }),
    ).rejects.toThrow("recovery_checkpoint_scope_mismatch");
  });

  it("fails closed when total_count changes between pages or resumes", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({ total_count: 201, workflow_runs: descendingRuns(500, 100) }),
      )
      .mockResolvedValueOnce(
        response({ total_count: 202, workflow_runs: descendingRuns(400, 100) }),
      );
    await expect(
      discoverPrivatePg17RecoveryRuns({
        repository: "owner/repository",
        workflowPath,
        token: "token",
        maximumPages: 2,
        scanStartedAt,
        request,
      }),
    ).rejects.toThrow("recovery_list_changed");
  });

  it("fails closed on short pages and duplicate or reordered page boundaries", async () => {
    const short = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response({ total_count: 101, workflow_runs: descendingRuns(500, 99) }),
      );
    await expect(
      discoverPrivatePg17RecoveryRuns({
        repository: "owner/repository",
        workflowPath,
        token: "token",
        maximumPages: 2,
        scanStartedAt,
        request: short,
      }),
    ).rejects.toThrow("recovery_list_page_incomplete");

    const reordered = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({ total_count: 101, workflow_runs: descendingRuns(500, 100) }),
      )
      .mockResolvedValueOnce(
        response({ total_count: 101, workflow_runs: [run(401)] }),
      );
    await expect(
      discoverPrivatePg17RecoveryRuns({
        repository: "owner/repository",
        workflowPath,
        token: "token",
        maximumPages: 2,
        scanStartedAt,
        request: reordered,
      }),
    ).rejects.toThrow("recovery_list_order_changed");
  });

  it("supports one exact manual recovery target without pagination", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response(run(42)));
    await expect(
      discoverPrivatePg17RecoveryRuns({
        repository: "owner/repository",
        workflowPath,
        token: "token",
        targetRunId: "42",
        maximumPages: 2,
        request,
      }),
    ).resolves.toEqual({
      runs: [{ run_id: "42", run_attempt: "1", head_sha: "2".repeat(40) }],
      complete: true,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("dispatches continuation with bounded exponential backoff and fails closed", async () => {
    const checkpoint: RecoverySweepCheckpoint = {
      version: 1,
      repository: "owner/repository",
      workflow_path: workflowPath,
      created_through: scanStartedAt,
      total_count: 201,
      next_page: 3,
      last_run_id: "301",
    };
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({}, 503))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const wait = vi.fn(async () => undefined);
    await dispatchPrivatePg17RecoveryContinuation({
      repository: "owner/repository",
      workflowFile: "private-pg17-runner-controller.yml",
      token: "token",
      checkpoint,
      attempts: 4,
      initialDelayMs: 1_000,
      maximumDelayMs: 8_000,
      request,
      wait,
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(1_000);
    expect(JSON.parse(String(request.mock.calls[1]?.[1]?.body))).toEqual({
      ref: "main",
      inputs: { sweep_checkpoint: JSON.stringify(checkpoint) },
    });

    await expect(
      dispatchPrivatePg17RecoveryContinuation({
        repository: "owner/repository",
        workflowFile: "private-pg17-runner-controller.yml",
        token: "token",
        checkpoint,
        attempts: 4,
        initialDelayMs: 1_000,
        maximumDelayMs: 8_000,
        request: vi.fn<typeof fetch>().mockResolvedValue(response({}, 403)),
        wait,
      }),
    ).rejects.toThrow("recovery_continuation_failed:403");
  });
});
