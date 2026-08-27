#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readExactZipEntries } from "./lib/github-actions-trusted-evidence.mjs";
import { verifyWithGhAttestation } from "./lib/live-catalog-gh-attestation-adapter.mjs";
import {
  assembleLiveCatalogClaim,
  canonicalJson,
  claimFingerprint,
  LIVE_CATALOG_CLAIM_SCHEMA,
  sha256Hex,
  validateLiveCatalogClaim,
} from "./lib/live-catalog-attestation-domain.mjs";

function parseCanonical(path, label) {
  const raw = readFileSync(path, "utf8");
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`live_catalog_${label}_not_json`);
  }
  if (canonicalJson(value) !== raw)
    throw new Error(`live_catalog_${label}_not_canonical`);
  return { raw, value };
}

export function verifyLiveCatalogAttestation(
  input,
  ghVerifier = verifyWithGhAttestation,
) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(input.repository ?? ""))
    throw new Error("live_catalog_verify_repository_invalid");
  const claimFile = parseCanonical(input.claimPath, "claim");
  const subjectFile = parseCanonical(input.subjectPath, "subject");
  const claim = validateLiveCatalogClaim(claimFile.value);
  const subject = subjectFile.value;
  if (
    subject?.schemaVersion !== `${LIVE_CATALOG_CLAIM_SCHEMA}.subject` ||
    subject.claimPath !== basename(input.claimPath) ||
    subject.size !== Buffer.byteLength(claimFile.raw) ||
    subject.sha256 !== sha256Hex(Buffer.from(claimFile.raw)) ||
    subject.fingerprint !== claimFingerprint(claim) ||
    claim.repository.name !== input.repository.toLowerCase() ||
    claim.attestor.commit !== input.attestorCommit
  )
    throw new Error("live_catalog_subject_tuple_mismatch");
  const archiveBytes = readFileSync(join(input.evidencePath, "artifact.zip"));
  const entries = readExactZipEntries(archiveBytes);
  const candidateEntries = [...entries.entries()].filter(([name]) =>
    /^activation-catalog-policy-candidate-[12]\.json$/u.test(name),
  );
  if (candidateEntries.length !== entries.size)
    throw new Error("live_catalog_offline_evidence_entries_invalid");
  const reconstructed = assembleLiveCatalogClaim({
    repositoryId: claim.repository.id,
    repositoryName: claim.repository.name,
    sourceCommit: claim.source.commit,
    sourceTree: claim.source.tree,
    sourceRef: claim.source.ref,
    sourceBranch: claim.source.branch,
    sourceWorkflowPath: claim.execution.workflowPath,
    sourceEvent: claim.execution.event,
    runId: claim.execution.runId,
    runAttempt: claim.execution.runAttempt,
    qualityJob: {
      id: claim.execution.qualityJob.id,
      name: claim.execution.qualityJob.name,
      conclusion: claim.execution.qualityJob.conclusion,
    },
    pg17Job: {
      id: claim.execution.pg17Job.id,
      name: claim.execution.pg17Job.name,
      conclusion: claim.execution.pg17Job.conclusion,
    },
    runnerEnvironment: claim.execution.runnerEnvironment,
    artifactId: claim.artifact.id,
    artifactName: claim.artifact.name,
    archiveSha256: sha256Hex(archiveBytes),
    candidateEntries,
    qualityLogBytes: readFileSync(join(input.evidencePath, "quality.log")),
    workflowSourceBytes: readFileSync(
      join(input.evidencePath, "source-ci.yml"),
    ),
    projectionSourceBytes: readFileSync(
      join(input.evidencePath, "source-live-catalog-projection.mjs"),
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
  JSON.parse(readFileSync(input.bundlePath, "utf8"));
  ghVerifier({
    repository: input.repository,
    claimPath: input.claimPath,
    bundlePath: input.bundlePath,
    attestorCommit: input.attestorCommit,
    token: input.token,
  });
  return Object.freeze({ fingerprint: subject.fingerprint, claim });
}

function argumentsFrom(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value)
      throw new Error("live_catalog_verify_usage");
    values[key.slice(2)] = value;
  }
  return values;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = argumentsFrom(process.argv.slice(2));
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
