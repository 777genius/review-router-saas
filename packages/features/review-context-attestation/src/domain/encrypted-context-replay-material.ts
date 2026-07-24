export const contextReplayMaterialEncryptionAlgorithm = "aes-256-gcm-v1";
export const contextReplayMaterialMaxPlaintextBytes = 512 * 1024;

export type EncryptedContextReplayMaterial = Readonly<{
  sessionId: string;
  algorithm: typeof contextReplayMaterialEncryptionAlgorithm;
  keyId: string;
  nonceBase64Url: string;
  authTagBase64Url: string;
  ciphertextBase64Url: string;
  associatedDataHash: string;
  plaintextHash: string;
  byteCount: number;
  expiresAtMs: number;
}>;

export function createEncryptedContextReplayMaterial(
  candidate: EncryptedContextReplayMaterial,
): EncryptedContextReplayMaterial {
  assertIdentifier(candidate.sessionId, "context_replay_session_id");
  if (candidate.algorithm !== contextReplayMaterialEncryptionAlgorithm) {
    throw new Error("context_replay_encryption_algorithm_invalid");
  }
  assertIdentifier(candidate.keyId, "context_replay_key_id");
  assertBase64UrlBytes(candidate.nonceBase64Url, 12, "context_replay_nonce");
  assertBase64UrlBytes(
    candidate.authTagBase64Url,
    16,
    "context_replay_auth_tag",
  );
  if (
    typeof candidate.ciphertextBase64Url !== "string" ||
    candidate.ciphertextBase64Url.length === 0 ||
    !/^[A-Za-z0-9_-]+$/.test(candidate.ciphertextBase64Url)
  ) {
    throw new Error("context_replay_ciphertext_invalid");
  }
  assertSha256(candidate.associatedDataHash, "context_replay_aad_hash");
  assertSha256(candidate.plaintextHash, "context_replay_plaintext_hash");
  if (
    !Number.isSafeInteger(candidate.byteCount) ||
    candidate.byteCount < 2 ||
    candidate.byteCount > contextReplayMaterialMaxPlaintextBytes ||
    Buffer.from(candidate.ciphertextBase64Url, "base64url").byteLength !==
      candidate.byteCount
  ) {
    throw new Error("context_replay_byte_count_invalid");
  }
  if (
    !Number.isSafeInteger(candidate.expiresAtMs) ||
    candidate.expiresAtMs < 1
  ) {
    throw new Error("context_replay_expiry_invalid");
  }
  return Object.freeze({ ...candidate });
}

function assertIdentifier(value: string, field: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value)) {
    throw new Error(`${field}_invalid`);
  }
}

function assertSha256(value: string, field: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${field}_invalid`);
}

function assertBase64UrlBytes(
  value: string,
  byteCount: number,
  field: string,
): void {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(value) ||
    Buffer.from(value, "base64url").byteLength !== byteCount
  ) {
    throw new Error(`${field}_invalid`);
  }
}
