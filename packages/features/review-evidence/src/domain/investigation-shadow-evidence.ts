import {
  stableJson,
  type CanonicalJsonValue,
} from "./provider-invocation-manifest";
import {
  ReviewProviderKind,
  ReviewTrustDomain,
  assertBoundedString,
  assertEpochMilliseconds,
  assertGitObjectId,
  assertNonNegativeInteger,
  assertPositiveInteger,
  assertSha256,
} from "./review-evidence-primitives";
import {
  prepareReviewObservationPayload,
  reviewEvidenceMaxPayloadBytes,
  type ReviewObservationPayload,
} from "./review-observation";

export const investigationShadowEvidenceVersion = 1;
export const investigationShadowEvidenceRetentionPolicyVersion =
  "investigation-shadow-evidence-retention.v1";
export const investigationShadowEvidenceRetentionMs = 30 * 24 * 60 * 60 * 1_000;
export const investigationShadowEvidenceMaxQueryLimit = 1_000;
export const investigationShadowEvidenceMaxPruneLimit = 10_000;
export const investigationShadowEvidenceMaxCertificateBytes =
  2 * reviewEvidenceMaxPayloadBytes + 128 * 1_024;

const maxIdentifierLength = 512;
const maxModelLength = 256;

export enum InvestigationShadowEvidenceAuthority {
  NonAuthoritative = "non_authoritative",
}

export enum InvestigationShadowEvidenceSourceKind {
  TerminalCertificate = "terminal_certificate",
}

export enum InvestigationShadowEvidenceConclusion {
  VerifiedClean = "verified_clean",
  Findings = "findings",
  Inconclusive = "inconclusive",
}

export enum InvestigationShadowEvidenceCriticDecision {
  Accept = "accept",
  Veto = "veto",
  Abstain = "abstain",
}

export type InvestigationShadowEvidenceScope = Readonly<{
  workspaceId: string;
  repositoryConnectionId: string;
  scmRepositoryIdentityId: string;
  pullRequestNumber: number;
  trustDomain: ReviewTrustDomain;
  authorizationScopeHash: string;
}>;

export type InvestigationShadowEvidenceRevision = Readonly<{
  baseSha: string;
  mergeBaseSha: string;
  headSha: string;
  reviewRevisionHash: string;
}>;

export type InvestigationShadowEvidenceCertificate = Readonly<{
  certificateId: string;
  certificateHash: string;
  investigationId: string;
  investigationVersion: number;
  dossierDigest: string;
  reviewRevisionHash: string;
  stableReviewUnitKey: string;
  providerVoteLaneId: string;
  coverageContractVersion: string;
  expansionRulesVersion: string;
  gatewayPolicyVersion: string;
  criticPolicyVersion: string;
  runtimeProfileVersion: string;
  producerReleaseId: string;
  conclusion: InvestigationShadowEvidenceConclusion;
  findingSetHash: string;
  obligationSetHash: string;
  receiptSetHash: string;
  scopeHash: string;
  coverageStateHash: string;
  contextAttestationSetHash: string;
  turnProvenanceHash: string;
  terminalProviderKind: ReviewProviderKind | null;
  terminalActualModel: string | null;
  terminalOutcomeHash: string;
  terminalObservationCanonicalJson: string;
  criticAttestationId: string | null;
  criticAttestationHash: string | null;
  criticDecision: InvestigationShadowEvidenceCriticDecision | null;
  issuedAt: string;
  expiresAt: string;
}>;

export type InvestigationShadowEvidenceProjectionSource = Readonly<{
  investigationId: string;
  investigationVersion: number;
  certifiedDossierDigest: string;
  scope: InvestigationShadowEvidenceScope;
  revision: InvestigationShadowEvidenceRevision;
  executionId: string;
  workSlotId: string;
  stableReviewUnitKey: string;
  providerVoteLaneId: string;
  coverageContractVersion: string;
  expansionRulesVersion: string;
  gatewayPolicyVersion: string;
  criticPolicyVersion: string;
  runtimeProfileVersion: string;
  producerReleaseId: string;
  conclusion: InvestigationShadowEvidenceConclusion;
  certificate: InvestigationShadowEvidenceCertificate;
}>;

export type InvestigationShadowEvidence = Readonly<{
  shadowEvidenceId: string;
  evidenceVersion: typeof investigationShadowEvidenceVersion;
  authority: InvestigationShadowEvidenceAuthority.NonAuthoritative;
  sourceKind: InvestigationShadowEvidenceSourceKind.TerminalCertificate;
  retentionPolicyVersion: typeof investigationShadowEvidenceRetentionPolicyVersion;
  investigationId: string;
  investigationVersion: number;
  scope: InvestigationShadowEvidenceScope;
  revision: InvestigationShadowEvidenceRevision;
  executionId: string;
  workSlotId: string;
  stableReviewUnitKey: string;
  providerVoteLaneId: string;
  producerReleaseId: string;
  conclusion: InvestigationShadowEvidenceConclusion;
  certificateId: string;
  certificateHash: string;
  certificateCanonicalJson: string;
  terminalProviderKind: ReviewProviderKind | null;
  terminalActualModel: string | null;
  terminalOutcomeHash: string;
  terminalObservationCanonicalJson: string;
  terminalPayloadHash: string;
  terminalPayloadByteCount: number;
  findingCount: number;
  recordHash: string;
  issuedAtMs: number;
  retainUntilMs: number;
}>;

export type InvestigationShadowEvidenceCandidate = Omit<
  InvestigationShadowEvidence,
  "scope" | "revision"
> &
  Readonly<{
    scope: InvestigationShadowEvidenceScope;
    revision: InvestigationShadowEvidenceRevision;
  }>;

export type PreparedInvestigationShadowTerminalPayload = Readonly<{
  canonicalJson: string;
  canonicalBytes: Uint8Array;
  byteCount: number;
  findingCount: number;
}>;

export function prepareInvestigationShadowTerminalPayload(
  canonicalJson: string,
): PreparedInvestigationShadowTerminalPayload {
  if (
    canonicalJson.length === 0 ||
    new TextEncoder().encode(canonicalJson).byteLength >
      reviewEvidenceMaxPayloadBytes
  ) {
    throw new Error("investigation_shadow_terminal_payload_size_invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(canonicalJson);
  } catch {
    throw new Error("investigation_shadow_terminal_payload_invalid");
  }
  if (!isRecord(parsed)) {
    throw new Error("investigation_shadow_terminal_payload_invalid");
  }
  let prepared;
  try {
    prepared = prepareReviewObservationPayload(
      parsed as unknown as ReviewObservationPayload,
    );
  } catch {
    throw new Error("investigation_shadow_terminal_payload_invalid");
  }
  const normalizedCanonicalJson = new TextDecoder().decode(
    prepared.canonicalBytes,
  );
  if (normalizedCanonicalJson !== canonicalJson) {
    throw new Error("investigation_shadow_terminal_payload_not_canonical");
  }
  return Object.freeze({
    canonicalJson: normalizedCanonicalJson,
    canonicalBytes: new Uint8Array(prepared.canonicalBytes),
    byteCount: prepared.byteCount,
    findingCount: prepared.findingCount,
  });
}

export function investigationShadowCertificateCanonicalValue(
  certificate: InvestigationShadowEvidenceCertificate,
): CanonicalJsonValue {
  return {
    certificateId: certificate.certificateId,
    investigationId: certificate.investigationId,
    investigationVersion: certificate.investigationVersion,
    dossierDigest: certificate.dossierDigest,
    reviewRevisionHash: certificate.reviewRevisionHash,
    stableReviewUnitKey: certificate.stableReviewUnitKey,
    providerVoteLaneId: certificate.providerVoteLaneId,
    coverageContractVersion: certificate.coverageContractVersion,
    expansionRulesVersion: certificate.expansionRulesVersion,
    gatewayPolicyVersion: certificate.gatewayPolicyVersion,
    criticPolicyVersion: certificate.criticPolicyVersion,
    runtimeProfileVersion: certificate.runtimeProfileVersion,
    producerReleaseId: certificate.producerReleaseId,
    conclusion: certificate.conclusion,
    findingSetHash: certificate.findingSetHash,
    obligationSetHash: certificate.obligationSetHash,
    receiptSetHash: certificate.receiptSetHash,
    scopeHash: certificate.scopeHash,
    coverageStateHash: certificate.coverageStateHash,
    contextAttestationSetHash: certificate.contextAttestationSetHash,
    turnProvenanceHash: certificate.turnProvenanceHash,
    terminalProviderKind: certificate.terminalProviderKind,
    terminalActualModel: certificate.terminalActualModel,
    terminalOutcomeHash: certificate.terminalOutcomeHash,
    terminalObservationCanonicalJson:
      certificate.terminalObservationCanonicalJson,
    criticAttestationId: certificate.criticAttestationId,
    criticAttestationHash: certificate.criticAttestationHash,
    criticDecision: certificate.criticDecision,
    issuedAt: certificate.issuedAt,
    expiresAt: certificate.expiresAt,
  };
}

export function assertInvestigationShadowEvidenceCertificate(
  certificate: InvestigationShadowEvidenceCertificate,
): void {
  assertShadowIdentifier(certificate.certificateId, "certificate_id");
  assertSha256(certificate.certificateHash, "certificate_hash");
  assertShadowIdentifier(certificate.investigationId, "investigation_id");
  assertPositiveInteger(
    certificate.investigationVersion,
    "certificate_investigation_version",
  );
  assertSha256(certificate.dossierDigest, "certificate_dossier_digest");
  assertSha256(
    certificate.reviewRevisionHash,
    "certificate_review_revision_hash",
  );
  assertShadowIdentifier(
    certificate.stableReviewUnitKey,
    "certificate_stable_review_unit_key",
  );
  assertShadowIdentifier(
    certificate.providerVoteLaneId,
    "certificate_provider_vote_lane_id",
  );
  for (const [field, value] of [
    [
      "certificate_coverage_contract_version",
      certificate.coverageContractVersion,
    ],
    ["certificate_expansion_rules_version", certificate.expansionRulesVersion],
    ["certificate_gateway_policy_version", certificate.gatewayPolicyVersion],
    ["certificate_critic_policy_version", certificate.criticPolicyVersion],
    ["certificate_runtime_profile_version", certificate.runtimeProfileVersion],
    ["certificate_producer_release_id", certificate.producerReleaseId],
  ] as const) {
    assertShadowIdentifier(value, field);
  }
  assertShadowConclusion(certificate.conclusion);
  for (const [field, value] of [
    ["certificate_finding_set_hash", certificate.findingSetHash],
    ["certificate_obligation_set_hash", certificate.obligationSetHash],
    ["certificate_receipt_set_hash", certificate.receiptSetHash],
    ["certificate_scope_hash", certificate.scopeHash],
    ["certificate_coverage_state_hash", certificate.coverageStateHash],
    [
      "certificate_context_attestation_set_hash",
      certificate.contextAttestationSetHash,
    ],
    ["certificate_turn_provenance_hash", certificate.turnProvenanceHash],
    ["certificate_terminal_outcome_hash", certificate.terminalOutcomeHash],
  ] as const) {
    assertSha256(value, field);
  }
  assertTerminalProvider(certificate.terminalProviderKind);
  if (certificate.terminalActualModel !== null) {
    assertBoundedString(
      certificate.terminalActualModel,
      "certificate_terminal_actual_model",
      maxModelLength,
    );
  }
  if (
    (certificate.terminalProviderKind === null) !==
    (certificate.terminalActualModel === null)
  ) {
    throw new Error("investigation_shadow_certificate_provenance_incomplete");
  }
  prepareInvestigationShadowTerminalPayload(
    certificate.terminalObservationCanonicalJson,
  );
  const hasCriticId = certificate.criticAttestationId !== null;
  const hasCriticHash = certificate.criticAttestationHash !== null;
  const hasCriticDecision = certificate.criticDecision !== null;
  if (hasCriticId !== hasCriticHash || hasCriticId !== hasCriticDecision) {
    throw new Error("investigation_shadow_critic_attestation_incomplete");
  }
  if (certificate.criticAttestationId !== null) {
    assertShadowIdentifier(
      certificate.criticAttestationId,
      "certificate_critic_attestation_id",
    );
  }
  if (certificate.criticAttestationHash !== null) {
    assertSha256(
      certificate.criticAttestationHash,
      "certificate_critic_attestation_hash",
    );
  }
  if (
    certificate.criticDecision !== null &&
    !Object.values(InvestigationShadowEvidenceCriticDecision).includes(
      certificate.criticDecision,
    )
  ) {
    throw new Error("investigation_shadow_critic_decision_invalid");
  }
  if (
    certificate.conclusion ===
      InvestigationShadowEvidenceConclusion.VerifiedClean &&
    certificate.criticDecision !==
      InvestigationShadowEvidenceCriticDecision.Accept
  ) {
    throw new Error("investigation_shadow_verified_clean_critic_invalid");
  }
  const issuedAtMs = strictIsoTimestamp(
    certificate.issuedAt,
    "certificate_issued_at",
  );
  const expiresAtMs = strictIsoTimestamp(
    certificate.expiresAt,
    "certificate_expires_at",
  );
  if (expiresAtMs <= issuedAtMs) {
    throw new Error("investigation_shadow_certificate_lifetime_invalid");
  }
  const canonicalBytes = new TextEncoder().encode(
    stableJson(investigationShadowCertificateCanonicalValue(certificate)),
  );
  if (
    canonicalBytes.byteLength > investigationShadowEvidenceMaxCertificateBytes
  ) {
    throw new Error("investigation_shadow_certificate_too_large");
  }
}

export function investigationShadowScopeCanonicalValue(
  scope: InvestigationShadowEvidenceScope,
): CanonicalJsonValue {
  return {
    workspaceId: scope.workspaceId,
    repositoryConnectionId: scope.repositoryConnectionId,
    scmRepositoryIdentityId: scope.scmRepositoryIdentityId,
    pullRequestNumber: scope.pullRequestNumber,
    trustDomain: scope.trustDomain,
    authorizationScopeHash: scope.authorizationScopeHash,
  };
}

export function investigationShadowEvidenceRecordCanonicalValue(
  evidence: Omit<InvestigationShadowEvidence, "recordHash">,
): CanonicalJsonValue {
  return {
    shadowEvidenceId: evidence.shadowEvidenceId,
    evidenceVersion: evidence.evidenceVersion,
    authority: evidence.authority,
    sourceKind: evidence.sourceKind,
    retentionPolicyVersion: evidence.retentionPolicyVersion,
    investigationId: evidence.investigationId,
    investigationVersion: evidence.investigationVersion,
    scope: investigationShadowScopeCanonicalValue(evidence.scope),
    revision: {
      baseSha: evidence.revision.baseSha,
      mergeBaseSha: evidence.revision.mergeBaseSha,
      headSha: evidence.revision.headSha,
      reviewRevisionHash: evidence.revision.reviewRevisionHash,
    },
    executionId: evidence.executionId,
    workSlotId: evidence.workSlotId,
    stableReviewUnitKey: evidence.stableReviewUnitKey,
    providerVoteLaneId: evidence.providerVoteLaneId,
    producerReleaseId: evidence.producerReleaseId,
    conclusion: evidence.conclusion,
    certificateId: evidence.certificateId,
    certificateHash: evidence.certificateHash,
    certificateCanonicalJson: evidence.certificateCanonicalJson,
    terminalProviderKind: evidence.terminalProviderKind,
    terminalActualModel: evidence.terminalActualModel,
    terminalOutcomeHash: evidence.terminalOutcomeHash,
    terminalObservationCanonicalJson: evidence.terminalObservationCanonicalJson,
    terminalPayloadHash: evidence.terminalPayloadHash,
    terminalPayloadByteCount: evidence.terminalPayloadByteCount,
    findingCount: evidence.findingCount,
    issuedAtMs: evidence.issuedAtMs,
    retainUntilMs: evidence.retainUntilMs,
  };
}

export function createInvestigationShadowEvidence(
  candidate: InvestigationShadowEvidenceCandidate,
): InvestigationShadowEvidence {
  assertShadowIdentifier(candidate.shadowEvidenceId, "shadow_evidence_id");
  if (candidate.evidenceVersion !== investigationShadowEvidenceVersion) {
    throw new Error("investigation_shadow_evidence_version_unsupported");
  }
  if (
    candidate.authority !==
    InvestigationShadowEvidenceAuthority.NonAuthoritative
  ) {
    throw new Error("investigation_shadow_evidence_authority_invalid");
  }
  if (
    candidate.sourceKind !==
    InvestigationShadowEvidenceSourceKind.TerminalCertificate
  ) {
    throw new Error("investigation_shadow_evidence_source_invalid");
  }
  if (
    candidate.retentionPolicyVersion !==
    investigationShadowEvidenceRetentionPolicyVersion
  ) {
    throw new Error("investigation_shadow_retention_policy_invalid");
  }
  assertShadowIdentifier(candidate.investigationId, "investigation_id");
  assertPositiveInteger(
    candidate.investigationVersion,
    "investigation_version",
  );
  const scope = normalizeInvestigationShadowScope(candidate.scope);
  const revision = normalizeInvestigationShadowRevision(candidate.revision);
  assertShadowIdentifier(candidate.executionId, "execution_id");
  assertShadowIdentifier(candidate.workSlotId, "work_slot_id");
  assertShadowIdentifier(
    candidate.stableReviewUnitKey,
    "stable_review_unit_key",
  );
  assertShadowIdentifier(candidate.providerVoteLaneId, "provider_vote_lane_id");
  assertShadowIdentifier(candidate.producerReleaseId, "producer_release_id");
  assertShadowConclusion(candidate.conclusion);
  assertShadowIdentifier(candidate.certificateId, "certificate_id");
  assertSha256(candidate.certificateHash, "certificate_hash");
  assertBoundedCanonicalJson(
    candidate.certificateCanonicalJson,
    "certificate_canonical_json",
    investigationShadowEvidenceMaxCertificateBytes,
  );
  assertTerminalProvider(candidate.terminalProviderKind);
  if (candidate.terminalActualModel !== null) {
    assertBoundedString(
      candidate.terminalActualModel,
      "terminal_actual_model",
      maxModelLength,
    );
  }
  if (
    (candidate.terminalProviderKind === null) !==
    (candidate.terminalActualModel === null)
  ) {
    throw new Error("investigation_shadow_terminal_provenance_incomplete");
  }
  assertSha256(candidate.terminalOutcomeHash, "terminal_outcome_hash");
  assertSha256(candidate.terminalPayloadHash, "terminal_payload_hash");
  if (candidate.terminalOutcomeHash !== candidate.terminalPayloadHash) {
    throw new Error("investigation_shadow_terminal_hash_mismatch");
  }
  const prepared = prepareInvestigationShadowTerminalPayload(
    candidate.terminalObservationCanonicalJson,
  );
  if (
    prepared.byteCount !== candidate.terminalPayloadByteCount ||
    prepared.findingCount !== candidate.findingCount
  ) {
    throw new Error("investigation_shadow_terminal_accounting_mismatch");
  }
  assertNonNegativeInteger(
    candidate.terminalPayloadByteCount,
    "terminal_payload_byte_count",
  );
  assertNonNegativeInteger(candidate.findingCount, "finding_count");
  if (
    (candidate.conclusion ===
      InvestigationShadowEvidenceConclusion.VerifiedClean &&
      candidate.findingCount !== 0) ||
    (candidate.conclusion === InvestigationShadowEvidenceConclusion.Findings &&
      candidate.findingCount === 0)
  ) {
    throw new Error("investigation_shadow_conclusion_payload_mismatch");
  }
  assertSha256(candidate.recordHash, "record_hash");
  assertInvestigationShadowEvidenceEpochMilliseconds(
    candidate.issuedAtMs,
    "issued_at_ms",
  );
  assertInvestigationShadowEvidenceEpochMilliseconds(
    candidate.retainUntilMs,
    "retain_until_ms",
  );
  if (
    candidate.retainUntilMs !==
    candidate.issuedAtMs + investigationShadowEvidenceRetentionMs
  ) {
    throw new Error("investigation_shadow_retention_invalid");
  }
  return Object.freeze({
    ...candidate,
    scope,
    revision,
  });
}

export function cloneInvestigationShadowEvidence(
  evidence: InvestigationShadowEvidence,
): InvestigationShadowEvidence {
  return createInvestigationShadowEvidence({
    ...evidence,
    scope: { ...evidence.scope },
    revision: { ...evidence.revision },
  });
}

export function sameInvestigationShadowEvidenceAcceptance(
  left: InvestigationShadowEvidence,
  right: InvestigationShadowEvidence,
): boolean {
  return (
    left.shadowEvidenceId === right.shadowEvidenceId &&
    left.investigationId === right.investigationId &&
    left.certificateId === right.certificateId &&
    left.certificateHash === right.certificateHash &&
    left.recordHash === right.recordHash
  );
}

export function canonicalInvestigationShadowCertificate(
  certificate: InvestigationShadowEvidenceCertificate,
): string {
  return stableJson(investigationShadowCertificateCanonicalValue(certificate));
}

function normalizeInvestigationShadowScope(
  scope: InvestigationShadowEvidenceScope,
): InvestigationShadowEvidenceScope {
  assertShadowIdentifier(scope.workspaceId, "workspace_id");
  assertShadowIdentifier(
    scope.repositoryConnectionId,
    "repository_connection_id",
  );
  assertShadowIdentifier(
    scope.scmRepositoryIdentityId,
    "scm_repository_identity_id",
  );
  assertPositiveInteger(scope.pullRequestNumber, "pull_request_number");
  if (
    ![
      ReviewTrustDomain.TrustedManaged,
      ReviewTrustDomain.TrustedLocal,
      ReviewTrustDomain.UntrustedContribution,
    ].includes(scope.trustDomain)
  ) {
    throw new Error("investigation_shadow_trust_domain_invalid");
  }
  assertSha256(scope.authorizationScopeHash, "authorization_scope_hash");
  return Object.freeze({ ...scope });
}

function normalizeInvestigationShadowRevision(
  revision: InvestigationShadowEvidenceRevision,
): InvestigationShadowEvidenceRevision {
  assertGitObjectId(revision.baseSha, "base_sha");
  assertGitObjectId(revision.mergeBaseSha, "merge_base_sha");
  assertGitObjectId(revision.headSha, "head_sha");
  assertSha256(revision.reviewRevisionHash, "review_revision_hash");
  return Object.freeze({ ...revision });
}

function assertShadowConclusion(
  conclusion: InvestigationShadowEvidenceConclusion,
): void {
  if (
    !Object.values(InvestigationShadowEvidenceConclusion).includes(conclusion)
  ) {
    throw new Error("investigation_shadow_conclusion_invalid");
  }
}

function assertTerminalProvider(provider: ReviewProviderKind | null): void {
  if (
    provider !== null &&
    provider !== ReviewProviderKind.Codex &&
    provider !== ReviewProviderKind.ClaudeCode
  ) {
    throw new Error("investigation_shadow_terminal_provider_invalid");
  }
}

function assertShadowIdentifier(value: string, field: string): void {
  if (
    value.length === 0 ||
    value.length > maxIdentifierLength ||
    value.trim() !== value ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
      );
    })
  ) {
    throw new Error(`${field}_invalid`);
  }
}

function assertBoundedCanonicalJson(
  value: string,
  field: string,
  maxBytes: number,
): void {
  if (
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > maxBytes
  ) {
    throw new Error(`${field}_invalid`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${field}_invalid`);
  }
  if (!isCanonicalJsonValue(parsed) || stableJson(parsed) !== value) {
    throw new Error(`${field}_invalid`);
  }
}

function isCanonicalJsonValue(value: unknown): value is CanonicalJsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isCanonicalJsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isCanonicalJsonValue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strictIsoTimestamp(value: string, field: string): number {
  const timestamp = Date.parse(value);
  if (
    !Number.isSafeInteger(timestamp) ||
    new Date(timestamp).toISOString() !== value
  ) {
    throw new Error(`${field}_invalid`);
  }
  return timestamp;
}

export function assertInvestigationShadowEvidenceEpochMilliseconds(
  value: number,
  field: string,
): void {
  assertEpochMilliseconds(value, field);
  if (!Number.isFinite(new Date(value).getTime())) {
    throw new Error(`${field}_invalid`);
  }
}
