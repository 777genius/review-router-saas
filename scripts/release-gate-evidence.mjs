import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { readExactZipEntries } from "./lib/github-actions-trusted-evidence.mjs";

export const releaseGateContract = Object.freeze({
  schemaVersion: "reviewrouter.production-release-gate.v1",
  workflowPath: ".github/workflows/ci.yml",
  jobs: Object.freeze([
    Object.freeze({
      gate: "release-authority-pg17-contract",
      jobName: "Dedicated Release Authority PG17 contract",
      artifactPrefix: "release-authority-pg17-",
    }),
    Object.freeze({
      gate: "private-pg16-to-pg17-rehearsal",
      jobName: "Full private PG16 to PG17 rehearsal",
      artifactPrefix: "private-pg16-to-pg17-rehearsal-",
    }),
  ]),
});

const githubApi = "https://api.github.com";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function required(value, label) {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`release gate ${label} is required`);
  return value;
}

function positiveInteger(value, label) {
  const number = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number <= 0)
    throw new Error(`release gate ${label} must be a positive integer`);
  return number;
}

function repositoryParts(repository) {
  const parts = required(repository, "repository").split("/");
  if (
    parts.length !== 2 ||
    parts.some((part) => !/^[A-Za-z0-9_.-]+$/u.test(part))
  )
    throw new Error("release gate repository must be owner/name");
  return parts;
}

async function githubJson(fetchImpl, url, headers) {
  const response = await fetchImpl(url, {
    headers,
    method: "GET",
    redirect: "follow",
  });
  if (!response.ok)
    throw new Error(
      `release gate GitHub API request failed: HTTP ${response.status}`,
    );
  let body;
  try {
    body = JSON.parse(await response.text());
  } catch {
    throw new Error("release gate GitHub API response is not JSON");
  }
  return body;
}

function exactManifest(value, expected) {
  const keys = [
    "schemaVersion",
    "gate",
    "repository",
    "commit",
    "runId",
    "runAttempt",
    "jobName",
    "artifactName",
  ];
  if (
    !value ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  )
    throw new Error("release gate artifact manifest keys are not exact");
  for (const key of keys) {
    if (value[key] !== expected[key])
      throw new Error(`release gate artifact manifest ${key} mismatch`);
  }
}

async function downloadAndVerifyArtifact(
  fetchImpl,
  prefix,
  headers,
  artifact,
  expected,
) {
  if (
    String(artifact.id) !== String(expected.artifactId) ||
    artifact.name !== expected.artifactName ||
    String(artifact.workflow_run?.id) !== String(expected.runId) ||
    artifact.workflow_run?.head_sha !== expected.commit ||
    artifact.expired !== false ||
    typeof artifact.digest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(artifact.digest)
  )
    throw new Error("release gate artifact identity is invalid");

  const response = await fetchImpl(
    `${githubApi}${prefix}/actions/artifacts/${artifact.id}/zip`,
    { headers, method: "GET", redirect: "follow" },
  );
  if (!response.ok)
    throw new Error(
      `release gate artifact download failed: HTTP ${response.status}`,
    );
  const finalUrl = new URL(response.url);
  if (
    finalUrl.protocol !== "https:" ||
    !(
      finalUrl.hostname === "api.github.com" ||
      finalUrl.hostname.endsWith(".githubusercontent.com") ||
      finalUrl.hostname.endsWith(".blob.core.windows.net")
    )
  )
    throw new Error("release gate artifact download used an untrusted host");
  const archive = Buffer.from(await response.arrayBuffer());
  if (
    archive.length === 0 ||
    archive.length > 1024 * 1024 ||
    `sha256:${sha256(archive)}` !== artifact.digest
  )
    throw new Error("release gate artifact digest mismatch");
  const entries = readExactZipEntries(archive);
  if (entries.size !== 1)
    throw new Error("release gate artifact must contain exactly one manifest");
  const manifestBytes = entries.get("release-gate-evidence.json");
  if (!manifestBytes)
    throw new Error("release gate artifact manifest is missing");
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new Error("release gate artifact manifest is not strict JSON");
  }
  exactManifest(manifest, expected);
  return Object.freeze({
    artifactId: String(artifact.id),
    artifactDigest: artifact.digest,
    artifactName: artifact.name,
  });
}

export async function verifyReleaseGateRun(
  configuration,
  fetchImpl = globalThis.fetch,
) {
  const [owner, name] = repositoryParts(configuration.repository);
  const repository = `${owner}/${name}`;
  const token = required(configuration.token, "GitHub token");
  const commit = required(configuration.commit, "commit");
  if (!/^[a-f0-9]{40}$/u.test(commit))
    throw new Error("release gate commit must be an immutable SHA");
  const runId = positiveInteger(configuration.runId, "run ID");
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const prefix = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const [repositoryFact, run, jobs, artifacts] = await Promise.all([
    githubJson(fetchImpl, `${githubApi}${prefix}`, headers),
    githubJson(
      fetchImpl,
      `${githubApi}${prefix}/actions/runs/${runId}`,
      headers,
    ),
    githubJson(
      fetchImpl,
      `${githubApi}${prefix}/actions/runs/${runId}/jobs?filter=latest&per_page=100`,
      headers,
    ),
    githubJson(
      fetchImpl,
      `${githubApi}${prefix}/actions/runs/${runId}/artifacts?per_page=100`,
      headers,
    ),
  ]);
  if (
    String(run.id) !== String(runId) ||
    String(run.repository?.id) !== String(repositoryFact.id) ||
    String(run.head_repository?.id) !== String(repositoryFact.id) ||
    repositoryFact.full_name?.toLowerCase() !== repository.toLowerCase() ||
    run.path !== releaseGateContract.workflowPath ||
    run.head_branch !== "main" ||
    run.head_sha !== commit ||
    !["push", "workflow_dispatch"].includes(run.event) ||
    run.status !== "completed" ||
    run.conclusion !== "success"
  )
    throw new Error("release gate workflow run identity or result mismatch");
  const runAttempt = positiveInteger(run.run_attempt, "run attempt");
  if (
    !Array.isArray(jobs.jobs) ||
    jobs.total_count !== jobs.jobs.length ||
    jobs.total_count > 100
  )
    throw new Error("release gate job inventory is incomplete");
  if (
    !Array.isArray(artifacts.artifacts) ||
    artifacts.total_count !== artifacts.artifacts.length ||
    artifacts.total_count > 100
  )
    throw new Error("release gate artifact inventory is incomplete");

  const receipts = [];
  for (const contract of releaseGateContract.jobs) {
    const matchingJobs = jobs.jobs.filter(
      (job) => job.name === contract.jobName,
    );
    if (matchingJobs.length !== 1)
      throw new Error(`release gate exact job is missing: ${contract.jobName}`);
    const job = matchingJobs[0];
    if (
      String(job.run_id) !== String(runId) ||
      job.run_attempt !== runAttempt ||
      job.head_sha !== commit ||
      job.status !== "completed" ||
      job.conclusion !== "success"
    )
      throw new Error(
        `release gate exact job did not succeed: ${contract.jobName}`,
      );
    const artifactName = `${contract.artifactPrefix}${commit}`;
    const matchingArtifacts = artifacts.artifacts.filter(
      (artifact) => artifact.name === artifactName,
    );
    if (matchingArtifacts.length !== 1)
      throw new Error(
        `release gate exact artifact is missing: ${artifactName}`,
      );
    const artifact = matchingArtifacts[0];
    receipts.push(
      await downloadAndVerifyArtifact(fetchImpl, prefix, headers, artifact, {
        schemaVersion: releaseGateContract.schemaVersion,
        gate: contract.gate,
        repository,
        commit,
        runId: String(runId),
        runAttempt,
        jobName: contract.jobName,
        artifactName,
        artifactId: artifact.id,
      }),
    );
  }
  return Object.freeze({ commit, runId: String(runId), runAttempt, receipts });
}

export async function findAndVerifyReleaseGate(
  configuration,
  fetchImpl = globalThis.fetch,
) {
  const [owner, name] = repositoryParts(configuration.repository);
  const commit = required(configuration.commit, "commit");
  if (!/^[a-f0-9]{40}$/u.test(commit))
    throw new Error("release gate commit must be an immutable SHA");
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${required(configuration.token, "GitHub token")}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const prefix = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const query = new URLSearchParams({
    branch: "main",
    head_sha: commit,
    per_page: "100",
    status: "completed",
  });
  const inventory = await githubJson(
    fetchImpl,
    `${githubApi}${prefix}/actions/workflows/ci.yml/runs?${query}`,
    headers,
  );
  if (
    !Array.isArray(inventory.workflow_runs) ||
    inventory.total_count !== inventory.workflow_runs.length ||
    inventory.total_count > 100
  )
    throw new Error("release gate workflow run inventory is incomplete");
  const candidates = inventory.workflow_runs.filter(
    (run) =>
      run.head_sha === commit &&
      run.head_branch === "main" &&
      run.status === "completed" &&
      run.conclusion === "success",
  );
  if (candidates.length === 0)
    throw new Error(`release gate has no successful CI run for ${commit}`);
  let lastError;
  for (const candidate of candidates) {
    try {
      return await verifyReleaseGateRun(
        { ...configuration, runId: candidate.id },
        fetchImpl,
      );
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `release gate found no run with complete exact evidence: ${lastError?.message ?? "unknown failure"}`,
  );
}

export function writeReleaseGateManifest(gate, environment = process.env) {
  const contract = releaseGateContract.jobs.find(
    (entry) => entry.gate === gate,
  );
  if (!contract) throw new Error(`release gate is unsupported: ${gate}`);
  const commit = required(environment.GITHUB_SHA, "commit");
  if (!/^[a-f0-9]{40}$/u.test(commit))
    throw new Error("release gate commit must be an immutable SHA");
  const artifactName = `${contract.artifactPrefix}${commit}`;
  const manifest = {
    schemaVersion: releaseGateContract.schemaVersion,
    gate: contract.gate,
    repository: required(environment.GITHUB_REPOSITORY, "repository"),
    commit,
    runId: String(positiveInteger(environment.GITHUB_RUN_ID, "run ID")),
    runAttempt: positiveInteger(environment.GITHUB_RUN_ATTEMPT, "run attempt"),
    jobName: contract.jobName,
    artifactName,
  };
  writeFileSync("release-gate-evidence.json", `${JSON.stringify(manifest)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return manifest;
}

async function main() {
  const [command, gate] = process.argv.slice(2);
  if (command === "write") {
    const manifest = writeReleaseGateManifest(gate);
    process.stdout.write(`artifact_name=${manifest.artifactName}\n`);
    return;
  }
  if (command === "verify") {
    const result = await findAndVerifyReleaseGate({
      repository: process.env.GITHUB_REPOSITORY,
      token: process.env.GH_TOKEN,
      commit:
        process.env.REVIEW_ROUTER_RELEASE_GATE_SHA ?? process.env.GITHUB_SHA,
    });
    process.stdout.write(`run_id=${result.runId}\n`);
    process.stdout.write(`run_attempt=${result.runAttempt}\n`);
    for (const receipt of result.receipts)
      process.stderr.write(
        `Verified ${receipt.artifactName} as artifact ${receipt.artifactId} (${receipt.artifactDigest})\n`,
      );
    return;
  }
  throw new Error("usage: release-gate-evidence.mjs <write GATE|verify>");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
