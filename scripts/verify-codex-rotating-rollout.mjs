#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const drainMilliseconds = 16 * 60 * 1_000;
const checkoutRoot = resolve(import.meta.dirname, "..");
const migrationId = "000060_codex_oauth_setup_serialization";
const migrationSourceFile =
  "packages/platform/db/prisma/migrations/000060_codex_oauth_setup_serialization/migration.sql";
const applicationNames = ["api", "web", "worker"];
const compatibilityCaseIds = [
  "legacy-manifest-reader-restart",
  "v2-manifest-reader-restart",
];

export function canonicalJson(value) {
  return `${JSON.stringify(sortJson(value))}\n`;
}

export function sha256Utf8(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function runCodexRotatingRolloutVerifierCli(
  args,
  { stdout = process.stdout, stderr = process.stderr } = {},
) {
  const evidencePath = args[0];
  if (!evidencePath) {
    stderr.write("usage: verify-codex-rotating-rollout.mjs <evidence.json>\n");
    return 2;
  }

  let evidence;
  try {
    evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  } catch {
    stderr.write("FAIL: rollout evidence is not readable JSON\n");
    return 1;
  }
  const result = verifyCodexRotatingRollout(evidence);
  if (!result.ok) {
    for (const failure of result.failures) stderr.write(`FAIL: ${failure}\n`);
    return 1;
  }
  stdout.write(`PASS canonical-result-sha256=${result.resultSha256}\n`);
  return 0;
}

export function verifyCodexRotatingRollout(
  evidence,
  { readSource = (path) => readFileSync(path) } = {},
) {
  const failures = [];
  const requireEvidence = (condition, message) => {
    if (!condition) failures.push(message);
  };
  const quiescedAt = Date.parse(evidence.issuance?.quiescedAt ?? "");
  const bridgeObservedAt = Date.parse(evidence.bridge?.observedAt ?? "");
  const migrationStartedAt = Date.parse(evidence.migration?.startedAt ?? "");
  const migrationCompletedAt = Date.parse(
    evidence.migration?.completedAt ?? "",
  );
  const canaryCompletedAt = Date.parse(evidence.canary?.completedAt ?? "");
  const canaryStartedAt = Date.parse(evidence.canary?.startedAt ?? "");
  const wideningStartedAt = Date.parse(evidence.widening?.startedAt ?? "");

  requireEvidence(evidence.version === 1, "unsupported evidence version");
  requireEvidence(
    evidence.bridge?.readerReady === true,
    "bridge reader is not ready",
  );
  requireEvidence(
    evidence.bridge?.compatibilityProbePassed === true,
    "bridge compatibility probe did not pass",
  );
  requireEvidence(
    /^[a-f0-9]{40}$/u.test(evidence.bridge?.commit ?? ""),
    "bridge commit must be exact",
  );
  requireEvidence(
    Number.isFinite(bridgeObservedAt) && bridgeObservedAt <= quiescedAt,
    "bridge was not observed before issuance quiescence",
  );
  requireEvidence(
    evidence.issuance?.drainSwitch === "setup_manifest_issuance",
    "setup-manifest issuance must be the drain switch",
  );
  requireEvidence(
    evidence.issuance?.quiesced === true,
    "setup issuance is not quiesced",
  );
  requireEvidence(
    evidence.issuance?.mainOAuthEnabledDuringDrain === true,
    "main OAuth must remain enabled during the drain",
  );
  requireEvidence(
    evidence.issuance?.confirmationLiveDuringDrain === true,
    "setup confirmation must remain live during the drain",
  );
  requireEvidence(
    Number.isFinite(quiescedAt),
    "issuance quiescence time is invalid",
  );
  requireEvidence(
    Number.isFinite(migrationStartedAt) &&
      migrationStartedAt - quiescedAt >= drainMilliseconds,
    "migration started before the 16-minute drain completed",
  );
  requireEvidence(
    evidence.migration?.id === migrationId,
    "migration is not exact 000060",
  );
  requireEvidence(
    evidence.migration?.sourceFile === migrationSourceFile,
    "migration source file is not exact 000060",
  );
  const migrationSourceSha256 = sourceDigest(
    evidence.migration?.sourceFile,
    readSource,
  );
  requireEvidence(
    /^[a-f0-9]{64}$/u.test(evidence.migration?.sourceFileSha256 ?? ""),
    "migration source-file digest is invalid",
  );
  requireEvidence(
    migrationSourceSha256 === evidence.migration?.sourceFileSha256,
    "checked-in 000060 digest mismatched",
  );
  requireEvidence(
    evidence.migration?.controlledRunCount === 1,
    "migration must run exactly once",
  );
  requireEvidence(
    evidence.migration?.succeeded === true,
    "migration did not succeed",
  );
  requireEvidence(
    migrationCompletedAt >= migrationStartedAt,
    "migration completion time is invalid",
  );
  requireEvidence(
    /^[a-f0-9]{40}$/u.test(evidence.targetCommit ?? ""),
    "target commit must be exact",
  );
  requireEvidence(
    /^sha256:[a-f0-9]{64}$/u.test(evidence.candidateImageDigest ?? ""),
    "candidate image digest must be exact",
  );
  requireEvidence(
    Array.isArray(evidence.applications) && evidence.applications.length > 0,
    "application convergence evidence is missing",
  );
  const observedApplicationNames = (evidence.applications ?? [])
    .map((application) => application.name)
    .sort();
  requireEvidence(
    JSON.stringify(observedApplicationNames) ===
      JSON.stringify(applicationNames),
    "application convergence must cover api, web, and worker exactly once",
  );
  let lastApplicationObservedAt = Number.NEGATIVE_INFINITY;
  for (const application of evidence.applications ?? []) {
    requireEvidence(
      application.commit === evidence.targetCommit,
      `${application.name ?? "application"} did not converge to target commit`,
    );
    const applicationObservedAt = Date.parse(application.observedAt ?? "");
    requireEvidence(
      applicationObservedAt >= migrationCompletedAt,
      `${application.name ?? "application"} converged before migration completion`,
    );
    lastApplicationObservedAt = Math.max(
      lastApplicationObservedAt,
      applicationObservedAt,
    );
  }
  requireEvidence(
    evidence.canary?.disposable === true,
    "canary repository is not disposable",
  );
  requireEvidence(
    evidence.canary?.passed === true,
    "disposable canary did not pass",
  );
  requireEvidence(
    Number.isFinite(canaryStartedAt) &&
      canaryStartedAt >= lastApplicationObservedAt,
    "canary started before exact-commit application convergence",
  );
  requireEvidence(
    canaryCompletedAt >= canaryStartedAt,
    "canary completion time is invalid",
  );
  requireEvidence(
    evidence.canary?.commit === evidence.targetCommit,
    "canary did not run the target commit",
  );
  requireEvidence(
    evidence.canary?.imageDigest === evidence.candidateImageDigest,
    "canary did not run the candidate image digest",
  );
  requireEvidence(
    evidence.widening?.approved === true,
    "widening is not approved",
  );
  requireEvidence(
    wideningStartedAt >= canaryCompletedAt,
    "widening started before canary completion",
  );
  requireEvidence(
    evidence.rollback?.applicationOnly === true,
    "rollback must be application-only",
  );
  requireEvidence(
    evidence.rollback?.databaseRollbackProhibited === true,
    "database rollback prohibition is missing",
  );
  requireEvidence(
    evidence.rollback?.directPreConfirmationRollbackProhibited === true,
    "direct pre-confirmation rollback prohibition is missing",
  );

  const probe = evidence.compatibilityProbe ?? {};
  const resultJson = canonicalJson(probe.result);
  const resultSha256 = sha256Utf8(resultJson);
  const sourceIsWithinCheckout = checkoutSourcePath(probe.sourceFile) !== null;
  const observedSourceFileSha256 = sourceDigest(probe.sourceFile, readSource);
  requireEvidence(
    sourceIsWithinCheckout,
    "probe source file must be inside the checkout",
  );
  requireEvidence(
    /^[a-f0-9]{64}$/u.test(probe.sourceFileSha256 ?? ""),
    "probe source-file digest is invalid",
  );
  requireEvidence(
    observedSourceFileSha256 === probe.sourceFileSha256,
    "trusted probe source-file digest mismatched",
  );
  requireEvidence(
    /^[a-f0-9]{64}$/u.test(probe.expectedResultSha256 ?? ""),
    "expected probe result digest is invalid",
  );
  requireEvidence(
    resultSha256 === probe.expectedResultSha256,
    "canonical compatibility-probe result digest mismatched",
  );
  requireEvidence(
    resultSha256 !== probe.sourceFileSha256,
    "result digest must be distinct from source-file digest",
  );
  requireEvidence(
    probe.result?.candidateSourceCommit === evidence.targetCommit,
    "probe result is bound to a different source commit",
  );
  requireEvidence(
    probe.result?.candidateImageDigest === evidence.candidateImageDigest,
    "probe result is bound to a different image digest",
  );
  requireEvidence(
    hasExactKeys(probe.result, [
      "candidateImageDigest",
      "candidateSourceCommit",
      "cases",
      "probePolicy",
      "probeVersion",
      "readerRestartCount",
    ]),
    "canonical compatibility result contains missing or unstable fields",
  );
  requireEvidence(
    probe.result?.probePolicy === "codex-rotating-rollback" &&
      probe.result?.probeVersion === 1,
    "compatibility probe policy/version is invalid",
  );
  requireEvidence(
    Array.isArray(probe.result?.cases) &&
      probe.result.cases.length === 2 &&
      probe.result.cases.every(
        (entry, index) =>
          hasExactKeys(entry, ["conclusion", "id"]) &&
          entry.id === compatibilityCaseIds[index] &&
          entry.conclusion === "pass",
      ),
    "both canonical compatibility cases must pass",
  );
  requireEvidence(
    Number.isSafeInteger(probe.result?.readerRestartCount) &&
      probe.result.readerRestartCount >= 1,
    "compatibility reader restart was not proved",
  );

  return {
    ok: failures.length === 0,
    failures,
    resultSha256,
    canonicalResult: resultJson,
  };
}

function sourceDigest(sourceFile, readSource) {
  const path = checkoutSourcePath(sourceFile);
  if (!path) return null;
  try {
    return createHash("sha256").update(readSource(path)).digest("hex");
  } catch {
    // Report a stable verifier failure instead of leaking a local path/error.
    return null;
  }
}

function checkoutSourcePath(sourceFile) {
  if (typeof sourceFile !== "string" || sourceFile.length === 0) return null;
  const path = resolve(checkoutRoot, sourceFile);
  return path.startsWith(`${checkoutRoot}${sep}`) ? path : null;
}

function hasExactKeys(value, expectedKeys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...expectedKeys].sort())
  );
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJson(value[key])]),
    );
  }
  return value;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = runCodexRotatingRolloutVerifierCli(process.argv.slice(2));
}
