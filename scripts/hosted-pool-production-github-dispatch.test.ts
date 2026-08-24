import { describe, expect, it, vi } from "vitest";
import {
  assertCanonicalAttemptOnePullRequestRun,
  collectAppBotPublicationEvidence,
} from "./hosted-pool-production-github-dispatch";

const workflowPath = ".github/workflows/reviewrouter-codex.yml";

describe("hosted pool GitHub rerun dispatch", () => {
  it("accepts only canonical attempt-1 pull_request source runs", () => {
    const run = {
      id: 42,
      repository: { id: 123 },
      run_attempt: 1,
      status: "completed",
      conclusion: "success",
      event: "pull_request",
      pull_requests: [{ number: 7, base: { repo: { id: 123 } } }],
      head_sha: "a".repeat(40),
      path: `${workflowPath}@refs/heads/main`,
    };
    expect(
      assertCanonicalAttemptOnePullRequestRun(run, {
        runId: 42,
        repositoryId: 123,
        workflowPath,
      }),
    ).toEqual({ headSha: "a".repeat(40), pullRequestNumber: 7 });
    for (const invalid of [
      { ...run, event: "workflow_dispatch" },
      { ...run, run_attempt: 2 },
      { ...run, pull_requests: [] },
    ]) {
      expect(() =>
        assertCanonicalAttemptOnePullRequestRun(invalid, {
          runId: 42,
          repositoryId: 123,
          workflowPath,
        }),
      ).toThrow("hosted_pool_canary_source_run_not_one_shot:42");
    }
  });

  it("rejects every ReviewRouter publication not authored by the App bot", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce([
        {
          body: "reviewrouter:summary:v2:abc",
          user: { login: "rr-app[bot]" },
          created_at: "2026-08-23T00:00:10Z",
          updated_at: "2026-08-24T00:00:10Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          body: "review-router-finding:def",
          user: { login: "github-actions[bot]" },
          created_at: "2026-08-24T00:00:20Z",
        },
      ])
      .mockResolvedValueOnce([]);
    await expect(
      collectAppBotPublicationEvidence(
        { request },
        {
          repository: "owner/repo",
          pullRequestNumber: 7,
          expectedAppBot: "rr-app[bot]",
          startedAt: new Date("2026-08-24T00:00:00Z"),
          finishedAt: new Date("2026-08-24T00:01:00Z"),
        },
      ),
    ).resolves.toEqual({
      appBotPublicationCount: 1,
      nonAppBotPublicationCount: 1,
    });
  });
});
