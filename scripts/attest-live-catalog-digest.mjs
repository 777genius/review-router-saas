#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertFreshProtectedMain,
  collectLiveCatalogClaim,
} from "./lib/live-catalog-github-evidence.mjs";
import {
  canonicalJson,
  claimFingerprint,
  LIVE_CATALOG_CLAIM_SCHEMA,
  sha256Hex,
} from "./lib/live-catalog-attestation-domain.mjs";
import { readBoundedRegularFile } from "./lib/github-actions-trusted-evidence.mjs";

export async function writeLiveCatalogAttestationSubject(configuration) {
  const collected = await collectLiveCatalogClaim(
    configuration,
    configuration.fetchImpl,
  );
  const { claim, evidence } = collected;
  const claimBytes = Buffer.from(canonicalJson(claim));
  const claimPath =
    configuration.claimPath ?? "live-catalog-provenance.claim.json";
  const subjectPath =
    configuration.subjectPath ?? "live-catalog-provenance.subject.json";
  writeFileSync(claimPath, claimBytes, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  const subject = {
    schemaVersion: `${LIVE_CATALOG_CLAIM_SCHEMA}.subject`,
    claimPath: basename(claimPath),
    size: claimBytes.length,
    sha256: sha256Hex(claimBytes),
    fingerprint: claimFingerprint(claim),
  };
  writeFileSync(subjectPath, canonicalJson(subject), {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  const evidencePath =
    configuration.evidencePath ?? "live-catalog-provenance.evidence";
  mkdirSync(evidencePath, { mode: 0o700 });
  const closureEvidence = Buffer.from(
    canonicalJson({
      schemaVersion: "reviewrouter.live-catalog.source-closure-evidence.v2",
      selector: evidence.sourceClosure.selector,
      inventoryDigest: evidence.sourceClosure.inventoryDigest,
      digest: evidence.sourceClosure.digest,
      files: evidence.sourceClosureFiles.map((file) => ({
        path: file.path,
        mode: file.mode,
        gitBlobSha: file.gitBlobSha,
        size: file.size,
        sha256: file.sha256,
        contentBase64: file.bytes.toString("base64"),
      })),
    }),
  );
  for (const [name, bytes] of [
    ["artifact.zip", evidence.archiveBytes],
    ["successful-capture.json", evidence.captureEvidenceBytes],
    ["producer.bundle.json", evidence.producerBundleBytes],
    ["source-inventory.json", evidence.sourceInventoryBytes],
    ["source-closure.json", closureEvidence],
  ])
    writeFileSync(`${evidencePath}/${name}`, bytes, {
      mode: 0o600,
      flag: "wx",
    });
  return { claim, claimPath, evidencePath, subject, subjectPath };
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`live_catalog_missing_${name}`);
  return value;
}

async function main() {
  const command = process.argv[2];
  if (command === "assemble") {
    const result = await writeLiveCatalogAttestationSubject({
      repository: required("GITHUB_REPOSITORY"),
      token: required("GH_TOKEN"),
      runId: required("SOURCE_RUN_ID"),
      artifactId: required("SOURCE_ARTIFACT_ID"),
      producerJobId: required("PRODUCER_JOB_ID"),
      attestorCommit: required("GITHUB_SHA"),
      attestorRunId: required("GITHUB_RUN_ID"),
      attestorRunAttempt: required("GITHUB_RUN_ATTEMPT"),
      attestorRef: required("GITHUB_REF"),
      attestorRunner: "ubuntu-24.04",
      attestorEnvironment: "production-release",
    });
    const output = required("GITHUB_OUTPUT");
    writeFileSync(
      output,
      `claim_path=${result.claimPath}\nsubject_path=${result.subjectPath}\nevidence_path=${result.evidencePath}\nfingerprint=${result.subject.fingerprint}\n`,
      { encoding: "utf8", flag: "a" },
    );
    return;
  }
  if (command === "assert-fresh-main") {
    await assertFreshProtectedMain({
      repository: required("GITHUB_REPOSITORY"),
      token: required("GH_TOKEN"),
      expectedCommit: required("GITHUB_SHA"),
    });
    return;
  }
  if (command === "finalize-bundle") {
    const source = required("ATTESTATION_BUNDLE_PATH");
    const bytes = readBoundedRegularFile(source, 8 * 1024 * 1024, "bundle");
    JSON.parse(bytes.toString("utf8"));
    writeFileSync("live-catalog-provenance.bundle.json", bytes, {
      flag: "wx",
      mode: 0o600,
    });
    return;
  }
  throw new Error(
    "usage: attest-live-catalog-digest.mjs <assemble|assert-fresh-main|finalize-bundle>",
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
