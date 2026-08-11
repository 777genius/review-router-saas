import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";

const githubApi = "https://api.github.com";
const trustedArchives = new WeakSet();
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export const gitBlobSha = (value) => {
  const bytes = Buffer.from(value);
  return createHash("sha1")
    .update(Buffer.from(`blob ${bytes.length}\0`))
    .update(bytes)
    .digest("hex");
};

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`trusted evidence ${label} is required`);
  return value;
}

function exactInteger(value, label) {
  const number = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number <= 0)
    throw new Error(`trusted evidence ${label} must be a positive integer`);
  return number;
}

function repositoryParts(value) {
  const parts = requiredString(value, "repository").split("/");
  if (
    parts.length !== 2 ||
    parts.some((part) => !/^[A-Za-z0-9_.-]+$/u.test(part))
  )
    throw new Error("trusted evidence repository must be owner/name");
  return parts;
}

async function githubJson(fetchImpl, path, headers) {
  const response = await fetchImpl(`${githubApi}${path}`, {
    headers,
    method: "GET",
    redirect: "follow",
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(
      `trusted evidence GitHub API request failed: HTTP ${response.status}`,
    );
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("trusted evidence GitHub API response is not JSON");
  }
  return { body, bodySha256: sha256(Buffer.from(text)), url: response.url };
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function endOfCentralDirectory(archive) {
  const minimum = Math.max(0, archive.length - 65_557);
  for (let offset = archive.length - 22; offset >= minimum; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("trusted evidence artifact is not a supported ZIP archive");
}

export function readExactZipEntries(archiveBytes) {
  const archive = Buffer.from(archiveBytes);
  const end = endOfCentralDirectory(archive);
  const disk = archive.readUInt16LE(end + 4);
  const centralDisk = archive.readUInt16LE(end + 6);
  const diskEntries = archive.readUInt16LE(end + 8);
  const entryCount = archive.readUInt16LE(end + 10);
  const centralSize = archive.readUInt32LE(end + 12);
  const centralOffset = archive.readUInt32LE(end + 16);
  const commentLength = archive.readUInt16LE(end + 20);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== entryCount ||
    entryCount === 0 ||
    entryCount > 32 ||
    end + 22 + commentLength !== archive.length ||
    centralOffset + centralSize !== end
  )
    throw new Error("trusted evidence ZIP structure is not canonical");

  const entries = new Map();
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (archive.readUInt32LE(cursor) !== 0x02014b50)
      throw new Error("trusted evidence ZIP central directory is invalid");
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const expectedCrc = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const entryCommentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString("utf8");
    if (
      flags & 1 ||
      ![0, 8].includes(method) ||
      !name ||
      name.startsWith("/") ||
      name.includes("\\") ||
      name.split("/").includes("..") ||
      name.endsWith("/") ||
      entries.has(name) ||
      uncompressedSize > 16 * 1024 * 1024 ||
      archive.readUInt32LE(localOffset) !== 0x04034b50
    )
      throw new Error("trusted evidence ZIP entry is unsafe or unsupported");
    const localFlags = archive.readUInt16LE(localOffset + 6);
    const localMethod = archive.readUInt16LE(localOffset + 8);
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const localName = archive
      .subarray(localOffset + 30, localOffset + 30 + localNameLength)
      .toString("utf8");
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = archive.subarray(
      dataOffset,
      dataOffset + compressedSize,
    );
    if (
      localFlags !== flags ||
      localMethod !== method ||
      localName !== name ||
      compressed.length !== compressedSize
    )
      throw new Error(
        "trusted evidence ZIP local entry mismatches its directory",
      );
    const value =
      method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed);
    if (value.length !== uncompressedSize || crc32(value) !== expectedCrc)
      throw new Error("trusted evidence ZIP entry digest is invalid");
    entries.set(name, value);
    cursor += 46 + nameLength + extraLength + entryCommentLength;
  }
  if (cursor !== end)
    throw new Error("trusted evidence ZIP directory has trailing data");
  return entries;
}

function exactExecution(evidence, expected) {
  if (evidence?.rolloutId !== expected.rolloutId)
    throw new Error("trusted evidence rollout ID mismatch or replay");
  const execution = evidence?.execution;
  const executionKeys = [
    "repositoryId",
    "repositoryFullName",
    "workflowPath",
    "workflowSha",
    "workflowRef",
    "runId",
    "runAttempt",
    "jobId",
    "jobName",
    "artifactName",
    "headSha",
  ];
  if (
    !execution ||
    Object.keys(execution).length !== executionKeys.length ||
    !executionKeys.every((key) => Object.hasOwn(execution, key))
  )
    throw new Error("trusted evidence execution object keys are not exact");
  if (
    evidence.version === 3 &&
    (Object.keys(evidence).length !== 4 ||
      !["version", "rolloutId", "execution", "rollout"].every((key) =>
        Object.hasOwn(evidence, key),
      ))
  )
    throw new Error("trusted rollout evidence object keys are not exact");
  const pairs = {
    repositoryId: String(expected.repositoryId),
    repositoryFullName: expected.repository.toLowerCase(),
    workflowPath: expected.workflowPath,
    workflowSha: expected.workflowSha,
    workflowRef: expected.workflowRef,
    runId: String(expected.runId),
    runAttempt: expected.runAttempt,
    jobId: String(expected.jobId),
    jobName: expected.jobName,
    artifactName: expected.artifactName,
    headSha: expected.headSha,
  };
  for (const [key, value] of Object.entries(pairs)) {
    const actual =
      key === "repositoryFullName"
        ? execution?.[key]?.toLowerCase()
        : execution?.[key];
    if (actual !== value)
      throw new Error(`trusted evidence execution ${key} mismatch`);
  }
}

export async function fetchTrustedGitHubEvidence(
  configuration,
  fetchImpl = globalThis.fetch,
) {
  const [owner, repository] = repositoryParts(configuration.repository);
  const token = requiredString(configuration.token, "GitHub token");
  const expected = {
    repository: `${owner}/${repository}`,
    repositoryId: exactInteger(configuration.repositoryId, "repository ID"),
    workflowPath: requiredString(configuration.workflowPath, "workflow path"),
    workflowSha: requiredString(configuration.workflowSha, "workflow SHA"),
    workflowRef: requiredString(configuration.workflowRef, "workflow ref"),
    runId: exactInteger(configuration.runId, "run ID"),
    runAttempt: exactInteger(configuration.runAttempt, "run attempt"),
    jobId: exactInteger(configuration.jobId, "job ID"),
    jobName: requiredString(configuration.jobName, "job name"),
    artifactId: exactInteger(configuration.artifactId, "artifact ID"),
    artifactName: requiredString(configuration.artifactName, "artifact name"),
    headSha: requiredString(configuration.headSha, "head SHA"),
    rolloutId: requiredString(configuration.rolloutId, "rollout ID"),
  };
  if (
    !/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/u.test(
      expected.workflowPath,
    )
  )
    throw new Error("trusted evidence workflow path is invalid");
  if (
    !/^[a-f0-9]{40}$/u.test(expected.workflowSha) ||
    !/^[a-f0-9]{40}$/u.test(expected.headSha)
  )
    throw new Error("trusted evidence immutable SHA is invalid");
  if (expected.workflowRef !== expected.headSha)
    throw new Error(
      "trusted evidence workflow ref must be the immutable head SHA",
    );

  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const prefix = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
  const [
    repositoryResponse,
    runResponse,
    jobsResponse,
    artifactResponse,
    sourceResponse,
  ] = await Promise.all([
    githubJson(fetchImpl, prefix, headers),
    githubJson(fetchImpl, `${prefix}/actions/runs/${expected.runId}`, headers),
    githubJson(
      fetchImpl,
      `${prefix}/actions/runs/${expected.runId}/jobs?filter=latest&per_page=100`,
      headers,
    ),
    githubJson(
      fetchImpl,
      `${prefix}/actions/artifacts/${expected.artifactId}`,
      headers,
    ),
    githubJson(
      fetchImpl,
      `${prefix}/contents/${expected.workflowPath}?ref=${expected.headSha}`,
      headers,
    ),
  ]);
  const repositoryFact = repositoryResponse.body;
  const run = runResponse.body;
  const jobs = jobsResponse.body;
  const artifact = artifactResponse.body;
  const source = sourceResponse.body;
  if (
    String(repositoryFact.id) !== String(expected.repositoryId) ||
    repositoryFact.full_name?.toLowerCase() !==
      expected.repository.toLowerCase()
  )
    throw new Error("trusted evidence repository identity mismatch");
  if (
    String(run.id) !== String(expected.runId) ||
    String(run.repository?.id) !== String(expected.repositoryId) ||
    String(run.head_repository?.id) !== String(expected.repositoryId) ||
    run.path !== expected.workflowPath ||
    run.head_sha !== expected.headSha ||
    run.run_attempt !== expected.runAttempt ||
    run.event !== "workflow_dispatch" ||
    run.status !== "completed" ||
    run.conclusion !== "success"
  )
    throw new Error(
      "trusted evidence workflow run identity or result mismatch",
    );
  if (
    !Array.isArray(jobs.jobs) ||
    jobs.total_count !== jobs.jobs.length ||
    jobs.total_count > 100
  )
    throw new Error("trusted evidence workflow job inventory is incomplete");
  const job = jobs.jobs.find(
    (candidate) => String(candidate.id) === String(expected.jobId),
  );
  if (
    !job ||
    String(job.run_id) !== String(expected.runId) ||
    job.run_attempt !== expected.runAttempt ||
    job.name !== expected.jobName ||
    job.head_sha !== expected.headSha ||
    job.status !== "completed" ||
    job.conclusion !== "success"
  )
    throw new Error(
      "trusted evidence workflow job identity or result mismatch",
    );
  const artifactDigest = `sha256:${sha256(Buffer.from(""))}`;
  if (
    String(artifact.id) !== String(expected.artifactId) ||
    artifact.name !== expected.artifactName ||
    String(artifact.workflow_run?.id) !== String(expected.runId) ||
    artifact.expired !== false ||
    typeof artifact.digest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(artifact.digest) ||
    artifact.digest === artifactDigest
  )
    throw new Error("trusted evidence artifact identity is invalid");
  if (
    source.path !== expected.workflowPath ||
    source.sha !== expected.workflowSha ||
    source.type !== "file"
  )
    throw new Error("trusted evidence workflow source identity mismatch");
  const artifactCreatedAt = Date.parse(artifact.created_at ?? "");
  const maximumAgeMs = configuration.maximumAgeMs ?? 6 * 60 * 60 * 1000;
  const now = configuration.now ?? Date.now();
  if (
    !Number.isSafeInteger(maximumAgeMs) ||
    maximumAgeMs <= 0 ||
    !Number.isFinite(artifactCreatedAt) ||
    artifactCreatedAt > now + 5 * 60 * 1000 ||
    now - artifactCreatedAt > maximumAgeMs
  )
    throw new Error("trusted evidence artifact is stale or replayed");

  const archiveResponse = await fetchImpl(
    `${githubApi}${prefix}/actions/artifacts/${expected.artifactId}/zip`,
    {
      headers,
      method: "GET",
      redirect: "follow",
    },
  );
  if (!archiveResponse.ok)
    throw new Error(
      `trusted evidence artifact download failed: HTTP ${archiveResponse.status}`,
    );
  const finalUrl = new URL(archiveResponse.url);
  if (
    finalUrl.protocol !== "https:" ||
    !(
      finalUrl.hostname === "api.github.com" ||
      finalUrl.hostname.endsWith(".githubusercontent.com") ||
      finalUrl.hostname.endsWith(".blob.core.windows.net")
    )
  )
    throw new Error(
      "trusted evidence artifact download redirected to an untrusted host",
    );
  const archive = Buffer.from(await archiveResponse.arrayBuffer());
  if (
    archive.length === 0 ||
    archive.length > 32 * 1024 * 1024 ||
    `sha256:${sha256(archive)}` !== artifact.digest
  )
    throw new Error("trusted evidence artifact digest mismatch");
  const entries = readExactZipEntries(archive);
  const manifestBytes = entries.get(
    "reviewrouter-trusted-rollout-evidence.json",
  );
  if (!manifestBytes)
    throw new Error("trusted evidence manifest is missing from artifact");
  let evidence;
  try {
    evidence = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new Error("trusted evidence manifest is not strict JSON");
  }
  if (![3, 4, 5].includes(evidence?.version))
    throw new Error("trusted evidence manifest version must be 3, 4, or 5");
  exactExecution(evidence, expected);
  const result = {
    evidence,
    readArtifact(path) {
      const value = entries.get(path);
      if (!value)
        throw new Error(`trusted evidence artifact entry is missing: ${path}`);
      return Buffer.from(value);
    },
    receipt: Object.freeze({
      artifactId: String(expected.artifactId),
      artifactDigest: artifact.digest,
      rolloutId: expected.rolloutId,
      runId: String(expected.runId),
      runAttempt: expected.runAttempt,
      jobId: String(expected.jobId),
      workflowPath: expected.workflowPath,
      commit: expected.headSha,
      observedResponseSha256: Object.freeze({
        artifact: artifactResponse.bodySha256,
        jobs: jobsResponse.bodySha256,
        repository: repositoryResponse.bodySha256,
        run: runResponse.bodySha256,
        workflowSource: sourceResponse.bodySha256,
      }),
    }),
  };
  trustedArchives.add(result);
  return result;
}

export function assertTrustedGitHubEvidence(value) {
  if (!value || !trustedArchives.has(value))
    throw new Error(
      "rollout evidence is not bound to an authenticated GitHub artifact observation",
    );
  return value;
}
