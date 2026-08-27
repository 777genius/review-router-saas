import {
  boundedGithubJson,
  boundedGithubRequest,
  gitBlobSha,
  readExactZipEntries,
} from "./github-actions-trusted-evidence.mjs";
import {
  assembleLiveCatalogClaim,
  LIVE_CATALOG_CONTRACT_PATH,
  LIVE_CATALOG_PG17_IMAGE,
  LIVE_CATALOG_PRODUCER_JOB_NAME,
  LIVE_CATALOG_PROJECTION_PATH,
  LIVE_CATALOG_SOURCE_WORKFLOW,
  localImportSpecifiers,
  resolveLocalImport,
  sha256Hex,
} from "./live-catalog-attestation-domain.mjs";
import { verifyWithGhAttestation } from "./live-catalog-gh-attestation-adapter.mjs";

const closureRoots = Object.freeze([
  LIVE_CATALOG_SOURCE_WORKFLOW,
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "scripts/install-private-dependencies.mjs",
  "scripts/rehearse-private-pg17-rollout.mjs",
  "scripts/package-live-catalog-capture-evidence.mjs",
  "scripts/capture-private-pg17-activation-catalog-policy.mjs",
  "scripts/run-codex-rotating-release-migration.mjs",
  "scripts/run-codex-rotating-role-bootstrap.mjs",
  "scripts/run-private-pg17-copy-bootstrap.ts",
  "scripts/activate-private-pg17-generation.mjs",
  "scripts/install-release-authority-db.mjs",
  LIVE_CATALOG_CONTRACT_PATH,
  LIVE_CATALOG_PROJECTION_PATH,
  "packages/platform/db/prisma/schema.prisma",
]);

function repositoryParts(repository) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? ""))
    throw new Error("live_catalog_repository_invalid");
  return repository.split("/");
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`live_catalog_${label}_invalid`);
  return parsed;
}

const json = (fetchImpl, path, token) =>
  boundedGithubJson(path, token, fetchImpl);
const bytes = (fetchImpl, path, token, maximumBytes) =>
  boundedGithubRequest(
    { path, token, kind: "download", maximumBytes },
    fetchImpl,
  );

async function sourceFile(fetchImpl, prefix, path, commit, token, expected) {
  const value = await json(
    fetchImpl,
    `${prefix}/contents/${path}?ref=${commit}`,
    token,
  );
  if (
    value.type !== "file" ||
    value.path !== path ||
    value.encoding !== "base64" ||
    typeof value.content !== "string"
  )
    throw new Error("live_catalog_source_file_identity_invalid");
  const fileBytes = Buffer.from(value.content.replaceAll("\n", ""), "base64");
  if (
    fileBytes.length !== value.size ||
    gitBlobSha(fileBytes) !== value.sha ||
    (expected && (expected.sha !== value.sha || expected.size !== value.size))
  )
    throw new Error("live_catalog_source_file_digest_invalid");
  return fileBytes;
}

export async function buildLiveCatalogSourceClosure({
  fetchImpl,
  prefix,
  token,
  commit,
  treeSha,
}) {
  const tree = await json(
    fetchImpl,
    `${prefix}/git/trees/${treeSha}?recursive=1`,
    token,
  );
  if (
    tree.sha !== treeSha ||
    tree.truncated !== false ||
    !Array.isArray(tree.tree)
  )
    throw new Error("live_catalog_source_tree_inventory_invalid");
  const blobs = new Map();
  for (const entry of tree.tree) {
    if (
      entry.type === "blob" &&
      typeof entry.path === "string" &&
      /^[a-f0-9]{40}$/u.test(entry.sha ?? "") &&
      Number.isSafeInteger(entry.size) &&
      entry.size >= 0
    )
      blobs.set(entry.path, entry);
  }
  const selected = new Set(closureRoots);
  for (const path of blobs.keys())
    if (
      /^packages\/platform\/db\/prisma\/migrations\/[^/]+\/migration\.sql$/u.test(
        path,
      ) ||
      /^packages\/platform\/release-authority-db\/migrations\/[^/]+\/migration\.sql$/u.test(
        path,
      )
    )
      selected.add(path);
  for (const root of selected)
    if (!blobs.has(root))
      throw new Error("live_catalog_source_closure_root_missing");
  const fetchPaths = async (paths) => {
    const results = [];
    for (let offset = 0; offset < paths.length; offset += 12)
      results.push(
        ...(await Promise.all(
          paths
            .slice(offset, offset + 12)
            .map(async (path) => [
              path,
              await sourceFile(
                fetchImpl,
                prefix,
                path,
                commit,
                token,
                blobs.get(path),
              ),
            ]),
        )),
      );
    return results;
  };
  const loaded = new Map();
  while (true) {
    const pending = [...selected].filter((path) => !loaded.has(path));
    if (!pending.length) break;
    const results = await fetchPaths(pending);
    for (const [path, fileBytes] of results) loaded.set(path, fileBytes);
    for (const [path, fileBytes] of results)
      for (const specifier of localImportSpecifiers(path, fileBytes))
        selected.add(resolveLocalImport(path, specifier, blobs));
  }
  // Package metadata affects resolution and dependency installation. Include every
  // package manifest governing a selected source file.
  for (const path of [...selected]) {
    let directory = path.includes("/")
      ? path.slice(0, path.lastIndexOf("/"))
      : "";
    while (directory) {
      const manifest = `${directory}/package.json`;
      if (blobs.has(manifest)) selected.add(manifest);
      directory = directory.includes("/")
        ? directory.slice(0, directory.lastIndexOf("/"))
        : "";
    }
  }
  const metadataPending = [...selected].filter((path) => !loaded.has(path));
  const metadata = await fetchPaths(metadataPending);
  for (const [path, fileBytes] of metadata) loaded.set(path, fileBytes);
  return [...loaded.entries()]
    .map(([path, fileBytes]) => ({
      path,
      gitBlobSha: blobs.get(path).sha,
      size: fileBytes.length,
      sha256: sha256Hex(fileBytes),
      bytes: fileBytes,
    }))
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
}

function exactProducerJob(jobs, id, runId, headSha) {
  if (jobs.length !== 1)
    throw new Error("live_catalog_producer_job_not_unique");
  const job = jobs[0];
  if (
    String(job.id) !== String(id) ||
    String(job.run_id) !== String(runId) ||
    job.run_attempt !== 1 ||
    job.head_sha !== headSha ||
    job.head_branch !== "main" ||
    job.name !== LIVE_CATALOG_PRODUCER_JOB_NAME ||
    job.status !== "completed" ||
    job.conclusion !== "success" ||
    JSON.stringify(job.labels) !== JSON.stringify(["ubuntu-24.04"]) ||
    job.runner_group_id !== 0 ||
    job.runner_group_name !== "GitHub Actions" ||
    !/^GitHub Actions [1-9][0-9]*$/u.test(job.runner_name ?? "")
  )
    throw new Error("live_catalog_job_tuple_invalid");
  return job;
}

export async function assertFreshProtectedMain(
  configuration,
  fetchImpl = globalThis.fetch,
) {
  const [owner, name] = repositoryParts(configuration.repository);
  const prefix = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const main = await json(
    fetchImpl,
    `${prefix}/branches/main`,
    configuration.token,
  );
  if (
    main.name !== "main" ||
    main.protected !== true ||
    main.commit?.sha !== configuration.expectedCommit
  )
    throw new Error("live_catalog_attestor_not_fresh_protected_main");
}

export async function collectLiveCatalogClaim(
  configuration,
  fetchImpl = globalThis.fetch,
  producerVerifier = verifyWithGhAttestation,
) {
  const [owner, name] = repositoryParts(configuration.repository);
  const token = configuration.token;
  if (typeof token !== "string" || !token)
    throw new Error("live_catalog_github_token_required");
  const runId = positiveInteger(configuration.runId, "run_id");
  const artifactId = positiveInteger(configuration.artifactId, "artifact_id");
  const producerJobId = positiveInteger(
    configuration.producerJobId,
    "producer_job_id",
  );
  const attestorCommit = configuration.attestorCommit;
  if (!/^[a-f0-9]{40}$/u.test(attestorCommit ?? ""))
    throw new Error("live_catalog_attestor_commit_invalid");
  const prefix = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const [repository, main, run, jobsResponse, artifact] = await Promise.all([
    json(fetchImpl, prefix, token),
    json(fetchImpl, `${prefix}/branches/main`, token),
    json(fetchImpl, `${prefix}/actions/runs/${runId}`, token),
    json(
      fetchImpl,
      `${prefix}/actions/runs/${runId}/jobs?filter=latest&per_page=100`,
      token,
    ),
    json(fetchImpl, `${prefix}/actions/artifacts/${artifactId}`, token),
  ]);
  if (
    repository.full_name?.toLowerCase() !==
      configuration.repository.toLowerCase() ||
    repository.default_branch !== "main" ||
    String(run.repository?.id) !== String(repository.id) ||
    run.repository?.full_name?.toLowerCase() !==
      configuration.repository.toLowerCase() ||
    run.head_repository?.full_name?.toLowerCase() !==
      configuration.repository.toLowerCase()
  )
    throw new Error("live_catalog_repository_identity_mismatch");
  if (
    main.name !== "main" ||
    main.protected !== true ||
    main.commit?.sha !== attestorCommit ||
    run.head_sha !== attestorCommit
  )
    throw new Error("live_catalog_source_not_exact_current_main");
  if (
    String(run.id) !== String(runId) ||
    run.run_attempt !== 1 ||
    run.event !== "workflow_dispatch" ||
    run.path !== LIVE_CATALOG_SOURCE_WORKFLOW ||
    run.head_branch !== "main" ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    String(run.head_repository?.id) !== String(repository.id)
  )
    throw new Error("live_catalog_source_run_tuple_invalid");
  if (
    !Array.isArray(jobsResponse.jobs) ||
    jobsResponse.total_count !== 1 ||
    jobsResponse.jobs.length !== 1
  )
    throw new Error("live_catalog_job_inventory_incomplete");
  const producerJob = exactProducerJob(
    jobsResponse.jobs,
    producerJobId,
    runId,
    run.head_sha,
  );
  const artifactName = `activation-catalog-policy-${run.head_sha}-1`;
  if (
    String(artifact.id) !== String(artifactId) ||
    artifact.name !== artifactName ||
    String(artifact.workflow_run?.id) !== String(runId) ||
    String(artifact.workflow_run?.repository_id) !== String(repository.id) ||
    String(artifact.workflow_run?.head_repository_id) !==
      String(repository.id) ||
    artifact.workflow_run?.head_branch !== "main" ||
    artifact.workflow_run?.head_sha !== run.head_sha ||
    artifact.expired !== false ||
    !/^sha256:[a-f0-9]{64}$/u.test(artifact.digest ?? "")
  )
    throw new Error("live_catalog_artifact_tuple_invalid");
  const [commit, archiveBytes] = await Promise.all([
    json(fetchImpl, `${prefix}/git/commits/${run.head_sha}`, token),
    bytes(
      fetchImpl,
      `${prefix}/actions/artifacts/${artifactId}/zip`,
      token,
      32 * 1024 * 1024,
    ),
  ]);
  if (
    commit.sha !== run.head_sha ||
    !/^[a-f0-9]{40}$/u.test(commit.tree?.sha ?? "") ||
    `sha256:${sha256Hex(archiveBytes)}` !== artifact.digest
  )
    throw new Error("live_catalog_source_or_archive_digest_mismatch");

  // Authenticate the producer subject before interpreting any archive entry.
  const producerAttestation = await producerVerifier({
    repository: configuration.repository.toLowerCase(),
    subjectBytes: archiveBytes,
    subjectName: artifactName,
    signerWorkflowPath: LIVE_CATALOG_SOURCE_WORKFLOW,
    signerDigest: run.head_sha,
    sourceRef: "refs/heads/main",
    sourceDigest: run.head_sha,
    runId: String(runId),
    token,
  });
  if (
    producerAttestation.subject.digest !== artifact.digest ||
    producerAttestation.subject.name !== artifactName
  )
    throw new Error("live_catalog_producer_artifact_digest_mismatch");

  const sourceClosureFiles = await buildLiveCatalogSourceClosure({
    fetchImpl,
    prefix,
    token,
    commit: run.head_sha,
    treeSha: commit.tree.sha,
  });
  const byPath = new Map(
    sourceClosureFiles.map((file) => [file.path, file.bytes]),
  );
  const workflowSourceBytes = byPath.get(LIVE_CATALOG_SOURCE_WORKFLOW);
  const projectionSourceBytes = byPath.get(LIVE_CATALOG_PROJECTION_PATH);
  const contractSourceBytes = byPath.get(LIVE_CATALOG_CONTRACT_PATH);
  const entries = readExactZipEntries(archiveBytes);
  const candidateEntries = [...entries.entries()].filter(([entryName]) =>
    /^activation-catalog-policy-candidate-[12]\.json$/u.test(entryName),
  );
  const captureEvidenceBytes = entries.get(
    "live-catalog-successful-capture-evidence.json",
  );
  if (
    candidateEntries.length !== 2 ||
    entries.size !== 3 ||
    !captureEvidenceBytes
  )
    throw new Error("live_catalog_artifact_contains_unexpected_entries");
  const claim = assembleLiveCatalogClaim({
    repositoryId: repository.id,
    repositoryName: repository.full_name,
    sourceCommit: run.head_sha,
    sourceTree: commit.tree.sha,
    sourceRef: run.head_sha,
    sourceBranch: run.head_branch,
    sourceWorkflowPath: run.path,
    sourceEvent: run.event,
    sourceStatus: run.status,
    sourceConclusion: run.conclusion,
    runId,
    runAttempt: run.run_attempt,
    producerJob: {
      id: producerJob.id,
      name: producerJob.name,
      status: producerJob.status,
      conclusion: producerJob.conclusion,
      runnerGroupId: producerJob.runner_group_id,
      runnerGroupName: producerJob.runner_group_name,
      runnerName: producerJob.runner_name,
      labels: producerJob.labels,
    },
    runnerEnvironment: "github-hosted",
    artifactId,
    artifactName,
    artifactRestDigest: artifact.digest,
    archiveSha256: sha256Hex(archiveBytes),
    candidateEntries,
    captureEvidenceBytes,
    workflowSourceBytes,
    projectionSourceBytes,
    contractSourceBytes,
    sourceClosureFiles,
    producerCertificate: producerAttestation.certificate,
    producerSubject: producerAttestation.subject,
    producerBundleBytes: producerAttestation.bundleBytes,
    pg17Image: LIVE_CATALOG_PG17_IMAGE,
    attestorCommit,
    attestorRunId: positiveInteger(
      configuration.attestorRunId,
      "attestor_run_id",
    ),
    attestorRunAttempt: positiveInteger(
      configuration.attestorRunAttempt,
      "attestor_run_attempt",
    ),
    attestorRef: configuration.attestorRef,
    attestorRunner: configuration.attestorRunner,
    attestorEnvironment: configuration.attestorEnvironment,
  });
  return Object.freeze({
    claim,
    evidence: Object.freeze({
      archiveBytes,
      captureEvidenceBytes,
      producerBundleBytes: producerAttestation.bundleBytes,
      sourceClosureFiles,
    }),
  });
}
