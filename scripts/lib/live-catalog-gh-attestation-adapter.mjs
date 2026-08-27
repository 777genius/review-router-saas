import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  canonicalJson,
  sha256Hex,
} from "./live-catalog-attestation-domain.mjs";

const exactKeys = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());

export function normalizeGhAttestationResult(entry, policy) {
  if (!exactKeys(entry, ["attestation", "verificationResult"]))
    throw new Error("live_catalog_gh_result_shape_invalid");
  const result = entry.verificationResult;
  if (
    !exactKeys(result, [
      "statement",
      "buildSignerURI",
      "buildSignerDigest",
      "sourceRepositoryURI",
      "sourceRepositoryDigest",
      "sourceRepositoryRef",
      "runnerEnvironment",
      "runInvocationURI",
    ]) ||
    !exactKeys(result.statement, [
      "_type",
      "predicateType",
      "subject",
      "predicate",
    ]) ||
    !Array.isArray(result.statement.subject) ||
    result.statement.subject.length !== 1
  )
    throw new Error("live_catalog_gh_result_shape_invalid");
  const subject = result.statement.subject[0];
  if (
    !exactKeys(subject, ["name", "digest"]) ||
    !exactKeys(subject.digest, ["sha256"]) ||
    subject.name !== policy.subjectName ||
    subject.digest.sha256 !== sha256Hex(policy.subjectBytes) ||
    result.buildSignerURI !==
      `https://github.com/${policy.repository}/${policy.signerWorkflowPath}@${policy.sourceRef}` ||
    result.buildSignerDigest !== policy.signerDigest ||
    result.sourceRepositoryURI !== `https://github.com/${policy.repository}` ||
    result.sourceRepositoryDigest !== policy.sourceDigest ||
    result.sourceRepositoryRef !== policy.sourceRef ||
    result.runnerEnvironment !== "github-hosted" ||
    result.runInvocationURI !==
      `https://github.com/${policy.repository}/actions/runs/${policy.runId}/attempts/1`
  )
    throw new Error("live_catalog_gh_authenticated_subject_mismatch");
  return Object.freeze({
    certificate: Object.freeze({
      repository: policy.repository.toLowerCase(),
      signerWorkflow: `${policy.repository.toLowerCase()}/${policy.signerWorkflowPath}`,
      signerDigest: result.buildSignerDigest,
      sourceRef: result.sourceRepositoryRef,
      sourceDigest: result.sourceRepositoryDigest,
      runnerEnvironment: result.runnerEnvironment,
      runInvocationURI: result.runInvocationURI,
    }),
    subject: Object.freeze({
      name: subject.name,
      digest: `sha256:${subject.digest.sha256}`,
    }),
  });
}

export function verifyWithGhAttestation(input, spawn = spawnSync) {
  if (!Buffer.isBuffer(input.subjectBytes))
    throw new Error("live_catalog_gh_exact_bytes_required");
  if (input.bundleBytes !== undefined && !Buffer.isBuffer(input.bundleBytes))
    throw new Error("live_catalog_gh_exact_bytes_required");
  const directory = mkdtempSync(join(tmpdir(), "rr-live-catalog-gh-"));
  const subjectPath = join(directory, "subject.bin");
  const bundlePath = join(directory, "bundle.json");
  try {
    writeFileSync(subjectPath, input.subjectBytes, { flag: "wx", mode: 0o600 });
    const args = ["attestation", "verify", subjectPath];
    let expectedBundle;
    if (input.bundleBytes) {
      try {
        expectedBundle = JSON.parse(input.bundleBytes.toString("utf8"));
      } catch {
        throw new Error("live_catalog_gh_bundle_not_json");
      }
      writeFileSync(bundlePath, input.bundleBytes, { flag: "wx", mode: 0o600 });
      args.push("--bundle", bundlePath);
    }
    args.push(
      "--repo",
      input.repository,
      "--deny-self-hosted-runners",
      "--signer-workflow",
      `${input.repository}/${input.signerWorkflowPath}`,
      "--signer-digest",
      input.signerDigest,
      "--source-ref",
      input.sourceRef,
      "--source-digest",
      input.sourceDigest,
      "--format",
      "json",
    );
    const spawned = spawn("gh", args, {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        ...(input.token ? { GH_TOKEN: input.token } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
    if (spawned.error?.code === "ETIMEDOUT")
      throw new Error("live_catalog_gh_attestation_timeout");
    if (spawned.status !== 0)
      throw new Error("live_catalog_gh_attestation_invalid");
    let verified;
    try {
      verified = JSON.parse(spawned.stdout);
    } catch {
      throw new Error("live_catalog_gh_attestation_output_invalid");
    }
    if (!Array.isArray(verified) || verified.length !== 1)
      throw new Error("live_catalog_gh_result_shape_invalid");
    if (
      expectedBundle !== undefined &&
      !isDeepStrictEqual(verified[0].attestation, expectedBundle)
    )
      throw new Error("live_catalog_gh_authenticated_bundle_mismatch");
    const normalized = normalizeGhAttestationResult(verified[0], input);
    const bundleBytes = Buffer.from(canonicalJson(verified[0].attestation));
    return Object.freeze({ ...normalized, bundleBytes });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
