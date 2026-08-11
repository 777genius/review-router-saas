const workflowPath = ".github/workflows/codex-rotating-release-migration.yml";

const exactKeys = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const decimalIdPattern = /^[1-9][0-9]*$/u;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function isCanonicalTimestamp(value) {
  if (!timestampPattern.test(value ?? "")) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

const v2Fields = Object.freeze([
  "artifactDigest",
  "artifactId",
  "claimedAt",
  "rolloutId",
  "runId",
]);
const v3Fields = Object.freeze([
  "artifactDigest",
  "artifactId",
  "claimedAt",
  "commit",
  "imageDigest",
  "jobId",
  "rolloutId",
  "runId",
  "runAttempt",
  "workflowPath",
]);
const v4Fields = Object.freeze([
  ...v3Fields,
  "receiptVersion",
  "recoveryWitnessSha256",
  "systemIdentifier",
]);

function validCommon(receipt) {
  return (
    typeof receipt.artifactDigest === "string" &&
    digestPattern.test(receipt.artifactDigest ?? "") &&
    typeof receipt.artifactId === "string" &&
    decimalIdPattern.test(receipt.artifactId ?? "") &&
    typeof receipt.rolloutId === "string" &&
    receipt.rolloutId.length > 0 &&
    typeof receipt.runId === "string" &&
    decimalIdPattern.test(receipt.runId ?? "") &&
    typeof receipt.claimedAt === "string" &&
    isCanonicalTimestamp(receipt.claimedAt)
  );
}

function validV3Fields(receipt) {
  return (
    validCommon(receipt) &&
    Number.isSafeInteger(receipt.runAttempt) &&
    receipt.runAttempt > 0 &&
    typeof receipt.jobId === "string" &&
    decimalIdPattern.test(receipt.jobId ?? "") &&
    receipt.workflowPath === workflowPath &&
    typeof receipt.commit === "string" &&
    /^[a-f0-9]{40}$/u.test(receipt.commit ?? "") &&
    typeof receipt.imageDigest === "string" &&
    digestPattern.test(receipt.imageDigest ?? "")
  );
}

/**
 * Convert every accepted historical shape to one explicit receipt version.
 * Shape is part of the version discriminator: extra, missing, or malformed
 * fields are rejected instead of being discarded during normalization.
 */
export function normalizeMigrationEvidenceReceipt(receipt) {
  if (exactKeys(receipt, v2Fields) && validCommon(receipt)) {
    return Object.freeze({ ...receipt, receiptVersion: 2 });
  }
  if (
    exactKeys(receipt, [...v2Fields, "receiptVersion"]) &&
    receipt.receiptVersion === 2 &&
    validCommon(receipt)
  ) {
    return Object.freeze({ ...receipt });
  }
  if (exactKeys(receipt, v3Fields) && validV3Fields(receipt)) {
    return Object.freeze({ ...receipt, receiptVersion: 3 });
  }
  if (
    exactKeys(receipt, [...v3Fields, "receiptVersion"]) &&
    receipt.receiptVersion === 3 &&
    validV3Fields(receipt)
  ) {
    return Object.freeze({ ...receipt });
  }
  if (
    exactKeys(receipt, v4Fields) &&
    receipt.receiptVersion === 4 &&
    validV3Fields(receipt) &&
    typeof receipt.systemIdentifier === "string" &&
    /^[0-9]+$/u.test(receipt.systemIdentifier ?? "") &&
    typeof receipt.recoveryWitnessSha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(receipt.recoveryWitnessSha256 ?? "")
  ) {
    return Object.freeze({ ...receipt });
  }
  throw new Error("migration evidence receipt is malformed or unsupported");
}

export function normalizeMigrationEvidenceReceipts(receipts) {
  if (!Array.isArray(receipts) || receipts.length === 0) {
    throw new Error("migration evidence receipt array is empty or invalid");
  }
  const normalized = receipts.map(normalizeMigrationEvidenceReceipt);
  const replayKeys = normalized.flatMap((receipt) => [
    receipt.artifactDigest,
    `rollout:${receipt.rolloutId}`,
    `run-artifact:${receipt.runId}:${receipt.artifactId}`,
  ]);
  if (new Set(replayKeys).size !== replayKeys.length) {
    throw new Error("migration evidence receipt replay keys are duplicated");
  }
  return Object.freeze(normalized);
}

export function isGenerationBoundMigrationReceipt(receipt, generation) {
  return (
    receipt?.receiptVersion === 4 &&
    receipt.systemIdentifier === generation?.systemIdentifier &&
    receipt.recoveryWitnessSha256 === generation?.recoveryWitnessSha256
  );
}
