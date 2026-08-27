#!/usr/bin/env node
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  readBoundedRegularFile,
  readExactZipEntries,
} from "./lib/github-actions-trusted-evidence.mjs";
import { verifyWithGhAttestation } from "./lib/live-catalog-gh-attestation-adapter.mjs";
import {
  assembleLiveCatalogClaim,
  canonicalJson,
  claimFingerprint,
  LIVE_CATALOG_CLAIM_SCHEMA,
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

export function verifyLiveCatalogAttestation(
  input,
  ghVerifier = verifyWithGhAttestation,
) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(input.repository ?? ""))
    throw new Error("live_catalog_verify_repository_invalid");
  const claimFile = parseCanonical(input.claimPath, "claim", 2 * 1024 * 1024);
  const subjectFile = parseCanonical(input.subjectPath, "subject", 64 * 1024);
  const claim = validateLiveCatalogClaim(claimFile.value);
  const subject = subjectFile.value;
  if (
    !subject ||
    typeof subject !== "object" ||
    Array.isArray(subject) ||
    JSON.stringify(Object.keys(subject).sort()) !==
      JSON.stringify(
        ["schemaVersion", "claimPath", "size", "sha256", "fingerprint"].sort(),
      ) ||
    subject?.schemaVersion !== `${LIVE_CATALOG_CLAIM_SCHEMA}.subject` ||
    subject.claimPath !== basename(input.claimPath) ||
    subject.size !== Buffer.byteLength(claimFile.raw) ||
    subject.sha256 !== sha256Hex(Buffer.from(claimFile.raw)) ||
    subject.fingerprint !== claimFingerprint(claim) ||
    claim.repository.name !== input.repository.toLowerCase() ||
    claim.attestor.commit !== input.attestorCommit
  )
    throw new Error("live_catalog_subject_tuple_mismatch");
  const bundleBytes = readBoundedRegularFile(
    input.bundlePath,
    8 * 1024 * 1024,
    "bundle",
  );
  try {
    JSON.parse(bundleBytes.toString("utf8"));
  } catch {
    throw new Error("live_catalog_bundle_not_json");
  }
  // Authenticate the exact immutable snapshot before processing large evidence.
  ghVerifier({
    repository: input.repository,
    claimBytes: claimFile.bytes,
    bundleBytes,
    attestorCommit: input.attestorCommit,
    token: input.token,
  });
  const archiveBytes = readBoundedRegularFile(
    join(input.evidencePath, "artifact.zip"),
    32 * 1024 * 1024,
    "archive",
  );
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
  const retainedCaptureEvidence = readBoundedRegularFile(
    join(input.evidencePath, "successful-capture.json"),
    2 * 1024 * 1024,
    "capture_evidence",
  );
  if (!retainedCaptureEvidence.equals(captureEvidenceBytes))
    throw new Error("live_catalog_offline_capture_evidence_mismatch");
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
    producerJob: {
      id: claim.execution.producerJob.id,
      name: claim.execution.producerJob.name,
      status: claim.execution.producerJob.status,
      conclusion: claim.execution.producerJob.conclusion,
      runnerGroupId: claim.execution.producerJob.runnerGroupId,
      runnerGroupName: claim.execution.producerJob.runnerGroupName,
      runnerName: claim.execution.producerJob.runnerName,
      labels: claim.execution.producerJob.labels,
    },
    runnerEnvironment: claim.execution.runnerEnvironment,
    artifactId: claim.artifact.id,
    artifactName: claim.artifact.name,
    archiveSha256: sha256Hex(archiveBytes),
    candidateEntries,
    captureEvidenceBytes,
    workflowSourceBytes: readBoundedRegularFile(
      join(input.evidencePath, "source-ci.yml"),
      2 * 1024 * 1024,
      "workflow_source",
    ),
    projectionSourceBytes: readBoundedRegularFile(
      join(input.evidencePath, "source-live-catalog-projection.mjs"),
      8 * 1024 * 1024,
      "projection_source",
    ),
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
  return Object.freeze({ fingerprint: subject.fingerprint, claim });
}

export function parseVerifyArguments(argv) {
  const expected = new Set([
    "repository",
    "claim",
    "subject",
    "bundle",
    "evidence",
    "attestor-digest",
  ]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    const name = key?.slice(2);
    if (
      !key?.startsWith("--") ||
      !value ||
      !expected.has(name) ||
      Object.hasOwn(values, name)
    )
      throw new Error("live_catalog_verify_usage");
    values[name] = value;
  }
  if (Object.keys(values).length !== expected.size)
    throw new Error("live_catalog_verify_usage");
  return values;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = parseVerifyArguments(process.argv.slice(2));
  const result = verifyLiveCatalogAttestation({
    repository: args.repository,
    claimPath: args.claim,
    subjectPath: args.subject,
    bundlePath: args.bundle,
    evidencePath: args.evidence,
    attestorCommit: args["attestor-digest"],
    token: process.env.GH_TOKEN,
  });
  process.stdout.write(
    `${canonicalJson({ verified: true, fingerprint: result.fingerprint })}`,
  );
}
