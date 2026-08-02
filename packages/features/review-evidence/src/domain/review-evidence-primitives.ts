export const sha256Pattern = /^[a-f0-9]{64}$/u;
export const gitObjectIdPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
export const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

export const reviewEvidenceMaxTaskKinds = 16;
export const reviewEvidenceMaxQualityFlags = 16;
export const reviewEvidenceMaxTransportAttempts = 16;

export enum ReviewProviderKind {
  Codex = "codex",
  ClaudeCode = "claude_code",
  OpenRouter = "openrouter",
  Unknown = "unknown",
}

export enum ReviewTaskKind {
  FindingDiscovery = "finding_discovery",
  LifecycleRevalidation = "lifecycle_revalidation",
  Unknown = "unknown",
}

export enum ProviderExecutionProfile {
  PromptOnlyEnvelopeV1 = "prompt_only_envelope_v1",
  AgenticUnboundedV1 = "agentic_unbounded_v1",
  ContextGatewayV1 = "context_gateway_v1",
  InvestigationGatewayV1 = "investigation_gateway_v1",
  Unknown = "unknown",
}

export enum ReviewTrustDomain {
  TrustedManaged = "trusted_managed",
  TrustedLocal = "trusted_local",
  UntrustedContribution = "untrusted_contribution",
  Unknown = "unknown",
}

export enum ReviewObservationStatus {
  Success = "success",
}

export enum ReviewObservationQualityFlag {
  ModelFallback = "model_fallback",
  LowConfidence = "low_confidence",
  ProviderWarning = "provider_warning",
  ContextInspectionIncomplete = "context_inspection_incomplete",
  ContextAttestationUnavailable = "context_attestation_unavailable",
  CrossRevisionReuseDisabled = "cross_revision_reuse_disabled",
  InvestigationFindings = "investigation_findings",
  InvestigationInconclusive = "investigation_inconclusive",
  Unknown = "unknown",
}

export enum ReviewFindingSeverity {
  Critical = "critical",
  Major = "major",
  Minor = "minor",
  Unknown = "unknown",
}

export enum ReviewLifecycleRevalidationVerdict {
  Resolved = "resolved",
  StillValid = "still_valid",
  Uncertain = "uncertain",
  Unknown = "unknown",
}

export type ReviewEvidenceScope = Readonly<{
  workspaceId: string;
  repositoryConnectionId: string;
  scmRepositoryIdentityId: string;
  pullRequestNumber: number;
  authorizationScopeHash: string;
}>;

export type ReviewRevision = Readonly<{
  baseSha: string;
  mergeBaseSha: string;
  headSha: string;
  reviewRevisionHash: string;
}>;

export function normalizeReviewEvidenceScope(
  value: ReviewEvidenceScope,
): ReviewEvidenceScope {
  assertIdentifier(value.workspaceId, "workspace_id");
  assertIdentifier(value.repositoryConnectionId, "repository_connection_id");
  assertIdentifier(value.scmRepositoryIdentityId, "scm_repository_identity_id");
  assertPositiveInteger(value.pullRequestNumber, "pull_request_number");
  assertSha256(value.authorizationScopeHash, "authorization_scope_hash");
  return Object.freeze({ ...value });
}

export function normalizeReviewRevision(value: ReviewRevision): ReviewRevision {
  assertGitObjectId(value.baseSha, "base_sha");
  assertGitObjectId(value.mergeBaseSha, "merge_base_sha");
  assertGitObjectId(value.headSha, "head_sha");
  assertSha256(value.reviewRevisionHash, "review_revision_hash");
  return Object.freeze({ ...value });
}

export function normalizeTaskKinds(
  values: readonly ReviewTaskKind[],
): readonly ReviewTaskKind[] {
  if (values.length === 0 || values.length > reviewEvidenceMaxTaskKinds) {
    throw new Error("review_evidence_task_kind_count_invalid");
  }
  const sorted = [...values].sort(compareStrings);
  assertNoDuplicates(sorted, "review_evidence_task_kind_duplicate");
  if (sorted.includes(ReviewTaskKind.Unknown)) {
    throw new Error("review_evidence_task_kind_unknown");
  }
  return Object.freeze(sorted);
}

export function normalizeQualityFlags(
  values: readonly ReviewObservationQualityFlag[],
): readonly ReviewObservationQualityFlag[] {
  if (values.length > reviewEvidenceMaxQualityFlags) {
    throw new Error("review_evidence_quality_flag_count_invalid");
  }
  const sorted = [...values].sort(compareStrings);
  assertNoDuplicates(sorted, "review_evidence_quality_flag_duplicate");
  if (sorted.includes(ReviewObservationQualityFlag.Unknown)) {
    throw new Error("review_evidence_quality_flag_unknown");
  }
  return Object.freeze(sorted);
}

export function assertSha256(value: string, field: string): void {
  if (!sha256Pattern.test(value)) throw new Error(`${field}_invalid`);
}

export function assertGitObjectId(value: string, field: string): void {
  if (!gitObjectIdPattern.test(value)) throw new Error(`${field}_invalid`);
}

export function assertIdentifier(value: string, field: string): void {
  if (!identifierPattern.test(value)) throw new Error(`${field}_invalid`);
}

export function assertBoundedString(
  value: string,
  field: string,
  maxLength: number,
  options: { readonly allowEmpty?: boolean } = {},
): void {
  if ((!options.allowEmpty && value.length === 0) || value.length > maxLength) {
    throw new Error(`${field}_invalid`);
  }
}

export function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field}_invalid`);
  }
}

export function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field}_invalid`);
  }
}

export function assertEpochMilliseconds(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field}_invalid`);
  }
}

export function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sameScope(
  left: ReviewEvidenceScope,
  right: ReviewEvidenceScope,
): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.repositoryConnectionId === right.repositoryConnectionId &&
    left.scmRepositoryIdentityId === right.scmRepositoryIdentityId &&
    left.pullRequestNumber === right.pullRequestNumber &&
    left.authorizationScopeHash === right.authorizationScopeHash
  );
}

export function sameRevision(
  left: ReviewRevision,
  right: ReviewRevision,
): boolean {
  return (
    left.baseSha === right.baseSha &&
    left.mergeBaseSha === right.mergeBaseSha &&
    left.headSha === right.headSha &&
    left.reviewRevisionHash === right.reviewRevisionHash
  );
}

function assertNoDuplicates(values: readonly string[], code: string): void {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] === values[index - 1]) throw new Error(code);
  }
}
