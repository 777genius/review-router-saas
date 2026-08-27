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

const VERIFICATION_RESULT_MEDIA_TYPE =
  "application/vnd.dev.sigstore.verificationresult+json;version=0.1";

const requiredCertificateKeys = Object.freeze([
  "certificateIssuer",
  "subjectAlternativeName",
  "issuer",
  "githubWorkflowTrigger",
  "githubWorkflowSHA",
  "githubWorkflowName",
  "githubWorkflowRepository",
  "githubWorkflowRef",
  "buildSignerURI",
  "buildSignerDigest",
  "runnerEnvironment",
  "sourceRepositoryURI",
  "sourceRepositoryDigest",
  "sourceRepositoryRef",
  "sourceRepositoryIdentifier",
  "sourceRepositoryOwnerURI",
  "sourceRepositoryOwnerIdentifier",
  "runInvocationURI",
]);

const optionalCertificateKeys = Object.freeze([
  "buildConfigURI",
  "buildConfigDigest",
  "buildTrigger",
  "sourceRepositoryVisibilityAtSigning",
]);

const nonemptyString = (value) => typeof value === "string" && value.length > 0;

function validSignature(value, policy) {
  const certificate = value?.certificate;
  const certificateKeys = Object.keys(certificate ?? {});
  const allowedCertificateKeys = new Set([
    ...requiredCertificateKeys,
    ...optionalCertificateKeys,
  ]);
  const repository = policy.repository.toLowerCase();
  const owner = repository.split("/", 1)[0];
  const signerURI =
    `https://github.com/${repository}/${policy.signerWorkflowPath}` +
    `@${policy.sourceRef}`;
  const sourceRepositoryURI = `https://github.com/${repository}`;
  const runInvocationURI = `https://github.com/${repository}/actions/runs/${policy.runId}/attempts/1`;
  return (
    exactKeys(value, ["certificate"]) &&
    requiredCertificateKeys.every((key) =>
      Object.hasOwn(certificate ?? {}, key),
    ) &&
    certificateKeys.every((key) => allowedCertificateKeys.has(key)) &&
    certificateKeys.every((key) => nonemptyString(certificate[key])) &&
    certificate.issuer === "https://token.actions.githubusercontent.com" &&
    certificate.subjectAlternativeName === signerURI &&
    certificate.githubWorkflowTrigger === "workflow_dispatch" &&
    certificate.githubWorkflowSHA === policy.sourceDigest &&
    certificate.githubWorkflowRepository.toLowerCase() === repository &&
    certificate.githubWorkflowRef === policy.sourceRef &&
    certificate.buildSignerURI === signerURI &&
    certificate.buildSignerDigest === policy.signerDigest &&
    certificate.runnerEnvironment === "github-hosted" &&
    certificate.sourceRepositoryURI === sourceRepositoryURI &&
    certificate.sourceRepositoryDigest === policy.sourceDigest &&
    certificate.sourceRepositoryRef === policy.sourceRef &&
    /^[1-9]\d*$/u.test(certificate.sourceRepositoryIdentifier) &&
    certificate.sourceRepositoryOwnerURI.toLowerCase() ===
      `https://github.com/${owner}` &&
    /^[1-9]\d*$/u.test(certificate.sourceRepositoryOwnerIdentifier) &&
    certificate.runInvocationURI === runInvocationURI &&
    (!Object.hasOwn(certificate, "sourceRepositoryVisibilityAtSigning") ||
      ["public", "private", "internal"].includes(
        certificate.sourceRepositoryVisibilityAtSigning,
      ))
  );
}

function validRfc3339Timestamp(value) {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/u.exec(
      value,
    );
  if (!match) return false;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day &&
    parsed.getUTCHours() === hour &&
    parsed.getUTCMinutes() === minute &&
    parsed.getUTCSeconds() === second
  );
}

function validVerifiedTimestamps(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (timestamp) =>
        exactKeys(timestamp, ["timestamp", "type", "uri"]) &&
        typeof timestamp.timestamp === "string" &&
        validRfc3339Timestamp(timestamp.timestamp) &&
        ["Tlog", "TSA"].includes(timestamp.type) &&
        typeof timestamp.uri === "string" &&
        /^https:\/\/[^\s]+$/u.test(timestamp.uri),
    )
  );
}

function validVerifiedIdentity(value, certificate) {
  return (
    exactKeys(value, ["issuer", "subjectAlternativeName"]) &&
    value.issuer === certificate.issuer &&
    value.subjectAlternativeName === certificate.subjectAlternativeName
  );
}

export function normalizeGhAttestationResult(entry, policy) {
  if (!exactKeys(entry, ["attestation", "verificationResult"]))
    throw new Error("live_catalog_gh_result_shape_invalid");
  const result = entry.verificationResult;
  const requiredResultKeys = [
    "mediaType",
    "statement",
    "signature",
    "verifiedTimestamps",
  ];
  const resultKeys = Object.keys(result ?? {});
  const allowedResultKeys = new Set([
    ...requiredResultKeys,
    "verifiedIdentity",
  ]);
  if (
    !requiredResultKeys.every((key) => Object.hasOwn(result ?? {}, key)) ||
    resultKeys.some((key) => !allowedResultKeys.has(key)) ||
    result.mediaType !== VERIFICATION_RESULT_MEDIA_TYPE ||
    !validSignature(result.signature, policy) ||
    !validVerifiedTimestamps(result.verifiedTimestamps) ||
    (Object.hasOwn(result ?? {}, "verifiedIdentity") &&
      !validVerifiedIdentity(
        result.verifiedIdentity,
        result.signature?.certificate,
      )) ||
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
    result.statement._type !== "https://in-toto.io/Statement/v1" ||
    result.statement.predicateType !== "https://slsa.dev/provenance/v1" ||
    subject.name !== policy.subjectName ||
    subject.digest.sha256 !== sha256Hex(policy.subjectBytes)
  )
    throw new Error("live_catalog_gh_authenticated_subject_mismatch");
  const certificate = result.signature.certificate;
  return Object.freeze({
    certificate: Object.freeze({
      repository: policy.repository.toLowerCase(),
      signerWorkflow: `${policy.repository.toLowerCase()}/${policy.signerWorkflowPath}`,
      signerDigest: certificate.buildSignerDigest,
      sourceRef: certificate.sourceRepositoryRef,
      sourceDigest: certificate.sourceRepositoryDigest,
      runnerEnvironment: certificate.runnerEnvironment,
      runInvocationURI: certificate.runInvocationURI,
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
