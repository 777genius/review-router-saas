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
  /** Externally witnessed immutable database resource identity, never copied from a restore. */
  readonly databaseResourceIdentity: string;
};

export type CredentialKeyringContext = CredentialEnvelopeContext & {
  readonly purpose: "relay" | "recovery";
  readonly schemaVersion: typeof schemaVersion;
};

export type WrappedDataEncryptionKey = {
  readonly keyId: string;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly authenticationTag: string;
};

export interface CredentialKeyringPort {
  readonly currentKeyId: string;
  readonly custodyMode?: "local_env" | "aws_kms";
  wrapDataEncryptionKey(input: {
    readonly dataEncryptionKey: Uint8Array;
    readonly associatedData: Uint8Array;
    readonly context: CredentialKeyringContext;
  }): Promise<WrappedDataEncryptionKey>;
  unwrapDataEncryptionKey(input: {
    readonly wrappedKey: WrappedDataEncryptionKey;
    readonly associatedData: Uint8Array;
    readonly context: CredentialKeyringContext;
    readonly signal?: AbortSignal;
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

export type PreparedCredentialEnvelopeCapture = {
  /** Local-only capture: all remote key wrapping completed before this exists. */
  capture(plaintext: Uint8Array): EncryptedCredentialEnvelope;
  destroy(): void;
};

export class CredentialEnvelopeVault {
  constructor(
    private readonly keyring: CredentialKeyringPort,
    private readonly purpose: CredentialKeyringContext["purpose"] = "relay",
  ) {}

  get currentKeyId(): string {
    return this.keyring.currentKeyId;
  }

  async encrypt(
    plaintext: Uint8Array,
    context: CredentialEnvelopeContext,
  ): Promise<EncryptedCredentialEnvelope> {
    const prepared = await this.prepareEncrypt(context);
    try {
      return prepared.capture(plaintext);
    } finally {
      prepared.destroy();
    }
  }

  /**
   * Wraps a fresh DEK before an external operation can yield a bearer. Once
   * prepared, capture performs only synchronous local authenticated encryption
   * and cannot fail because KMS or another remote dependency is unavailable.
   */
  async prepareEncrypt(
    context: CredentialEnvelopeContext,
  ): Promise<PreparedCredentialEnvelopeCapture> {
    const associatedData = encodeAssociatedData(context);
    const dataEncryptionKey = randomBytes(32);
    try {
      const wrappedDataEncryptionKey = await this.keyring.wrapDataEncryptionKey(
        {
          dataEncryptionKey,
          associatedData,
          context: this.keyringContext(context),
        },
      );
      if (wrappedDataEncryptionKey.keyId !== this.keyring.currentKeyId) {
        throw new Error("credential_keyring_current_key_mismatch");
      }
      let destroyed = false;
      return {
        capture: (plaintext) => {
          if (destroyed) throw new Error("credential_capture_destroyed");
          if (plaintext.byteLength === 0)
            throw new Error("credential_plaintext_empty");
          const nonce = randomBytes(12);
          const plaintextCopy = Buffer.from(plaintext);
          let ciphertext: Buffer | undefined;
          let authenticationTag: Buffer | undefined;
          try {
            const cipher = createCipheriv(algorithm, dataEncryptionKey, nonce);
            cipher.setAAD(associatedData);
            ciphertext = Buffer.concat([
              cipher.update(plaintextCopy),
              cipher.final(),
            ]);
            authenticationTag = cipher.getAuthTag();
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
            plaintextCopy.fill(0);
            authenticationTag?.fill(0);
            ciphertext?.fill(0);
            nonce.fill(0);
          }
        },
        destroy: () => {
          if (destroyed) return;
          destroyed = true;
          dataEncryptionKey.fill(0);
          associatedData.fill(0);
        },
      };
    } catch (error) {
      dataEncryptionKey.fill(0);
      associatedData.fill(0);
      throw error;
    }
  }

  async decrypt(
    envelope: EncryptedCredentialEnvelope,
    context: CredentialEnvelopeContext,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    if (
      envelope.schemaVersion !== schemaVersion ||
      envelope.encryptionAlgorithm !== algorithm ||
      envelope.keyId !== envelope.wrappedDataEncryptionKey.keyId
    ) {
      throw new Error("credential_envelope_unsupported");
    }
    const associatedData = encodeAssociatedData(context);
    let ciphertext: Buffer | undefined;
    let nonce: Buffer | undefined;
    let authenticationTag: Buffer | undefined;
    let unwrappedDataEncryptionKey: Uint8Array | undefined;
    let dataEncryptionKey: Buffer | undefined;
    try {
      if (sha256(associatedData) !== envelope.associatedDataHash)
        throw new Error("credential_envelope_context_mismatch");
      ciphertext = decodeBase64(envelope.ciphertext);
      if (sha256(ciphertext) !== envelope.ciphertextHash)
        throw new Error("credential_envelope_ciphertext_corrupt");
      nonce = decodeBase64(envelope.nonce);
      authenticationTag = decodeBase64(envelope.authenticationTag);
      unwrappedDataEncryptionKey = await this.keyring.unwrapDataEncryptionKey({
        wrappedKey: envelope.wrappedDataEncryptionKey,
        associatedData,
        context: this.keyringContext(context),
        ...(signal ? { signal } : {}),
      });
      dataEncryptionKey = Buffer.from(unwrappedDataEncryptionKey);
      if (dataEncryptionKey.byteLength !== 32)
        throw new Error("credential_data_key_invalid");
      const decipher = createDecipheriv(algorithm, dataEncryptionKey, nonce);
      decipher.setAAD(associatedData);
      decipher.setAuthTag(authenticationTag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch (error) {
      if (
        error instanceof Error &&
        [
          "credential_envelope_context_mismatch",
          "credential_envelope_ciphertext_corrupt",
          "credential_data_key_invalid",
          "credential_envelope_base64_invalid",
        ].includes(error.message)
      )
        throw error;
      throw new Error("credential_envelope_authentication_failed", {
        cause: error,
      });
    } finally {
      dataEncryptionKey?.fill(0);
      unwrappedDataEncryptionKey?.fill(0);
      authenticationTag?.fill(0);
      nonce?.fill(0);
      ciphertext?.fill(0);
      associatedData.fill(0);
    }
  }

  /** Rotates only the wrapped DEK; credential ciphertext remains encrypted. */
  async rewrap(
    envelope: EncryptedCredentialEnvelope,
    context: CredentialEnvelopeContext,
  ): Promise<EncryptedCredentialEnvelope> {
    const associatedData = encodeAssociatedData(context);
    let unwrappedDataEncryptionKey: Uint8Array | undefined;
    let dataEncryptionKey: Buffer | undefined;
    try {
      if (sha256(associatedData) !== envelope.associatedDataHash)
        throw new Error("credential_envelope_context_mismatch");
      unwrappedDataEncryptionKey = await this.keyring.unwrapDataEncryptionKey({
        wrappedKey: envelope.wrappedDataEncryptionKey,
        associatedData,
        context: this.keyringContext(context),
      });
      dataEncryptionKey = Buffer.from(unwrappedDataEncryptionKey);
      if (dataEncryptionKey.byteLength !== 32)
        throw new Error("credential_data_key_invalid");
      const wrappedDataEncryptionKey = await this.keyring.wrapDataEncryptionKey(
        {
          dataEncryptionKey,
          associatedData,
          context: this.keyringContext(context),
        },
      );
      if (wrappedDataEncryptionKey.keyId !== this.keyring.currentKeyId) {
        throw new Error("credential_keyring_current_key_mismatch");
      }
      return {
        ...envelope,
        keyId: wrappedDataEncryptionKey.keyId,
        wrappedDataEncryptionKey,
      };
    } finally {
      dataEncryptionKey?.fill(0);
      unwrappedDataEncryptionKey?.fill(0);
      associatedData.fill(0);
    }
  }

  private keyringContext(
    context: CredentialEnvelopeContext,
  ): CredentialKeyringContext {
    return { ...context, purpose: this.purpose, schemaVersion };
  }
}

export class EnvCredentialKeyring implements CredentialKeyringPort {
  readonly custodyMode = "local_env" as const;
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
      if (key.byteLength !== 32) {
        key.fill(0);
        for (const retained of keys.values()) retained.fill(0);
        throw new Error("hosted_codex_kek_invalid");
      }
      keys.set(keyId, key);
    }
    if (!keys.has(currentKeyId)) {
      for (const retained of keys.values()) retained.fill(0);
      throw new Error("hosted_codex_current_kek_missing");
    }
    this.currentKeyId = currentKeyId;
    this.keys = keys;
  }

  async wrapDataEncryptionKey(input: {
    readonly dataEncryptionKey: Uint8Array;
    readonly associatedData: Uint8Array;
  }): Promise<WrappedDataEncryptionKey> {
    const key = this.requireKey(this.currentKeyId);
    const nonce = randomBytes(12);
    const associatedData = Buffer.from(input.associatedData);
    const dataEncryptionKey = Buffer.from(input.dataEncryptionKey);
    let ciphertext: Buffer | undefined;
    let authenticationTag: Buffer | undefined;
    try {
      const cipher = createCipheriv(algorithm, key, nonce);
      cipher.setAAD(associatedData);
      ciphertext = Buffer.concat([
        cipher.update(dataEncryptionKey),
        cipher.final(),
      ]);
      authenticationTag = cipher.getAuthTag();
      return {
        keyId: this.currentKeyId,
        nonce: nonce.toString("base64"),
        ciphertext: ciphertext.toString("base64"),
        authenticationTag: authenticationTag.toString("base64"),
      };
    } finally {
      authenticationTag?.fill(0);
      ciphertext?.fill(0);
      dataEncryptionKey.fill(0);
      associatedData.fill(0);
      nonce.fill(0);
    }
  }

  async unwrapDataEncryptionKey(input: {
    readonly wrappedKey: WrappedDataEncryptionKey;
    readonly associatedData: Uint8Array;
  }): Promise<Uint8Array> {
    const associatedData = Buffer.from(input.associatedData);
    let nonce: Buffer | undefined;
    let authenticationTag: Buffer | undefined;
    let ciphertext: Buffer | undefined;
    try {
      nonce = decodeBase64(input.wrappedKey.nonce);
      authenticationTag = decodeBase64(input.wrappedKey.authenticationTag);
      ciphertext = decodeBase64(input.wrappedKey.ciphertext);
      const decipher = createDecipheriv(
        algorithm,
        this.requireKey(input.wrappedKey.keyId),
        nonce,
      );
      decipher.setAAD(associatedData);
      decipher.setAuthTag(authenticationTag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "credential_envelope_base64_invalid"
      )
        throw error;
      throw new Error("credential_wrapped_key_authentication_failed", {
        cause: error,
      });
    } finally {
      associatedData.fill(0);
      ciphertext?.fill(0);
      authenticationTag?.fill(0);
      nonce?.fill(0);
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
    context.databaseResourceIdentity,
  ];
  if (fields.some((field) => !field || field.includes("\u0000"))) {
    throw new Error("credential_envelope_context_invalid");
  }
  return Buffer.from(fields.join("\u0000"), "utf8");
}

function decodeBase64(value: string): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (!value || decoded.toString("base64") !== value) {
    decoded.fill(0);
    throw new Error("credential_envelope_base64_invalid");
  }
  return decoded;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
