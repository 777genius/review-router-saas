import {
  assertDigest,
  assertIdentifier,
  assertPositiveInteger,
  ReviewInvestigationDomainError,
} from "./canonicalization";

export const investigationPrivateMaterialEncryptionAlgorithm =
  "aes-256-gcm-v1" as const;
export const investigationPrivateMaterialMaxPlaintextBytes = 64 * 1024;

export type EncryptedInvestigationPrivateMaterial = Readonly<{
  privateMaterialId: string;
  investigationId: string;
  obligationId: string | null;
  algorithm: typeof investigationPrivateMaterialEncryptionAlgorithm;
  keyId: string;
  nonceBase64Url: string;
  authTagBase64Url: string;
  ciphertextBase64Url: string;
  associatedDataHash: string;
  plaintextHash: string;
  byteCount: number;
  createdAt: string;
  expiresAt: string;
}>;

export function createEncryptedInvestigationPrivateMaterial(
  input: EncryptedInvestigationPrivateMaterial,
): EncryptedInvestigationPrivateMaterial {
  assertIdentifier(input.privateMaterialId, "private_material_id");
  assertIdentifier(input.investigationId, "private_material_investigation_id");
  if (input.obligationId !== null) {
    assertIdentifier(input.obligationId, "private_material_obligation_id");
  }
  if (input.algorithm !== investigationPrivateMaterialEncryptionAlgorithm) {
    throw new ReviewInvestigationDomainError(
      "private_material_algorithm_invalid",
    );
  }
  assertIdentifier(input.keyId, "private_material_key_id");
  assertBase64UrlBytes(input.nonceBase64Url, 12, "private_material_nonce");
  assertBase64UrlBytes(input.authTagBase64Url, 16, "private_material_auth_tag");
  assertDigest(input.associatedDataHash, "private_material_aad_hash");
  assertDigest(input.plaintextHash, "private_material_plaintext_hash");
  assertPositiveInteger(input.byteCount, "private_material_byte_count");
  if (input.byteCount > investigationPrivateMaterialMaxPlaintextBytes) {
    throw new ReviewInvestigationDomainError(
      "private_material_byte_count_invalid",
    );
  }
  assertBase64UrlBytes(
    input.ciphertextBase64Url,
    input.byteCount,
    "private_material_ciphertext",
  );
  const createdAt = parseTimestamp(
    input.createdAt,
    "private_material_created_at",
  );
  const expiresAt = parseTimestamp(
    input.expiresAt,
    "private_material_expires_at",
  );
  if (expiresAt <= createdAt) {
    throw new ReviewInvestigationDomainError("private_material_expiry_invalid");
  }
  return Object.freeze({ ...input });
}

function assertBase64UrlBytes(
  value: string,
  expectedBytes: number,
  field: string,
): void {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new ReviewInvestigationDomainError(`${field}_invalid`);
  }
  const remainder = value.length % 4;
  const decodedByteLength = Math.floor((value.length * 6) / 8);
  if (remainder === 1 || decodedByteLength !== expectedBytes) {
    throw new ReviewInvestigationDomainError(`${field}_invalid`);
  }
}

function parseTimestamp(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new ReviewInvestigationDomainError(`${field}_invalid`);
  }
  return parsed;
}
