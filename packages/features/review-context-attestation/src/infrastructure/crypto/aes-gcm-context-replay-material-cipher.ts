import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { ContextReplayMaterialCipherPort } from "../../application/ports/context-attestation-ports";
import {
  contextReplayMaterialEncryptionAlgorithm,
  contextReplayMaterialMaxPlaintextBytes,
  createEncryptedContextReplayMaterial,
  type EncryptedContextReplayMaterial,
} from "../../domain/encrypted-context-replay-material";

export class AesGcmContextReplayMaterialCipher implements ContextReplayMaterialCipherPort {
  private readonly keys: ReadonlyMap<string, Buffer>;

  constructor(
    private readonly activeKeyId: string,
    keys: ReadonlyMap<string, Uint8Array>,
  ) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(activeKeyId)) {
      throw new Error("context_replay_active_key_id_invalid");
    }
    const copied = new Map<string, Buffer>();
    for (const [keyId, key] of keys) {
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(keyId) ||
        key.byteLength !== 32
      ) {
        throw new Error("context_replay_key_invalid");
      }
      copied.set(keyId, Buffer.from(key));
    }
    if (!copied.has(activeKeyId)) {
      throw new Error("context_replay_active_key_missing");
    }
    this.keys = copied;
  }

  async encrypt(input: {
    readonly sessionId: string;
    readonly plaintextCanonicalJson: string;
    readonly associatedDataCanonicalJson: string;
    readonly expiresAtMs: number;
  }): Promise<EncryptedContextReplayMaterial> {
    const plaintext = boundedJsonBytes(
      input.plaintextCanonicalJson,
      "context_replay_plaintext",
    );
    const associatedData = boundedJsonBytes(
      input.associatedDataCanonicalJson,
      "context_replay_associated_data",
    );
    const key = this.keys.get(this.activeKeyId)!;
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(associatedData);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    return createEncryptedContextReplayMaterial({
      sessionId: input.sessionId,
      algorithm: contextReplayMaterialEncryptionAlgorithm,
      keyId: this.activeKeyId,
      nonceBase64Url: nonce.toString("base64url"),
      authTagBase64Url: cipher.getAuthTag().toString("base64url"),
      ciphertextBase64Url: ciphertext.toString("base64url"),
      associatedDataHash: sha256(associatedData),
      plaintextHash: plaintextMac(key, plaintext),
      byteCount: plaintext.byteLength,
      expiresAtMs: input.expiresAtMs,
    });
  }

  async decrypt(input: {
    readonly material: EncryptedContextReplayMaterial;
    readonly associatedDataCanonicalJson: string;
  }): Promise<string> {
    const material = createEncryptedContextReplayMaterial(input.material);
    const key = this.keys.get(material.keyId);
    if (!key) throw new Error("context_replay_decryption_key_unavailable");
    const associatedData = boundedJsonBytes(
      input.associatedDataCanonicalJson,
      "context_replay_associated_data",
    );
    if (!sameHash(sha256(associatedData), material.associatedDataHash)) {
      throw new Error("context_replay_associated_data_mismatch");
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(material.nonceBase64Url, "base64url"),
    );
    decipher.setAAD(associatedData);
    decipher.setAuthTag(Buffer.from(material.authTagBase64Url, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(material.ciphertextBase64Url, "base64url")),
      decipher.final(),
    ]);
    if (
      plaintext.byteLength !== material.byteCount ||
      !sameHash(plaintextMac(key, plaintext), material.plaintextHash)
    ) {
      throw new Error("context_replay_plaintext_integrity_mismatch");
    }
    return plaintext.toString("utf8");
  }
}

function boundedJsonBytes(value: string, field: string): Buffer {
  if (typeof value !== "string") throw new Error(`${field}_invalid`);
  const bytes = Buffer.from(value, "utf8");
  if (
    bytes.byteLength < 2 ||
    bytes.byteLength > contextReplayMaterialMaxPlaintextBytes
  ) {
    throw new Error(`${field}_size_invalid`);
  }
  try {
    JSON.parse(value);
  } catch {
    throw new Error(`${field}_invalid`);
  }
  return bytes;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function plaintextMac(key: Uint8Array, value: Uint8Array): string {
  return createHmac("sha256", key)
    .update("reviewrouter.context-replay-plaintext.v1\0", "utf8")
    .update(value)
    .digest("hex");
}

function sameHash(left: string, right: string): boolean {
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
