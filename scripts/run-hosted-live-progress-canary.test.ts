import { describe, expect, it, vi } from "vitest";
import {
  assertMonotonicObservation,
  parseProgressComment,
  readHostedProgressCanaryConfig,
  runHostedProgressCanary,
} from "./run-hosted-live-progress-canary.mjs";

const repo = "777genius/review-router-saas-e2e";
const nodeId = "R_kgDOSTKVDw";
const headSha = "a".repeat(40);

describe("hosted live-progress canary", () => {
  it("rejects every repository outside the immutable disposable allowlist", () => {
    expect(() =>
      readHostedProgressCanaryConfig(
        env({ REVIEW_ROUTER_HOSTED_CANARY_REPOSITORY: "company/product" }),
      ),
    ).toThrow("hosted_progress_canary_target_not_allowlisted");
  });

  it("requires an explicit mutation confirmation", () => {
    expect(() =>
      readHostedProgressCanaryConfig(
        env({ REVIEW_ROUTER_RUN_HOSTED_PROGRESS_CANARY: "0" }),
      ),
    ).toThrow("hosted_progress_canary_confirmation_required");
  });

  it("requires a fixture with at least 100 changed files", () => {
    expect(() =>
      readHostedProgressCanaryConfig(
        env({ REVIEW_ROUTER_HOSTED_CANARY_EXPECTED_CHANGED_FILES: "99" }),
      ),
    ).toThrow("hosted_progress_canary_fixture_not_large");
  });

  it("proves one comment ID, monotonic units/files, and complete 108-file coverage", async () => {
    const timeline = [
      [comment(41, progress("Reviewing", 12, 72, 18, 108, 1))],
      [comment(41, progress("Reviewing", 42, 72, 63, 108, 2))],
      [comment(41, progress("Complete", 72, 72, 108, 108, 3))],
    ];
    const github = fakeGitHub(timeline);
    const result = await runHostedProgressCanary(config(), {
      github,
      now: tickingClock(),
      sleep: async () => undefined,
    });
    expect(github.rerunWorkflow).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      markerCommentId: 41,
      progressUpdates: 3,
      reviewedFiles: 108,
      terminal: "Complete",
    });
  });

  it("rejects a marker comment ID replacement", async () => {
    const github = fakeGitHub([
      [comment(41, progress("Reviewing", 1, 2, 54, 108, 1))],
      [comment(42, progress("Complete", 2, 2, 108, 108, 2))],
    ]);
    await expect(
      runHostedProgressCanary(config(), {
        github,
        now: tickingClock(),
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("hosted_progress_canary_comment_id_changed");
  });

  it("rejects duplicate marker comments", async () => {
    const github = fakeGitHub([
      [
        comment(41, progress("Reviewing", 1, 2, 54, 108, 1)),
        comment(42, progress("Reviewing", 1, 2, 54, 108, 1)),
      ],
    ]);
    await expect(
      runHostedProgressCanary(config(), {
        github,
        now: tickingClock(),
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("hosted_progress_canary_multiple_marker_comments");
  });

  it("rejects a progress marker owned by another bot", async () => {
    const foreign = comment(41, progress("Reviewing", 1, 2, 54, 108, 1));
    foreign.user.login = "github-actions[bot]";
    const github = fakeGitHub([[foreign]]);
    await expect(
      runHostedProgressCanary(config(), {
        github,
        now: tickingClock(),
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("hosted_progress_canary_marker_author_invalid");
  });

  it("rejects regressing batch or file coverage", () => {
    const first = parseProgressComment(
      comment(41, progress("Reviewing", 42, 72, 63, 108, 2)),
    );
    const regressed = parseProgressComment(
      comment(41, progress("Reviewing", 41, 72, 62, 108, 3)),
    );
    expect(() => assertMonotonicObservation(first, regressed)).toThrow(
      "hosted_progress_canary_progress_regressed",
    );
  });

  it("rejects terminal success without exact fixture coverage", async () => {
    const github = fakeGitHub([
      [comment(41, progress("Reviewing", 1, 2, 54, 108, 1))],
      [comment(41, progress("Complete", 2, 2, 107, 108, 2))],
    ]);
    await expect(
      runHostedProgressCanary(config(), {
        github,
        now: tickingClock(),
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("hosted_progress_canary_final_coverage_incomplete");
  });

  it("rejects a workflow run not bound to the exact PR head", async () => {
    const github = fakeGitHub([]);
    github.getWorkflowRun.mockReset().mockResolvedValueOnce({
      ...workflowRun(1, "completed"),
      head_sha: "b".repeat(40),
    });
    await expect(
      runHostedProgressCanary(config(), {
        github,
        now: tickingClock(),
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("hosted_progress_canary_workflow_run_contract_mismatch");
    expect(github.rerunWorkflow).not.toHaveBeenCalled();
  });
});

function env(overrides: Record<string, string> = {}) {
  return {
    REVIEW_ROUTER_RUN_HOSTED_PROGRESS_CANARY: "1",
    REVIEW_ROUTER_HOSTED_CANARY_REPOSITORY: repo,
    REVIEW_ROUTER_HOSTED_CANARY_REPOSITORY_NODE_ID: nodeId,
    REVIEW_ROUTER_HOSTED_CANARY_PR_NUMBER: "37",
    REVIEW_ROUTER_HOSTED_CANARY_RUN_ID: "123",
    REVIEW_ROUTER_HOSTED_CANARY_WORKFLOW_PATH:
      ".github/workflows/reviewrouter-codex.yml",
    REVIEW_ROUTER_HOSTED_CANARY_EXPECTED_BOT_LOGIN: "review-router[bot]",
    REVIEW_ROUTER_HOSTED_CANARY_EXPECTED_CHANGED_FILES: "108",
    REVIEW_ROUTER_HOSTED_CANARY_EXPECTED_REVIEWED_FILES: "108",
    REVIEW_ROUTER_HOSTED_CANARY_EXPECTED_EXCLUDED_FILES: "0",
    ...overrides,
  };
}

function config() {
  return readHostedProgressCanaryConfig(env());
}

function fakeGitHub(timeline: ReturnType<typeof comment>[][]) {
  let poll = 0;
  return {
    getRepository: vi.fn(async () => ({ full_name: repo, node_id: nodeId })),
    getPullRequest: vi.fn(async () => ({
      state: "open",
      changed_files: 108,
      head: { sha: headSha, repo: { full_name: repo } },
    })),
    getWorkflowRun: vi
      .fn()
      .mockResolvedValueOnce(workflowRun(1, "completed"))
      .mockImplementation(async () =>
        workflowRun(
          2,
          poll >= timeline.length - 1 ? "completed" : "in_progress",
        ),
      ),
    listIssueComments: vi
      .fn()
      .mockResolvedValueOnce([])
      .mockImplementation(
        async () => timeline[Math.min(poll++, timeline.length - 1)] ?? [],
      ),
    rerunWorkflow: vi.fn(async () => undefined),
  };
}

function workflowRun(attempt: number, status: string) {
  return {
    event: "pull_request",
    head_sha: headSha,
    path: ".github/workflows/reviewrouter-codex.yml",
    pull_requests: [{ number: 37 }],
    run_attempt: attempt,
    status,
    conclusion: status === "completed" ? "success" : null,
  };
}

function comment(id: number, body: string) {
  const update =
    body.match(/Last update: 2026-08-13 10:00:0(\d) UTC/u)?.[1] ?? "0";
  return {
    id,
    body,
    updated_at: `2026-08-13T10:00:0${update}.000Z`,
    user: { type: "Bot", login: "review-router[bot]" },
  };
}

function progress(
  phase: string,
  completed: number,
  total: number,
  covered: number,
  files: number,
  second: number,
) {
  return `<!-- review-router-live-progress -->\n## ReviewRouter\n\n**Phase:** ${phase}\n\nReview units: ${completed} of ${total} complete (50%)\n[■■■■■□□□□□] 50%\nFiles in completed units: ${covered} of ${files}\nFiles not assigned: 0\nFiles unavailable or excluded: 0\nUnits currently retrying: 0\nUnits recovered by retry: 0\nUnits not completed after retries: 0\n\nLast update: 2026-08-13 10:00:0${second} UTC`;
}

function tickingClock() {
  let tick = 0;
  return () => 1_000 + tick++ * 100;
}
