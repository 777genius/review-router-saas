import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { InvestigationPrivateMaterialCipherPort } from "../../application/ports/investigation-private-material-ports";
import {
  createEncryptedInvestigationPrivateMaterial,
  investigationPrivateMaterialEncryptionAlgorithm,
  investigationPrivateMaterialMaxPlaintextBytes,
  type EncryptedInvestigationPrivateMaterial,
} from "../../domain/investigation-private-material";

export class AesGcmInvestigationPrivateMaterialCipher implements InvestigationPrivateMaterialCipherPort {
  private readonly keys: ReadonlyMap<string, Buffer>;

  constructor(
    private readonly activeKeyId: string,
    keys: ReadonlyMap<string, Uint8Array>,
  ) {
    if (!validKeyId(activeKeyId)) {
      throw new Error("investigation_private_material_active_key_id_invalid");
    }
    const copied = new Map<string, Buffer>();
    for (const [keyId, key] of keys) {
      if (!validKeyId(keyId) || key.byteLength !== 32) {
        throw new Error("investigation_private_material_key_invalid");
      }
      copied.set(keyId, Buffer.from(key));
    }
    if (!copied.has(activeKeyId)) {
      throw new Error("investigation_private_material_active_key_missing");
    }
    this.keys = copied;
  }

  async encrypt(input: {
    readonly privateMaterialId: string;
    readonly investigationId: string;
    readonly obligationId: string | null;
    readonly plaintextCanonicalJson: string;
    readonly associatedDataCanonicalJson: string;
    readonly createdAt: string;
    readonly expiresAt: string;
  }): Promise<EncryptedInvestigationPrivateMaterial> {
    const plaintext = boundedJsonBytes(
      input.plaintextCanonicalJson,
      "investigation_private_material_plaintext",
    );
    const associatedData = boundedJsonBytes(
      input.associatedDataCanonicalJson,
      "investigation_private_material_associated_data",
    );
    const key = this.keys.get(this.activeKeyId)!;
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(associatedData);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    return createEncryptedInvestigationPrivateMaterial({
      privateMaterialId: input.privateMaterialId,
      investigationId: input.investigationId,
      obligationId: input.obligationId,
      algorithm: investigationPrivateMaterialEncryptionAlgorithm,
      keyId: this.activeKeyId,
      nonceBase64Url: nonce.toString("base64url"),
      authTagBase64Url: cipher.getAuthTag().toString("base64url"),
      ciphertextBase64Url: ciphertext.toString("base64url"),
      associatedDataHash: sha256(associatedData),
      plaintextHash: plaintextMac(key, nonce, plaintext),
      byteCount: plaintext.byteLength,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
    });
  }

  async decrypt(input: {
    readonly material: EncryptedInvestigationPrivateMaterial;
    readonly associatedDataCanonicalJson: string;
  }): Promise<string> {
    const material = createEncryptedInvestigationPrivateMaterial(
      input.material,
    );
    const key = this.keys.get(material.keyId);
    if (!key) {
      throw new Error("investigation_private_material_key_unavailable");
    }
    const associatedData = boundedJsonBytes(
      input.associatedDataCanonicalJson,
      "investigation_private_material_associated_data",
    );
    if (!sameHash(sha256(associatedData), material.associatedDataHash)) {
      throw new Error(
        "investigation_private_material_associated_data_mismatch",
      );
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
      !sameHash(
        plaintextMac(
          key,
          Buffer.from(material.nonceBase64Url, "base64url"),
          plaintext,
        ),
        material.plaintextHash,
      )
    ) {
      throw new Error("investigation_private_material_integrity_mismatch");
    }
    return plaintext.toString("utf8");
  }
}

function boundedJsonBytes(value: string, field: string): Buffer {
  if (typeof value !== "string") throw new Error(`${field}_invalid`);
  const bytes = Buffer.from(value, "utf8");
  if (
    bytes.byteLength < 2 ||
    bytes.byteLength > investigationPrivateMaterialMaxPlaintextBytes
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

function validKeyId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(value);
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function plaintextMac(
  key: Uint8Array,
  nonce: Uint8Array,
  value: Uint8Array,
): string {
  const recordKey = createHmac("sha256", key)
    .update("reviewrouter.investigation-private-material.mac-key.v1\0", "utf8")
    .update(nonce)
    .digest();
  return createHmac("sha256", recordKey)
    .update("reviewrouter.investigation-private-material.v1\0", "utf8")
    .update(value)
    .digest("hex");
}

function sameHash(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}
