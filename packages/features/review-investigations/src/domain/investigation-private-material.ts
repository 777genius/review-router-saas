import {
  assertBoundedText,
  assertDigest,
  assertIdentifier,
  assertPositiveInteger,
  canonicalJson,
  ReviewInvestigationDomainError,
} from "./canonicalization";
import { investigationDiscoveryQueryMaximumLength } from "./obligation-closure-policy";

export const investigationPrivateMaterialEncryptionAlgorithm =
  "aes-256-gcm-v1" as const;
export const investigationPrivateMaterialMaxPlaintextBytes = 64 * 1024;
export const investigationPrivateMaterialDefaultTtlMs = 24 * 60 * 60 * 1_000;
export const investigationPrivateMaterialMinimumTtlMs = 60 * 1_000;
export const investigationPrivateMaterialMaximumTtlMs =
  7 * 24 * 60 * 60 * 1_000;
export const investigationSearchQueryPrivateMaterialVersion = 1 as const;
export const investigationSearchQueryPrivateMaterialKind =
  "search_query" as const;
export const investigationSearchQueryPrivateMaterialPurpose =
  "review_investigation_search_query" as const;

export enum InvestigationPrivateMaterialExpiryDisposition {
  Unchanged = "unchanged",
  DeferredActiveTurn = "deferred_active_turn",
  Inconclusive = "inconclusive",
}

export enum InvestigationPrivateMaterialExpiryReason {
  RegenerationUnavailable = "private_material_expired_regeneration_unavailable",
}

export type InvestigationSearchQueryPrivateMaterial = Readonly<{
  materialVersion: typeof investigationSearchQueryPrivateMaterialVersion;
  kind: typeof investigationSearchQueryPrivateMaterialKind;
  query: string;
  queryHash: string;
}>;

export type InvestigationSearchQueryPrivateMaterialAssociatedData = Readonly<{
  associatedDataVersion: 1;
  purpose: typeof investigationSearchQueryPrivateMaterialPurpose;
  privateMaterialId: string;
  investigationId: string;
  obligationId: string;
  coverageContractVersion: string;
  stableReviewUnitKey: string;
  canonicalSubject: string;
  canonicalRequirement: string;
  queryHash: string;
  createdAt: string;
  expiresAt: string;
}>;

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
  assertInvestigationPrivateMaterialTtl(expiresAt - createdAt);
  return Object.freeze({ ...input });
}

export function assertInvestigationPrivateMaterialTtl(ttlMs: number): void {
  if (
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < investigationPrivateMaterialMinimumTtlMs ||
    ttlMs > investigationPrivateMaterialMaximumTtlMs
  ) {
    throw new ReviewInvestigationDomainError("private_material_ttl_invalid");
  }
}

export function canonicalInvestigationSearchQueryPrivateMaterial(
  input: InvestigationSearchQueryPrivateMaterial,
): string {
  const material = createInvestigationSearchQueryPrivateMaterial(input);
  return canonicalJson(material);
}

export function parseInvestigationSearchQueryPrivateMaterial(
  value: string,
): InvestigationSearchQueryPrivateMaterial {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ReviewInvestigationDomainError(
      "private_material_payload_invalid",
    );
  }
  if (!isRecord(parsed)) {
    throw new ReviewInvestigationDomainError(
      "private_material_payload_invalid",
    );
  }
  const keys = Object.keys(parsed).sort();
  const expected = ["kind", "materialVersion", "query", "queryHash"];
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw new ReviewInvestigationDomainError(
      "private_material_payload_invalid",
    );
  }
  const material = createInvestigationSearchQueryPrivateMaterial({
    materialVersion: parsed.materialVersion as 1,
    kind: parsed.kind as typeof investigationSearchQueryPrivateMaterialKind,
    query: parsed.query as string,
    queryHash: parsed.queryHash as string,
  });
  if (canonicalJson(material) !== value) {
    throw new ReviewInvestigationDomainError(
      "private_material_payload_invalid",
    );
  }
  return material;
}

export function canonicalInvestigationSearchQueryPrivateMaterialAssociatedData(
  input: InvestigationSearchQueryPrivateMaterialAssociatedData,
): string {
  if (
    input.associatedDataVersion !== 1 ||
    input.purpose !== investigationSearchQueryPrivateMaterialPurpose
  ) {
    throw new ReviewInvestigationDomainError(
      "private_material_associated_data_invalid",
    );
  }
  assertIdentifier(input.privateMaterialId, "private_material_id");
  assertIdentifier(input.investigationId, "private_material_investigation_id");
  assertIdentifier(input.obligationId, "private_material_obligation_id");
  assertIdentifier(
    input.coverageContractVersion,
    "private_material_coverage_contract_version",
  );
  assertIdentifier(
    input.stableReviewUnitKey,
    "private_material_stable_review_unit_key",
  );
  assertBoundedText(
    input.canonicalSubject,
    "private_material_canonical_subject",
    4_096,
  );
  assertBoundedText(
    input.canonicalRequirement,
    "private_material_canonical_requirement",
    64_000,
  );
  assertDigest(input.queryHash, "private_material_query_hash");
  const createdAt = parseTimestamp(
    input.createdAt,
    "private_material_created_at",
  );
  const expiresAt = parseTimestamp(
    input.expiresAt,
    "private_material_expires_at",
  );
  assertInvestigationPrivateMaterialTtl(expiresAt - createdAt);
  return canonicalJson(input);
}

function createInvestigationSearchQueryPrivateMaterial(
  input: InvestigationSearchQueryPrivateMaterial,
): InvestigationSearchQueryPrivateMaterial {
  if (
    input.materialVersion !== investigationSearchQueryPrivateMaterialVersion ||
    input.kind !== investigationSearchQueryPrivateMaterialKind
  ) {
    throw new ReviewInvestigationDomainError(
      "private_material_payload_invalid",
    );
  }
  assertDigest(input.queryHash, "private_material_query_hash");
  assertCanonicalQuery(input.query);
  return Object.freeze({ ...input });
}

function assertCanonicalQuery(query: string): void {
  assertBoundedText(
    query,
    "private_material_query",
    investigationDiscoveryQueryMaximumLength,
  );
  if (
    query.trim() !== query ||
    /[\r\n]/u.test(query) ||
    [...query].some((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
      );
    })
  ) {
    throw new ReviewInvestigationDomainError("private_material_query_invalid");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
