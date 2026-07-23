import { Buffer } from "node:buffer";
import {
  ConfiguredCapabilityKeyRing,
  type ConfiguredCapabilityVerificationKey,
} from "@reviewrouter/platform-signed-capabilities";

export const reviewRunAuthorizationActiveKeyIdEnv =
  "REVIEW_ROUTER_REVIEW_RUN_AUTHORIZATION_ACTIVE_KEY_ID";
export const reviewRunAuthorizationKeysEnv =
  "REVIEW_ROUTER_REVIEW_RUN_AUTHORIZATION_KEYS_JSON";

export function createReviewRunAuthorizationKeyRingFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): ConfiguredCapabilityKeyRing {
  const activeKeyId = env[reviewRunAuthorizationActiveKeyIdEnv];
  const rawKeys = env[reviewRunAuthorizationKeysEnv];
  if (!activeKeyId || !rawKeys) {
    throw new Error("review_run_authorization_signing_keys_missing");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawKeys);
  } catch {
    throw new Error("review_run_authorization_signing_keys_invalid");
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 10) {
    throw new Error("review_run_authorization_signing_keys_invalid");
  }
  return new ConfiguredCapabilityKeyRing({
    activeKeyId,
    keys: parsed.map(parseKey),
  });
}

function parseKey(value: unknown): ConfiguredCapabilityVerificationKey {
  if (!isRecord(value)) {
    throw new Error("review_run_authorization_signing_key_invalid");
  }
  const actualKeys = Object.keys(value).sort().join(",");
  if (actualKeys !== "keyId,secretBase64,verifyUntil") {
    throw new Error("review_run_authorization_signing_key_shape_invalid");
  }
  if (
    typeof value.keyId !== "string" ||
    typeof value.secretBase64 !== "string" ||
    (value.verifyUntil !== null && typeof value.verifyUntil !== "string")
  ) {
    throw new Error("review_run_authorization_signing_key_invalid");
  }
  const secret = decodeCanonicalBase64(value.secretBase64);
  const verifyUntil =
    value.verifyUntil === null ? null : parseIsoTimestamp(value.verifyUntil);
  return { keyId: value.keyId, secret, verifyUntil };
}

function decodeCanonicalBase64(value: string): Uint8Array {
  if (value.length < 44 || value.length > 5_464 || !base64Pattern.test(value)) {
    throw new Error("review_run_authorization_signing_key_invalid");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength < 32 || decoded.toString("base64") !== value) {
    throw new Error("review_run_authorization_signing_key_invalid");
  }
  return new Uint8Array(decoded);
}

function parseIsoTimestamp(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error("review_run_authorization_signing_key_expiry_invalid");
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const base64Pattern =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
