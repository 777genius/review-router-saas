import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";

const algorithm = "aes-256-gcm" as const;
const schemaVersion = 1 as const;

export type CredentialEnvelopeContext = {
  readonly workspaceId: string;
  readonly poolId: string;
  readonly accountId: string;
  readonly generation: number;
  readonly databaseIncarnation: string;
};

export type WrappedDataEncryptionKey = {
  readonly keyId: string;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly authenticationTag: string;
};

export interface CredentialKeyringPort {
  readonly currentKeyId: string;
  wrapDataEncryptionKey(input: {
    readonly dataEncryptionKey: Uint8Array;
    readonly associatedData: Uint8Array;
  }): Promise<WrappedDataEncryptionKey>;
  unwrapDataEncryptionKey(input: {
    readonly wrappedKey: WrappedDataEncryptionKey;
    readonly associatedData: Uint8Array;
  }): Promise<Uint8Array>;
}

export type EncryptedCredentialEnvelope = {
  readonly schemaVersion: typeof schemaVersion;
  readonly encryptionAlgorithm: typeof algorithm;
  readonly keyId: string;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly authenticationTag: string;
  readonly wrappedDataEncryptionKey: WrappedDataEncryptionKey;
  readonly associatedDataHash: string;
  readonly ciphertextHash: string;
};

export class CredentialEnvelopeVault {
  constructor(private readonly keyring: CredentialKeyringPort) {}

  async encrypt(
    plaintext: Uint8Array,
    context: CredentialEnvelopeContext,
  ): Promise<EncryptedCredentialEnvelope> {
    if (plaintext.byteLength === 0)
      throw new Error("credential_plaintext_empty");
    const associatedData = encodeAssociatedData(context);
    const dataEncryptionKey = randomBytes(32);
    const nonce = randomBytes(12);
    try {
      const cipher = createCipheriv(algorithm, dataEncryptionKey, nonce);
      cipher.setAAD(associatedData);
      const ciphertext = Buffer.concat([
        cipher.update(Buffer.from(plaintext)),
        cipher.final(),
      ]);
      const authenticationTag = cipher.getAuthTag();
      const wrappedDataEncryptionKey = await this.keyring.wrapDataEncryptionKey(
        {
          dataEncryptionKey,
          associatedData,
        },
      );
      if (wrappedDataEncryptionKey.keyId !== this.keyring.currentKeyId) {
        throw new Error("credential_keyring_current_key_mismatch");
      }
      return {
        schemaVersion,
        encryptionAlgorithm: algorithm,
        keyId: wrappedDataEncryptionKey.keyId,
        nonce: nonce.toString("base64"),
        ciphertext: ciphertext.toString("base64"),
        authenticationTag: authenticationTag.toString("base64"),
        wrappedDataEncryptionKey,
        associatedDataHash: sha256(associatedData),
        ciphertextHash: sha256(ciphertext),
      };
    } finally {
      dataEncryptionKey.fill(0);
    }
  }

  async decrypt(
    envelope: EncryptedCredentialEnvelope,
    context: CredentialEnvelopeContext,
  ): Promise<Uint8Array> {
    if (
      envelope.schemaVersion !== schemaVersion ||
      envelope.encryptionAlgorithm !== algorithm ||
      envelope.keyId !== envelope.wrappedDataEncryptionKey.keyId
    ) {
      throw new Error("credential_envelope_unsupported");
    }
    const associatedData = encodeAssociatedData(context);
    if (sha256(associatedData) !== envelope.associatedDataHash) {
      throw new Error("credential_envelope_context_mismatch");
    }
    const ciphertext = decodeBase64(envelope.ciphertext);
    if (sha256(ciphertext) !== envelope.ciphertextHash) {
      throw new Error("credential_envelope_ciphertext_corrupt");
    }
    const dataEncryptionKey = Buffer.from(
      await this.keyring.unwrapDataEncryptionKey({
        wrappedKey: envelope.wrappedDataEncryptionKey,
        associatedData,
      }),
    );
    if (dataEncryptionKey.byteLength !== 32) {
      dataEncryptionKey.fill(0);
      throw new Error("credential_data_key_invalid");
    }
    try {
      const decipher = createDecipheriv(
        algorithm,
        dataEncryptionKey,
        decodeBase64(envelope.nonce),
      );
      decipher.setAAD(associatedData);
      decipher.setAuthTag(decodeBase64(envelope.authenticationTag));
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new Error("credential_envelope_authentication_failed");
    } finally {
      dataEncryptionKey.fill(0);
    }
  }
}

export class EnvCredentialKeyring implements CredentialKeyringPort {
  readonly currentKeyId: string;
  private readonly keys: ReadonlyMap<string, Buffer>;

  constructor(env: Readonly<Record<string, string | undefined>>) {
    const currentKeyId = env.REVIEW_ROUTER_HOSTED_CODEX_KEK_CURRENT_ID?.trim();
    const serialized = env.REVIEW_ROUTER_HOSTED_CODEX_KEK_KEYRING_JSON?.trim();
    if (!currentKeyId || !serialized) {
      throw new Error("hosted_codex_keyring_not_configured");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      throw new Error("hosted_codex_keyring_invalid");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("hosted_codex_keyring_invalid");
    }
    const keys = new Map<string, Buffer>();
    for (const [keyId, encoded] of Object.entries(parsed)) {
      if (!keyId || typeof encoded !== "string") continue;
      const key = decodeBase64(encoded);
      if (key.byteLength !== 32) throw new Error("hosted_codex_kek_invalid");
      keys.set(keyId, key);
    }
    if (!keys.has(currentKeyId))
      throw new Error("hosted_codex_current_kek_missing");
    this.currentKeyId = currentKeyId;
    this.keys = keys;
  }

  async wrapDataEncryptionKey(input: {
    readonly dataEncryptionKey: Uint8Array;
    readonly associatedData: Uint8Array;
  }): Promise<WrappedDataEncryptionKey> {
    const key = this.requireKey(this.currentKeyId);
    const nonce = randomBytes(12);
    const cipher = createCipheriv(algorithm, key, nonce);
    cipher.setAAD(Buffer.from(input.associatedData));
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(input.dataEncryptionKey)),
      cipher.final(),
    ]);
    return {
      keyId: this.currentKeyId,
      nonce: nonce.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      authenticationTag: cipher.getAuthTag().toString("base64"),
    };
  }

  async unwrapDataEncryptionKey(input: {
    readonly wrappedKey: WrappedDataEncryptionKey;
    readonly associatedData: Uint8Array;
  }): Promise<Uint8Array> {
    const decipher = createDecipheriv(
      algorithm,
      this.requireKey(input.wrappedKey.keyId),
      decodeBase64(input.wrappedKey.nonce),
    );
    decipher.setAAD(Buffer.from(input.associatedData));
    decipher.setAuthTag(decodeBase64(input.wrappedKey.authenticationTag));
    try {
      return Buffer.concat([
        decipher.update(decodeBase64(input.wrappedKey.ciphertext)),
        decipher.final(),
      ]);
    } catch {
      throw new Error("credential_wrapped_key_authentication_failed");
    }
  }

  private requireKey(keyId: string): Buffer {
    const key = this.keys.get(keyId);
    if (!key) throw new Error("credential_kek_unavailable");
    return key;
  }
}

export function stableAccountFingerprint(input: {
  readonly canonicalSubject: string;
  readonly pepper: Uint8Array;
}): string {
  if (!input.canonicalSubject.trim() || input.pepper.byteLength < 32) {
    throw new Error("account_fingerprint_input_invalid");
  }
  return createHmac("sha256", input.pepper)
    .update(input.canonicalSubject.trim().toLowerCase(), "utf8")
    .digest("hex");
}

function encodeAssociatedData(context: CredentialEnvelopeContext): Buffer {
  if (!Number.isSafeInteger(context.generation) || context.generation < 1) {
    throw new Error("credential_generation_invalid");
  }
  const fields = [
    context.workspaceId,
    context.poolId,
    context.accountId,
    String(context.generation),
    `schema:${schemaVersion}`,
    context.databaseIncarnation,
  ];
  if (fields.some((field) => !field || field.includes("\u0000"))) {
    throw new Error("credential_envelope_context_invalid");
  }
  return Buffer.from(fields.join("\u0000"), "utf8");
}

function decodeBase64(value: string): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (!value || decoded.toString("base64") !== value) {
    throw new Error("credential_envelope_base64_invalid");
  }
  return decoded;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
