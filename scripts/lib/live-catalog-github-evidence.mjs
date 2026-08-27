import {
  boundedGithubJson,
  boundedGithubRequest,
  readExactZipEntries,
  gitBlobSha,
} from "./github-actions-trusted-evidence.mjs";
import {
  assembleLiveCatalogClaim,
  LIVE_CATALOG_PG17_IMAGE,
  LIVE_CATALOG_PROJECTION_PATH,
  LIVE_CATALOG_SOURCE_WORKFLOW,
  sha256Hex,
} from "./live-catalog-attestation-domain.mjs";

function repositoryParts(repository) {
  if (
    typeof repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)
  )
    throw new Error("live_catalog_repository_invalid");
  return repository.split("/");
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`live_catalog_${label}_invalid`);
  return parsed;
}

async function json(fetchImpl, path, token) {
  return boundedGithubJson(path, token, fetchImpl);
}

async function bytes(fetchImpl, path, token, maximumBytes) {
  return boundedGithubRequest(
    { path, token, kind: "download", maximumBytes },
    fetchImpl,
  );
}

async function sourceFile(fetchImpl, prefix, path, commit, token) {
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
  if (fileBytes.length !== value.size || gitBlobSha(fileBytes) !== value.sha)
    throw new Error("live_catalog_source_file_digest_invalid");
  return fileBytes;
}

function exactJob(jobs, id, name, runId, attempt, headSha) {
  const matches = jobs.filter(
    (job) => String(job.id) === String(id) && job.name === name,
  );
  if (
    matches.length !== 1 ||
    String(matches[0].run_id) !== String(runId) ||
    matches[0].run_attempt !== attempt ||
    matches[0].head_sha !== headSha ||
    matches[0].head_branch !== "main" ||
    matches[0].status !== "completed" ||
    matches[0].conclusion !== "success" ||
    JSON.stringify(matches[0].labels) !== JSON.stringify(["ubuntu-24.04"]) ||
    matches[0].runner_group_id !== 0 ||
    matches[0].runner_group_name !== "GitHub Actions" ||
    !/^GitHub Actions [1-9][0-9]*$/u.test(matches[0].runner_name ?? "")
  )
    throw new Error("live_catalog_job_tuple_invalid");
  return matches[0];
}

export async function collectLiveCatalogClaim(
  configuration,
  fetchImpl = globalThis.fetch,
) {
  const [owner, name] = repositoryParts(configuration.repository);
  const token = configuration.token;
  if (typeof token !== "string" || token.length === 0)
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
  const attestorRunId = positiveInteger(
    configuration.attestorRunId,
    "attestor_run_id",
  );
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
    main.commit?.sha !== attestorCommit
  )
    throw new Error("live_catalog_attestor_not_fresh_protected_main");
  if (
    String(run.id) !== String(runId) ||
    run.run_attempt !== 1 ||
    run.event !== "workflow_dispatch" ||
    run.path !== LIVE_CATALOG_SOURCE_WORKFLOW ||
    run.head_branch !== "main" ||
    !/^[a-f0-9]{40}$/u.test(run.head_sha ?? "") ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    String(run.head_repository?.id) !== String(repository.id)
  )
    throw new Error("live_catalog_source_run_tuple_invalid");
  if (
    !Array.isArray(jobsResponse.jobs) ||
    jobsResponse.total_count !== jobsResponse.jobs.length ||
    jobsResponse.total_count > 100
  )
    throw new Error("live_catalog_job_inventory_incomplete");
  const producerJob = exactJob(
    jobsResponse.jobs,
    producerJobId,
    "Full private PG16 to PG17 rehearsal",
    runId,
    1,
    run.head_sha,
  );
  if (
    String(artifact.id) !== String(artifactId) ||
    artifact.name !== `activation-catalog-policy-${run.head_sha}-1` ||
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

  const [
    commit,
    ancestry,
    workflowSourceBytes,
    projectionSourceBytes,
    archiveBytes,
  ] = await Promise.all([
    json(fetchImpl, `${prefix}/git/commits/${run.head_sha}`, token),
    json(
      fetchImpl,
      `${prefix}/compare/${run.head_sha}...${attestorCommit}`,
      token,
    ),
    sourceFile(
      fetchImpl,
      prefix,
      LIVE_CATALOG_SOURCE_WORKFLOW,
      run.head_sha,
      token,
    ),
    sourceFile(
      fetchImpl,
      prefix,
      LIVE_CATALOG_PROJECTION_PATH,
      run.head_sha,
      token,
    ),
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
    !["ahead", "identical"].includes(ancestry.status) ||
    ancestry.base_commit?.sha !== run.head_sha ||
    ancestry.merge_base_commit?.sha !== run.head_sha ||
    `sha256:${sha256Hex(archiveBytes)}` !== artifact.digest
  )
    throw new Error("live_catalog_source_or_archive_digest_mismatch");
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
    artifactName: artifact.name,
    archiveSha256: sha256Hex(archiveBytes),
    candidateEntries,
    captureEvidenceBytes,
    workflowSourceBytes,
    projectionSourceBytes,
    pg17Image: LIVE_CATALOG_PG17_IMAGE,
    attestorCommit,
    attestorRunId,
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
      projectionSourceBytes,
      captureEvidenceBytes,
      workflowSourceBytes,
    }),
  });
}
