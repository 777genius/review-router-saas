import { createHash } from "node:crypto";
import ts from "typescript";
import { parseDocument } from "yaml";
import { parsePrivatePg17ActivationCatalogPolicyArtifactBytes } from "../capture-private-pg17-activation-catalog-policy.mjs";

export const LIVE_CATALOG_CLAIM_SCHEMA =
  "reviewrouter.live-catalog-provenance.v2";
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
  const initializer = exportedLiteral(
    sourceBytes,
    LIVE_CATALOG_PROJECTION_EXPORT,
  );
  if (!ts.isNoSubstitutionTemplateLiteral(initializer))
    throw new Error("live_catalog_projection_export_not_static_template");
  return Buffer.from(initializer.text, "utf8");
}

export function extractConfiguredCatalogDigest(sourceBytes) {
  const initializer = exportedLiteral(
    sourceBytes,
    LIVE_CATALOG_EXPECTED_DIGEST_EXPORT,
  );
  if (
    !ts.isStringLiteral(initializer) ||
    !/^sha256:[a-f0-9]{64}$/u.test(initializer.text)
  )
    throw new Error("live_catalog_expected_digest_export_invalid");
  return initializer.text;
}

function exportedLiteral(sourceBytes, exportName) {
  const source = ts.createSourceFile(
    "live-catalog-projection.mjs",
    Buffer.from(sourceBytes).toString("utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  if (source.parseDiagnostics.length > 0)
    throw new Error("live_catalog_projection_source_syntax_invalid");
  const matches = [];
  for (const statement of source.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause) &&
      statement.exportClause.elements.some(
        (element) => element.name.text === exportName,
      )
    )
      matches.push(undefined);
    if (
      !ts.isVariableStatement(statement) ||
      !(statement.modifiers ?? []).some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      ) ||
      (statement.declarationList.flags & ts.NodeFlags.Const) === 0
    )
      continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === exportName &&
        declaration.initializer
      )
        matches.push(declaration.initializer);
    }
  }
  if (matches.length !== 1)
    throw new Error("live_catalog_projection_export_missing_or_ambiguous");
  return matches[0];
}

export function assertSourceWorkflowPg17Image(sourceBytes) {
  const document = parseDocument(Buffer.from(sourceBytes).toString("utf8"), {
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0)
    throw new Error("live_catalog_source_workflow_yaml_invalid");
  const workflow = document.toJS({ maxAliasCount: 0 });
  const scalarType = (path) => document.getIn(path, true)?.type;
  const plain = (path) => scalarType(path) === "PLAIN";
  const jobs = workflow?.jobs;
  const producer = jobs?.["private-pg16-to-pg17-rehearsal"];
  const steps = producer?.steps;
  const namedStep = (name) =>
    Array.isArray(steps) ? steps.filter((step) => step?.name === name) : [];
  const capture = namedStep(
    "Capture two reproducible activation catalog policies",
  );
  const upload = namedStep("Upload activation catalog policy captures");
  const producerPath = ["jobs", "private-pg16-to-pg17-rehearsal", "steps"];
  const producerDeclarations = Object.entries(jobs ?? {}).filter(
    ([, job]) => job?.name === "Full private PG16 to PG17 rehearsal",
  );
  const captureDeclarations = Object.entries(jobs ?? {}).flatMap(
    ([jobId, job]) =>
      Array.isArray(job?.steps)
        ? job.steps
            .filter(
              (step) =>
                step?.name ===
                "Capture two reproducible activation catalog policies",
            )
            .map((step) => ({ jobId, step }))
        : [],
  );
  const uploadDeclarations = Object.entries(jobs ?? {}).flatMap(
    ([jobId, job]) =>
      Array.isArray(job?.steps)
        ? job.steps
            .filter(
              (step) =>
                step?.with?.name ===
                "activation-catalog-policy-${{ github.sha }}-${{ github.run_attempt }}",
            )
            .map((step) => ({ jobId, step }))
        : [],
  );
  const expectedCaptureRun = `export REVIEW_ROUTER_ACTIVATION_CATALOG_DISPOSABLE_DATABASE_IDENTITY="rr-disposable-\${GITHUB_RUN_ID}-\${GITHUB_RUN_ATTEMPT}-a"
node --import tsx scripts/rehearse-private-pg17-rollout.mjs > activation-catalog-capture-result-1.json
export REVIEW_ROUTER_ACTIVATION_CATALOG_DISPOSABLE_DATABASE_IDENTITY="rr-disposable-\${GITHUB_RUN_ID}-\${GITHUB_RUN_ATTEMPT}-b"
node --import tsx scripts/rehearse-private-pg17-rollout.mjs > activation-catalog-capture-result-2.json
node --import tsx scripts/package-live-catalog-capture-evidence.mjs activation-catalog-capture-result-1.json activation-catalog-capture-result-2.json
cmp activation-catalog-policy-candidate-1.json activation-catalog-policy-candidate-2.json
sha256sum activation-catalog-policy-candidate-1.json activation-catalog-policy-candidate-2.json live-catalog-successful-capture-evidence.json
`;
  if (
    !jobs ||
    typeof jobs !== "object" ||
    Array.isArray(jobs) ||
    !producer ||
    producerDeclarations.length !== 1 ||
    producerDeclarations[0][0] !== "private-pg16-to-pg17-rehearsal" ||
    producer.name !== "Full private PG16 to PG17 rehearsal" ||
    producer["runs-on"] !== "ubuntu-24.04" ||
    !plain(["jobs", "private-pg16-to-pg17-rehearsal", "name"]) ||
    !plain(["jobs", "private-pg16-to-pg17-rehearsal", "runs-on"]) ||
    capture.length !== 1 ||
    captureDeclarations.length !== 1 ||
    captureDeclarations[0].jobId !== "private-pg16-to-pg17-rehearsal" ||
    upload.length !== 1 ||
    uploadDeclarations.length !== 1 ||
    uploadDeclarations[0].jobId !== "private-pg16-to-pg17-rehearsal" ||
    !plain([...producerPath, steps.indexOf(capture[0]), "name"]) ||
    !plain([...producerPath, steps.indexOf(capture[0]), "if"]) ||
    scalarType([
      ...producerPath,
      steps.indexOf(capture[0]),
      "env",
      "REVIEW_ROUTER_PRIVATE_PG17_REHEARSAL",
    ]) !== "QUOTE_DOUBLE" ||
    scalarType([
      ...producerPath,
      steps.indexOf(capture[0]),
      "env",
      "REVIEW_ROUTER_PRIVATE_PG17_ACTIVATION_CATALOG_POLICY_CAPTURE_ONLY",
    ]) !== "QUOTE_DOUBLE" ||
    !plain([
      ...producerPath,
      steps.indexOf(capture[0]),
      "env",
      "REVIEW_ROUTER_REHEARSAL_PG17_IMAGE",
    ]) ||
    capture[0].if !== "${{ inputs.activation_catalog_policy_capture }}" ||
    capture[0].env?.REVIEW_ROUTER_PRIVATE_PG17_REHEARSAL !== "1" ||
    capture[0].env
      ?.REVIEW_ROUTER_PRIVATE_PG17_ACTIVATION_CATALOG_POLICY_CAPTURE_ONLY !==
      "1" ||
    capture[0].env?.REVIEW_ROUTER_REHEARSAL_PG17_IMAGE !==
      LIVE_CATALOG_PG17_IMAGE ||
    Object.hasOwn(capture[0], "uses") ||
    capture[0]["continue-on-error"] !== undefined ||
    capture[0].run !== expectedCaptureRun ||
    upload[0].if !== "${{ inputs.activation_catalog_policy_capture }}" ||
    upload[0].uses !==
      "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02" ||
    Object.hasOwn(upload[0], "run") ||
    upload[0]["continue-on-error"] !== undefined ||
    upload[0].with?.name !==
      "activation-catalog-policy-${{ github.sha }}-${{ github.run_attempt }}" ||
    upload[0].with?.path !==
      "activation-catalog-policy-candidate-1.json\nactivation-catalog-policy-candidate-2.json\nlive-catalog-successful-capture-evidence.json\n" ||
    upload[0].with?.["if-no-files-found"] !== "error" ||
    upload[0].with?.["retention-days"] !== 14 ||
    !plain([...producerPath, steps.indexOf(upload[0]), "name"]) ||
    !plain([...producerPath, steps.indexOf(upload[0]), "if"]) ||
    !plain([...producerPath, steps.indexOf(upload[0]), "uses"]) ||
    !plain([...producerPath, steps.indexOf(upload[0]), "with", "name"]) ||
    !plain([
      ...producerPath,
      steps.indexOf(upload[0]),
      "with",
      "if-no-files-found",
    ]) ||
    !plain([
      ...producerPath,
      steps.indexOf(upload[0]),
      "with",
      "retention-days",
    ]) ||
    document.getIn(
      [
        "jobs",
        "private-pg16-to-pg17-rehearsal",
        "steps",
        steps.indexOf(capture[0]),
        "run",
      ],
      true,
    )?.type !== "BLOCK_LITERAL" ||
    document.getIn(
      [
        "jobs",
        "private-pg16-to-pg17-rehearsal",
        "steps",
        steps.indexOf(upload[0]),
        "with",
        "path",
      ],
      true,
    )?.type !== "BLOCK_LITERAL"
  )
    throw new Error("live_catalog_source_workflow_producer_invalid");
}

function candidateFacts(name, bytes) {
  const value = Buffer.from(bytes);
  if (value.length === 0) throw new Error("live_catalog_candidate_empty");
  parsePrivatePg17ActivationCatalogPolicyArtifactBytes(value);
  return Object.freeze({ name, size: value.length, sha256: sha256Hex(value) });
}

function captureEvidenceFacts(
  bytes,
  candidates,
  projectionBytes,
  configuredDigest,
  runId,
  runAttempt,
) {
  let evidence;
  try {
    evidence = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error("live_catalog_capture_evidence_not_json");
  }
  exactKeys(
    evidence,
    ["kind", "version", "observedCatalogDigest", "projection", "inputs"],
    "capture_evidence",
  );
  exactKeys(
    evidence.projection,
    ["path", "export", "sqlSha256"],
    "capture_projection",
  );
  if (!Array.isArray(evidence.inputs) || evidence.inputs.length !== 2)
    throw new Error("live_catalog_capture_inputs_invalid");
  evidence.inputs.forEach((input, index) => {
    exactKeys(
      input,
      [
        "disposableDatabaseIdentity",
        "candidateName",
        "candidateSize",
        "candidateSha256",
        "receiptCatalogDigest",
      ],
      "capture_input",
    );
    if (
      !/^rr-disposable-[a-z0-9][a-z0-9._-]{7,127}$/u.test(
        input.disposableDatabaseIdentity ?? "",
      ) ||
      !input.disposableDatabaseIdentity.endsWith(index === 0 ? "-a" : "-b") ||
      input.disposableDatabaseIdentity !==
        `rr-disposable-${runId}-${runAttempt}-${index === 0 ? "a" : "b"}` ||
      input.candidateName !== candidates[index].name ||
      input.candidateSize !== candidates[index].size ||
      input.candidateSha256 !== candidates[index].sha256 ||
      input.receiptCatalogDigest !== configuredDigest
    )
      throw new Error("live_catalog_capture_input_tuple_invalid");
  });
  if (
    evidence.kind !== "reviewrouter-live-catalog-successful-capture-evidence" ||
    evidence.version !== 1 ||
    evidence.observedCatalogDigest !== configuredDigest ||
    evidence.projection.path !== LIVE_CATALOG_PROJECTION_PATH ||
    evidence.projection.export !== LIVE_CATALOG_PROJECTION_EXPORT ||
    evidence.projection.sqlSha256 !== sha256Hex(projectionBytes)
  )
    throw new Error("live_catalog_capture_evidence_tuple_invalid");
  return Object.freeze({
    size: Buffer.byteLength(bytes),
    sha256: sha256Hex(bytes),
    observedCatalogDigest: evidence.observedCatalogDigest,
    projectionSqlSha256: evidence.projection.sqlSha256,
    inputs: evidence.inputs.map((input) => Object.freeze({ ...input })),
  });
}

function githubHostedJob(job, label) {
  if (
    job.runnerGroupId !== 0 ||
    job.runnerGroupName !== "GitHub Actions" ||
    !/^GitHub Actions [1-9][0-9]*$/u.test(job.runnerName ?? "") ||
    JSON.stringify(job.labels) !== JSON.stringify(["ubuntu-24.04"])
  )
    throw new Error(`live_catalog_${label}_runner_tuple_invalid`);
  return {
    id: String(integer(job.id, `${label}_id`)),
    name: job.name,
    conclusion: job.conclusion,
    runnerGroupId: job.runnerGroupId,
    runnerGroupName: job.runnerGroupName,
    runnerName: job.runnerName,
    labels: [...job.labels],
  };
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
  if (input.sourceRef !== input.sourceCommit || input.sourceBranch !== "main")
    throw new Error("live_catalog_source_ref_invalid");
  if (input.sourceWorkflowPath !== LIVE_CATALOG_SOURCE_WORKFLOW)
    throw new Error("live_catalog_source_workflow_mismatch");
  if (input.sourceEvent !== "workflow_dispatch")
    throw new Error("live_catalog_source_event_mismatch");
  if (
    input.sourceStatus !== "completed" ||
    input.sourceConclusion !== "success"
  )
    throw new Error("live_catalog_source_run_not_successful");
  if (
    input.producerJob.name !== "Full private PG16 to PG17 rehearsal" ||
    input.producerJob.status !== "completed" ||
    input.producerJob.conclusion !== "success"
  )
    throw new Error("live_catalog_producer_job_mismatch");
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

  const projectionBytes = extractProjectionBytes(input.projectionSourceBytes);
  const configuredDigest = extractConfiguredCatalogDigest(
    input.projectionSourceBytes,
  );
  const captureEvidence = captureEvidenceFacts(
    input.captureEvidenceBytes,
    candidates,
    projectionBytes,
    configuredDigest,
    input.runId,
    input.runAttempt,
  );
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
      status: input.sourceStatus,
      conclusion: input.sourceConclusion,
      producerJob: {
        ...githubHostedJob(input.producerJob, "producer_job"),
        status: input.producerJob.status,
      },
      runnerEnvironment: input.runnerEnvironment,
    },
    artifact: {
      id: String(integer(input.artifactId, "artifact_id")),
      name: string(input.artifactName, "artifact_name", /^[A-Za-z0-9_.-]+$/u),
      archiveSha256: string(input.archiveSha256, "archive_sha256", shaPattern),
      candidates,
      captureEvidence,
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
    observedCatalogDigest: captureEvidence.observedCatalogDigest,
    candidateToObservedDigest: candidateToObservedDigest(
      candidates,
      captureEvidence.observedCatalogDigest,
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
      "status",
      "conclusion",
      "producerJob",
      "runnerEnvironment",
    ],
    "execution",
  );
  exactKeys(
    claim.artifact,
    ["id", "name", "archiveSha256", "candidates", "captureEvidence"],
    "artifact",
  );
  exactKeys(
    claim.execution.producerJob,
    [
      "id",
      "name",
      "conclusion",
      "status",
      "runnerGroupId",
      "runnerGroupName",
      "runnerName",
      "labels",
    ],
    "producer_job",
  );
  exactKeys(
    claim.artifact.captureEvidence,
    [
      "size",
      "sha256",
      "observedCatalogDigest",
      "projectionSqlSha256",
      "inputs",
    ],
    "capture_evidence_facts",
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
  if (
    !Array.isArray(claim.artifact.candidates) ||
    !Array.isArray(claim.artifact.captureEvidence.inputs)
  )
    throw new Error("live_catalog_claim_candidate_tuple_mismatch");
  for (const input of claim.artifact.captureEvidence.inputs)
    exactKeys(
      input,
      [
        "disposableDatabaseIdentity",
        "candidateName",
        "candidateSize",
        "candidateSha256",
        "receiptCatalogDigest",
      ],
      "capture_input",
    );
  for (const candidate of claim.artifact.candidates)
    exactKeys(candidate, ["name", "size", "sha256"], "candidate");
  if (
    !/^[1-9][0-9]*$/u.test(claim.repository.id) ||
    !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/u.test(claim.repository.name) ||
    !commitPattern.test(claim.source.commit) ||
    !commitPattern.test(claim.source.tree) ||
    claim.source.ref !== claim.source.commit ||
    claim.source.branch !== "main" ||
    claim.execution.runAttempt !== 1 ||
    claim.execution.workflowPath !== LIVE_CATALOG_SOURCE_WORKFLOW ||
    claim.execution.event !== "workflow_dispatch" ||
    claim.execution.status !== "completed" ||
    claim.execution.conclusion !== "success" ||
    !/^[1-9][0-9]*$/u.test(claim.execution.runId) ||
    !/^[1-9][0-9]*$/u.test(claim.execution.producerJob.id) ||
    claim.execution.producerJob.name !==
      "Full private PG16 to PG17 rehearsal" ||
    claim.execution.producerJob.status !== "completed" ||
    claim.execution.producerJob.conclusion !== "success" ||
    claim.execution.producerJob.runnerGroupId !== 0 ||
    claim.execution.producerJob.runnerGroupName !== "GitHub Actions" ||
    !/^GitHub Actions [1-9][0-9]*$/u.test(
      claim.execution.producerJob.runnerName,
    ) ||
    JSON.stringify(claim.execution.producerJob.labels) !==
      JSON.stringify(["ubuntu-24.04"]) ||
    claim.execution.runnerEnvironment !== "github-hosted" ||
    !/^[1-9][0-9]*$/u.test(claim.artifact.id) ||
    claim.artifact.name !==
      `activation-catalog-policy-${claim.source.commit}-1` ||
    !shaPattern.test(claim.artifact.archiveSha256) ||
    !Number.isSafeInteger(claim.artifact.captureEvidence.size) ||
    claim.artifact.captureEvidence.size <= 0 ||
    !shaPattern.test(claim.artifact.captureEvidence.sha256) ||
    claim.artifact.captureEvidence.observedCatalogDigest !==
      claim.observedCatalogDigest ||
    claim.artifact.captureEvidence.projectionSqlSha256 !==
      claim.sources.projection.sha256 ||
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
    claim.observedCatalogDigest !== claim.sources.projection.configuredDigest ||
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
    claim.artifact.candidates[0].size !== claim.artifact.candidates[1].size ||
    claim.artifact.captureEvidence.inputs.length !== 2 ||
    claim.artifact.captureEvidence.inputs.some(
      (input, index) =>
        !/^rr-disposable-[a-z0-9][a-z0-9._-]{7,127}$/u.test(
          input.disposableDatabaseIdentity,
        ) ||
        !input.disposableDatabaseIdentity.endsWith(index === 0 ? "-a" : "-b") ||
        input.disposableDatabaseIdentity !==
          `rr-disposable-${claim.execution.runId}-${claim.execution.runAttempt}-${index === 0 ? "a" : "b"}` ||
        input.candidateName !== claim.artifact.candidates[index].name ||
        input.candidateSize !== claim.artifact.candidates[index].size ||
        input.candidateSha256 !== claim.artifact.candidates[index].sha256 ||
        input.receiptCatalogDigest !== claim.observedCatalogDigest,
    )
  )
    throw new Error("live_catalog_claim_candidate_tuple_mismatch");
  return claim;
}

export function claimFingerprint(claim) {
  validateLiveCatalogClaim(claim);
  return sha256Digest(Buffer.from(canonicalJson(claim)));
}
