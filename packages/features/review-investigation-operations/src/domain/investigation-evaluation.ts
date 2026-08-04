import {
  InvestigationLegacyComparison,
  InvestigationTelemetryConclusion,
  InvestigationTelemetryEvidenceCompleteness,
  type InvestigationFullyEvaluatedTelemetrySample,
  type InvestigationTerminalOperationalTelemetrySample,
} from "./investigation-telemetry";
import { canonicalInvestigationOperationsJson } from "./canonical-json";

export enum InvestigationEvaluationAttestationVersion {
  V1 = "review-investigation-evaluation.v1",
}

export enum InvestigationEvaluationSignatureAlgorithm {
  Ed25519 = "ed25519",
}

export enum InvestigationEvaluationImportStatus {
  Imported = "imported",
  AlreadyImported = "already_imported",
}

export enum InvestigationEvaluationImportErrorCode {
  InvalidAttestation = "invalid_attestation",
  InvalidSignature = "invalid_signature",
  AttestationNotYetValid = "attestation_not_yet_valid",
  AttestationExpired = "attestation_expired",
  SubjectNotFound = "subject_not_found",
  SubjectMismatch = "subject_mismatch",
  Conflict = "conflict",
}

export class InvestigationEvaluationImportError extends Error {
  constructor(readonly code: InvestigationEvaluationImportErrorCode) {
    super(`investigation_evaluation_${code}`);
    this.name = "InvestigationEvaluationImportError";
  }
}

export type InvestigationEvaluationAttestationPayload = Readonly<{
  attestationVersion: InvestigationEvaluationAttestationVersion.V1;
  attestationId: string;
  issuedAt: string;
  expiresAt: string;
  subject: Readonly<{
    terminalSampleId: string;
    terminalSamplePayloadHash: string;
    investigationId: string;
    certificateId: string;
    certificateHash: string;
    producerReleaseId: string;
    repositoryScopeHash: string;
    reviewRevisionHash: string;
    stableReviewUnitHash: string;
  }>;
  corpus: Readonly<{
    version: string;
    groundTruthSetHash: string;
  }>;
  evaluationPolicyVersion: string;
  facts: Readonly<{
    groundTruth: Readonly<{
      expectedDefectCount: number;
      detectedDefectCount: number;
      detectedDefectSetHash: string;
    }>;
    security: Readonly<{
      evaluationHash: string;
      violationCount: number;
    }>;
    legacy: Readonly<{
      resultHash: string;
      comparison: Exclude<
        InvestigationLegacyComparison,
        InvestigationLegacyComparison.NotCompared
      >;
    }>;
  }>;
}>;

export type SignedInvestigationEvaluationAttestation = Readonly<{
  payload: InvestigationEvaluationAttestationPayload;
  signature: Readonly<{
    algorithm: InvestigationEvaluationSignatureAlgorithm.Ed25519;
    keyId: string;
    value: string;
  }>;
}>;

export type InvestigationEvaluationSubject = Readonly<{
  terminalSample: InvestigationTerminalOperationalTelemetrySample;
  terminalSamplePayloadHash: string;
  investigationId: string;
  certificateId: string;
  certificateHash: string;
  certificateProducerReleaseId: string;
  certificateRepositoryScopeHash: string;
  certificateReviewRevisionHash: string;
  certificateStableReviewUnitKey: string;
  certificateConclusion: InvestigationTelemetryConclusion;
}>;

export function assertInvestigationEvaluationSubjectBindings(input: {
  readonly attested: InvestigationEvaluationAttestationPayload["subject"];
  readonly subject: InvestigationEvaluationSubject;
  readonly certificateStableReviewUnitHash: string;
}): void {
  const { attested, subject } = input;
  if (
    subject.terminalSample.evidenceCompleteness !==
      InvestigationTelemetryEvidenceCompleteness.TerminalOperational ||
    subject.terminalSample.sampleId !== attested.terminalSampleId ||
    subject.terminalSamplePayloadHash !== attested.terminalSamplePayloadHash ||
    subject.investigationId !== attested.investigationId ||
    subject.certificateId !== attested.certificateId ||
    subject.certificateHash !== attested.certificateHash ||
    subject.certificateProducerReleaseId !== attested.producerReleaseId ||
    subject.terminalSample.producerReleaseId !== attested.producerReleaseId ||
    subject.certificateRepositoryScopeHash !== attested.repositoryScopeHash ||
    subject.terminalSample.repositoryScopeHash !==
      attested.repositoryScopeHash ||
    subject.certificateReviewRevisionHash !== attested.reviewRevisionHash ||
    subject.terminalSample.reviewRevisionHash !== attested.reviewRevisionHash ||
    input.certificateStableReviewUnitHash !== attested.stableReviewUnitHash ||
    subject.terminalSample.stableReviewUnitHash !==
      attested.stableReviewUnitHash ||
    subject.certificateConclusion !== subject.terminalSample.conclusion
  ) {
    throw new InvestigationEvaluationImportError(
      InvestigationEvaluationImportErrorCode.SubjectMismatch,
    );
  }
}

export type InvestigationEvaluationRecord = Readonly<{
  attestationId: string;
  attestationVersion: InvestigationEvaluationAttestationVersion.V1;
  attestationHash: string;
  envelopeHash: string;
  signingKeyId: string;
  signatureAlgorithm: InvestigationEvaluationSignatureAlgorithm.Ed25519;
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
  importedAt: string;
}>;

const payloadFields = Object.freeze([
  "attestationVersion",
  "attestationId",
  "issuedAt",
  "expiresAt",
  "subject",
  "corpus",
  "evaluationPolicyVersion",
  "facts",
] as const);
const subjectFields = Object.freeze([
  "terminalSampleId",
  "terminalSamplePayloadHash",
  "investigationId",
  "certificateId",
  "certificateHash",
  "producerReleaseId",
  "repositoryScopeHash",
  "reviewRevisionHash",
  "stableReviewUnitHash",
] as const);
const corpusFields = Object.freeze(["version", "groundTruthSetHash"] as const);
const factsFields = Object.freeze([
  "groundTruth",
  "security",
  "legacy",
] as const);
const groundTruthFields = Object.freeze([
  "expectedDefectCount",
  "detectedDefectCount",
  "detectedDefectSetHash",
] as const);
const securityFields = Object.freeze([
  "evaluationHash",
  "violationCount",
] as const);
const legacyFields = Object.freeze(["resultHash", "comparison"] as const);
const envelopeFields = Object.freeze(["payload", "signature"] as const);
const signatureFields = Object.freeze(["algorithm", "keyId", "value"] as const);

export function validateSignedInvestigationEvaluationAttestation(
  input: SignedInvestigationEvaluationAttestation,
): void {
  exactFields(input, envelopeFields, "evaluation_envelope_fields");
  exactFields(input.payload, payloadFields, "evaluation_payload_fields");
  exactFields(
    input.payload.subject,
    subjectFields,
    "evaluation_subject_fields",
  );
  exactFields(input.payload.corpus, corpusFields, "evaluation_corpus_fields");
  exactFields(input.payload.facts, factsFields, "evaluation_facts_fields");
  exactFields(
    input.payload.facts.groundTruth,
    groundTruthFields,
    "evaluation_ground_truth_fields",
  );
  exactFields(
    input.payload.facts.security,
    securityFields,
    "evaluation_security_fields",
  );
  exactFields(
    input.payload.facts.legacy,
    legacyFields,
    "evaluation_legacy_fields",
  );
  exactFields(input.signature, signatureFields, "evaluation_signature_fields");

  if (
    input.payload.attestationVersion !==
    InvestigationEvaluationAttestationVersion.V1
  ) {
    throw new Error("evaluation_attestation_version_invalid");
  }
  if (
    input.signature.algorithm !==
    InvestigationEvaluationSignatureAlgorithm.Ed25519
  ) {
    throw new Error("evaluation_signature_algorithm_invalid");
  }
  identifier(input.payload.attestationId, "evaluation_attestation_id");
  identifier(input.signature.keyId, "evaluation_signing_key_id");
  timestamp(input.payload.issuedAt, "evaluation_issued_at");
  timestamp(input.payload.expiresAt, "evaluation_expires_at");
  if (
    Date.parse(input.payload.expiresAt) <= Date.parse(input.payload.issuedAt) ||
    Date.parse(input.payload.expiresAt) - Date.parse(input.payload.issuedAt) >
      maximumEvaluationAttestationLifetimeMs
  ) {
    throw new Error("evaluation_attestation_lifetime_invalid");
  }

  for (const [field, value] of Object.entries(input.payload.subject)) {
    if (field.endsWith("Hash")) digest(value, `evaluation_${field}`);
    else identifier(value, `evaluation_${field}`);
  }
  identifier(input.payload.corpus.version, "evaluation_corpus_version");
  digest(
    input.payload.corpus.groundTruthSetHash,
    "evaluation_ground_truth_set_hash",
  );
  identifier(
    input.payload.evaluationPolicyVersion,
    "evaluation_policy_version",
  );
  nonNegative(
    input.payload.facts.groundTruth.expectedDefectCount,
    "evaluation_expected_defect_count",
  );
  nonNegative(
    input.payload.facts.groundTruth.detectedDefectCount,
    "evaluation_detected_defect_count",
  );
  if (
    input.payload.facts.groundTruth.detectedDefectCount >
    input.payload.facts.groundTruth.expectedDefectCount
  ) {
    throw new Error("evaluation_detected_defect_count_exceeds_expected");
  }
  digest(
    input.payload.facts.groundTruth.detectedDefectSetHash,
    "evaluation_detected_defect_set_hash",
  );
  digest(
    input.payload.facts.security.evaluationHash,
    "evaluation_security_evaluation_hash",
  );
  nonNegative(
    input.payload.facts.security.violationCount,
    "evaluation_security_violation_count",
  );
  digest(
    input.payload.facts.legacy.resultHash,
    "evaluation_legacy_result_hash",
  );
  const legacyComparison = input.payload.facts.legacy
    .comparison as InvestigationLegacyComparison;
  if (
    !Object.values(InvestigationLegacyComparison).includes(legacyComparison) ||
    legacyComparison === InvestigationLegacyComparison.NotCompared
  ) {
    throw new Error("evaluation_legacy_comparison_invalid");
  }
  if (!/^[A-Za-z0-9_-]{86}$/u.test(input.signature.value)) {
    throw new Error("evaluation_signature_value_invalid");
  }
}

export function assertEvaluationAttestationTimeWindow(input: {
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly now: Date;
  readonly maximumFutureClockSkewMs?: number;
}): void {
  if (!Number.isFinite(input.now.getTime())) {
    throw new Error("evaluation_clock_invalid");
  }
  const skew = input.maximumFutureClockSkewMs ?? 300_000;
  if (!Number.isSafeInteger(skew) || skew < 0 || skew > 300_000) {
    throw new Error("evaluation_clock_skew_invalid");
  }
  if (Date.parse(input.issuedAt) > input.now.getTime() + skew) {
    throw new InvestigationEvaluationImportError(
      InvestigationEvaluationImportErrorCode.AttestationNotYetValid,
    );
  }
  if (Date.parse(input.expiresAt) <= input.now.getTime()) {
    throw new InvestigationEvaluationImportError(
      InvestigationEvaluationImportErrorCode.AttestationExpired,
    );
  }
}

export function deriveFullyEvaluatedTelemetrySample(input: {
  readonly terminal: InvestigationTerminalOperationalTelemetrySample;
  readonly attestationHash: string;
  readonly evaluatedAt: string;
  readonly expectedDefectCount: number;
  readonly detectedDefectCount: number;
  readonly securityViolationCount: number;
  readonly legacyComparison: Exclude<
    InvestigationLegacyComparison,
    InvestigationLegacyComparison.NotCompared
  >;
}): InvestigationFullyEvaluatedTelemetrySample {
  return Object.freeze({
    ...input.terminal,
    sampleId: `evaluated-${input.attestationHash}`,
    collectedAt: input.evaluatedAt,
    evidenceCompleteness:
      InvestigationTelemetryEvidenceCompleteness.FullyEvaluated,
    expectedDefectCount: input.expectedDefectCount,
    detectedDefectCount: input.detectedDefectCount,
    falseClean:
      input.terminal.conclusion ===
        InvestigationTelemetryConclusion.VerifiedClean &&
      input.expectedDefectCount > 0,
    legacyComparison: input.legacyComparison,
    securityViolationCount: input.securityViolationCount,
  });
}

export function canonicalEvaluationJson(value: unknown): string {
  return canonicalInvestigationOperationsJson(value);
}

const maximumEvaluationAttestationLifetimeMs = 7 * 24 * 60 * 60 * 1_000;

function exactFields(
  value: unknown,
  expected: readonly string[],
  field: string,
): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field}_invalid`);
  }
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error(`${field}_invalid`);
  }
}

function identifier(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
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

function nonNegative(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field}_invalid`);
  }
}
