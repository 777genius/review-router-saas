#!/usr/bin/env node
import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFile } from "node:fs/promises";

export const liveProgressMarker = "<!-- review-router-live-progress -->";
export const liveProgressSourceMarkerPrefix =
  "<!-- review-router-live-progress-source ";
const pinnedTarget = Object.freeze({
  repository: "777genius/review-router-saas-e2e",
  repositoryId: 1228051727,
  repositoryNodeId: "R_kgDOSTKVDw",
  pullRequest: 37,
  changedFiles: 108,
  branch: "test/context-gateway-v103-batches-20260811",
  fixturePathsSha256:
    "b66509de865391f460c874fc02f65b5e527aa4d08521e1f1c6d5b57f8087b69b",
  expectedReviewUnits: 72,
  expectedReviewedFiles: 108,
  expectedExcludedFiles: 0,
  sourceWorkflowPath: ".github/workflows/reviewrouter-codex.yml",
});
const terminalPhases = new Set([
  "Complete",
  "Complete with gaps",
  "Failed",
  "Cancelled",
  "Superseded",
]);

export function readCanaryConfig(env = process.env) {
  if (env.REVIEW_ROUTER_RUN_HOSTED_PROGRESS_CANARY !== "1")
    throw new Error("hosted_progress_canary_confirmation_required");
  const config = {
    ...pinnedTarget,
    installationId: positive(env.REVIEW_ROUTER_HOSTED_CANARY_INSTALLATION_ID),
    sourceRunId: positive(env.REVIEW_ROUTER_HOSTED_CANARY_SOURCE_RUN_ID),
    producerSha: sha(env.REVIEW_ROUTER_HOSTED_CANARY_PRODUCER_SHA),
    sourceWorkflowBlobSha: sha(
      env.REVIEW_ROUTER_HOSTED_CANARY_SOURCE_WORKFLOW_BLOB_SHA,
    ),
    expectedBotLogin: required(
      env.REVIEW_ROUTER_HOSTED_CANARY_EXPECTED_BOT_LOGIN,
    ).toLowerCase(),
    expectedAppSlug: required(
      env.REVIEW_ROUTER_HOSTED_CANARY_EXPECTED_APP_SLUG,
    ).toLowerCase(),
    pollIntervalMs: positive(
      env.REVIEW_ROUTER_HOSTED_CANARY_POLL_INTERVAL_MS ?? "10000",
    ),
    timeoutMs: positive(
      env.REVIEW_ROUTER_HOSTED_CANARY_TIMEOUT_MS ?? "5400000",
    ),
  };
  if (!/^[a-z0-9][a-z0-9-]*\[bot\]$/u.test(config.expectedBotLogin))
    throw new Error("hosted_progress_canary_bot_login_invalid");
  return config;
}

export async function triggerHostedProgressCanary(config, github, nowIso) {
  assertPinned(config);
  const pullHeadSha = await assertFixture(github, config);
  const installation = await github.getInstallation(config.installationId);
  if (installation.app_slug?.toLowerCase() !== config.expectedAppSlug)
    throw new Error("hosted_progress_canary_installation_app_mismatch");
  const source = await github.getWorkflowRun(
    config.repository,
    config.sourceRunId,
  );
  assertSourceRun(source, config, pullHeadSha);
  const workflow = await github.getFile(
    config.repository,
    config.sourceWorkflowPath,
    source.head_sha,
  );
  if (workflow.sha !== config.sourceWorkflowBlobSha)
    throw new Error("hosted_progress_canary_source_workflow_blob_mismatch");
  const baseline = ownedMarkerComments(
    await github.listComments(config.repository, config.pullRequest),
    config,
  );
  if (baseline.length > 1)
    throw new Error("hosted_progress_canary_multiple_marker_comments");
  const triggeredAt = nowIso();
  await github.rerunWorkflow(config.repository, config.sourceRunId);
  return {
    schemaVersion: 1,
    repositoryId: config.repositoryId,
    repositoryNodeId: config.repositoryNodeId,
    pullRequest: config.pullRequest,
    headSha: source.head_sha,
    sourceRunId: source.id,
    sourceRunAttempt: source.run_attempt,
    producerSha: config.producerSha,
    sourceWorkflowBlobSha: config.sourceWorkflowBlobSha,
    baselineCommentId: baseline[0]?.id ?? null,
    baselineCommentUpdatedAt: baseline[0]?.updated_at ?? null,
    triggeredAt,
  };
}

export async function verifyHostedProgressCanary(
  config,
  receipt,
  { github, now, sleep },
) {
  assertPinned(config);
  assertReceipt(receipt, config);
  await assertFixture(github, config, receipt.headSha);
  const deadline = now() + config.timeoutMs;
  const observations = [];
  let attempt;
  let commentId = receipt.baselineCommentId ?? undefined;
  let lastFingerprint;

  while (now() <= deadline) {
    const source = await github.getWorkflowRunAttempt(
      config.repository,
      config.sourceRunId,
      receipt.sourceRunAttempt + 1,
    );
    if (
      source === null ||
      source.status === "queued" ||
      source.status === "requested"
    ) {
      await sleep(config.pollIntervalMs);
      continue;
    }
    assertRerunAttempt(source, receipt, config);
    attempt = source;

    const comments = ownedMarkerComments(
      await github.listComments(config.repository, config.pullRequest),
      config,
    );
    if (comments.length !== 1)
      throw new Error("hosted_progress_canary_marker_cardinality_invalid");
    const comment = comments[0];
    commentId ??= comment.id;
    if (comment.id !== commentId)
      throw new Error("hosted_progress_canary_comment_id_changed");
    const fingerprint = `${comment.updated_at}\n${comment.body}`;
    const updatedAfterTriggerBaseline =
      receipt.baselineCommentUpdatedAt === null ||
      Date.parse(comment.updated_at) >
        Date.parse(receipt.baselineCommentUpdatedAt);
    if (fingerprint !== lastFingerprint && updatedAfterTriggerBaseline) {
      const next = parseProgressComment(comment, config, {
        sourceRunId: String(config.sourceRunId),
        sourceRunAttempt: String(receipt.sourceRunAttempt + 1),
      });
      assertMonotonic(observations.at(-1), next);
      observations.push(next);
      lastFingerprint = fingerprint;
    }
    if (
      source.status === "completed" &&
      terminalPhases.has(observations.at(-1)?.phase)
    )
      break;
    await sleep(config.pollIntervalMs);
  }

  if (!attempt) throw new Error("hosted_progress_canary_rerun_not_found");
  if (attempt.status !== "completed" || attempt.conclusion !== "success")
    throw new Error("hosted_progress_canary_rerun_not_successful");
  if (
    observations.length < 2 ||
    !observations.some((item) => !terminalPhases.has(item.phase))
  )
    throw new Error("hosted_progress_canary_dynamic_update_missing");
  const final = observations.at(-1);
  if (
    final.phase !== "Complete" ||
    final.completedUnits !== config.expectedReviewUnits ||
    final.totalUnits !== config.expectedReviewUnits ||
    final.coveredFiles !== config.expectedReviewedFiles ||
    final.totalFiles !== config.expectedReviewedFiles ||
    final.unassignedFiles !== 0 ||
    final.excludedFiles !== config.expectedExcludedFiles ||
    final.exhaustedUnits !== 0
  )
    throw new Error("hosted_progress_canary_final_coverage_incomplete");
  return {
    sourceRunId: config.sourceRunId,
    sourceRunAttempt: receipt.sourceRunAttempt + 1,
    commentId,
    progressUpdates: observations.length,
    terminal: final.phase,
  };
}

export function assertRerunAttempt(run, receipt, config) {
  if (
    run.id !== config.sourceRunId ||
    run.run_attempt !== receipt.sourceRunAttempt + 1 ||
    run.event !== "pull_request" ||
    run.head_sha !== receipt.headSha ||
    run.path !== config.sourceWorkflowPath ||
    !run.referenced_workflows?.some(
      (workflow) => workflow.ref === config.producerSha,
    )
  )
    throw new Error("hosted_progress_canary_rerun_attempt_contract_mismatch");
}

export function parseProgressComment(comment, config, expectedSource) {
  if (
    comment.user?.login?.toLowerCase() !== config.expectedBotLogin ||
    comment.performed_via_github_app?.slug?.toLowerCase() !==
      config.expectedAppSlug ||
    occurrences(comment.body, liveProgressMarker) !== 1
  )
    throw new Error("hosted_progress_canary_comment_identity_invalid");
  const sourceIdentity = parseSourceIdentity(comment.body);
  if (
    expectedSource !== undefined &&
    (sourceIdentity === null ||
      sourceIdentity.sourceRunId !== expectedSource.sourceRunId ||
      sourceIdentity.sourceRunAttempt !== expectedSource.sourceRunAttempt)
  )
    throw new Error("hosted_progress_canary_comment_source_mismatch");
  const units = numbers(comment.body, /Review units: (\d+) of (\d+) complete/u);
  const files = numbers(
    comment.body,
    /Files in completed units: (\d+) of (\d+)/u,
  );
  return {
    commentId: comment.id,
    updatedAt: instant(comment.updated_at),
    phase: capture(comment.body, /\*\*Phase:\*\* ([^\n]+)/u),
    completedUnits: units[0],
    totalUnits: units[1],
    coveredFiles: files[0],
    totalFiles: files[1],
    unassignedFiles: metric(comment.body, "Files not assigned"),
    excludedFiles: metric(comment.body, "Files unavailable or excluded"),
    exhaustedUnits: metric(comment.body, "Units not completed after retries"),
    sourceIdentity,
  };
}

export function parseSourceIdentity(body) {
  const lines = body
    .split(/\r?\n/u)
    .filter((line) => line.includes(liveProgressSourceMarkerPrefix));
  if (lines.length === 0) return null;
  if (lines.length !== 1)
    throw new Error("hosted_progress_canary_comment_source_invalid");
  const match =
    /^<!-- review-router-live-progress-source run-id=([1-9][0-9]{0,19}) run-attempt=([1-9][0-9]{0,9}) -->$/u.exec(
      lines[0],
    );
  if (!match) throw new Error("hosted_progress_canary_comment_source_invalid");
  return { sourceRunId: match[1], sourceRunAttempt: match[2] };
}

export function assertMonotonic(previous, next) {
  if (!previous) return;
  if (
    next.commentId !== previous.commentId ||
    Date.parse(next.updatedAt) <= Date.parse(previous.updatedAt) ||
    next.totalUnits !== previous.totalUnits ||
    next.totalFiles !== previous.totalFiles ||
    next.completedUnits < previous.completedUnits ||
    next.coveredFiles < previous.coveredFiles ||
    phaseRank(next.phase) < phaseRank(previous.phase) ||
    next.sourceIdentity?.sourceRunId !== previous.sourceIdentity?.sourceRunId ||
    next.sourceIdentity?.sourceRunAttempt !==
      previous.sourceIdentity?.sourceRunAttempt
  )
    throw new Error("hosted_progress_canary_progress_not_monotonic");
}

export function createInstallationGitHub({
  appId,
  privateKey,
  installationId,
  fetchImpl = globalThis.fetch,
  createJwt = createAppJwt,
}) {
  let token;
  let tokenRefreshAt = 0;
  let authenticating;
  const refreshMarginMs = 10 * 60 * 1000;
  async function authenticate() {
    const appJwt = createJwt(appId, privateKey);
    const issued = await rawRequest(
      `/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        appAuth: true,
        appJwt,
        body: JSON.stringify({
          repository_ids: [pinnedTarget.repositoryId],
          permissions: {
            actions: "write",
            issues: "read",
            metadata: "read",
            pull_requests: "read",
            contents: "read",
          },
        }),
      },
    );
    if (
      issued.repositories?.length !== 1 ||
      issued.repositories[0]?.id !== pinnedTarget.repositoryId ||
      issued.permissions?.actions !== "write" ||
      issued.permissions?.contents !== "read" ||
      issued.permissions?.issues !== "read" ||
      issued.permissions?.pull_requests !== "read"
    )
      throw new Error("hosted_progress_canary_token_scope_invalid");
    const expiresAt = Date.parse(issued.expires_at);
    if (
      !Number.isFinite(expiresAt) ||
      expiresAt <= Date.now() + refreshMarginMs
    )
      throw new Error("hosted_progress_canary_token_expiry_invalid");
    token = issued.token;
    tokenRefreshAt = expiresAt - refreshMarginMs;
  }
  async function ensureAuthenticated() {
    if (token && Date.now() < tokenRefreshAt) return;
    authenticating ??= authenticate().finally(() => {
      authenticating = undefined;
    });
    await authenticating;
  }
  async function rawRequest(path, options = {}) {
    const response = await fetchImpl(`https://api.github.com${path}`, {
      ...options,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        Authorization: `Bearer ${options.appAuth ? options.appJwt : token}`,
      },
    });
    if (!response.ok)
      throw new Error(`hosted_progress_canary_github_${response.status}`);
    return response.status === 204 ? null : response.json();
  }
  async function request(path, options = {}) {
    if (!options.appAuth) await ensureAuthenticated();
    return rawRequest(path, options);
  }
  function appRequest(path, options = {}) {
    return rawRequest(path, {
      ...options,
      appAuth: true,
      appJwt: createJwt(appId, privateKey),
    });
  }
  return {
    authenticate,
    getInstallation: (id) => appRequest(`/app/installations/${id}`),
    getRepository: (repo) => request(`/repos/${repo}`),
    getPullRequest: (repo, number) => request(`/repos/${repo}/pulls/${number}`),
    getPullFiles: (repo, number) =>
      paginate(request, `/repos/${repo}/pulls/${number}/files?per_page=100`, 2),
    getWorkflowRun: (repo, id) => request(`/repos/${repo}/actions/runs/${id}`),
    getWorkflowRunAttempt: async (repo, id, attempt) => {
      await ensureAuthenticated();
      const response = await fetchImpl(
        `https://api.github.com/repos/${repo}/actions/runs/${id}/attempts/${attempt}`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            Authorization: `Bearer ${token}`,
          },
        },
      );
      if (response.status === 404) return null;
      if (!response.ok)
        throw new Error(`hosted_progress_canary_github_${response.status}`);
      return response.json();
    },
    getFile: (repo, path, ref) =>
      request(`/repos/${repo}/contents/${path}?ref=${ref}`),
    rerunWorkflow: (repo, id) =>
      request(`/repos/${repo}/actions/runs/${id}/rerun`, { method: "POST" }),
    listComments: (repo, number) =>
      paginate(
        request,
        `/repos/${repo}/issues/${number}/comments?per_page=100`,
        10,
      ),
  };
}

async function assertFixture(github, config, expectedHead) {
  const repo = await github.getRepository(config.repository);
  if (
    repo.id !== config.repositoryId ||
    repo.node_id !== config.repositoryNodeId ||
    repo.full_name !== config.repository
  )
    throw new Error("hosted_progress_canary_repository_identity_mismatch");
  const pull = await github.getPullRequest(
    config.repository,
    config.pullRequest,
  );
  if (
    pull.number !== config.pullRequest ||
    pull.state !== "open" ||
    pull.changed_files !== config.changedFiles ||
    pull.head?.repo?.id !== config.repositoryId ||
    pull.head?.ref !== config.branch ||
    (expectedHead && pull.head.sha !== expectedHead)
  )
    throw new Error("hosted_progress_canary_pull_contract_mismatch");
  const files = await github.getPullFiles(
    config.repository,
    config.pullRequest,
  );
  if (
    files.length !== config.changedFiles ||
    filePathsDigest(files) !== config.fixturePathsSha256
  )
    throw new Error("hosted_progress_canary_fixture_profile_mismatch");
  return pull.head.sha;
}
function assertSourceRun(run, config, currentHeadSha) {
  if (
    run.id !== config.sourceRunId ||
    run.event !== "pull_request" ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    run.head_sha !== currentHeadSha ||
    !/^[0-9a-f]{40}$/u.test(run.head_sha) ||
    !Number.isSafeInteger(run.run_attempt) ||
    run.run_attempt < 1 ||
    run.path !== config.sourceWorkflowPath ||
    !run.pull_requests?.some((pull) => pull.number === config.pullRequest) ||
    !run.referenced_workflows?.some(
      (workflow) => workflow.ref === config.producerSha,
    )
  )
    throw new Error("hosted_progress_canary_source_run_contract_mismatch");
}
function assertReceipt(receipt, config) {
  if (
    receipt.schemaVersion !== 1 ||
    receipt.repositoryId !== config.repositoryId ||
    receipt.repositoryNodeId !== config.repositoryNodeId ||
    receipt.pullRequest !== config.pullRequest ||
    receipt.sourceRunId !== config.sourceRunId ||
    receipt.producerSha !== config.producerSha ||
    receipt.sourceWorkflowBlobSha !== config.sourceWorkflowBlobSha ||
    !(
      receipt.baselineCommentId === null ||
      Number.isSafeInteger(receipt.baselineCommentId)
    ) ||
    !(
      receipt.baselineCommentUpdatedAt === null ||
      Number.isFinite(Date.parse(receipt.baselineCommentUpdatedAt))
    ) ||
    !Number.isFinite(Date.parse(receipt.triggeredAt))
  )
    throw new Error("hosted_progress_canary_receipt_invalid");
  sha(receipt.headSha);
  positive(receipt.sourceRunAttempt);
}
function assertPinned(config) {
  for (const [key, value] of Object.entries(pinnedTarget))
    if (config[key] !== value)
      throw new Error("hosted_progress_canary_target_not_pinned");
}
function ownedMarkerComments(comments, config) {
  const marked = comments.filter((item) =>
    item.body?.includes(liveProgressMarker),
  );
  marked.forEach((item) => parseProgressComment(item, config));
  return marked;
}
async function paginate(request, path, pages) {
  const rows = [];
  for (let page = 1; page <= pages; page++) {
    const result = await request(`${path}&page=${page}`);
    if (!Array.isArray(result))
      throw new Error("hosted_progress_canary_page_invalid");
    rows.push(...result);
    if (result.length < 100) return rows;
  }
  throw new Error("hosted_progress_canary_pagination_limit_exceeded");
}
function createAppJwt(appId, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ iat: now - 30, exp: now + 540, iss: String(appId) }),
  ).toString("base64url");
  const input = `${header}.${payload}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), createPrivateKey(privateKey)).toString("base64url")}`;
}
function filePathsDigest(files) {
  if (
    files.some(
      (file) =>
        typeof file.filename !== "string" || file.filename.includes("\n"),
    )
  )
    throw new Error("hosted_progress_canary_fixture_path_invalid");
  return createHash("sha256")
    .update(
      `${files
        .map((file) => file.filename)
        .sort()
        .join("\n")}\n`,
    )
    .digest("hex");
}
function required(value) {
  if (!value?.trim())
    throw new Error("hosted_progress_canary_required_value_missing");
  return value.trim();
}
function positive(value) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1)
    throw new Error("hosted_progress_canary_positive_integer_required");
  return result;
}
function sha(value) {
  if (!/^[0-9a-f]{40}$/u.test(value ?? ""))
    throw new Error("hosted_progress_canary_sha_invalid");
  return value;
}
function capture(body, regex) {
  const value = body?.match(regex)?.[1];
  if (!value) throw new Error("hosted_progress_canary_comment_metric_missing");
  return value;
}
function numbers(body, regex) {
  const match = body?.match(regex);
  if (!match) throw new Error("hosted_progress_canary_comment_metric_missing");
  return [Number(match[1]), Number(match[2])];
}
function metric(body, label) {
  return Number(capture(body, new RegExp(`${label}: (\\d+)`, "u")));
}
function instant(value) {
  if (!Number.isFinite(Date.parse(value)))
    throw new Error("hosted_progress_canary_instant_invalid");
  return new Date(value).toISOString();
}
function occurrences(body, marker) {
  return typeof body === "string" ? body.split(marker).length - 1 : 0;
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

async function main() {
  const mode = process.argv[2];
  if (!new Set(["trigger", "verify"]).has(mode))
    throw new Error("usage: hosted:progress-canary -- trigger|verify");
  const config = readCanaryConfig();
  const github = createInstallationGitHub({
    appId: required(process.env.REVIEW_ROUTER_HOSTED_CANARY_APP_ID),
    privateKey: await readFile(
      required(process.env.REVIEW_ROUTER_HOSTED_CANARY_PRIVATE_KEY_FILE),
      "utf8",
    ),
    installationId: config.installationId,
  });
  await github.authenticate();
  if (mode === "trigger")
    console.log(
      JSON.stringify(
        await triggerHostedProgressCanary(config, github, () =>
          new Date().toISOString(),
        ),
      ),
    );
  else {
    const receipt = JSON.parse(
      await readFile(
        required(process.env.REVIEW_ROUTER_HOSTED_CANARY_RECEIPT_FILE),
        "utf8",
      ),
    );
    console.log(
      JSON.stringify(
        await verifyHostedProgressCanary(config, receipt, {
          github,
          now: Date.now,
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        }),
      ),
    );
  }
}
if (import.meta.url === `file://${process.argv[1]}`)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
