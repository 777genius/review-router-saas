import {
  createPublicKey,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";
import type { InvestigationEvaluationSignatureVerifierPort } from "../../application/ports/operations-ports";
import { InvestigationEvaluationSignatureAlgorithm } from "../../domain/investigation-evaluation";

export type ConfiguredInvestigationEvaluationPublicKey = Readonly<{
  keyId: string;
  publicKeySpkiBase64: string;
  notBefore: string;
  verifyUntil: string | null;
}>;

type VerificationKey = Readonly<{
  key: KeyObject;
  notBefore: number;
  verifyUntil: number | null;
}>;

export class ConfiguredEd25519InvestigationEvaluationVerifier implements InvestigationEvaluationSignatureVerifierPort {
  private readonly keys: ReadonlyMap<string, VerificationKey>;

  constructor(keys: readonly ConfiguredInvestigationEvaluationPublicKey[]) {
    if (keys.length < 1 || keys.length > 32) {
      throw new Error("evaluation_verification_key_count_invalid");
    }
    const parsed = new Map<string, VerificationKey>();
    for (const item of keys) {
      if (parsed.has(item.keyId)) {
        throw new Error("evaluation_verification_key_id_duplicate");
      }
      parsed.set(item.keyId, parseKey(item));
    }
    this.keys = parsed;
  }

  static fromJson(
    value: string,
  ): ConfiguredEd25519InvestigationEvaluationVerifier {
    let decoded: unknown;
    try {
      decoded = JSON.parse(value);
    } catch {
      throw new Error("evaluation_verification_keys_json_invalid");
    }
    if (!Array.isArray(decoded)) {
      throw new Error("evaluation_verification_keys_json_invalid");
    }
    return new ConfiguredEd25519InvestigationEvaluationVerifier(
      decoded.map(parseConfiguredKey),
    );
  }

  async verify(
    input: Parameters<
      InvestigationEvaluationSignatureVerifierPort["verify"]
    >[0],
  ): Promise<boolean> {
    if (
      input.algorithm !== InvestigationEvaluationSignatureAlgorithm.Ed25519 ||
      !Number.isFinite(input.now.getTime())
    ) {
      return false;
    }
    const configured = this.keys.get(input.keyId);
    if (!configured) return false;
    const issuedAt = Date.parse(input.issuedAt);
    if (
      !Number.isFinite(issuedAt) ||
      issuedAt < configured.notBefore ||
      input.now.getTime() < configured.notBefore ||
      (configured.verifyUntil !== null &&
        (issuedAt >= configured.verifyUntil ||
          input.now.getTime() >= configured.verifyUntil))
    ) {
      return false;
    }
    let signature: Buffer;
    try {
      signature = Buffer.from(input.signature, "base64url");
    } catch {
      return false;
    }
    if (
      signature.byteLength !== 64 ||
      signature.toString("base64url") !== input.signature
    ) {
      return false;
    }
    try {
      return verifySignature(
        null,
        Buffer.from(input.payloadCanonicalJson, "utf8"),
        configured.key,
        signature,
      );
    } catch {
      return false;
    }
  }
}

function parseConfiguredKey(
  input: unknown,
): ConfiguredInvestigationEvaluationPublicKey {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("evaluation_verification_key_invalid");
  }
  const record = input as Record<string, unknown>;
  const fields = Object.keys(record).sort();
  const expected = [
    "keyId",
    "notBefore",
    "publicKeySpkiBase64",
    "verifyUntil",
  ].sort();
  if (
    fields.length !== expected.length ||
    fields.some((field, index) => field !== expected[index]) ||
    typeof record.keyId !== "string" ||
    typeof record.publicKeySpkiBase64 !== "string" ||
    typeof record.notBefore !== "string" ||
    (record.verifyUntil !== null && typeof record.verifyUntil !== "string")
  ) {
    throw new Error("evaluation_verification_key_invalid");
  }
  return Object.freeze({
    keyId: record.keyId,
    publicKeySpkiBase64: record.publicKeySpkiBase64,
    notBefore: record.notBefore,
    verifyUntil: record.verifyUntil,
  });
}

function parseKey(
  input: ConfiguredInvestigationEvaluationPublicKey,
): VerificationKey {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(input.keyId)) {
    throw new Error("evaluation_verification_key_id_invalid");
  }
  const notBefore = canonicalTimestamp(
    input.notBefore,
    "evaluation_verification_key_not_before_invalid",
  );
  const verifyUntil =
    input.verifyUntil === null
      ? null
      : canonicalTimestamp(
          input.verifyUntil,
          "evaluation_verification_key_verify_until_invalid",
        );
  if (verifyUntil !== null && verifyUntil <= notBefore) {
    throw new Error("evaluation_verification_key_window_invalid");
  }
  if (
    input.publicKeySpkiBase64.length > 512 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(input.publicKeySpkiBase64)
  ) {
    throw new Error("evaluation_verification_public_key_invalid");
  }
  let key: KeyObject;
  try {
    const der = Buffer.from(input.publicKeySpkiBase64, "base64");
    if (der.toString("base64") !== input.publicKeySpkiBase64) {
      throw new Error("public_key_encoding_invalid");
    }
    key = createPublicKey({ key: der, format: "der", type: "spki" });
  } catch {
    throw new Error("evaluation_verification_public_key_invalid");
  }
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
    throw new Error("evaluation_verification_public_key_invalid");
  }
  return Object.freeze({ key, notBefore, verifyUntil });
}

function canonicalTimestamp(value: string, errorCode: string): number {
  if (
    !value.endsWith("Z") ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error(errorCode);
  }
  return Date.parse(value);
}
