import { createHash } from "node:crypto";

export const LIVE_CATALOG_CLAIM_SCHEMA =
  "reviewrouter.live-catalog-provenance.v1";
export const LIVE_CATALOG_WORKFLOW =
  ".github/workflows/attest-live-catalog-digest.yml";
export const LIVE_CATALOG_SOURCE_WORKFLOW = ".github/workflows/ci.yml";
export const LIVE_CATALOG_PROJECTION_PATH =
  "packages/features/release-rollout/src/adapters/live-v70-v72-catalog-digest.mjs";
export const LIVE_CATALOG_PROJECTION_EXPORT =
  "fencedLiveV70V73CatalogDigestSql";
export const LIVE_CATALOG_EXPECTED_DIGEST_EXPORT =
  "liveV70V73CatalogDigestSha256";
export const LIVE_CATALOG_PG17_IMAGE =
  "postgres:17.5-bookworm@sha256:fbcea1bd13b6a882cd6caa6b58db3ae5c102efe50ec625b3e2a5cbc50db5bfe4";

export const sha256Hex = (value) =>
  createHash("sha256").update(value).digest("hex");
export const sha256Digest = (value) => `sha256:${sha256Hex(value)}`;

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined)
        throw new Error("live_catalog_claim_undefined_value");
      result[key] = canonicalize(value[key]);
    }
    return result;
  }
  throw new Error("live_catalog_claim_noncanonical_value");
}

export const canonicalJson = (value) =>
  `${JSON.stringify(canonicalize(value), null, 2)}\n`;

function exactKeys(value, keys, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify([...keys].sort())
  )
    throw new Error(`live_catalog_${label}_shape_invalid`);
}

function string(value, label, pattern) {
  if (typeof value !== "string" || !pattern.test(value))
    throw new Error(`live_catalog_${label}_invalid`);
  return value;
}

function integer(value, label) {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`live_catalog_${label}_invalid`);
  return parsed;
}

const shaPattern = /^[a-f0-9]{64}$/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const commitPattern = /^[a-f0-9]{40}$/u;

export function extractProjectionBytes(sourceBytes) {
  const source = Buffer.from(sourceBytes).toString("utf8");
  const marker = `export const ${LIVE_CATALOG_PROJECTION_EXPORT} = \``;
  const start = source.indexOf(marker);
  if (start < 0 || source.indexOf(marker, start + marker.length) >= 0)
    throw new Error("live_catalog_projection_export_missing_or_ambiguous");
  const bodyStart = start + marker.length;
  const bodyEnd = source.indexOf("`;", bodyStart);
  if (bodyEnd < 0 || source.slice(bodyStart, bodyEnd).includes("`"))
    throw new Error("live_catalog_projection_export_not_static_template");
  return Buffer.from(source.slice(bodyStart, bodyEnd), "utf8");
}

export function extractConfiguredCatalogDigest(sourceBytes) {
  const source = Buffer.from(sourceBytes).toString("utf8");
  const marker = `export const ${LIVE_CATALOG_EXPECTED_DIGEST_EXPORT} =`;
  const start = source.indexOf(marker);
  if (start < 0 || source.indexOf(marker, start + marker.length) >= 0)
    throw new Error("live_catalog_expected_digest_export_missing_or_ambiguous");
  const declaration = source.slice(start, source.indexOf(";", start) + 1);
  const match = declaration.match(/=\s*"(sha256:[a-f0-9]{64})"\s*;$/u);
  if (!match) throw new Error("live_catalog_expected_digest_export_invalid");
  return match[1];
}

export function assertSourceWorkflowPg17Image(sourceBytes) {
  const source = Buffer.from(sourceBytes).toString("utf8");
  const jobBlock = (name) => {
    const startPattern = new RegExp(`^  ${name}:\\s*$`, "mu");
    const start = startPattern.exec(source);
    if (!start) return "";
    const bodyStart = start.index + start[0].length;
    const next = /^ {2}[a-z0-9-]+:\s*$/gmu;
    next.lastIndex = bodyStart;
    const end = next.exec(source)?.index ?? source.length;
    return source.slice(bodyStart, end);
  };
  const releaseJob = jobBlock("release-authority-pg17-contract");
  const qualityJob = jobBlock("quality");
  const escaped = LIVE_CATALOG_PG17_IMAGE.replace(
    /[.*+?^${}()|[\]\\]/gu,
    "\\$&",
  );
  if (
    !new RegExp(
      `^      REVIEW_ROUTER_PG17_ADVERSARIAL_IMAGE: ${escaped}\\s*$`,
      "mu",
    ).test(releaseJob) ||
    !new RegExp(`^        image: ${escaped}\\s*$`, "mu").test(qualityJob)
  )
    throw new Error("live_catalog_source_workflow_pg17_image_unpinned");
}

export function sanitizeOneObservation(logBytes) {
  const log = Buffer.from(logBytes).toString("utf8");
  const matches = [];
  for (const rawLine of log.split(/\r?\n/u)) {
    const detail = rawLine.match(
      /^Quality Gates\tStop containers\t\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z {2}(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}) UTC \[[1-9][0-9]*\] DETAIL: {2}expected=(sha256:[a-f0-9]{64}) observed=(sha256:[a-f0-9]{64})$/u,
    );
    if (detail) {
      matches.push({
        lineBytes: Buffer.from(rawLine, "utf8"),
        observation: {
          kind: "release-migration-live-catalog-digest",
          observedAt: `${detail[1].replace(" ", "T")}Z`,
          expectedDigest: detail[2],
          observedDigest: detail[3],
        },
      });
    }
  }
  if (matches.length !== 1)
    throw new Error("live_catalog_observation_count_not_one");
  return Object.freeze(matches[0]);
}

function candidateFacts(name, bytes) {
  const value = Buffer.from(bytes);
  if (value.length === 0) throw new Error("live_catalog_candidate_empty");
  let parsed;
  try {
    parsed = JSON.parse(value.toString("utf8"));
  } catch {
    throw new Error("live_catalog_candidate_not_json");
  }
  if (
    parsed?.kind !==
      "reviewrouter-activation-catalog-policy-artifact-candidate" ||
    parsed.version !== 1 ||
    !parsed.policies?.preactivation ||
    !parsed.policies?.activated
  )
    throw new Error("live_catalog_candidate_contract_invalid");
  return Object.freeze({ name, size: value.length, sha256: sha256Hex(value) });
}

export function candidateToObservedDigest(candidates, observedDigest) {
  return sha256Digest(
    Buffer.from(
      canonicalJson({
        domain: "reviewrouter.live-catalog.candidates-to-observation.v1",
        candidates: candidates.map(({ name, size, sha256 }) => ({
          name,
          size,
          sha256,
        })),
        observedDigest,
      }),
    ),
  );
}

export function assembleLiveCatalogClaim(input) {
  if (
    input.attestorRef !== "refs/heads/main" ||
    input.attestorRunAttempt !== 1 ||
    input.attestorRunner !== "ubuntu-24.04" ||
    input.attestorEnvironment !== "production-release"
  )
    throw new Error("live_catalog_attestor_execution_invalid");
  if (input.runAttempt !== 1)
    throw new Error("live_catalog_source_run_attempt_must_be_one");
  if (
    input.sourceRef !== input.sourceCommit ||
    typeof input.sourceBranch !== "string" ||
    !/^[A-Za-z0-9._/-]+$/u.test(input.sourceBranch)
  )
    throw new Error("live_catalog_source_ref_invalid");
  if (input.sourceWorkflowPath !== LIVE_CATALOG_SOURCE_WORKFLOW)
    throw new Error("live_catalog_source_workflow_mismatch");
  if (input.sourceEvent !== "workflow_dispatch")
    throw new Error("live_catalog_source_event_mismatch");
  if (
    input.qualityJob.name !== "Quality Gates" ||
    input.qualityJob.conclusion !== "success"
  )
    throw new Error("live_catalog_quality_job_mismatch");
  if (
    input.pg17Job.name !== "Dedicated Release Authority PG17 contract" ||
    input.pg17Job.conclusion !== "success"
  )
    throw new Error("live_catalog_pg17_job_mismatch");
  if (input.runnerEnvironment !== "github-hosted")
    throw new Error("live_catalog_self_hosted_runner_denied");
  if (input.pg17Image !== LIVE_CATALOG_PG17_IMAGE)
    throw new Error("live_catalog_pg17_image_mismatch");
  assertSourceWorkflowPg17Image(input.workflowSourceBytes);

  const candidates = [...input.candidateEntries]
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([name, bytes]) => candidateFacts(name, bytes));
  if (
    candidates.length !== 2 ||
    candidates[0].name !== "activation-catalog-policy-candidate-1.json" ||
    candidates[1].name !== "activation-catalog-policy-candidate-2.json" ||
    candidates[0].size !== candidates[1].size ||
    candidates[0].sha256 !== candidates[1].sha256
  )
    throw new Error("live_catalog_candidate_pair_not_byte_identical");

  const sanitized = sanitizeOneObservation(input.qualityLogBytes);
  const observation = sanitized.observation;
  const projectionBytes = extractProjectionBytes(input.projectionSourceBytes);
  const configuredDigest = extractConfiguredCatalogDigest(
    input.projectionSourceBytes,
  );
  if (observation.expectedDigest !== configuredDigest)
    throw new Error("live_catalog_observation_expected_digest_mismatch");
  const claim = {
    schemaVersion: LIVE_CATALOG_CLAIM_SCHEMA,
    repository: {
      id: String(integer(input.repositoryId, "repository_id")),
      name: string(
        input.repositoryName.toLowerCase(),
        "repository_name",
        /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/u,
      ),
    },
    source: {
      commit: string(input.sourceCommit, "source_commit", commitPattern),
      tree: string(input.sourceTree, "source_tree", commitPattern),
      ref: input.sourceRef,
      branch: input.sourceBranch,
    },
    execution: {
      runId: String(integer(input.runId, "run_id")),
      runAttempt: input.runAttempt,
      workflowPath: input.sourceWorkflowPath,
      event: input.sourceEvent,
      qualityJob: {
        id: String(integer(input.qualityJob.id, "quality_job_id")),
        name: input.qualityJob.name,
        conclusion: input.qualityJob.conclusion,
      },
      pg17Job: {
        id: String(integer(input.pg17Job.id, "pg17_job_id")),
        name: input.pg17Job.name,
        conclusion: input.pg17Job.conclusion,
      },
      runnerEnvironment: input.runnerEnvironment,
    },
    artifact: {
      id: String(integer(input.artifactId, "artifact_id")),
      name: string(input.artifactName, "artifact_name", /^[A-Za-z0-9_.-]+$/u),
      archiveSha256: string(input.archiveSha256, "archive_sha256", shaPattern),
      candidates,
    },
    qualityLog: {
      size: Buffer.byteLength(input.qualityLogBytes),
      sha256: sha256Hex(input.qualityLogBytes),
      observationLineSize: sanitized.lineBytes.length,
      observationLineSha256: sha256Hex(sanitized.lineBytes),
      observation,
    },
    sources: {
      workflow: {
        path: LIVE_CATALOG_SOURCE_WORKFLOW,
        size: Buffer.byteLength(input.workflowSourceBytes),
        sha256: sha256Hex(input.workflowSourceBytes),
      },
      projection: {
        path: LIVE_CATALOG_PROJECTION_PATH,
        export: LIVE_CATALOG_PROJECTION_EXPORT,
        configuredDigestExport: LIVE_CATALOG_EXPECTED_DIGEST_EXPORT,
        configuredDigest,
        sourceSize: Buffer.byteLength(input.projectionSourceBytes),
        sourceSha256: sha256Hex(input.projectionSourceBytes),
        size: projectionBytes.length,
        sha256: sha256Hex(projectionBytes),
      },
    },
    pg17Image: input.pg17Image,
    observedCatalogDigest: observation.observedDigest,
    candidateToObservedDigest: candidateToObservedDigest(
      candidates,
      observation.observedDigest,
    ),
    attestor: {
      workflowPath: LIVE_CATALOG_WORKFLOW,
      ref: input.attestorRef,
      commit: string(input.attestorCommit, "attestor_commit", commitPattern),
      runId: String(integer(input.attestorRunId, "attestor_run_id")),
      runAttempt: input.attestorRunAttempt,
      runner: input.attestorRunner,
      environment: input.attestorEnvironment,
    },
  };
  validateLiveCatalogClaim(claim);
  return Object.freeze(claim);
}

export function validateLiveCatalogClaim(claim) {
  exactKeys(
    claim,
    [
      "schemaVersion",
      "repository",
      "source",
      "execution",
      "artifact",
      "qualityLog",
      "sources",
      "pg17Image",
      "observedCatalogDigest",
      "candidateToObservedDigest",
      "attestor",
    ],
    "claim",
  );
  if (claim.schemaVersion !== LIVE_CATALOG_CLAIM_SCHEMA)
    throw new Error("live_catalog_claim_version_invalid");
  exactKeys(claim.repository, ["id", "name"], "repository");
  exactKeys(claim.source, ["commit", "tree", "ref", "branch"], "source");
  exactKeys(
    claim.execution,
    [
      "runId",
      "runAttempt",
      "workflowPath",
      "event",
      "qualityJob",
      "pg17Job",
      "runnerEnvironment",
    ],
    "execution",
  );
  exactKeys(
    claim.artifact,
    ["id", "name", "archiveSha256", "candidates"],
    "artifact",
  );
  exactKeys(
    claim.execution.qualityJob,
    ["id", "name", "conclusion"],
    "quality_job",
  );
  exactKeys(claim.execution.pg17Job, ["id", "name", "conclusion"], "pg17_job");
  exactKeys(
    claim.qualityLog,
    [
      "size",
      "sha256",
      "observationLineSize",
      "observationLineSha256",
      "observation",
    ],
    "quality_log",
  );
  exactKeys(claim.sources, ["workflow", "projection"], "sources");
  exactKeys(
    claim.sources.workflow,
    ["path", "size", "sha256"],
    "workflow_source",
  );
  exactKeys(
    claim.sources.projection,
    [
      "path",
      "export",
      "configuredDigestExport",
      "configuredDigest",
      "sourceSize",
      "sourceSha256",
      "size",
      "sha256",
    ],
    "projection_source",
  );
  exactKeys(
    claim.attestor,
    [
      "workflowPath",
      "ref",
      "commit",
      "runId",
      "runAttempt",
      "runner",
      "environment",
    ],
    "attestor",
  );
  exactKeys(
    claim.qualityLog.observation,
    ["kind", "observedAt", "expectedDigest", "observedDigest"],
    "observation",
  );
  for (const candidate of claim.artifact.candidates)
    exactKeys(candidate, ["name", "size", "sha256"], "candidate");
  if (
    !/^[1-9][0-9]*$/u.test(claim.repository.id) ||
    !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/u.test(claim.repository.name) ||
    !commitPattern.test(claim.source.commit) ||
    !commitPattern.test(claim.source.tree) ||
    claim.source.ref !== claim.source.commit ||
    !/^[A-Za-z0-9._/-]+$/u.test(claim.source.branch) ||
    claim.execution.runAttempt !== 1 ||
    claim.execution.workflowPath !== LIVE_CATALOG_SOURCE_WORKFLOW ||
    claim.execution.event !== "workflow_dispatch" ||
    !/^[1-9][0-9]*$/u.test(claim.execution.runId) ||
    !/^[1-9][0-9]*$/u.test(claim.execution.qualityJob.id) ||
    claim.execution.qualityJob.name !== "Quality Gates" ||
    claim.execution.qualityJob.conclusion !== "success" ||
    !/^[1-9][0-9]*$/u.test(claim.execution.pg17Job.id) ||
    claim.execution.pg17Job.name !==
      "Dedicated Release Authority PG17 contract" ||
    claim.execution.pg17Job.conclusion !== "success" ||
    claim.execution.runnerEnvironment !== "github-hosted" ||
    !/^[1-9][0-9]*$/u.test(claim.artifact.id) ||
    claim.artifact.name !==
      `activation-catalog-policy-${claim.source.commit}-1` ||
    !shaPattern.test(claim.artifact.archiveSha256) ||
    !Number.isSafeInteger(claim.qualityLog.size) ||
    claim.qualityLog.size <= 0 ||
    !shaPattern.test(claim.qualityLog.sha256) ||
    claim.pg17Image !== LIVE_CATALOG_PG17_IMAGE ||
    claim.attestor.workflowPath !== LIVE_CATALOG_WORKFLOW ||
    claim.attestor.ref !== "refs/heads/main" ||
    !commitPattern.test(claim.attestor.commit) ||
    !/^[1-9][0-9]*$/u.test(claim.attestor.runId) ||
    claim.attestor.runAttempt !== 1 ||
    claim.attestor.runner !== "ubuntu-24.04" ||
    claim.attestor.environment !== "production-release" ||
    claim.sources.workflow.path !== LIVE_CATALOG_SOURCE_WORKFLOW ||
    !Number.isSafeInteger(claim.sources.workflow.size) ||
    claim.sources.workflow.size <= 0 ||
    !shaPattern.test(claim.sources.workflow.sha256) ||
    claim.sources.projection.path !== LIVE_CATALOG_PROJECTION_PATH ||
    claim.sources.projection.export !== LIVE_CATALOG_PROJECTION_EXPORT ||
    claim.sources.projection.configuredDigestExport !==
      LIVE_CATALOG_EXPECTED_DIGEST_EXPORT ||
    !digestPattern.test(claim.sources.projection.configuredDigest) ||
    !Number.isSafeInteger(claim.sources.projection.sourceSize) ||
    claim.sources.projection.sourceSize <= 0 ||
    !shaPattern.test(claim.sources.projection.sourceSha256) ||
    !Number.isSafeInteger(claim.sources.projection.size) ||
    claim.sources.projection.size <= 0 ||
    !shaPattern.test(claim.sources.projection.sha256) ||
    !digestPattern.test(claim.observedCatalogDigest) ||
    claim.qualityLog.observation.kind !==
      "release-migration-live-catalog-digest" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(
      claim.qualityLog.observation.observedAt,
    ) ||
    !digestPattern.test(claim.qualityLog.observation.expectedDigest) ||
    claim.qualityLog.observation.expectedDigest !==
      claim.sources.projection.configuredDigest ||
    claim.qualityLog.observation.observedDigest !==
      claim.observedCatalogDigest ||
    !Number.isSafeInteger(claim.qualityLog.observationLineSize) ||
    claim.qualityLog.observationLineSize <= 0 ||
    !shaPattern.test(claim.qualityLog.observationLineSha256) ||
    claim.candidateToObservedDigest !==
      candidateToObservedDigest(
        claim.artifact.candidates,
        claim.observedCatalogDigest,
      )
  )
    throw new Error("live_catalog_claim_tuple_mismatch");
  if (
    claim.artifact.candidates.length !== 2 ||
    claim.artifact.candidates[0].name !==
      "activation-catalog-policy-candidate-1.json" ||
    claim.artifact.candidates[1].name !==
      "activation-catalog-policy-candidate-2.json" ||
    !Number.isSafeInteger(claim.artifact.candidates[0].size) ||
    claim.artifact.candidates[0].size <= 0 ||
    !shaPattern.test(claim.artifact.candidates[0].sha256) ||
    claim.artifact.candidates[0].sha256 !==
      claim.artifact.candidates[1].sha256 ||
    claim.artifact.candidates[0].size !== claim.artifact.candidates[1].size
  )
    throw new Error("live_catalog_claim_candidate_tuple_mismatch");
  return claim;
}

export function claimFingerprint(claim) {
  validateLiveCatalogClaim(claim);
  return sha256Digest(Buffer.from(canonicalJson(claim)));
}
