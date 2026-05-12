#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local", override: false });
dotenv.config({ path: ".env", override: false });

const defaultRepo = "777genius/review-router-saas-e2e";
const repo = readEnv("REVIEW_ROUTER_GITHUB_MEMORY_E2E_REPO", defaultRepo);
const workflowName = readEnv(
  "REVIEW_ROUTER_GITHUB_MEMORY_E2E_WORKFLOW",
  "ReviewRouter Interaction",
);
const marker = readEnv(
  "REVIEW_ROUTER_GITHUB_MEMORY_E2E_MARKER",
  `rr-memory-smoke-${Date.now()}`,
);
const timeoutMs = readInt(
  "REVIEW_ROUTER_GITHUB_MEMORY_E2E_TIMEOUT_MS",
  12 * 60 * 1000,
);
const pollMs = readInt("REVIEW_ROUTER_GITHUB_MEMORY_E2E_POLL_MS", 15_000);
const botLoopWaitMs = readInt(
  "REVIEW_ROUTER_GITHUB_MEMORY_E2E_BOT_LOOP_WAIT_MS",
  45_000,
);
const preflightOnly =
  process.env.REVIEW_ROUTER_GITHUB_MEMORY_E2E_PREFLIGHT_ONLY === "1";

if (process.env.REVIEW_ROUTER_GITHUB_MEMORY_E2E !== "1") {
  fail(
    "github_memory_e2e_not_enabled",
    "Set REVIEW_ROUTER_GITHUB_MEMORY_E2E=1 to allow this script to post comments and trigger GitHub Actions.",
  );
}

const prNumber = readRequiredInt("REVIEW_ROUTER_GITHUB_MEMORY_E2E_PR");
const startedAt = new Date();
const evidence = {
  repo,
  prNumber,
  marker,
  workflowName,
  startedAt: startedAt.toISOString(),
  comments: [],
  runs: [],
};

await main();

async function main() {
  requireCommand("gh");
  gh(["auth", "status", "--hostname", "github.com"], { stdio: "ignore" });

  const [owner, name] = parseRepo(repo);
  const repository = ghJson([
    "repo",
    "view",
    repo,
    "--json",
    "nameWithOwner,defaultBranchRef,isPrivate",
  ]);
  const defaultBranch = repository.defaultBranchRef?.name;
  if (!defaultBranch) {
    fail(
      "github_repo_default_branch_missing",
      "Target repository has no default branch.",
    );
  }

  assertInteractionWorkflowReady({ owner, name, defaultBranch });
  const pr = ghJson([
    "pr",
    "view",
    String(prNumber),
    "--repo",
    repo,
    "--json",
    "number,state,url,headRefName,baseRefName,author",
  ]);
  if (pr.state !== "OPEN") {
    fail(
      "github_memory_e2e_pr_not_open",
      `Target PR must be open so issue_comment events can trigger the interaction workflow. Got ${pr.state}.`,
      { prUrl: pr.url },
    );
  }

  if (preflightOnly) {
    printEvidence({ status: "preflight_passed", prUrl: pr.url });
    return;
  }

  const directComment = await postPrComment(
    `/rr remember repo ${marker} direct repository memory smoke.`,
  );
  const directRun = await waitForInteractionRun({
    eventName: "issue_comment",
    after: directComment.createdAt,
  });
  const directBotComment = await waitForBotCommentContaining({
    after: directComment.createdAt,
    values: [marker, "mem_"],
  });
  const directMemoryId = extractMemoryItemId(directBotComment.body);
  if (!directMemoryId) {
    fail(
      "github_memory_e2e_direct_memory_id_missing",
      "Interaction bot reply did not expose a confirmed memory id for the direct remember command.",
      { commentUrl: directBotComment.url },
    );
  }

  const suggestionComment = await postPrComment(
    `Remember for this repository: ${marker} natural language pending suggestion.`,
  );
  const suggestionRun = await waitForInteractionRun({
    eventName: "issue_comment",
    after: suggestionComment.createdAt,
  });
  const suggestionBotComment = await waitForBotCommentContaining({
    after: suggestionComment.createdAt,
    values: [marker, "mem_suggestion_"],
  });
  const suggestionId = extractSuggestionId(suggestionBotComment.body);
  if (!suggestionId) {
    fail(
      "github_memory_e2e_suggestion_id_missing",
      "Interaction bot reply did not expose a pending memory suggestion id.",
      { commentUrl: suggestionBotComment.url },
    );
  }

  const confirmComment = await postPrComment(`/rr remember ${suggestionId}`);
  const confirmRun = await waitForInteractionRun({
    eventName: "issue_comment",
    after: confirmComment.createdAt,
  });
  const confirmBotComment = await waitForBotCommentContaining({
    after: confirmComment.createdAt,
    values: [suggestionId, "mem_"],
  });
  const confirmedMemoryId = extractMemoryItemId(confirmBotComment.body);
  if (!confirmedMemoryId) {
    fail(
      "github_memory_e2e_confirmed_memory_id_missing",
      "Interaction bot reply did not expose a confirmed memory id after suggestion confirmation.",
      { commentUrl: confirmBotComment.url },
    );
  }

  const forgetComment = await postPrComment(`/rr forget ${confirmedMemoryId}`);
  const forgetRun = await waitForInteractionRun({
    eventName: "issue_comment",
    after: forgetComment.createdAt,
  });
  await waitForBotCommentContaining({
    after: forgetComment.createdAt,
    values: [confirmedMemoryId, "deleted"],
    allowAnyValue: true,
  });

  await assertNoBotLoopAfter({
    after: latestIso([
      directBotComment.createdAt,
      suggestionBotComment.createdAt,
      confirmBotComment.createdAt,
    ]),
  });

  printEvidence({
    status: "passed",
    prUrl: pr.url,
    directMemoryId,
    suggestionId,
    confirmedMemoryId,
    runUrls: [directRun.url, suggestionRun.url, confirmRun.url, forgetRun.url],
  });
}

function assertInteractionWorkflowReady({ owner, name, defaultBranch }) {
  const workflows = ghJson(["api", `repos/${owner}/${name}/actions/workflows`]);
  const workflow = workflows.workflows?.find(
    (candidate) =>
      candidate.name === workflowName ||
      candidate.path === ".github/workflows/reviewrouter-interaction.yml",
  );
  if (!workflow || workflow.state !== "active") {
    fail(
      "github_memory_e2e_interaction_workflow_inactive",
      "Target repository does not have an active ReviewRouter Interaction workflow.",
    );
  }

  try {
    gh([
      "api",
      `repos/${owner}/${name}/contents/.github/workflows/reviewrouter-interaction.yml?ref=${defaultBranch}`,
      "--jq",
      ".name",
    ]);
  } catch {
    fail(
      "github_memory_e2e_interaction_workflow_missing_on_default_branch",
      "ReviewRouter Interaction workflow must exist on the target repo default branch before memory comment smoke can run.",
      {
        repo,
        defaultBranch,
        expectedPath: ".github/workflows/reviewrouter-interaction.yml",
      },
    );
  }
}

async function postPrComment(body) {
  const before = new Date();
  gh(["pr", "comment", String(prNumber), "--repo", repo, "--body", body]);
  const comment = await waitForOwnComment({
    body,
    after: before.toISOString(),
  });
  evidence.comments.push({
    kind: "human",
    url: comment.url,
    createdAt: comment.createdAt,
  });
  return comment;
}

async function waitForOwnComment({ body, after }) {
  return waitFor(`own comment ${body.slice(0, 40)}`, async () => {
    const comments = listPrComments();
    return comments.find(
      (comment) =>
        comment.viewerDidAuthor === true &&
        comment.body.trim() === body.trim() &&
        Date.parse(comment.createdAt) >= Date.parse(after),
    );
  });
}

async function waitForInteractionRun({ eventName, after }) {
  const run = await waitFor(`completed ${workflowName} run`, async () => {
    const runs = ghJson([
      "run",
      "list",
      "--repo",
      repo,
      "--workflow",
      workflowName,
      "--limit",
      "20",
      "--json",
      "databaseId,workflowName,event,status,conclusion,createdAt,url,actor",
    ]);
    const candidates = runs
      .filter(
        (run) =>
          run.event === eventName &&
          Date.parse(run.createdAt) >= Date.parse(after),
      )
      .sort(
        (left, right) =>
          Date.parse(right.createdAt) - Date.parse(left.createdAt),
      );
    const latest = candidates[0];
    if (!latest || latest.status !== "completed") return null;
    if (latest.conclusion !== "success") {
      fail(
        "github_memory_e2e_interaction_run_failed",
        `Interaction workflow completed with ${latest.conclusion}.`,
        { runUrl: latest.url },
      );
    }
    return latest;
  });
  evidence.runs.push({
    id: run.databaseId,
    url: run.url,
    event: run.event,
    actor: run.actor?.login ?? null,
    createdAt: run.createdAt,
  });
  return run;
}

async function waitForBotCommentContaining({
  after,
  values,
  allowAnyValue = false,
}) {
  const comment = await waitFor(
    `bot comment containing ${values.join(", ")}`,
    async () => {
      const comments = listPrComments();
      return comments.find((comment) => {
        const created = Date.parse(comment.createdAt) >= Date.parse(after);
        const bot = /(?:github-actions|reviewrouter)\[?bot\]?/i.test(
          comment.author?.login ?? "",
        );
        const matches = allowAnyValue
          ? values.some((value) => comment.body.includes(value))
          : values.every((value) => comment.body.includes(value));
        return created && bot && matches;
      });
    },
  );
  evidence.comments.push({
    kind: "bot",
    url: comment.url,
    createdAt: comment.createdAt,
  });
  return comment;
}

async function assertNoBotLoopAfter({ after }) {
  await delay(botLoopWaitMs);
  const runs = ghJson([
    "run",
    "list",
    "--repo",
    repo,
    "--workflow",
    workflowName,
    "--limit",
    "20",
    "--json",
    "databaseId,event,createdAt,url,actor",
  ]);
  const botRuns = runs.filter(
    (run) =>
      Date.parse(run.createdAt) > Date.parse(after) &&
      /(?:github-actions|reviewrouter)\[?bot\]?/i.test(run.actor?.login ?? ""),
  );
  if (botRuns.length > 0) {
    fail(
      "github_memory_e2e_bot_loop_detected",
      "Bot-authored comments triggered interaction runs.",
      {
        runUrls: botRuns.map((run) => run.url),
      },
    );
  }
}

function listPrComments() {
  const pr = ghJson([
    "pr",
    "view",
    String(prNumber),
    "--repo",
    repo,
    "--json",
    "comments",
  ]);
  return pr.comments ?? [];
}

async function waitFor(label, fn) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(pollMs);
  }
  fail("github_memory_e2e_timeout", `Timed out waiting for ${label}.`, {
    timeoutMs,
    lastError: lastError instanceof Error ? lastError.message : null,
  });
}

function extractSuggestionId(text) {
  return /mem_suggestion_[A-Za-z0-9_-]+/.exec(text)?.[0] ?? null;
}

function extractMemoryItemId(text) {
  return /mem_(?!suggestion_)[A-Za-z0-9_-]+/.exec(text)?.[0] ?? null;
}

function latestIso(values) {
  return new Date(
    Math.max(...values.map((value) => Date.parse(value))),
  ).toISOString();
}

function requireCommand(command) {
  try {
    execFileSync("bash", ["-lc", `command -v ${command}`], { stdio: "ignore" });
  } catch {
    fail("missing_command", `Missing required command: ${command}`);
  }
}

function gh(args, options = {}) {
  const output = execFileSync("gh", args, {
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
  return typeof output === "string" ? output.trim() : "";
}

function ghJson(args) {
  const output = gh(args);
  return output ? JSON.parse(output) : null;
}

function parseRepo(value) {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(value);
  if (!match) {
    fail("invalid_repo", "Repository must be owner/name.", { repo: value });
  }
  return [match[1], match[2]];
}

function readEnv(name, fallback) {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

function readInt(name, fallback) {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    fail("invalid_integer_env", `${name} must be a positive integer.`);
  }
  return parsed;
}

function readRequiredInt(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    fail("missing_required_env", `${name} is required.`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    fail("invalid_integer_env", `${name} must be a positive integer.`);
  }
  return parsed;
}

function printEvidence(extra) {
  console.log(JSON.stringify({ ...evidence, ...extra }, null, 2));
}

function fail(code, message, details = {}) {
  console.error(
    JSON.stringify({ error: { code, message, ...details } }, null, 2),
  );
  process.exit(1);
}
