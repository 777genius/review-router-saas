import { describe, expect, it, vi } from "vitest";
import {
  discoverPrivatePg17RecoveryRuns,
  selectPrivatePg17RecoveryRuns,
} from "./private-pg17-recovery-runs";

const workflowPath = ".github/workflows/private-network-pg17-rollout.yml";
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
const response = (value: unknown) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("private PG17 scheduled recovery discovery", () => {
  it("selects only exact first-attempt main workflow dispatches", () => {
    expect(
      selectPrivatePg17RecoveryRuns({
        workflowPath,
        runs: [
          run(12),
          run(11, { run_attempt: 2 }),
          run(10, { path: ".github/workflows/other.yml@refs/heads/main" }),
          run(9, { display_title: "untrusted" }),
        ],
      }),
    ).toEqual([{ run_id: "12", run_attempt: "1", head_sha: "2".repeat(40) }]);
  });

  it("paginates to the declared bound and never silently truncates recovery", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({ total_count: 101, workflow_runs: [run(12)] }),
      )
      .mockResolvedValueOnce(
        response({ total_count: 101, workflow_runs: [run(11)] }),
      );
    await expect(
      discoverPrivatePg17RecoveryRuns({
        repository: "owner/repository",
        workflowPath,
        token: "token",
        maximumPages: 2,
        request,
      }),
    ).rejects.toThrow("recovery_list_bound_exhausted");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("supports one exact manual recovery target", async () => {
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
    ).resolves.toEqual([
      { run_id: "42", run_attempt: "1", head_sha: "2".repeat(40) },
    ]);
  });
});
