import {
  InvestigationEvaluationAttestationVersion,
  InvestigationEvaluationSignatureAlgorithm,
  canonicalEvaluationJson,
  validateSignedInvestigationEvaluationAttestation,
  type InvestigationEvaluationAttestationPayload,
} from "./investigation-evaluation";
import {
  InvestigationTelemetryEvidenceCompleteness,
  type InvestigationFullyEvaluatedTelemetrySample,
} from "./investigation-telemetry";

export const maximumInvestigationPromotionSigningKeyIds = 32;

export enum InvestigationPromotionTrustProfileVersion {
  V1 = "review-investigation-promotion-trust.v1",
}

export enum InvestigationPromotionSigningKeyPolicy {
  ApprovedLineageAllowlist = "approved_lineage_allowlist",
}

export enum InvestigationPromotionEvidenceFreshnessPolicy {
  IssuedAtOrAfterAndUnexpired = "issued_at_or_after_and_unexpired",
}

export enum InvestigationPromotionTrustErrorCode {
  EvaluationAttestationInvalid = "evaluation_attestation_invalid",
  EvaluationTrustMismatch = "evaluation_trust_mismatch",
  EvaluationEvidenceStale = "evaluation_evidence_stale",
  EvaluationEvidenceNotYetValid = "evaluation_evidence_not_yet_valid",
}

export class InvestigationPromotionTrustError extends Error {
  constructor(readonly code: InvestigationPromotionTrustErrorCode) {
    super(`promotion_${code}`);
    this.name = "InvestigationPromotionTrustError";
  }
}

export type InvestigationPromotionTrustProfile = Readonly<{
  profileVersion: InvestigationPromotionTrustProfileVersion.V1;
  corpusVersion: string;
  groundTruthSetHash: string;
  evaluationPolicyVersion: string;
  freshness: Readonly<{
    policy: InvestigationPromotionEvidenceFreshnessPolicy.IssuedAtOrAfterAndUnexpired;
    issuedAtOrAfter: string;
  }>;
  signingKeys: Readonly<{
    policy: InvestigationPromotionSigningKeyPolicy.ApprovedLineageAllowlist;
    lineageId: string;
    policyVersion: string;
    signatureAlgorithm: InvestigationEvaluationSignatureAlgorithm.Ed25519;
    acceptedKeyIds: readonly string[];
  }>;
}>;

export type InvestigationPromotionEvaluationEvidence = Readonly<{
  attestationVersion: InvestigationEvaluationAttestationVersion.V1;
  attestationHash: string;
  derivedSampleId: string;
  producerReleaseId: string;
  corpusVersion: string;
  groundTruthSetHash: string;
  evaluationPolicyVersion: string;
  issuedAt: string;
  expiresAt: string;
  signingKeyId: string;
  signatureAlgorithm: InvestigationEvaluationSignatureAlgorithm.Ed25519;
}>;

export type StoredInvestigationPromotionEvaluationAttestation = Readonly<{
  attestationId: string;
  attestationVersion: string;
  attestationHash: string;
  envelopeHash: string;
  signingKeyId: string;
  signatureAlgorithm: string;
  signatureValue: string;
  terminalSampleId: string;
  terminalSamplePayloadHash: string;
  derivedSampleId: string;
  investigationId: string;
  certificateId: string;
  certificateHash: string;
  producerReleaseId: string;
  corpusVersion: string;
  evaluationPolicyVersion: string;
  payloadCanonicalJson: string;
}>;

export type ParsedInvestigationPromotionEvaluationAttestation = Readonly<{
  evidence: InvestigationPromotionEvaluationEvidence;
  payloadCanonicalJson: string;
  envelopeCanonicalJson: string;
}>;

const trustProfileFields = Object.freeze([
  "profileVersion",
  "corpusVersion",
  "groundTruthSetHash",
  "evaluationPolicyVersion",
  "freshness",
  "signingKeys",
] as const);
const freshnessFields = Object.freeze(["policy", "issuedAtOrAfter"] as const);
const signingKeyFields = Object.freeze([
  "policy",
  "lineageId",
  "policyVersion",
  "signatureAlgorithm",
  "acceptedKeyIds",
] as const);

export function normalizeInvestigationPromotionTrustProfile(
  input: InvestigationPromotionTrustProfile,
): InvestigationPromotionTrustProfile {
  exactFields(input, trustProfileFields, "promotion_trust_profile_fields");
  exactFields(input.freshness, freshnessFields, "promotion_freshness_fields");
  exactFields(
    input.signingKeys,
    signingKeyFields,
    "promotion_signing_key_fields",
  );
  if (input.profileVersion !== InvestigationPromotionTrustProfileVersion.V1) {
    throw new Error("promotion_trust_profile_version_invalid");
  }
  if (
    input.freshness.policy !==
    InvestigationPromotionEvidenceFreshnessPolicy.IssuedAtOrAfterAndUnexpired
  ) {
    throw new Error("promotion_freshness_policy_invalid");
  }
  if (
    input.signingKeys.policy !==
    InvestigationPromotionSigningKeyPolicy.ApprovedLineageAllowlist
  ) {
    throw new Error("promotion_signing_key_policy_invalid");
  }
  if (
    input.signingKeys.signatureAlgorithm !==
    InvestigationEvaluationSignatureAlgorithm.Ed25519
  ) {
    throw new Error("promotion_signature_algorithm_invalid");
  }
  identifier(input.corpusVersion, "promotion_corpus_version");
  digest(input.groundTruthSetHash, "promotion_ground_truth_set_hash");
  identifier(
    input.evaluationPolicyVersion,
    "promotion_evaluation_policy_version",
  );
  timestamp(input.freshness.issuedAtOrAfter, "promotion_evidence_issued_at");
  identifier(input.signingKeys.lineageId, "promotion_signing_key_lineage_id");
  identifier(
    input.signingKeys.policyVersion,
    "promotion_signing_key_policy_version",
  );
  if (
    !Array.isArray(input.signingKeys.acceptedKeyIds) ||
    input.signingKeys.acceptedKeyIds.length === 0 ||
    input.signingKeys.acceptedKeyIds.length >
      maximumInvestigationPromotionSigningKeyIds
  ) {
    throw new Error("promotion_signing_key_ids_count_invalid");
  }
  input.signingKeys.acceptedKeyIds.forEach((keyId) =>
    identifier(keyId, "promotion_signing_key_id"),
  );
  const acceptedKeyIds = [...input.signingKeys.acceptedKeyIds].sort(
    compareAsciiIdentifiers,
  );
  if (new Set(acceptedKeyIds).size !== acceptedKeyIds.length) {
    throw new Error("promotion_signing_key_id_duplicate");
  }
  return Object.freeze({
    profileVersion: input.profileVersion,
    corpusVersion: input.corpusVersion,
    groundTruthSetHash: input.groundTruthSetHash,
    evaluationPolicyVersion: input.evaluationPolicyVersion,
    freshness: Object.freeze({ ...input.freshness }),
    signingKeys: Object.freeze({
      ...input.signingKeys,
      acceptedKeyIds: Object.freeze(acceptedKeyIds),
    }),
  });
}

export function assertInvestigationPromotionTrustProfileValidAt(input: {
  readonly profile: InvestigationPromotionTrustProfile;
  readonly validAt: string;
}): void {
  timestamp(input.validAt, "promotion_evidence_valid_at");
  if (
    Date.parse(input.profile.freshness.issuedAtOrAfter) >
    Date.parse(input.validAt)
  ) {
    throw trustError(
      InvestigationPromotionTrustErrorCode.EvaluationEvidenceNotYetValid,
    );
  }
}

export function assertInvestigationPromotionEvaluationEvidenceTrusted(input: {
  readonly sample: InvestigationFullyEvaluatedTelemetrySample;
  readonly evidence: InvestigationPromotionEvaluationEvidence;
  readonly trustProfile: InvestigationPromotionTrustProfile;
  readonly validAt: string;
}): void {
  assertInvestigationPromotionEvaluationEvidenceIntegrity(
    input.sample,
    input.evidence,
  );
  if (
    input.evidence.corpusVersion !== input.trustProfile.corpusVersion ||
    input.evidence.groundTruthSetHash !==
      input.trustProfile.groundTruthSetHash ||
    input.evidence.evaluationPolicyVersion !==
      input.trustProfile.evaluationPolicyVersion ||
    input.evidence.signatureAlgorithm !==
      input.trustProfile.signingKeys.signatureAlgorithm ||
    !input.trustProfile.signingKeys.acceptedKeyIds.includes(
      input.evidence.signingKeyId,
    )
  ) {
    throw trustError(
      InvestigationPromotionTrustErrorCode.EvaluationTrustMismatch,
    );
  }
  const validAt = Date.parse(input.validAt);
  if (Date.parse(input.evidence.issuedAt) > validAt) {
    throw trustError(
      InvestigationPromotionTrustErrorCode.EvaluationEvidenceNotYetValid,
    );
  }
  if (
    Date.parse(input.evidence.issuedAt) <
      Date.parse(input.trustProfile.freshness.issuedAtOrAfter) ||
    Date.parse(input.evidence.expiresAt) <= validAt
  ) {
    throw trustError(
      InvestigationPromotionTrustErrorCode.EvaluationEvidenceStale,
    );
  }
}

export function assertInvestigationPromotionEvaluationEvidenceIntegrity(
  sample: InvestigationFullyEvaluatedTelemetrySample,
  evidence: InvestigationPromotionEvaluationEvidence,
): void {
  try {
    if (
      sample.evidenceCompleteness !==
        InvestigationTelemetryEvidenceCompleteness.FullyEvaluated ||
      evidence.attestationVersion !==
        InvestigationEvaluationAttestationVersion.V1 ||
      evidence.signatureAlgorithm !==
        InvestigationEvaluationSignatureAlgorithm.Ed25519 ||
      evidence.derivedSampleId !== sample.sampleId ||
      sample.sampleId !== `evaluated-${evidence.attestationHash}` ||
      evidence.producerReleaseId !== sample.producerReleaseId
    ) {
      throw new Error("promotion_evaluation_binding_invalid");
    }
    digest(evidence.attestationHash, "promotion_attestation_hash");
    identifier(evidence.producerReleaseId, "promotion_evidence_release");
    identifier(evidence.corpusVersion, "promotion_evidence_corpus_version");
    digest(
      evidence.groundTruthSetHash,
      "promotion_evidence_ground_truth_set_hash",
    );
    identifier(
      evidence.evaluationPolicyVersion,
      "promotion_evidence_policy_version",
    );
    timestamp(evidence.issuedAt, "promotion_evidence_issued_at");
    timestamp(evidence.expiresAt, "promotion_evidence_expires_at");
    identifier(evidence.signingKeyId, "promotion_evidence_signing_key_id");
    if (Date.parse(evidence.expiresAt) <= Date.parse(evidence.issuedAt)) {
      throw new Error("promotion_evidence_lifetime_invalid");
    }
  } catch (error) {
    if (error instanceof InvestigationPromotionTrustError) throw error;
    throw trustError(
      InvestigationPromotionTrustErrorCode.EvaluationAttestationInvalid,
      error,
    );
  }
}

export function parseStoredInvestigationPromotionEvaluationAttestation(
  record: StoredInvestigationPromotionEvaluationAttestation,
): ParsedInvestigationPromotionEvaluationAttestation {
  try {
    if (
      record.attestationVersion !==
        InvestigationEvaluationAttestationVersion.V1 ||
      record.signatureAlgorithm !==
        InvestigationEvaluationSignatureAlgorithm.Ed25519
    ) {
      throw new Error("promotion_evaluation_discriminator_invalid");
    }
    digest(record.attestationHash, "promotion_attestation_hash");
    digest(record.envelopeHash, "promotion_envelope_hash");
    let payload: InvestigationEvaluationAttestationPayload;
    try {
      payload = JSON.parse(
        record.payloadCanonicalJson,
      ) as InvestigationEvaluationAttestationPayload;
    } catch {
      throw new Error("promotion_evaluation_payload_json_invalid");
    }
    if (canonicalEvaluationJson(payload) !== record.payloadCanonicalJson) {
      throw new Error("promotion_evaluation_payload_canonical_invalid");
    }
    const signature = {
      algorithm: InvestigationEvaluationSignatureAlgorithm.Ed25519,
      keyId: record.signingKeyId,
      value: record.signatureValue,
    } as const;
    validateSignedInvestigationEvaluationAttestation({ payload, signature });
    if (
      payload.attestationId !== record.attestationId ||
      payload.attestationVersion !== record.attestationVersion ||
      payload.subject.terminalSampleId !== record.terminalSampleId ||
      payload.subject.terminalSamplePayloadHash !==
        record.terminalSamplePayloadHash ||
      payload.subject.investigationId !== record.investigationId ||
      payload.subject.certificateId !== record.certificateId ||
      payload.subject.certificateHash !== record.certificateHash ||
      payload.subject.producerReleaseId !== record.producerReleaseId ||
      payload.corpus.version !== record.corpusVersion ||
      payload.evaluationPolicyVersion !== record.evaluationPolicyVersion ||
      record.derivedSampleId !== `evaluated-${record.attestationHash}`
    ) {
      throw new Error("promotion_evaluation_record_binding_invalid");
    }
    return Object.freeze({
      evidence: Object.freeze({
        attestationVersion: InvestigationEvaluationAttestationVersion.V1,
        attestationHash: record.attestationHash,
        derivedSampleId: record.derivedSampleId,
        producerReleaseId: record.producerReleaseId,
        corpusVersion: payload.corpus.version,
        groundTruthSetHash: payload.corpus.groundTruthSetHash,
        evaluationPolicyVersion: payload.evaluationPolicyVersion,
        issuedAt: payload.issuedAt,
        expiresAt: payload.expiresAt,
        signingKeyId: record.signingKeyId,
        signatureAlgorithm: InvestigationEvaluationSignatureAlgorithm.Ed25519,
      }),
      payloadCanonicalJson: record.payloadCanonicalJson,
      envelopeCanonicalJson: canonicalEvaluationJson({ payload, signature }),
    });
  } catch (error) {
    if (error instanceof InvestigationPromotionTrustError) throw error;
    throw trustError(
      InvestigationPromotionTrustErrorCode.EvaluationAttestationInvalid,
      error,
    );
  }
}

function trustError(
  code: InvestigationPromotionTrustErrorCode,
  cause?: unknown,
): InvestigationPromotionTrustError {
  const error = new InvestigationPromotionTrustError(code);
  if (cause !== undefined)
    Object.defineProperty(error, "cause", { value: cause });
  return error;
}

function exactFields(
  value: unknown,
  expected: readonly string[],
  field: string,
): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field}_invalid`);
  }
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((item, index) => item !== sortedExpected[index])
  ) {
    throw new Error(`${field}_invalid`);
  }
}

function identifier(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length > 256 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(value)
  ) {
    throw new Error(`${field}_invalid`);
  }
}

function digest(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${field}_invalid`);
  }
}

function timestamp(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !value.endsWith("Z") ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error(`${field}_invalid`);
  }
}

function compareAsciiIdentifiers(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
