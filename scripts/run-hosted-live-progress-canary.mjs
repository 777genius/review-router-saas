#!/usr/bin/env node
import { spawnSync } from "node:child_process";

export const liveProgressMarker = "<!-- review-router-live-progress -->";

const disposableTargets = new Map([
  ["777genius/review-router-saas-e2e", "R_kgDOSTKVDw"],
]);

const terminalPhases = new Set([
  "Complete",
  "Complete with gaps",
  "Failed",
  "Cancelled",
  "Superseded",
]);

export function readHostedProgressCanaryConfig(env = process.env) {
  const config = {
    repository: required(env, "REVIEW_ROUTER_HOSTED_CANARY_REPOSITORY"),
    repositoryNodeId: required(
      env,
      "REVIEW_ROUTER_HOSTED_CANARY_REPOSITORY_NODE_ID",
    ),
    pullRequest: positiveInteger(
      required(env, "REVIEW_ROUTER_HOSTED_CANARY_PR_NUMBER"),
      "REVIEW_ROUTER_HOSTED_CANARY_PR_NUMBER",
    ),
    runId: positiveInteger(
      required(env, "REVIEW_ROUTER_HOSTED_CANARY_RUN_ID"),
      "REVIEW_ROUTER_HOSTED_CANARY_RUN_ID",
    ),
    workflowPath: required(env, "REVIEW_ROUTER_HOSTED_CANARY_WORKFLOW_PATH"),
    expectedBotLogin: required(
      env,
      "REVIEW_ROUTER_HOSTED_CANARY_EXPECTED_BOT_LOGIN",
    ).toLowerCase(),
    expectedChangedFiles: positiveInteger(
      required(env, "REVIEW_ROUTER_HOSTED_CANARY_EXPECTED_CHANGED_FILES"),
      "REVIEW_ROUTER_HOSTED_CANARY_EXPECTED_CHANGED_FILES",
    ),
    expectedReviewedFiles: positiveInteger(
      required(env, "REVIEW_ROUTER_HOSTED_CANARY_EXPECTED_REVIEWED_FILES"),
      "REVIEW_ROUTER_HOSTED_CANARY_EXPECTED_REVIEWED_FILES",
    ),
    expectedExcludedFiles: nonNegativeInteger(
      required(env, "REVIEW_ROUTER_HOSTED_CANARY_EXPECTED_EXCLUDED_FILES"),
      "REVIEW_ROUTER_HOSTED_CANARY_EXPECTED_EXCLUDED_FILES",
    ),
    pollIntervalMs: positiveInteger(
      env.REVIEW_ROUTER_HOSTED_CANARY_POLL_INTERVAL_MS ?? "10000",
      "REVIEW_ROUTER_HOSTED_CANARY_POLL_INTERVAL_MS",
    ),
    timeoutMs: positiveInteger(
      env.REVIEW_ROUTER_HOSTED_CANARY_TIMEOUT_MS ?? "5400000",
      "REVIEW_ROUTER_HOSTED_CANARY_TIMEOUT_MS",
    ),
  };
  if (env.REVIEW_ROUTER_RUN_HOSTED_PROGRESS_CANARY !== "1") {
    throw new Error(
      "hosted_progress_canary_confirmation_required: set REVIEW_ROUTER_RUN_HOSTED_PROGRESS_CANARY=1",
    );
  }
  assertDisposableTarget(config.repository, config.repositoryNodeId);
  if (config.expectedChangedFiles < 100) {
    throw new Error("hosted_progress_canary_fixture_not_large");
  }
  if (
    config.expectedReviewedFiles + config.expectedExcludedFiles !==
    config.expectedChangedFiles
  ) {
    throw new Error("hosted_progress_canary_expected_coverage_inconsistent");
  }
  if (
    config.workflowPath !== ".github/workflows/reviewrouter-codex.yml" ||
    !/^[a-z0-9][a-z0-9-]*\[bot\]$/u.test(config.expectedBotLogin)
  ) {
    throw new Error("hosted_progress_canary_identity_contract_invalid");
  }
  return config;
}

export async function runHostedProgressCanary(config, dependencies) {
  assertDisposableTarget(config.repository, config.repositoryNodeId);
  const { github, now, sleep } = dependencies;
  const repository = await github.getRepository(config.repository);
  if (
    repository.full_name !== config.repository ||
    repository.node_id !== config.repositoryNodeId
  ) {
    throw new Error("hosted_progress_canary_repository_identity_mismatch");
  }

  const pull = await github.getPullRequest(
    config.repository,
    config.pullRequest,
  );
  if (
    pull.state !== "open" ||
    pull.head?.repo?.full_name !== config.repository ||
    pull.changed_files !== config.expectedChangedFiles
  ) {
    throw new Error("hosted_progress_canary_pull_request_contract_mismatch");
  }
  const headSha = pull.head?.sha;
  if (!/^[0-9a-f]{40}$/u.test(headSha ?? "")) {
    throw new Error("hosted_progress_canary_head_sha_invalid");
  }

  const runBefore = await github.getWorkflowRun(
    config.repository,
    config.runId,
  );
  assertWorkflowRun(
    runBefore,
    config.pullRequest,
    headSha,
    config.workflowPath,
  );
  if (runBefore.status !== "completed") {
    throw new Error("hosted_progress_canary_run_not_rerunnable");
  }

  const baseline = markerComments(
    await github.listIssueComments(config.repository, config.pullRequest),
    config.expectedBotLogin,
  );
  if (baseline.length > 1) {
    throw new Error("hosted_progress_canary_multiple_marker_comments");
  }
  const baselineComment = baseline[0];
  if (
    baselineComment &&
    (typeof baselineComment.id !== "number" ||
      !Number.isFinite(Date.parse(baselineComment.updated_at ?? "")))
  ) {
    throw new Error("hosted_progress_canary_comment_contract_invalid");
  }
  const baselineUpdatedAt = baselineComment
    ? Date.parse(baselineComment.updated_at)
    : undefined;
  const triggerTime = now();
  await github.rerunWorkflow(config.repository, config.runId);

  const observations = [];
  let markerCommentId = baselineComment?.id;
  let lastFingerprint = baselineComment
    ? `${baselineComment.updated_at}\n${baselineComment.body}`
    : undefined;
  let rerunObserved = false;
  let finalRun;
  const deadline = triggerTime + config.timeoutMs;

  while (now() <= deadline) {
    const run = await github.getWorkflowRun(config.repository, config.runId);
    assertWorkflowRun(run, config.pullRequest, headSha, config.workflowPath);
    if (run.run_attempt > runBefore.run_attempt) rerunObserved = true;

    const comments = markerComments(
      await github.listIssueComments(config.repository, config.pullRequest),
      config.expectedBotLogin,
    );
    if (comments.length > 1) {
      throw new Error("hosted_progress_canary_multiple_marker_comments");
    }
    const comment = comments[0];
    if (comment) {
      if (markerCommentId !== undefined && comment.id !== markerCommentId) {
        throw new Error("hosted_progress_canary_comment_id_changed");
      }
      markerCommentId ??= comment.id;
      const fingerprint = `${comment.updated_at}\n${comment.body}`;
      if (fingerprint !== lastFingerprint) {
        const observation = parseProgressComment(comment);
        if (
          baselineUpdatedAt !== undefined &&
          Date.parse(observation.updatedAt) <= baselineUpdatedAt
        ) {
          throw new Error("hosted_progress_canary_stale_comment_update");
        }
        assertMonotonicObservation(observations.at(-1), observation);
        observations.push(observation);
        lastFingerprint = fingerprint;
      }
    }

    if (
      rerunObserved &&
      run.status === "completed" &&
      terminalPhases.has(observations.at(-1)?.phase ?? "")
    ) {
      finalRun = run;
      break;
    }
    await sleep(config.pollIntervalMs);
  }

  if (!rerunObserved)
    throw new Error("hosted_progress_canary_rerun_not_observed");
  if (!finalRun) throw new Error("hosted_progress_canary_timed_out");
  if (finalRun.conclusion !== "success") {
    throw new Error("hosted_progress_canary_workflow_failed");
  }
  if (observations.length < 2) {
    throw new Error("hosted_progress_canary_not_dynamically_updated");
  }
  if (!observations.some((item) => !terminalPhases.has(item.phase))) {
    throw new Error("hosted_progress_canary_intermediate_state_missing");
  }
  const final = observations.at(-1);
  if (
    final.phase !== "Complete" ||
    final.completedUnits !== final.totalUnits ||
    final.coveredFiles !== config.expectedReviewedFiles ||
    final.totalFiles !== config.expectedReviewedFiles ||
    final.unassignedFiles !== 0 ||
    final.excludedFiles !== config.expectedExcludedFiles ||
    final.exhaustedUnits !== 0
  ) {
    throw new Error("hosted_progress_canary_final_coverage_incomplete");
  }

  return {
    repository: config.repository,
    pullRequest: config.pullRequest,
    headSha,
    runId: config.runId,
    runAttempt: finalRun.run_attempt,
    markerCommentId,
    progressUpdates: observations.length,
    reviewedFiles: final.coveredFiles,
    reviewUnits: final.totalUnits,
    terminal: final.phase,
  };
}

export function parseProgressComment(comment) {
  if (
    typeof comment?.id !== "number" ||
    typeof comment?.body !== "string" ||
    comment.user?.type !== "Bot" ||
    occurrences(comment.body, liveProgressMarker) !== 1
  ) {
    throw new Error("hosted_progress_canary_comment_contract_invalid");
  }
  const phase = capture(comment.body, /\*\*Phase:\*\* ([^\n]+)/u, "phase");
  const units = captureNumbers(
    comment.body,
    /Review units: (\d+) of (\d+) complete \(\d+%\)/u,
    "review_units",
  );
  const files = captureNumbers(
    comment.body,
    /Files in completed units: (\d+) of (\d+)/u,
    "file_coverage",
  );
  return {
    commentId: comment.id,
    updatedAt: requireInstant(comment.updated_at),
    phase,
    completedUnits: units[0],
    totalUnits: units[1],
    coveredFiles: files[0],
    totalFiles: files[1],
    unassignedFiles: singleNumber(comment.body, "Files not assigned"),
    excludedFiles: singleNumber(comment.body, "Files unavailable or excluded"),
    exhaustedUnits: singleNumber(
      comment.body,
      "Units not completed after retries",
    ),
  };
}

export function assertMonotonicObservation(previous, next) {
  if (!previous) return;
  if (Date.parse(next.updatedAt) <= Date.parse(previous.updatedAt)) {
    throw new Error("hosted_progress_canary_sequence_not_monotonic");
  }
  if (
    next.commentId !== previous.commentId ||
    next.totalUnits !== previous.totalUnits ||
    next.totalFiles !== previous.totalFiles
  ) {
    throw new Error("hosted_progress_canary_manifest_changed");
  }
  if (
    next.completedUnits < previous.completedUnits ||
    next.coveredFiles < previous.coveredFiles ||
    phaseRank(next.phase) < phaseRank(previous.phase)
  ) {
    throw new Error("hosted_progress_canary_progress_regressed");
  }
}

export function createGhGitHub() {
  return {
    getRepository: (repo) => api(`repos/${repo}`),
    getPullRequest: (repo, number) => api(`repos/${repo}/pulls/${number}`),
    getWorkflowRun: (repo, runId) => api(`repos/${repo}/actions/runs/${runId}`),
    listIssueComments: (repo, number) =>
      apiPages(`repos/${repo}/issues/${number}/comments?per_page=100`),
    rerunWorkflow(repo, runId) {
      command(["run", "rerun", String(runId), "--repo", repo]);
    },
  };
}

function assertDisposableTarget(repository, nodeId) {
  if (disposableTargets.get(repository) !== nodeId) {
    throw new Error("hosted_progress_canary_target_not_allowlisted");
  }
}

function assertWorkflowRun(run, pullRequest, headSha, workflowPath) {
  if (
    run.event !== "pull_request" ||
    run.head_sha !== headSha ||
    run.path !== workflowPath ||
    !run.pull_requests?.some((pull) => pull.number === pullRequest) ||
    !Number.isInteger(run.run_attempt)
  ) {
    throw new Error("hosted_progress_canary_workflow_run_contract_mismatch");
  }
}

function markerComments(comments, expectedBotLogin) {
  const marked = comments.filter(
    (comment) =>
      typeof comment.body === "string" &&
      comment.body.includes(liveProgressMarker),
  );
  if (
    marked.some(
      (comment) =>
        comment.user?.type !== "Bot" ||
        comment.user?.login?.toLowerCase() !== expectedBotLogin,
    )
  ) {
    throw new Error("hosted_progress_canary_marker_author_invalid");
  }
  return marked;
}

function api(endpoint) {
  const result = command([
    "api",
    `/${endpoint}`,
    "-H",
    "Accept: application/vnd.github+json",
  ]);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error("hosted_progress_canary_github_response_invalid");
  }
}

function apiPages(endpoint) {
  const result = command([
    "api",
    `/${endpoint}`,
    "-H",
    "Accept: application/vnd.github+json",
    "--paginate",
    "--slurp",
  ]);
  try {
    const pages = JSON.parse(result.stdout);
    if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
      throw new Error("invalid");
    }
    return pages.flat();
  } catch {
    throw new Error("hosted_progress_canary_github_response_invalid");
  }
}

function command(args) {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `hosted_progress_canary_github_command_failed: gh ${args[0] ?? "command"}`,
    );
  }
  return result;
}

function capture(body, pattern, field) {
  const value = body.match(pattern)?.[1];
  if (!value) throw new Error(`hosted_progress_canary_${field}_missing`);
  return value;
}

function captureNumbers(body, pattern, field) {
  const match = body.match(pattern);
  if (!match) throw new Error(`hosted_progress_canary_${field}_missing`);
  return [Number(match[1]), Number(match[2])];
}

function singleNumber(body, label) {
  return Number(capture(body, new RegExp(`${label}: (\\d+)`, "u"), "metric"));
}

function requireInstant(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error("hosted_progress_canary_updated_at_invalid");
  }
  return new Date(value).toISOString();
}

function occurrences(value, needle) {
  return value.split(needle).length - 1;
}

function phaseRank(phase) {
  return (
    {
      Preparing: 0,
      Reviewing: 1,
      "Assembling results": 2,
      "Publishing results": 3,
      Complete: 4,
      "Complete with gaps": 4,
      Failed: 4,
      Cancelled: 4,
      Superseded: 4,
    }[phase] ?? -1
  );
}

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`hosted_progress_canary_missing_${name}`);
  return value;
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`hosted_progress_canary_invalid_${name}`);
  }
  return parsed;
}

function nonNegativeInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`hosted_progress_canary_invalid_${name}`);
  }
  return parsed;
}

async function main() {
  const result = await runHostedProgressCanary(
    readHostedProgressCanaryConfig(),
    {
      github: createGhGitHub(),
      now: () => Date.now(),
      sleep: (milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)),
    },
  );
  console.log(JSON.stringify(result));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
