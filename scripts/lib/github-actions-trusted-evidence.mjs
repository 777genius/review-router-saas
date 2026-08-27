import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
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

export function readBoundedRegularFile(
  path,
  maximumBytes,
  label,
  { afterLstat } = {},
) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0)
    throw new Error("bounded_regular_file_limit_invalid");
  let before;
  try {
    before = lstatSync(path, { bigint: true });
  } catch {
    throw new Error(`live_catalog_${label}_file_unavailable`);
  }
  if (!before.isFile() || before.nlink !== 1n)
    throw new Error(`live_catalog_${label}_file_not_private_regular`);
  afterLstat?.();
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const opened = fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.size <= 0n ||
      opened.size > BigInt(maximumBytes)
    )
      throw new Error(`live_catalog_${label}_file_identity_or_size_invalid`);
    const expected = Number(opened.size);
    const value = Buffer.allocUnsafe(expected);
    let offset = 0;
    while (offset < expected) {
      const count = readSync(
        descriptor,
        value,
        offset,
        expected - offset,
        null,
      );
      if (count === 0) throw new Error(`live_catalog_${label}_file_truncated`);
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.nlink !== 1n
    )
      throw new Error(`live_catalog_${label}_file_replaced`);
    return value;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

const storageHosts = [
  "artifact.actions.githubusercontent.com",
  "objects.githubusercontent.com",
  "pipelines.actions.githubusercontent.com",
];

function isStorageHost(hostname) {
  return (
    storageHosts.includes(hostname) ||
    hostname.endsWith(".blob.core.windows.net")
  );
}

function assertTransportUrl(url, kind, redirected) {
  if (url.protocol !== "https:")
    throw new Error("live_catalog_github_transport_url_untrusted");
  if (!redirected && url.origin !== githubApi)
    throw new Error("live_catalog_github_transport_url_untrusted");
  if (redirected && (kind === "json" || !isStorageHost(url.hostname)))
    throw new Error("live_catalog_github_redirect_host_untrusted");
}

async function boundedBody(response, maximumBytes) {
  const declared = response.headers?.get?.("content-length");
  if (declared !== null && declared !== undefined) {
    if (!/^[0-9]+$/u.test(declared) || Number(declared) > maximumBytes)
      throw new Error("live_catalog_github_content_length_invalid");
  }
  if (!response.body)
    throw new Error("live_catalog_github_response_body_missing");
  const chunks = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new Error("live_catalog_github_download_size_invalid");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  if (size === 0 || (declared != null && Number(declared) !== size))
    throw new Error("live_catalog_github_download_size_invalid");
  return Buffer.concat(chunks, size);
}

export async function boundedGithubRequest(
  { path, token, kind, maximumBytes, timeoutMs = 20_000, maximumRedirects = 3 },
  fetchImpl = globalThis.fetch,
) {
  if (!path.startsWith("/"))
    throw new Error("live_catalog_github_transport_path_invalid");
  let url = new URL(path, githubApi);
  let authorization = `Bearer ${token}`;
  const controller = new globalThis.AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let redirects = 0; ; redirects += 1) {
      assertTransportUrl(url, kind, redirects > 0);
      let response;
      try {
        response = await fetchImpl(url.href, {
          headers: {
            Accept: "application/vnd.github+json",
            "Accept-Encoding": "identity",
            ...(authorization ? { Authorization: authorization } : {}),
            "X-GitHub-Api-Version": "2022-11-28",
          },
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted)
          throw new Error("live_catalog_github_transport_timeout", {
            cause: error,
          });
        throw error;
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (kind === "json" || redirects >= maximumRedirects)
          throw new Error("live_catalog_github_redirect_invalid");
        const location = response.headers?.get?.("location");
        if (!location) throw new Error("live_catalog_github_redirect_invalid");
        const next = new URL(location, url);
        assertTransportUrl(next, kind, true);
        if (next.origin !== url.origin) authorization = "";
        url = next;
        continue;
      }
      if (!response.ok)
        throw new Error(`live_catalog_github_http_${response.status}`);
      return await boundedBody(response, maximumBytes);
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function boundedGithubJson(path, token, fetchImpl) {
  const bytes = await boundedGithubRequest(
    {
      path,
      token,
      kind: "json",
      maximumBytes: 2 * 1024 * 1024,
      maximumRedirects: 0,
    },
    fetchImpl,
  );
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("live_catalog_github_response_not_json");
  }
}

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
  const token = headers.Authorization.replace(/^Bearer /u, "");
  const bytes = await boundedGithubRequest(
    {
      path,
      token,
      kind: "json",
      maximumBytes: 2 * 1024 * 1024,
      maximumRedirects: 0,
    },
    fetchImpl,
  );
  const text = bytes.toString("utf8");
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("trusted evidence GitHub API response is not JSON");
  }
  return { body, bodySha256: sha256(bytes) };
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

export function readExactZipEntries(
  archiveBytes,
  {
    maximumEntryBytes = 16 * 1024 * 1024,
    maximumTotalBytes = 24 * 1024 * 1024,
  } = {},
) {
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
  let totalUncompressedBytes = 0;
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
      uncompressedSize > maximumEntryBytes ||
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
    totalUncompressedBytes += uncompressedSize;
    if (totalUncompressedBytes > maximumTotalBytes)
      throw new Error("trusted evidence ZIP uncompressed total is too large");
    const value =
      method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: maximumEntryBytes });
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

  const archive = await boundedGithubRequest(
    {
      path: `${prefix}/actions/artifacts/${expected.artifactId}/zip`,
      token,
      kind: "download",
      maximumBytes: 32 * 1024 * 1024,
    },
    fetchImpl,
  );
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
