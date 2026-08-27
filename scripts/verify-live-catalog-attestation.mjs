#!/usr/bin/env node
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  gitBlobSha,
  readBoundedRegularFile,
  readExactZipEntries,
} from "./lib/github-actions-trusted-evidence.mjs";
import { verifyWithGhAttestation } from "./lib/live-catalog-gh-attestation-adapter.mjs";
import {
  assembleLiveCatalogClaim,
  assertLiveCatalogClaimAtProtectedMain,
  canonicalJson,
  claimFingerprint,
  LIVE_CATALOG_CLAIM_SCHEMA,
  LIVE_CATALOG_CONTRACT_PATH,
  LIVE_CATALOG_PROJECTION_PATH,
  LIVE_CATALOG_SOURCE_WORKFLOW,
  LIVE_CATALOG_WORKFLOW,
  sha256Hex,
  validateLiveCatalogClaim,
} from "./lib/live-catalog-attestation-domain.mjs";

function parseCanonical(path, label, maximumBytes) {
  const bytes = readBoundedRegularFile(path, maximumBytes, label);
  const raw = bytes.toString("utf8");
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`live_catalog_${label}_not_json`);
  }
  if (canonicalJson(value) !== raw)
    throw new Error(`live_catalog_${label}_not_canonical`);
  return { bytes, raw, value };
}

function parseClosureEvidence(path) {
  const parsed = parseCanonical(path, "source_closure", 32 * 1024 * 1024).value;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    parsed.schemaVersion !==
      "reviewrouter.live-catalog.source-closure-evidence.v1" ||
    JSON.stringify(Object.keys(parsed).sort()) !==
      JSON.stringify(["schemaVersion", "files"].sort()) ||
    !Array.isArray(parsed.files) ||
    !parsed.files.length
  )
    throw new Error("live_catalog_source_closure_evidence_invalid");
  return parsed.files.map((file) => {
    if (
      !file ||
      typeof file !== "object" ||
      Array.isArray(file) ||
      JSON.stringify(Object.keys(file).sort()) !==
        JSON.stringify(
          ["path", "gitBlobSha", "size", "sha256", "contentBase64"].sort(),
        ) ||
      typeof file.contentBase64 !== "string"
    )
      throw new Error("live_catalog_source_closure_evidence_invalid");
    const bytes = Buffer.from(file.contentBase64, "base64");
    if (
      bytes.toString("base64") !== file.contentBase64 ||
      bytes.length !== file.size ||
      sha256Hex(bytes) !== file.sha256 ||
      gitBlobSha(bytes) !== file.gitBlobSha
    )
      throw new Error("live_catalog_source_closure_evidence_invalid");
    return { ...file, bytes };
  });
}

export function verifyLiveCatalogAttestation(
  input,
  ghVerifier = verifyWithGhAttestation,
) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(input.repository ?? ""))
    throw new Error("live_catalog_verify_repository_invalid");
  const claimFile = parseCanonical(input.claimPath, "claim", 4 * 1024 * 1024);
  const subjectFile = parseCanonical(input.subjectPath, "subject", 64 * 1024);
  const claim = validateLiveCatalogClaim(claimFile.value);
  assertLiveCatalogClaimAtProtectedMain(claim, input.trustedCurrentMainCommit);
  const subject = subjectFile.value;
  if (
    !subject ||
    typeof subject !== "object" ||
    Array.isArray(subject) ||
    JSON.stringify(Object.keys(subject).sort()) !==
      JSON.stringify(
        ["schemaVersion", "claimPath", "size", "sha256", "fingerprint"].sort(),
      ) ||
    subject.schemaVersion !== `${LIVE_CATALOG_CLAIM_SCHEMA}.subject` ||
    subject.claimPath !== basename(input.claimPath) ||
    subject.size !== claimFile.bytes.length ||
    subject.sha256 !== sha256Hex(claimFile.bytes) ||
    subject.fingerprint !== claimFingerprint(claim) ||
    claim.repository.name !== input.repository.toLowerCase() ||
    claim.attestor.commit !== input.trustedCurrentMainCommit ||
    claim.source.commit !== input.trustedCurrentMainCommit
  )
    throw new Error("live_catalog_subject_tuple_mismatch");

  const archiveBytes = readBoundedRegularFile(
    join(input.evidencePath, "artifact.zip"),
    32 * 1024 * 1024,
    "archive",
  );
  const producerBundleBytes = readBoundedRegularFile(
    join(input.evidencePath, "producer.bundle.json"),
    8 * 1024 * 1024,
    "producer_bundle",
  );
  if (
    sha256Hex(archiveBytes) !== claim.artifact.archiveSha256 ||
    sha256Hex(producerBundleBytes) !== claim.producerAttestation.bundleSha256
  )
    throw new Error("live_catalog_offline_producer_digest_mismatch");

  // Verify the producer signature and authenticated certificate before parsing
  // the archive or accepting any capture assertion.
  const producer = ghVerifier({
    repository: input.repository.toLowerCase(),
    subjectBytes: archiveBytes,
    subjectName: claim.artifact.name,
    bundleBytes: producerBundleBytes,
    signerWorkflowPath: LIVE_CATALOG_SOURCE_WORKFLOW,
    signerDigest: claim.source.commit,
    sourceRef: "refs/heads/main",
    sourceDigest: claim.source.commit,
    runId: claim.execution.runId,
    token: input.token,
  });
  const entries = readExactZipEntries(archiveBytes);
  const candidateEntries = [...entries.entries()].filter(([name]) =>
    /^activation-catalog-policy-candidate-[12]\.json$/u.test(name),
  );
  const captureEvidenceBytes = entries.get(
    "live-catalog-successful-capture-evidence.json",
  );
  if (
    candidateEntries.length !== 2 ||
    entries.size !== 3 ||
    !captureEvidenceBytes
  )
    throw new Error("live_catalog_offline_evidence_entries_invalid");
  const retainedCapture = readBoundedRegularFile(
    join(input.evidencePath, "successful-capture.json"),
    2 * 1024 * 1024,
    "capture_evidence",
  );
  if (!retainedCapture.equals(captureEvidenceBytes))
    throw new Error("live_catalog_offline_capture_evidence_mismatch");
  const sourceClosureFiles = parseClosureEvidence(
    join(input.evidencePath, "source-closure.json"),
  );
  const source = new Map(
    sourceClosureFiles.map((file) => [file.path, file.bytes]),
  );
  const reconstructed = assembleLiveCatalogClaim({
    repositoryId: claim.repository.id,
    repositoryName: claim.repository.name,
    sourceCommit: claim.source.commit,
    sourceTree: claim.source.tree,
    sourceRef: claim.source.ref,
    sourceBranch: claim.source.branch,
    sourceWorkflowPath: claim.execution.workflowPath,
    sourceEvent: claim.execution.event,
    sourceStatus: claim.execution.status,
    sourceConclusion: claim.execution.conclusion,
    runId: claim.execution.runId,
    runAttempt: claim.execution.runAttempt,
    producerJob: claim.execution.producerJob,
    runnerEnvironment: claim.execution.runnerEnvironment,
    artifactId: claim.artifact.id,
    artifactName: claim.artifact.name,
    artifactRestDigest: claim.artifact.restDigest,
    archiveSha256: sha256Hex(archiveBytes),
    candidateEntries,
    captureEvidenceBytes,
    workflowSourceBytes: source.get(LIVE_CATALOG_SOURCE_WORKFLOW),
    projectionSourceBytes: source.get(LIVE_CATALOG_PROJECTION_PATH),
    contractSourceBytes: source.get(LIVE_CATALOG_CONTRACT_PATH),
    sourceClosureFiles,
    producerCertificate: producer.certificate,
    producerSubject: producer.subject,
    producerBundleBytes,
    pg17Image: claim.pg17Image,
    attestorCommit: claim.attestor.commit,
    attestorRunId: claim.attestor.runId,
    attestorRunAttempt: claim.attestor.runAttempt,
    attestorRef: claim.attestor.ref,
    attestorRunner: claim.attestor.runner,
    attestorEnvironment: claim.attestor.environment,
  });
  if (canonicalJson(reconstructed) !== claimFile.raw)
    throw new Error("live_catalog_offline_evidence_tuple_mismatch");

  // The final bundle is checked only after the producer chain and all retained
  // evidence have reconstructed the exact claim bytes.
  const finalBundleBytes = readBoundedRegularFile(
    input.bundlePath,
    8 * 1024 * 1024,
    "bundle",
  );
  ghVerifier({
    repository: input.repository.toLowerCase(),
    subjectBytes: claimFile.bytes,
    subjectName: basename(input.claimPath),
    bundleBytes: finalBundleBytes,
    signerWorkflowPath: LIVE_CATALOG_WORKFLOW,
    signerDigest: claim.attestor.commit,
    sourceRef: "refs/heads/main",
    sourceDigest: claim.attestor.commit,
    runId: claim.attestor.runId,
    token: input.token,
  });
  return Object.freeze({ fingerprint: subject.fingerprint, claim });
}

export function parseVerifyArguments(argv) {
  const expected = new Set([
    "repository",
    "claim",
    "subject",
    "bundle",
    "evidence",
  ]);
  const trustArguments = new Set([
    "trusted-current-main",
    "trusted-current-main-file",
  ]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    const name = key?.slice(2);
    if (
      !key?.startsWith("--") ||
      !value ||
      (!expected.has(name) && !trustArguments.has(name)) ||
      Object.hasOwn(values, name)
    )
      throw new Error("live_catalog_verify_usage");
    values[name] = value;
  }
  if (
    ![...expected].every((name) => Object.hasOwn(values, name)) ||
    [...trustArguments].filter((name) => Object.hasOwn(values, name)).length !==
      1 ||
    Object.keys(values).length !== expected.size + 1
  )
    throw new Error("live_catalog_verify_usage");
  return values;
}

export function trustedCurrentMainFromArguments(args) {
  const direct = args["trusted-current-main"];
  const fromFile = args["trusted-current-main-file"];
  const value = fromFile
    ? readBoundedRegularFile(fromFile, 128, "trusted_current_main").toString(
        "utf8",
      )
    : direct;
  const normalized = value?.endsWith("\n") ? value.slice(0, -1) : value;
  if (!/^[a-f0-9]{40}$/u.test(normalized ?? ""))
    throw new Error("live_catalog_trusted_current_main_invalid");
  return normalized;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = parseVerifyArguments(process.argv.slice(2));
  const result = verifyLiveCatalogAttestation({
    repository: args.repository,
    claimPath: args.claim,
    subjectPath: args.subject,
    bundlePath: args.bundle,
    evidencePath: args.evidence,
    trustedCurrentMainCommit: trustedCurrentMainFromArguments(args),
    token: process.env.GH_TOKEN,
  });
  process.stdout.write(
    canonicalJson({ verified: true, fingerprint: result.fingerprint }),
  );
}
