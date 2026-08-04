export enum ScmProvider {
  GitHub = "github",
  GitLab = "gitlab",
}

export enum ProducerDistributionKind {
  HostedComposite = "hosted_composite",
  PublicReusable = "public_reusable",
}

export enum ProducerReleaseState {
  Registered = "registered",
  Revoked = "revoked",
}

export enum ReviewCapabilityProfile {
  ExactRevisionV2 = "exact_revision_v2",
  PromptOnlyV2 = "prompt_only_v2",
  ContextGatewayV2 = "context_gateway_v2",
}

export enum ReviewProtocolVersion {
  V2 = "review_action_v2",
}

export enum ReviewMutationLaneKind {
  HostedReviewRouterApp = "hosted_reviewrouter_app",
}

export enum ReviewMutationMode {
  V1Open = "v1_open",
  V1Draining = "v1_draining",
  V2Active = "v2_active",
  Paused = "paused",
}

export enum ReviewMutationAuthorityInitializationMode {
  V1 = "v1",
  DirectV2 = "direct_v2",
}

export enum ReviewRunAuthorizationState {
  Active = "active",
  Expired = "expired",
  Revoked = "revoked",
}

export enum ReviewRunAuthorizationTokenAudience {
  ReviewRun = "review_run",
}

export const REVIEW_RUN_AUTHORIZATION_TOKEN_ISSUER =
  "reviewrouter-review-run-control";

export enum ReviewTrustDomain {
  TrustedManaged = "trusted_managed",
  TrustedLocal = "trusted_local",
  UntrustedContribution = "untrusted_contribution",
}

export enum ReviewSafetyPolicyScope {
  Global = "global",
  Workspace = "workspace",
  Repository = "repository",
}

export enum ReviewSafetyCapability {
  RunAuthorizationV2 = "run_authorization_v2",
  ReviewInvestigationV1 = "review_investigation_v1",
  EvidenceWritesV2 = "evidence_writes_v2",
  EvidenceReuseV2 = "evidence_reuse_v2",
  PromptOnlyReuse = "prompt_only_reuse",
  ContextGatewayReuse = "context_gateway_reuse",
  PublicationOperationsV2 = "publication_operations_v2",
  MutationEpochV2 = "mutation_epoch_v2",
}

export enum ReviewSafetyRolloutMode {
  Disabled = "disabled",
  Shadow = "shadow",
  Allowlisted = "allowlisted",
  Enabled = "enabled",
}

export enum ReviewSafetyDecisionKind {
  RunAuthorization = "run_authorization",
  InvestigationExecution = "investigation_execution",
  InvocationLeaseAdmission = "invocation_lease_admission",
  ObservationAcceptance = "observation_acceptance",
  AuthorizedExecutionContinuation = "authorized_execution_continuation",
  ExactRevisionCrossExecutionReuse = "exact_revision_cross_execution_reuse",
  PromptOnlyCrossRevisionReuse = "prompt_only_cross_revision_reuse",
  ContextGatewayCrossRevisionReuse = "context_gateway_cross_revision_reuse",
  ExecutionFinalizationWithPermit = "execution_finalization_with_permit",
  PublicationMutation = "publication_mutation",
  MutationEpochActivation = "mutation_epoch_activation",
  StatusOrReconciliation = "status_or_reconciliation",
}

export enum ReviewProviderKind {
  Codex = "codex",
  ClaudeCode = "claude_code",
  OpenRouter = "openrouter",
}

export enum ReviewTaskKind {
  CodeReview = "code_review",
  FindingRevalidation = "finding_revalidation",
  ConflictReview = "conflict_review",
}

export enum ReviewRunControlErrorCode {
  InvalidArgument = "invalid_argument",
  ImmutableConflict = "immutable_conflict",
  VersionConflict = "version_conflict",
  Missing = "missing",
  InvalidTransition = "invalid_transition",
  ProofRequired = "proof_required",
  BehaviorDisabled = "behavior_disabled",
}

export class ReviewRunControlDomainError extends Error {
  constructor(
    readonly code: ReviewRunControlErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ReviewRunControlDomainError";
  }
}

export type ReviewRunScope = {
  readonly workspaceId: string;
  readonly repositoryConnectionId: string;
  readonly scmRepositoryIdentityId: string;
  readonly pullRequestNumber: number;
};

export type ProviderTaskSelector = {
  readonly providerKind: ReviewProviderKind;
  readonly taskKind: ReviewTaskKind;
};

export type ProviderVoteLane = {
  readonly providerKind: ReviewProviderKind;
  readonly providerVoteIdentityHash: string;
};

export function assertIdentifier(value: string, field: string): void {
  if (value.length < 1 || value.length > 255 || value.trim() !== value) {
    invalid(`${field}_invalid`);
  }
}

export function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    invalid(`${field}_invalid`);
  }
}

export function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalid(`${field}_invalid`);
  }
}

export function assertNonNegativeBigInt(value: bigint, field: string): void {
  if (typeof value !== "bigint" || value < 0n) {
    invalid(`${field}_invalid`);
  }
}

export function unsignedDecimal(value: bigint): string {
  assertNonNegativeBigInt(value, "unsigned_decimal");
  return value.toString(10);
}

export function assertDate(value: Date, field: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    invalid(`${field}_invalid`);
  }
}

export function assertSha256(value: string, field: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    invalid(`${field}_invalid`);
  }
}

export function assertCommitSha(value: string, field: string): void {
  if (!/^[a-f0-9]{40}$/.test(value)) {
    invalid(`${field}_invalid`);
  }
}

export function cloneDate(value: Date): Date {
  return new Date(value.getTime());
}

export function invalid(message: string): never {
  throw new ReviewRunControlDomainError(
    ReviewRunControlErrorCode.InvalidArgument,
    message,
  );
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortCanonicalValue(value));
}

function sortCanonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortCanonicalValue);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "bigint") {
    return unsignedDecimal(value);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, sortCanonicalValue(entry)]),
    );
  }
  return value;
}
