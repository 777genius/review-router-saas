import {
  assertActivationCatalogRawCaptureEvidence,
  type ActivationCatalogRawCaptureEvidence,
} from "./activation-catalog-policy-provenance-contract";
import { canonicalReleaseMigrationPostManifestIdentity } from "./release-migration-artifact-identity.js";
import activationCatalogRawPromotionTrustRootData from "./activation-catalog-policy-raw-promotion-trust-root.json";

export const activationCatalogRawPromotionOptIn =
  "promote-reviewed-activation-catalog-raw-v1";

export const activationCatalogRawReviewArtifactRepositoryPath =
  "docs/release-evidence/activation-catalog-policy-raw-independent-review.md";
export const activationCatalogRawReviewerRuntimeRepositoryPath =
  "docs/release-evidence/activation-catalog-policy-raw-reviewer-runtime.json";

export type ActivationCatalogRawPromotionTrustRootPending = Readonly<{
  status: "pending";
  reason: "fresh-authenticated-raw-capture-and-independent-review-required";
}>;

export type ActivationCatalogRawPromotionTrustRootReady = Readonly<{
  status: "ready";
  optIn: typeof activationCatalogRawPromotionOptIn;
  evidence: ActivationCatalogRawCaptureEvidence;
  independentReview: Readonly<{
    // V1 binds the historical capture base; V2 binds the reviewed audited head.
    contractVersion: 1 | 2;
    reviewArtifact: Readonly<{
      repositoryPath: typeof activationCatalogRawReviewArtifactRepositoryPath;
      bytes: number;
      sha256: string;
    }>;
    reviewerRuntime: Readonly<{
      repositoryPath: typeof activationCatalogRawReviewerRuntimeRepositoryPath;
      bytes: number;
      sha256: string;
    }>;
    reviewerRunId: string;
    reviewerTaskId: string;
    reviewedAt: string;
    completedAt: string;
  }>;
}>;

export type ActivationCatalogRawPromotionTrustRoot =
  | ActivationCatalogRawPromotionTrustRootPending
  | ActivationCatalogRawPromotionTrustRootReady;

const rawSha256 = /^[a-f0-9]{64}$/u;
const rawLabel = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/u;
const rawTimestamp =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z$/u;

const exactRawRootRecord = (
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === fields.length &&
  fields.every((field) => Object.hasOwn(value, field));

const deepFreeze = <T>(
  value: T,
  seen: WeakSet<object> = new WeakSet<object>(),
): T => {
  if (value === null || typeof value !== "object" || seen.has(value))
    return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value))
    deepFreeze(Reflect.get(value, key), seen);
  Object.freeze(value);
  return value;
};

const deeplyFrozen = (
  value: unknown,
  seen: WeakSet<object> = new WeakSet<object>(),
): boolean => {
  if (value === null || typeof value !== "object") return true;
  if (seen.has(value)) return true;
  seen.add(value);
  return (
    Object.isFrozen(value) &&
    Reflect.ownKeys(value).every((key) =>
      deeplyFrozen(Reflect.get(value, key), seen),
    )
  );
};

const validRawTimestamp = (value: unknown): value is string =>
  typeof value === "string" &&
  rawTimestamp.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(Date.parse(value)).toISOString() ===
    (value.includes(".") ? value : value.replace(/Z$/u, ".000Z"));

export function activationCatalogRawTrustRootReadiness(
  value: unknown,
): Readonly<{ status: "pending" | "ready"; reason: string }> {
  if (
    exactRawRootRecord(value, ["status", "reason"]) &&
    value.status === "pending" &&
    value.reason ===
      "fresh-authenticated-raw-capture-and-independent-review-required"
  )
    return Object.freeze({ status: "pending", reason: value.reason });

  try {
    if (
      !exactRawRootRecord(value, [
        "status",
        "optIn",
        "evidence",
        "independentReview",
      ]) ||
      value.status !== "ready" ||
      value.optIn !== activationCatalogRawPromotionOptIn
    )
      throw new Error("invalid");

    assertActivationCatalogRawCaptureEvidence(value.evidence);
    const evidence = value.evidence;
    if (
      evidence.captures[0].label !==
        "activation-catalog-policy-candidate-1.json" ||
      evidence.captures[1].label !==
        "activation-catalog-policy-candidate-2.json" ||
      evidence.selectedCaptureId !== evidence.captures[0].label ||
      evidence.captures[0].sha256 === evidence.captures[1].sha256 ||
      evidence.postManifestIdentity !==
        canonicalReleaseMigrationPostManifestIdentity
    )
      throw new Error("invalid");

    const review = value.independentReview;
    if (
      !exactRawRootRecord(review, [
        "contractVersion",
        "reviewArtifact",
        "reviewerRuntime",
        "reviewerRunId",
        "reviewerTaskId",
        "reviewedAt",
        "completedAt",
      ]) ||
      (review.contractVersion !== 1 && review.contractVersion !== 2) ||
      !exactRawRootRecord(review.reviewArtifact, [
        "repositoryPath",
        "bytes",
        "sha256",
      ]) ||
      review.reviewArtifact.repositoryPath !==
        activationCatalogRawReviewArtifactRepositoryPath ||
      !exactRawRootRecord(review.reviewerRuntime, [
        "repositoryPath",
        "bytes",
        "sha256",
      ]) ||
      review.reviewerRuntime.repositoryPath !==
        activationCatalogRawReviewerRuntimeRepositoryPath ||
      ![review.reviewArtifact, review.reviewerRuntime].every(
        (file) =>
          typeof file.bytes === "number" &&
          Number.isSafeInteger(file.bytes) &&
          file.bytes > 0 &&
          file.bytes <= 16 * 1024 * 1024 &&
          typeof file.sha256 === "string" &&
          rawSha256.test(file.sha256),
      ) ||
      typeof review.reviewerRunId !== "string" ||
      !rawLabel.test(review.reviewerRunId) ||
      typeof review.reviewerTaskId !== "string" ||
      !rawLabel.test(review.reviewerTaskId) ||
      !validRawTimestamp(review.reviewedAt) ||
      !validRawTimestamp(review.completedAt) ||
      Date.parse(review.reviewedAt) >= Date.parse(review.completedAt)
    )
      throw new Error("invalid");

    return Object.freeze({
      status: "ready",
      reason: "authenticated-raw-capture-and-independent-review-bound",
    });
  } catch {
    return Object.freeze({
      status: "pending",
      reason: "activation-catalog-policy-raw-trust-root-invalid",
    });
  }
}

export function assertActivationCatalogRawPromotionTrustRootReady(
  value: unknown,
): asserts value is ActivationCatalogRawPromotionTrustRootReady {
  const readiness = activationCatalogRawTrustRootReadiness(value);
  if (readiness.status !== "ready" || !deeplyFrozen(value))
    throw new Error(
      `activation_catalog_policy_raw_trust_root_${
        exactRawRootRecord(value, ["status", "reason"]) &&
        value.status === "pending" &&
        value.reason ===
          "fresh-authenticated-raw-capture-and-independent-review-required"
          ? "pending"
          : "invalid"
      }`,
    );
}

export const loadActivationCatalogRawPromotionTrustRoot = (
  value: unknown,
): ActivationCatalogRawPromotionTrustRoot => {
  const frozen = deepFreeze(value);
  if (
    exactRawRootRecord(frozen, ["status", "reason"]) &&
    frozen.status === "pending" &&
    frozen.reason ===
      "fresh-authenticated-raw-capture-and-independent-review-required"
  )
    return frozen as ActivationCatalogRawPromotionTrustRootPending;

  assertActivationCatalogRawPromotionTrustRootReady(frozen);
  return frozen;
};

// The JSON file is the sole post-capture trust-data surface. Loading,
// validation, and deep immutability remain in this audited module.
export const activationCatalogRawPromotionTrustRoot =
  loadActivationCatalogRawPromotionTrustRoot(
    activationCatalogRawPromotionTrustRootData,
  );
