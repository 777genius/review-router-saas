import { createHash } from "node:crypto";
import { posix } from "node:path";
import { isDeepStrictEqual } from "node:util";
import ts from "typescript";
import { parseDocument } from "yaml";
import { parsePrivatePg17ActivationCatalogPolicyArtifactBytes } from "../capture-private-pg17-activation-catalog-policy.mjs";

export const LIVE_CATALOG_CLAIM_SCHEMA =
  "reviewrouter.live-catalog-provenance.v3";
export const LIVE_CATALOG_WORKFLOW =
  ".github/workflows/attest-live-catalog-digest.yml";
export const LIVE_CATALOG_SOURCE_WORKFLOW =
  ".github/workflows/capture-live-catalog.yml";
export const LIVE_CATALOG_PRODUCER_JOB_NAME = "Capture live catalog producer";
export const LIVE_CATALOG_CONTRACT_PATH =
  "scripts/lib/live-catalog-capture-contract.mjs";
export const LIVE_CATALOG_PROJECTION_PATH =
  "packages/features/release-rollout/src/adapters/live-v70-v72-catalog-digest.mjs";
export const LIVE_CATALOG_PROJECTION_EXPORT =
  "fencedLiveV70V73CatalogDigestSql";
export const LIVE_CATALOG_EXPECTED_DIGEST_EXPORT =
  "liveV70V73CatalogDigestSha256";
export const LIVE_CATALOG_PG17_IMAGE =
  "postgres:17.5-bookworm@sha256:fbcea1bd13b6a882cd6caa6b58db3ae5c102efe50ec625b3e2a5cbc50db5bfe4";

const commitPattern = /^[a-f0-9]{40}$/u;
const shaPattern = /^[a-f0-9]{64}$/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const checkoutPin = "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803";
const setupNodePin =
  "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020";
const uploadPin =
  "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02";
const attestPin =
  "actions/attest-build-provenance@e8998f949152b193b063cb0ec769d69d929409be";

export const sha256Hex = (value) =>
  createHash("sha256").update(value).digest("hex");
export const sha256Digest = (value) => `sha256:${sha256Hex(value)}`;
const gitBlobShaHex = (value) => {
  const bytes = Buffer.from(value);
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
};

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
    !isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())
  )
    throw new Error(`live_catalog_${label}_shape_invalid`);
}

function positiveInteger(value, label) {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`live_catalog_${label}_invalid`);
  return parsed;
}

function exportedLiteral(sourceBytes, exportName, label = "projection") {
  const source = ts.createSourceFile(
    `${label}.mjs`,
    Buffer.from(sourceBytes).toString("utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  if (source.parseDiagnostics.length)
    throw new Error(`live_catalog_${label}_source_syntax_invalid`);
  const matches = [];
  const declaresName = (name) => {
    if (ts.isIdentifier(name)) return name.text === exportName;
    if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name))
      return name.elements.some(
        (element) => ts.isBindingElement(element) && declaresName(element.name),
      );
    return false;
  };
  for (const statement of source.statements) {
    const exported = (statement.modifiers ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (
      exported &&
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isModuleDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name?.text === exportName
    )
      matches.push(undefined);
    if (exported && ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations)
        if (declaresName(declaration.name))
          matches.push(
            statement.declarationList.flags & ts.NodeFlags.Const
              ? declaration.initializer
              : undefined,
          );
    if (
      ts.isExportAssignment(statement) ||
      (ts.isExportDeclaration(statement) &&
        (!statement.exportClause ||
          (ts.isNamedExports(statement.exportClause) &&
            statement.exportClause.elements.some(
              (element) =>
                element.name.text === exportName ||
                element.propertyName?.text === exportName,
            ))))
    )
      matches.push(undefined);
  }
  if (matches.length !== 1 || !matches[0])
    throw new Error(`live_catalog_${label}_export_missing_or_ambiguous`);
  return matches[0];
}

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
  if (!ts.isStringLiteral(initializer) || !digestPattern.test(initializer.text))
    throw new Error("live_catalog_expected_digest_export_invalid");
  return initializer.text;
}

export function assertLiveCatalogCaptureContract(sourceBytes) {
  const text = Buffer.from(sourceBytes).toString("utf8");
  const source = ts.createSourceFile(
    LIVE_CATALOG_CONTRACT_PATH,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  if (source.parseDiagnostics.length)
    throw new Error("live_catalog_contract_source_syntax_invalid");
  const exports = source.statements.filter(
    (statement) =>
      ts.isExportDeclaration(statement) ||
      ts.isExportAssignment(statement) ||
      (statement.modifiers ?? []).some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      ),
  );
  if (
    exports.length !== 1 ||
    !ts.isFunctionDeclaration(exports[0]) ||
    exports[0].name?.text !== "captureSuccessfulLiveCatalogContract" ||
    !text.includes(`"${LIVE_CATALOG_PROJECTION_PATH}"`) ||
    !text.includes(`"${LIVE_CATALOG_PROJECTION_EXPORT}"`) ||
    !text.includes("migrationReceipt?.postCatalogDigest") ||
    !text.includes("runProjection(") ||
    !text.includes(
      "observedCatalogDigest !== migrationReceipt.postCatalogDigest",
    )
  )
    throw new Error("live_catalog_contract_semantics_invalid");
}

const expectedCaptureRun = `export REVIEW_ROUTER_ACTIVATION_CATALOG_DISPOSABLE_DATABASE_IDENTITY="rr-disposable-\${GITHUB_RUN_ID}-\${GITHUB_RUN_ATTEMPT}-a"
node --import tsx scripts/rehearse-private-pg17-rollout.mjs > activation-catalog-capture-result-1.json
export REVIEW_ROUTER_ACTIVATION_CATALOG_DISPOSABLE_DATABASE_IDENTITY="rr-disposable-\${GITHUB_RUN_ID}-\${GITHUB_RUN_ATTEMPT}-b"
node --import tsx scripts/rehearse-private-pg17-rollout.mjs > activation-catalog-capture-result-2.json
`;
const expectedPackageRun = `node --import tsx scripts/package-live-catalog-capture-evidence.mjs activation-catalog-capture-result-1.json activation-catalog-capture-result-2.json
cmp activation-catalog-policy-candidate-1.json activation-catalog-policy-candidate-2.json
sha256sum activation-catalog-policy-candidate-1.json activation-catalog-policy-candidate-2.json live-catalog-successful-capture-evidence.json
`;

export function assertSourceWorkflowPg17Image(sourceBytes) {
  const document = parseDocument(Buffer.from(sourceBytes).toString("utf8"), {
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length)
    throw new Error("live_catalog_source_workflow_yaml_invalid");
  const workflow = document.toJS({ maxAliasCount: 0 });
  const expected = {
    name: "Capture live catalog",
    on: { workflow_dispatch: null },
    permissions: { contents: "read" },
    jobs: {
      producer: {
        name: LIVE_CATALOG_PRODUCER_JOB_NAME,
        "runs-on": "ubuntu-24.04",
        "timeout-minutes": 30,
        permissions: {
          contents: "read",
          "id-token": "write",
          attestations: "write",
        },
        steps: [
          {
            name: "Checkout exact producer commit",
            uses: checkoutPin,
            with: { "persist-credentials": false, ref: "${{ github.sha }}" },
          },
          {
            name: "Set up Node",
            uses: setupNodePin,
            with: { "node-version": "24" },
          },
          { name: "Enable pinned pnpm", run: "corepack enable pnpm" },
          {
            name: "Install frozen dependencies",
            env: {
              SUBSCRIPTION_RUNTIME_DEPLOY_KEY_B64:
                "${{ secrets.SUBSCRIPTION_RUNTIME_DEPLOY_KEY_B64 }}",
            },
            run: "node scripts/install-private-dependencies.mjs --frozen-lockfile",
          },
          { name: "Generate Prisma client", run: "pnpm db:generate" },
          {
            name: "Migrate and capture twice",
            env: {
              REVIEW_ROUTER_PRIVATE_PG17_REHEARSAL: "1",
              REVIEW_ROUTER_PRIVATE_PG17_ACTIVATION_CATALOG_POLICY_CAPTURE_ONLY:
                "1",
              REVIEW_ROUTER_REHEARSAL_PG16_IMAGE:
                "postgres:16.13-bookworm@sha256:472efd9a66f2b2f1a5aeb18b28de74332e6ef88c2b93a1a5d812fb6db67a5f60",
              REVIEW_ROUTER_REHEARSAL_PG17_IMAGE: LIVE_CATALOG_PG17_IMAGE,
            },
            run: expectedCaptureRun,
          },
          { name: "Package immutable capture", run: expectedPackageRun },
          {
            name: "Upload immutable capture",
            id: "upload",
            uses: uploadPin,
            with: {
              name: "activation-catalog-policy-${{ github.sha }}-${{ github.run_attempt }}",
              path: "activation-catalog-policy-candidate-1.json\nactivation-catalog-policy-candidate-2.json\nlive-catalog-successful-capture-evidence.json\n",
              "if-no-files-found": "error",
              "retention-days": 14,
              "compression-level": 0,
              overwrite: false,
              "include-hidden-files": false,
            },
          },
          {
            name: "Attest uploaded capture digest",
            uses: attestPin,
            with: {
              "subject-name":
                "activation-catalog-policy-${{ github.sha }}-${{ github.run_attempt }}",
              "subject-digest":
                "sha256:${{ steps.upload.outputs.artifact-digest }}",
            },
          },
        ],
      },
    },
  };
  if (canonicalJson(workflow) !== canonicalJson(expected))
    throw new Error("live_catalog_source_workflow_producer_invalid");
}

function candidateFacts(name, bytes) {
  const value = Buffer.from(bytes);
  parsePrivatePg17ActivationCatalogPolicyArtifactBytes(value);
  return Object.freeze({ name, size: value.length, sha256: sha256Hex(value) });
}

function captureEvidenceFacts(
  bytes,
  candidates,
  projectionBytes,
  digest,
  runId,
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
  evidence.inputs.forEach((entry, index) => {
    exactKeys(
      entry,
      [
        "disposableDatabaseIdentity",
        "candidateName",
        "candidateSize",
        "candidateSha256",
        "receiptCatalogDigest",
      ],
      "capture_input",
    );
    const suffix = index ? "b" : "a";
    if (
      entry.disposableDatabaseIdentity !==
        `rr-disposable-${runId}-1-${suffix}` ||
      entry.candidateName !== candidates[index].name ||
      entry.candidateSize !== candidates[index].size ||
      entry.candidateSha256 !== candidates[index].sha256 ||
      entry.receiptCatalogDigest !== digest
    )
      throw new Error("live_catalog_capture_input_tuple_invalid");
  });
  if (
    evidence.kind !== "reviewrouter-live-catalog-successful-capture-evidence" ||
    evidence.version !== 1 ||
    evidence.observedCatalogDigest !== digest ||
    evidence.projection.path !== LIVE_CATALOG_PROJECTION_PATH ||
    evidence.projection.export !== LIVE_CATALOG_PROJECTION_EXPORT ||
    evidence.projection.sqlSha256 !== sha256Hex(projectionBytes)
  )
    throw new Error("live_catalog_capture_evidence_tuple_invalid");
  return Object.freeze({
    size: Buffer.byteLength(bytes),
    sha256: sha256Hex(bytes),
    observedCatalogDigest: digest,
    projectionSqlSha256: evidence.projection.sqlSha256,
    inputs: evidence.inputs.map((entry) => Object.freeze({ ...entry })),
  });
}

export function sourceClosureFacts(files) {
  if (!Array.isArray(files) || !files.length)
    throw new Error("live_catalog_source_closure_empty");
  const paths = new Set();
  const entries = files
    .map((file) => {
      const bytes = Buffer.from(file.bytes);
      if (
        typeof file.path !== "string" ||
        file.path.startsWith("/") ||
        file.path.includes("..") ||
        paths.has(file.path) ||
        !commitPattern.test(file.gitBlobSha ?? "") ||
        file.gitBlobSha !== gitBlobShaHex(bytes) ||
        file.size !== bytes.length ||
        file.sha256 !== sha256Hex(bytes)
      )
        throw new Error("live_catalog_source_closure_entry_invalid");
      paths.add(file.path);
      return Object.freeze({
        path: file.path,
        gitBlobSha: file.gitBlobSha,
        size: bytes.length,
        sha256: file.sha256,
      });
    })
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
  const digest = sourceClosureDigest(entries);
  return Object.freeze({ digest, entries });
}

function sourceClosureDigest(entries) {
  return sha256Digest(
    Buffer.from(
      canonicalJson({
        domain: "reviewrouter.live-catalog.source-closure.v1",
        entries,
      }),
    ),
  );
}

export function candidateToObservedDigest(candidates, observedDigest) {
  return sha256Digest(
    Buffer.from(
      canonicalJson({
        domain: "reviewrouter.live-catalog.candidates-to-observation.v1",
        candidates,
        observedDigest,
      }),
    ),
  );
}

function validateCertificate(certificate, source, execution, repository) {
  exactKeys(
    certificate,
    [
      "repository",
      "signerWorkflow",
      "signerDigest",
      "sourceRef",
      "sourceDigest",
      "runnerEnvironment",
      "runInvocationURI",
    ],
    "producer_certificate",
  );
  if (
    certificate.repository !== repository.name ||
    certificate.signerWorkflow !==
      `${repository.name}/${LIVE_CATALOG_SOURCE_WORKFLOW}` ||
    certificate.signerDigest !== source.commit ||
    certificate.sourceRef !== "refs/heads/main" ||
    certificate.sourceDigest !== source.commit ||
    certificate.runnerEnvironment !== "github-hosted" ||
    certificate.runInvocationURI !==
      `https://github.com/${repository.name}/actions/runs/${execution.runId}/attempts/1`
  )
    throw new Error("live_catalog_producer_certificate_tuple_mismatch");
}

export function assembleLiveCatalogClaim(input) {
  if (
    input.sourceCommit !== input.attestorCommit ||
    input.sourceRef !== input.sourceCommit ||
    input.sourceBranch !== "main" ||
    input.runAttempt !== 1 ||
    input.sourceWorkflowPath !== LIVE_CATALOG_SOURCE_WORKFLOW ||
    input.sourceEvent !== "workflow_dispatch" ||
    input.sourceStatus !== "completed" ||
    input.sourceConclusion !== "success" ||
    input.producerJob.name !== LIVE_CATALOG_PRODUCER_JOB_NAME ||
    input.producerJob.status !== "completed" ||
    input.producerJob.conclusion !== "success" ||
    input.runnerEnvironment !== "github-hosted" ||
    input.pg17Image !== LIVE_CATALOG_PG17_IMAGE ||
    input.attestorRef !== "refs/heads/main" ||
    input.attestorRunAttempt !== 1 ||
    input.attestorRunner !== "ubuntu-24.04" ||
    input.attestorEnvironment !== "production-release"
  )
    throw new Error("live_catalog_execution_tuple_invalid");
  assertSourceWorkflowPg17Image(input.workflowSourceBytes);
  assertLiveCatalogCaptureContract(input.contractSourceBytes);
  const projectionBytes = extractProjectionBytes(input.projectionSourceBytes);
  const configuredDigest = extractConfiguredCatalogDigest(
    input.projectionSourceBytes,
  );
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
  const captureEvidence = captureEvidenceFacts(
    input.captureEvidenceBytes,
    candidates,
    projectionBytes,
    configuredDigest,
    input.runId,
  );
  const closure = sourceClosureFacts(input.sourceClosureFiles);
  const repository = {
    id: String(positiveInteger(input.repositoryId, "repository_id")),
    name: String(input.repositoryName).toLowerCase(),
  };
  const source = {
    commit: input.sourceCommit,
    tree: input.sourceTree,
    ref: input.sourceRef,
    branch: input.sourceBranch,
  };
  const execution = {
    runId: String(positiveInteger(input.runId, "run_id")),
    runAttempt: input.runAttempt,
    workflowPath: input.sourceWorkflowPath,
    event: input.sourceEvent,
    status: input.sourceStatus,
    conclusion: input.sourceConclusion,
    producerJob: {
      id: String(positiveInteger(input.producerJob.id, "producer_job_id")),
      name: input.producerJob.name,
      status: input.producerJob.status,
      conclusion: input.producerJob.conclusion,
      runnerGroupId: input.producerJob.runnerGroupId,
      runnerGroupName: input.producerJob.runnerGroupName,
      runnerName: input.producerJob.runnerName,
      labels: [...input.producerJob.labels],
    },
    runnerEnvironment: input.runnerEnvironment,
  };
  validateCertificate(input.producerCertificate, source, execution, repository);
  if (
    input.artifactRestDigest !== `sha256:${input.archiveSha256}` ||
    input.producerSubject.name !== input.artifactName ||
    input.producerSubject.digest !== input.artifactRestDigest
  )
    throw new Error("live_catalog_archive_digest_convergence_failed");
  const claim = {
    schemaVersion: LIVE_CATALOG_CLAIM_SCHEMA,
    repository,
    source,
    execution,
    artifact: {
      id: String(positiveInteger(input.artifactId, "artifact_id")),
      name: input.artifactName,
      restDigest: input.artifactRestDigest,
      archiveSha256: input.archiveSha256,
      candidates,
      captureEvidence,
    },
    producerAttestation: {
      certificate: { ...input.producerCertificate },
      subject: { ...input.producerSubject },
      bundleSha256: sha256Hex(input.producerBundleBytes),
    },
    sourceClosure: closure,
    sources: {
      workflow: LIVE_CATALOG_SOURCE_WORKFLOW,
      contract: LIVE_CATALOG_CONTRACT_PATH,
      projection: {
        path: LIVE_CATALOG_PROJECTION_PATH,
        export: LIVE_CATALOG_PROJECTION_EXPORT,
        configuredDigestExport: LIVE_CATALOG_EXPECTED_DIGEST_EXPORT,
        configuredDigest,
        sqlSha256: sha256Hex(projectionBytes),
      },
    },
    pg17Image: input.pg17Image,
    observedCatalogDigest: configuredDigest,
    candidateToObservedDigest: candidateToObservedDigest(
      candidates,
      configuredDigest,
    ),
    attestor: {
      workflowPath: LIVE_CATALOG_WORKFLOW,
      ref: input.attestorRef,
      commit: input.attestorCommit,
      tree: input.sourceTree,
      runId: String(positiveInteger(input.attestorRunId, "attestor_run_id")),
      runAttempt: input.attestorRunAttempt,
      runner: input.attestorRunner,
      environment: input.attestorEnvironment,
    },
  };
  return Object.freeze(validateLiveCatalogClaim(claim));
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
      "producerAttestation",
      "sourceClosure",
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
    claim.execution.producerJob,
    [
      "id",
      "name",
      "status",
      "conclusion",
      "runnerGroupId",
      "runnerGroupName",
      "runnerName",
      "labels",
    ],
    "producer_job",
  );
  exactKeys(
    claim.artifact,
    [
      "id",
      "name",
      "restDigest",
      "archiveSha256",
      "candidates",
      "captureEvidence",
    ],
    "artifact",
  );
  exactKeys(
    claim.producerAttestation,
    ["certificate", "subject", "bundleSha256"],
    "producer_attestation",
  );
  exactKeys(
    claim.producerAttestation.subject,
    ["name", "digest"],
    "producer_subject",
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
  if (
    !Array.isArray(claim.artifact.candidates) ||
    !Array.isArray(claim.artifact.captureEvidence.inputs)
  )
    throw new Error("live_catalog_claim_candidate_tuple_mismatch");
  for (const candidate of claim.artifact.candidates)
    exactKeys(candidate, ["name", "size", "sha256"], "candidate");
  for (const entry of claim.artifact.captureEvidence.inputs)
    exactKeys(
      entry,
      [
        "disposableDatabaseIdentity",
        "candidateName",
        "candidateSize",
        "candidateSha256",
        "receiptCatalogDigest",
      ],
      "capture_input",
    );
  exactKeys(claim.sourceClosure, ["digest", "entries"], "source_closure");
  exactKeys(claim.sources, ["workflow", "contract", "projection"], "sources");
  exactKeys(
    claim.sources.projection,
    [
      "path",
      "export",
      "configuredDigestExport",
      "configuredDigest",
      "sqlSha256",
    ],
    "projection_source",
  );
  exactKeys(
    claim.attestor,
    [
      "workflowPath",
      "ref",
      "commit",
      "tree",
      "runId",
      "runAttempt",
      "runner",
      "environment",
    ],
    "attestor",
  );
  validateCertificate(
    claim.producerAttestation.certificate,
    claim.source,
    claim.execution,
    claim.repository,
  );
  let previousClosurePath = "";
  for (const entry of claim.sourceClosure.entries ?? []) {
    exactKeys(
      entry,
      ["path", "gitBlobSha", "size", "sha256"],
      "source_closure_entry",
    );
    if (
      typeof entry.path !== "string" ||
      (previousClosurePath &&
        entry.path.localeCompare(previousClosurePath, "en") <= 0) ||
      entry.path.startsWith("/") ||
      entry.path.includes("..") ||
      !commitPattern.test(entry.gitBlobSha) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      !shaPattern.test(entry.sha256)
    )
      throw new Error("live_catalog_source_closure_entry_invalid");
    previousClosurePath = entry.path;
  }
  const job = claim.execution.producerJob;
  if (
    !/^[1-9][0-9]*$/u.test(claim.repository.id) ||
    !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/u.test(claim.repository.name) ||
    !commitPattern.test(claim.source.commit) ||
    !commitPattern.test(claim.source.tree) ||
    claim.source.commit !== claim.attestor.commit ||
    claim.source.tree !== claim.attestor.tree ||
    claim.source.ref !== claim.source.commit ||
    claim.source.branch !== "main" ||
    claim.execution.workflowPath !== LIVE_CATALOG_SOURCE_WORKFLOW ||
    !/^[1-9][0-9]*$/u.test(claim.execution.runId) ||
    claim.execution.runAttempt !== 1 ||
    claim.execution.event !== "workflow_dispatch" ||
    claim.execution.status !== "completed" ||
    claim.execution.conclusion !== "success" ||
    job.name !== LIVE_CATALOG_PRODUCER_JOB_NAME ||
    !/^[1-9][0-9]*$/u.test(job.id) ||
    job.status !== "completed" ||
    job.conclusion !== "success" ||
    job.runnerGroupId !== 0 ||
    job.runnerGroupName !== "GitHub Actions" ||
    !/^GitHub Actions [1-9][0-9]*$/u.test(job.runnerName) ||
    !isDeepStrictEqual(job.labels, ["ubuntu-24.04"]) ||
    claim.execution.runnerEnvironment !== "github-hosted" ||
    !/^[1-9][0-9]*$/u.test(claim.artifact.id) ||
    claim.artifact.name !==
      `activation-catalog-policy-${claim.source.commit}-1` ||
    claim.artifact.restDigest !== `sha256:${claim.artifact.archiveSha256}` ||
    !shaPattern.test(claim.artifact.archiveSha256) ||
    !digestPattern.test(claim.artifact.restDigest) ||
    !Number.isSafeInteger(claim.artifact.captureEvidence.size) ||
    claim.artifact.captureEvidence.size <= 0 ||
    !shaPattern.test(claim.artifact.captureEvidence.sha256) ||
    claim.artifact.captureEvidence.observedCatalogDigest !==
      claim.observedCatalogDigest ||
    claim.artifact.captureEvidence.projectionSqlSha256 !==
      claim.sources.projection.sqlSha256 ||
    claim.producerAttestation.subject.name !== claim.artifact.name ||
    claim.producerAttestation.subject.digest !== claim.artifact.restDigest ||
    !shaPattern.test(claim.producerAttestation.bundleSha256) ||
    !digestPattern.test(claim.sourceClosure.digest) ||
    !Array.isArray(claim.sourceClosure.entries) ||
    !claim.sourceClosure.entries.length ||
    claim.sourceClosure.digest !==
      sourceClosureDigest(claim.sourceClosure.entries) ||
    claim.sources.workflow !== LIVE_CATALOG_SOURCE_WORKFLOW ||
    claim.sources.contract !== LIVE_CATALOG_CONTRACT_PATH ||
    claim.sources.projection.path !== LIVE_CATALOG_PROJECTION_PATH ||
    claim.sources.projection.export !== LIVE_CATALOG_PROJECTION_EXPORT ||
    claim.sources.projection.configuredDigestExport !==
      LIVE_CATALOG_EXPECTED_DIGEST_EXPORT ||
    claim.sources.projection.configuredDigest !== claim.observedCatalogDigest ||
    !shaPattern.test(claim.sources.projection.sqlSha256) ||
    claim.pg17Image !== LIVE_CATALOG_PG17_IMAGE ||
    !digestPattern.test(claim.observedCatalogDigest) ||
    claim.attestor.workflowPath !== LIVE_CATALOG_WORKFLOW ||
    claim.attestor.ref !== "refs/heads/main" ||
    !commitPattern.test(claim.attestor.tree) ||
    !/^[1-9][0-9]*$/u.test(claim.attestor.runId) ||
    claim.attestor.runAttempt !== 1 ||
    claim.attestor.runner !== "ubuntu-24.04" ||
    claim.attestor.environment !== "production-release"
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
    claim.artifact.candidates[0].size !== claim.artifact.candidates[1].size ||
    !shaPattern.test(claim.artifact.candidates[0].sha256) ||
    claim.artifact.candidates[0].sha256 !==
      claim.artifact.candidates[1].sha256 ||
    claim.artifact.captureEvidence.inputs.length !== 2 ||
    claim.artifact.captureEvidence.inputs.some(
      (entry, index) =>
        entry.disposableDatabaseIdentity !==
          `rr-disposable-${claim.execution.runId}-1-${index ? "b" : "a"}` ||
        entry.candidateName !== claim.artifact.candidates[index].name ||
        entry.candidateSize !== claim.artifact.candidates[index].size ||
        entry.candidateSha256 !== claim.artifact.candidates[index].sha256 ||
        entry.receiptCatalogDigest !== claim.observedCatalogDigest,
    )
  )
    throw new Error("live_catalog_claim_candidate_tuple_mismatch");
  if (
    claim.candidateToObservedDigest !==
    candidateToObservedDigest(
      claim.artifact.candidates,
      claim.observedCatalogDigest,
    )
  )
    throw new Error("live_catalog_claim_candidate_tuple_mismatch");
  return claim;
}

export function claimFingerprint(claim) {
  validateLiveCatalogClaim(claim);
  return sha256Digest(Buffer.from(canonicalJson(claim)));
}

export function assertLiveCatalogClaimAtProtectedMain(
  claim,
  expectedMainCommit,
) {
  validateLiveCatalogClaim(claim);
  if (
    !commitPattern.test(expectedMainCommit ?? "") ||
    claim.source.commit !== expectedMainCommit ||
    claim.attestor.commit !== expectedMainCommit
  )
    throw new Error("live_catalog_claim_stale_protected_main");
}

export function localImportSpecifiers(path, bytes) {
  if (!/\.(?:[cm]?[jt]s|tsx?)$/u.test(path)) return [];
  const source = ts.createSourceFile(
    path,
    Buffer.from(bytes).toString("utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  if (source.parseDiagnostics.length)
    throw new Error("live_catalog_source_closure_syntax_invalid");
  const specifiers = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    ) {
      if (!ts.isStringLiteral(node.moduleSpecifier))
        throw new Error("live_catalog_source_closure_dynamic_import_denied");
      if (node.moduleSpecifier.text.startsWith("."))
        specifiers.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0]))
        throw new Error("live_catalog_source_closure_dynamic_import_denied");
      if (node.arguments[0].text.startsWith("."))
        specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...new Set(specifiers)].sort();
}

export function resolveLocalImport(importer, specifier, paths) {
  const base = posix.normalize(posix.join(posix.dirname(importer), specifier));
  const sourceMapped = base.endsWith(".js")
    ? [base.slice(0, -3) + ".ts", base.slice(0, -3) + ".tsx"]
    : [];
  const candidates = [
    base,
    ...sourceMapped,
    `${base}.mjs`,
    `${base}.js`,
    `${base}.ts`,
    `${base}.tsx`,
    posix.join(base, "index.mjs"),
    posix.join(base, "index.js"),
    posix.join(base, "index.ts"),
  ];
  const matches = candidates.filter((candidate) => paths.has(candidate));
  if (matches.length !== 1)
    throw new Error("live_catalog_source_closure_unresolved_import");
  return matches[0];
}
