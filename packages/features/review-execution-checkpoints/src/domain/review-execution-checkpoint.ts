import { createHash } from "node:crypto";

export const reviewExecutionCheckpointSchemaVersion = 1;
export const reviewExecutionCheckpointTtlMs = 7 * 24 * 60 * 60 * 1000;
export const reviewExecutionCheckpointMaxPlannedWorkKeys = 200;
export const reviewExecutionCheckpointMaxBatchBytes = 128 * 1024;
export const reviewExecutionCheckpointMaxAggregateBytes = 2 * 1024 * 1024;
export const reviewExecutionCheckpointMaxFindings = 1_000;
export const reviewExecutionCheckpointMaxPruneLimit = 10_000;

const maxFilePathsPerBatch = 200;
const maxProviderResultsPerBatch = 50;
const maxLifecycleTargetsPerProvider = 200;
const maxLifecycleRevalidationsPerProvider = 200;
const maxEvidencePerRevalidation = 20;
const maxTokenCount = 1_000_000_000;

export enum ReviewExecutionCheckpointState {
  Active = "active",
  Finalized = "finalized",
}

export enum ReviewExecutionCheckpointRestoreStatus {
  Found = "found",
  Missing = "missing",
  Expired = "expired",
  BaseChanged = "base_changed",
  HeadChanged = "head_changed",
  CompatibilityChanged = "compatibility_changed",
  PlanChanged = "plan_changed",
}

export enum ReviewExecutionCheckpointStartStatus {
  Started = "started",
  Replaced = "replaced",
  Idempotent = "idempotent",
  Conflict = "conflict",
  Finalized = "finalized",
}

export enum ReviewExecutionBatchCommitStatus {
  Committed = "committed",
  Idempotent = "idempotent",
  Conflict = "conflict",
  Missing = "missing",
  Finalized = "finalized",
  UnplannedWork = "unplanned_work",
  BudgetExceeded = "budget_exceeded",
  Corrupted = "corrupted",
}

export enum ReviewExecutionCheckpointFinalizeStatus {
  Finalized = "finalized",
  Idempotent = "idempotent",
  Conflict = "conflict",
  Missing = "missing",
  Incomplete = "incomplete",
  Corrupted = "corrupted",
}

export enum ReviewExecutionCheckpointClearStatus {
  Cleared = "cleared",
  Missing = "missing",
  Conflict = "conflict",
}

export enum ReviewExecutionFindingSeverity {
  Critical = "critical",
  Major = "major",
  Minor = "minor",
}

export enum ReviewExecutionProviderResultStatus {
  Success = "success",
  Error = "error",
  Timeout = "timeout",
  RateLimited = "rate-limited",
}

export enum ReviewExecutionLifecycleVerdict {
  Resolved = "resolved",
  StillValid = "still_valid",
  Uncertain = "uncertain",
}

export type ReviewExecutionFinding = {
  readonly file: string;
  readonly startLine?: number | undefined;
  readonly line: number;
  readonly endLine?: number | undefined;
  readonly severity: ReviewExecutionFindingSeverity;
  readonly title: string;
  readonly message: string;
  readonly provider?: string | undefined;
  readonly providers?: readonly string[] | undefined;
  readonly actualModel?: string | undefined;
  readonly providerVoteKeys?: readonly string[] | undefined;
  readonly providerPoolSize?: number | undefined;
  readonly confidence?: number | undefined;
  readonly category?: string | undefined;
  readonly hasConsensus?: boolean | undefined;
};

export type ReviewExecutionLifecycleEvidence = {
  readonly path: string;
  readonly startLine?: number | undefined;
  readonly endLine?: number | undefined;
  readonly reason: string;
};

export type ReviewExecutionLifecycleRevalidation = {
  readonly targetId: string;
  readonly fingerprint?: string | undefined;
  readonly verdict: ReviewExecutionLifecycleVerdict;
  readonly confidence?: number | undefined;
  readonly evidence: readonly ReviewExecutionLifecycleEvidence[];
  readonly rationale?: string | undefined;
};

export type ReviewExecutionProviderResult = {
  readonly name: string;
  readonly status: ReviewExecutionProviderResultStatus;
  readonly durationSeconds: number;
  readonly errorMessage?: string | undefined;
  readonly actualModel?: string | undefined;
  readonly aiLikelihood?: number | undefined;
  readonly usage?:
    | {
        readonly promptTokens: number;
        readonly completionTokens: number;
        readonly totalTokens: number;
      }
    | undefined;
  readonly lifecycleAssignedTargetIds: readonly string[];
  readonly lifecycleRevalidations: readonly ReviewExecutionLifecycleRevalidation[];
};

export type ReviewExecutionBatchPayload = {
  readonly filePaths: readonly string[];
  readonly findings: readonly ReviewExecutionFinding[];
  readonly providerResults: readonly ReviewExecutionProviderResult[];
};

export type ReviewExecutionCheckpointScope = {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly pullRequestNumber: number;
};

export type ReviewExecutionCheckpointRoot = ReviewExecutionCheckpointScope & {
  readonly version: number;
  readonly state: ReviewExecutionCheckpointState;
  readonly schemaVersion: number;
  readonly baseSha: string;
  readonly headSha: string;
  readonly compatibilityKey: string;
  readonly planHash: string;
  readonly plannedWorkKeys: readonly string[];
  readonly acceptedBytes: number;
  readonly acceptedFindings: number;
  readonly sourceRunId: string;
  readonly sourceRunAttempt: string;
  readonly updatedAt: Date;
  readonly expiresAt: Date;
  readonly finalizedAt?: Date | undefined;
};

export type ReviewExecutionCheckpointCandidate = Omit<
  ReviewExecutionCheckpointRoot,
  | "version"
  | "state"
  | "acceptedBytes"
  | "acceptedFindings"
  | "updatedAt"
  | "expiresAt"
  | "finalizedAt"
>;

export type ReviewExecutionBatchResult = {
  readonly workKey: string;
  readonly batchId: string;
  readonly batchIndex: number;
  readonly payload: ReviewExecutionBatchPayload;
  readonly payloadHash: string;
  readonly byteCount: number;
  readonly sourceRunId: string;
  readonly sourceRunAttempt: string;
  readonly completedAt: Date;
};

export type ReviewExecutionBatchResultCandidate = Omit<
  ReviewExecutionBatchResult,
  "payloadHash" | "byteCount" | "completedAt"
>;

export type ReviewExecutionCheckpointAggregate = {
  readonly checkpoint: ReviewExecutionCheckpointRoot;
  readonly batchResults: readonly ReviewExecutionBatchResult[];
};

export function prepareReviewExecutionCheckpointRoot(
  candidate: ReviewExecutionCheckpointCandidate,
  input: { readonly version: number; readonly now: Date },
): ReviewExecutionCheckpointRoot {
  assertReviewExecutionCheckpointCandidate(candidate);
  assertPositiveInteger(input.version, "version");
  assertDate(input.now, "updated_at");
  return {
    ...candidate,
    plannedWorkKeys: [...candidate.plannedWorkKeys],
    version: input.version,
    state: ReviewExecutionCheckpointState.Active,
    acceptedBytes: 0,
    acceptedFindings: 0,
    updatedAt: input.now,
    expiresAt: new Date(input.now.getTime() + reviewExecutionCheckpointTtlMs),
  };
}

export function prepareReviewExecutionBatchResult(
  candidate: ReviewExecutionBatchResultCandidate,
  input: { readonly completedAt: Date },
): ReviewExecutionBatchResult {
  assertSha256(candidate.workKey, "work_key");
  assertSha256(candidate.batchId, "batch_id");
  assertNonNegativeInteger(candidate.batchIndex, "batch_index");
  assertIdentifier(candidate.sourceRunId, "source_run_id");
  assertIdentifier(candidate.sourceRunAttempt, "source_run_attempt");
  assertDate(input.completedAt, "completed_at");
  const payload = normalizeReviewExecutionBatchPayload(candidate.payload);
  const byteCount = reviewExecutionBatchPayloadBytes(payload);
  if (byteCount > reviewExecutionCheckpointMaxBatchBytes) {
    throw new Error("review_execution_checkpoint_batch_payload_too_large");
  }
  return {
    ...candidate,
    payload,
    payloadHash: hashReviewExecutionBatchPayload(payload),
    byteCount,
    completedAt: input.completedAt,
  };
}

export function decideReviewExecutionCheckpointRestore(
  aggregate: ReviewExecutionCheckpointAggregate | null,
  input: {
    readonly baseSha: string;
    readonly headSha: string;
    readonly compatibilityKey: string;
    readonly planHash: string;
    readonly now: Date;
  },
):
  | {
      readonly status: ReviewExecutionCheckpointRestoreStatus.Found;
      readonly expectedVersion: number;
      readonly checkpoint: ReviewExecutionCheckpointRoot;
      readonly batchResults: readonly ReviewExecutionBatchResult[];
    }
  | {
      readonly status: Exclude<
        ReviewExecutionCheckpointRestoreStatus,
        ReviewExecutionCheckpointRestoreStatus.Found
      >;
      readonly expectedVersion: number;
    } {
  assertSha(input.baseSha, "base_sha");
  assertSha(input.headSha, "head_sha");
  assertSha256(input.compatibilityKey, "compatibility_key");
  assertSha256(input.planHash, "plan_hash");
  assertDate(input.now, "restore_now");
  if (!aggregate) {
    return {
      status: ReviewExecutionCheckpointRestoreStatus.Missing,
      expectedVersion: 0,
    };
  }
  const { checkpoint } = aggregate;
  if (checkpoint.expiresAt <= input.now) {
    return {
      status: ReviewExecutionCheckpointRestoreStatus.Expired,
      expectedVersion: checkpoint.version,
    };
  }
  if (checkpoint.baseSha !== input.baseSha) {
    return {
      status: ReviewExecutionCheckpointRestoreStatus.BaseChanged,
      expectedVersion: checkpoint.version,
    };
  }
  if (checkpoint.headSha !== input.headSha) {
    return {
      status: ReviewExecutionCheckpointRestoreStatus.HeadChanged,
      expectedVersion: checkpoint.version,
    };
  }
  if (checkpoint.compatibilityKey !== input.compatibilityKey) {
    return {
      status: ReviewExecutionCheckpointRestoreStatus.CompatibilityChanged,
      expectedVersion: checkpoint.version,
    };
  }
  if (checkpoint.planHash !== input.planHash) {
    return {
      status: ReviewExecutionCheckpointRestoreStatus.PlanChanged,
      expectedVersion: checkpoint.version,
    };
  }
  return {
    status: ReviewExecutionCheckpointRestoreStatus.Found,
    expectedVersion: checkpoint.version,
    checkpoint,
    batchResults: orderReviewExecutionBatchResults(
      checkpoint.plannedWorkKeys,
      aggregate.batchResults,
    ),
  };
}

export function normalizeReviewExecutionBatchPayload(
  payload: unknown,
): ReviewExecutionBatchPayload {
  if (!isUnknownRecord(payload)) {
    throw new Error("review_execution_checkpoint_payload_invalid");
  }
  assertExactKeys(
    payload,
    ["filePaths", "findings", "providerResults"],
    "payload_fields",
  );
  const filePaths = normalizeStringArray(payload.filePaths, {
    field: "file_paths",
    maxItems: maxFilePathsPerBatch,
    maxLength: 4_096,
    unique: true,
  });
  if (
    !Array.isArray(payload.findings) ||
    payload.findings.length > reviewExecutionCheckpointMaxFindings
  ) {
    throw new Error("review_execution_checkpoint_findings_invalid");
  }
  if (
    !Array.isArray(payload.providerResults) ||
    payload.providerResults.length > maxProviderResultsPerBatch
  ) {
    throw new Error("review_execution_checkpoint_provider_results_invalid");
  }
  return {
    filePaths,
    findings: payload.findings.map(normalizeFinding),
    providerResults: payload.providerResults.map(normalizeProviderResult),
  };
}

export function decodeReviewExecutionBatchPayload(
  payload: unknown,
): ReviewExecutionBatchPayload | null {
  try {
    return normalizeReviewExecutionBatchPayload(payload);
  } catch {
    return null;
  }
}

export function hashReviewExecutionBatchPayload(
  payload: ReviewExecutionBatchPayload,
): string {
  return sha256(JSON.stringify(payload));
}

export function reviewExecutionBatchPayloadBytes(
  payload: ReviewExecutionBatchPayload,
): number {
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

export function assertReviewExecutionCheckpointCandidate(
  candidate: ReviewExecutionCheckpointCandidate,
): void {
  assertScope(candidate);
  if (candidate.schemaVersion !== reviewExecutionCheckpointSchemaVersion) {
    throw new Error("review_execution_checkpoint_schema_version_unsupported");
  }
  assertSha(candidate.baseSha, "base_sha");
  assertSha(candidate.headSha, "head_sha");
  assertSha256(candidate.compatibilityKey, "compatibility_key");
  assertSha256(candidate.planHash, "plan_hash");
  normalizeStringArray(candidate.plannedWorkKeys, {
    field: "planned_work_keys",
    maxItems: reviewExecutionCheckpointMaxPlannedWorkKeys,
    maxLength: 64,
    unique: true,
    itemValidator: assertSha256,
  });
  assertIdentifier(candidate.sourceRunId, "source_run_id");
  assertIdentifier(candidate.sourceRunAttempt, "source_run_attempt");
}

export function assertReviewExecutionCheckpointScope(
  scope: ReviewExecutionCheckpointScope,
): void {
  assertScope(scope);
}

export function assertExpectedReviewExecutionCheckpointVersion(
  expectedVersion: number,
): void {
  assertNonNegativeInteger(expectedVersion, "expected_version");
}

export function assertReviewExecutionBatchResult(
  result: ReviewExecutionBatchResult,
): void {
  assertBatchResult(result);
}

export function assertReviewExecutionCheckpointHeadAndPlan(input: {
  readonly headSha: string;
  readonly planHash: string;
}): void {
  assertSha(input.headSha, "head_sha");
  assertSha256(input.planHash, "plan_hash");
}

export function assertReviewExecutionCheckpointAggregate(
  aggregate: ReviewExecutionCheckpointAggregate,
): void {
  const { checkpoint, batchResults } = aggregate;
  assertReviewExecutionCheckpointRoot(checkpoint);
  const plannedWorkKeys = checkpoint.plannedWorkKeys;
  if (batchResults.length > plannedWorkKeys.length) {
    throw new Error("review_execution_checkpoint_batch_results_invalid");
  }
  const seen = new Set<string>();
  let acceptedBytes = 0;
  let findingCount = 0;
  for (const result of batchResults) {
    assertBatchResult(result);
    if (seen.has(result.workKey)) {
      throw new Error("review_execution_checkpoint_duplicate_work_key");
    }
    seen.add(result.workKey);
    const plannedIndex = plannedWorkKeys.indexOf(result.workKey);
    if (plannedIndex < 0 || result.batchIndex !== plannedIndex) {
      throw new Error("review_execution_checkpoint_unplanned_work");
    }
    acceptedBytes += result.byteCount;
    findingCount += result.payload.findings.length;
  }
  if (acceptedBytes !== checkpoint.acceptedBytes) {
    throw new Error("review_execution_checkpoint_accepted_bytes_invalid");
  }
  if (findingCount !== checkpoint.acceptedFindings) {
    throw new Error("review_execution_checkpoint_accepted_findings_invalid");
  }
  if (
    checkpoint.state === ReviewExecutionCheckpointState.Finalized &&
    seen.size !== plannedWorkKeys.length
  ) {
    throw new Error("review_execution_checkpoint_finalized_incomplete");
  }
}

export function assertReviewExecutionCheckpointRoot(
  checkpoint: ReviewExecutionCheckpointRoot,
): void {
  assertScope(checkpoint);
  assertPositiveInteger(checkpoint.version, "version");
  if (
    !Object.values(ReviewExecutionCheckpointState).includes(checkpoint.state)
  ) {
    throw new Error("review_execution_checkpoint_state_invalid");
  }
  if (checkpoint.schemaVersion !== reviewExecutionCheckpointSchemaVersion) {
    throw new Error("review_execution_checkpoint_schema_version_unsupported");
  }
  assertSha(checkpoint.baseSha, "base_sha");
  assertSha(checkpoint.headSha, "head_sha");
  assertSha256(checkpoint.compatibilityKey, "compatibility_key");
  assertSha256(checkpoint.planHash, "plan_hash");
  normalizeStringArray(checkpoint.plannedWorkKeys, {
    field: "planned_work_keys",
    maxItems: reviewExecutionCheckpointMaxPlannedWorkKeys,
    maxLength: 64,
    unique: true,
    itemValidator: assertSha256,
  });
  assertNonNegativeInteger(checkpoint.acceptedBytes, "accepted_bytes");
  if (checkpoint.acceptedBytes > reviewExecutionCheckpointMaxAggregateBytes) {
    throw new Error("review_execution_checkpoint_aggregate_payload_too_large");
  }
  assertNonNegativeInteger(checkpoint.acceptedFindings, "accepted_findings");
  if (checkpoint.acceptedFindings > reviewExecutionCheckpointMaxFindings) {
    throw new Error("review_execution_checkpoint_findings_limit_exceeded");
  }
  assertIdentifier(checkpoint.sourceRunId, "source_run_id");
  assertIdentifier(checkpoint.sourceRunAttempt, "source_run_attempt");
  assertDate(checkpoint.updatedAt, "updated_at");
  assertDate(checkpoint.expiresAt, "expires_at");
  if (checkpoint.finalizedAt !== undefined) {
    assertDate(checkpoint.finalizedAt, "finalized_at");
  }
  if (
    checkpoint.state === ReviewExecutionCheckpointState.Active &&
    checkpoint.finalizedAt !== undefined
  ) {
    throw new Error("review_execution_checkpoint_active_finalized_at_invalid");
  }
  if (
    checkpoint.state === ReviewExecutionCheckpointState.Finalized &&
    checkpoint.finalizedAt === undefined
  ) {
    throw new Error("review_execution_checkpoint_finalized_at_required");
  }
}

export function isReviewExecutionCheckpointStartIdempotent(
  current: ReviewExecutionCheckpointRoot,
  candidate: ReviewExecutionCheckpointRoot,
): boolean {
  return (
    current.state === ReviewExecutionCheckpointState.Active &&
    current.expiresAt > candidate.updatedAt &&
    current.baseSha === candidate.baseSha &&
    current.headSha === candidate.headSha &&
    current.compatibilityKey === candidate.compatibilityKey &&
    current.planHash === candidate.planHash &&
    arraysEqual(current.plannedWorkKeys, candidate.plannedWorkKeys)
  );
}

export function orderReviewExecutionBatchResults(
  plannedWorkKeys: readonly string[],
  results: readonly ReviewExecutionBatchResult[],
): readonly ReviewExecutionBatchResult[] {
  const order = new Map(
    plannedWorkKeys.map((workKey, index) => [workKey, index]),
  );
  return [...results].sort(
    (left, right) =>
      (order.get(left.workKey) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(right.workKey) ?? Number.MAX_SAFE_INTEGER),
  );
}

export function redactReviewExecutionCheckpointSecrets(value: string): string {
  return value
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      "-----BEGIN PRIVATE KEY-----***-----END PRIVATE KEY-----",
    )
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, "sk-***")
    .replace(/ghs_[A-Za-z0-9_]{16,}/g, "ghs_***")
    .replace(/gh[pousr]_[A-Za-z0-9_]{16,}/g, "gh*-***")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "github_pat_***")
    .replace(
      /(?:eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g,
      "jwt-***",
    )
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, "$1***")
    .replace(/(access_token["'\s:=]+)[^"',\s}]+/gi, "$1***")
    .replace(/(refresh_token["'\s:=]+)[^"',\s}]+/gi, "$1***")
    .replace(/(id_token["'\s:=]+)[^"',\s}]+/gi, "$1***")
    .replace(/(client_secret["'\s:=]+)[^"',\s}]+/gi, "$1***")
    .replace(
      /((?:api[_-]?key|apikey|api[_-]?secret|token|password)["'\s:=]+)[A-Za-z0-9_./+=-]{16,}/gi,
      "$1***",
    );
}

function normalizeFinding(value: unknown): ReviewExecutionFinding {
  if (!isUnknownRecord(value)) {
    throw new Error("review_execution_checkpoint_finding_invalid");
  }
  assertExactKeys(
    value,
    [
      "file",
      "startLine",
      "line",
      "endLine",
      "severity",
      "title",
      "message",
      "provider",
      "providers",
      "actualModel",
      "providerVoteKeys",
      "providerPoolSize",
      "confidence",
      "category",
      "hasConsensus",
    ],
    "finding_fields",
  );
  const file = normalizeText(value.file, 4_096, "finding_file");
  assertPositiveInteger(value.line, "finding_line");
  assertOptionalPositiveInteger(value.startLine, "finding_start_line");
  assertOptionalPositiveInteger(value.endLine, "finding_end_line");
  if (
    !Object.values(ReviewExecutionFindingSeverity).includes(
      value.severity as ReviewExecutionFindingSeverity,
    )
  ) {
    throw new Error("review_execution_checkpoint_finding_severity_invalid");
  }
  const title = normalizeText(value.title, 1_000, "finding_title");
  const message = normalizeText(
    value.message,
    20_000,
    "finding_message",
    false,
  );
  const provider = normalizeOptionalText(
    value.provider,
    500,
    "finding_provider",
  );
  const providers = normalizeOptionalStringArray(value.providers, {
    field: "finding_providers",
    maxItems: 50,
    maxLength: 500,
  });
  const actualModel = normalizeOptionalText(
    value.actualModel,
    500,
    "finding_actual_model",
  );
  const providerVoteKeys = normalizeOptionalStringArray(
    value.providerVoteKeys,
    {
      field: "finding_provider_vote_keys",
      maxItems: 100,
      maxLength: 500,
    },
  );
  assertOptionalPositiveInteger(
    value.providerPoolSize,
    "finding_provider_pool_size",
  );
  assertOptionalProbability(value.confidence, "finding_confidence");
  const category = normalizeOptionalText(
    value.category,
    500,
    "finding_category",
  );
  if (
    value.hasConsensus !== undefined &&
    typeof value.hasConsensus !== "boolean"
  ) {
    throw new Error("review_execution_checkpoint_finding_consensus_invalid");
  }
  return {
    file,
    ...(value.startLine !== undefined ? { startLine: value.startLine } : {}),
    line: value.line,
    ...(value.endLine !== undefined ? { endLine: value.endLine } : {}),
    severity: value.severity as ReviewExecutionFindingSeverity,
    title,
    message,
    ...(provider !== undefined ? { provider } : {}),
    ...(providers !== undefined ? { providers } : {}),
    ...(actualModel !== undefined ? { actualModel } : {}),
    ...(providerVoteKeys !== undefined ? { providerVoteKeys } : {}),
    ...(value.providerPoolSize !== undefined
      ? { providerPoolSize: value.providerPoolSize }
      : {}),
    ...(value.confidence !== undefined ? { confidence: value.confidence } : {}),
    ...(category !== undefined ? { category } : {}),
    ...(value.hasConsensus !== undefined
      ? { hasConsensus: value.hasConsensus }
      : {}),
  };
}

function normalizeProviderResult(
  value: unknown,
): ReviewExecutionProviderResult {
  if (!isUnknownRecord(value)) {
    throw new Error("review_execution_checkpoint_provider_result_invalid");
  }
  assertExactKeys(
    value,
    [
      "name",
      "status",
      "durationSeconds",
      "errorMessage",
      "actualModel",
      "aiLikelihood",
      "usage",
      "lifecycleAssignedTargetIds",
      "lifecycleRevalidations",
    ],
    "provider_result_fields",
  );
  const name = normalizeText(value.name, 500, "provider_result_name");
  if (
    !Object.values(ReviewExecutionProviderResultStatus).includes(
      value.status as ReviewExecutionProviderResultStatus,
    )
  ) {
    throw new Error(
      "review_execution_checkpoint_provider_result_status_invalid",
    );
  }
  assertBoundedDuration(value.durationSeconds);
  const errorMessage = normalizeOptionalText(
    value.errorMessage,
    2_000,
    "provider_result_error_message",
    false,
  );
  if (
    value.status === ReviewExecutionProviderResultStatus.Success &&
    errorMessage !== undefined
  ) {
    throw new Error(
      "review_execution_checkpoint_success_error_message_invalid",
    );
  }
  const actualModel = normalizeOptionalText(
    value.actualModel,
    500,
    "provider_result_actual_model",
  );
  assertOptionalProbability(
    value.aiLikelihood,
    "provider_result_ai_likelihood",
  );
  const usage = normalizeProviderUsage(value.usage);
  const lifecycleAssignedTargetIds = normalizeStringArray(
    value.lifecycleAssignedTargetIds ?? [],
    {
      field: "provider_result_lifecycle_assigned_target_ids",
      maxItems: maxLifecycleTargetsPerProvider,
      maxLength: 500,
      unique: true,
    },
  );
  const lifecycleRevalidations = value.lifecycleRevalidations ?? [];
  if (
    !Array.isArray(lifecycleRevalidations) ||
    lifecycleRevalidations.length > maxLifecycleRevalidationsPerProvider
  ) {
    throw new Error(
      "review_execution_checkpoint_provider_result_lifecycle_revalidations_invalid",
    );
  }
  return {
    name,
    status: value.status as ReviewExecutionProviderResultStatus,
    durationSeconds: value.durationSeconds as number,
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    ...(actualModel !== undefined ? { actualModel } : {}),
    ...(value.aiLikelihood !== undefined
      ? { aiLikelihood: value.aiLikelihood as number }
      : {}),
    ...(usage ? { usage } : {}),
    lifecycleAssignedTargetIds,
    lifecycleRevalidations: lifecycleRevalidations.map(
      normalizeLifecycleRevalidation,
    ),
  };
}

function normalizeProviderUsage(
  value: unknown,
): ReviewExecutionProviderResult["usage"] {
  if (value === undefined) return undefined;
  if (!isUnknownRecord(value)) {
    throw new Error("review_execution_checkpoint_provider_usage_invalid");
  }
  assertExactKeys(
    value,
    ["promptTokens", "completionTokens", "totalTokens"],
    "provider_usage_fields",
  );
  for (const field of [
    "promptTokens",
    "completionTokens",
    "totalTokens",
  ] as const) {
    if (
      !Number.isSafeInteger(value[field]) ||
      (value[field] as number) < 0 ||
      (value[field] as number) > maxTokenCount
    ) {
      throw new Error("review_execution_checkpoint_provider_usage_invalid");
    }
  }
  return {
    promptTokens: value.promptTokens as number,
    completionTokens: value.completionTokens as number,
    totalTokens: value.totalTokens as number,
  };
}

function normalizeLifecycleRevalidation(
  value: unknown,
): ReviewExecutionLifecycleRevalidation {
  if (!isUnknownRecord(value)) {
    throw new Error(
      "review_execution_checkpoint_lifecycle_revalidation_invalid",
    );
  }
  assertExactKeys(
    value,
    [
      "targetId",
      "fingerprint",
      "verdict",
      "confidence",
      "evidence",
      "rationale",
    ],
    "lifecycle_revalidation_fields",
  );
  const targetId = normalizeText(value.targetId, 500, "lifecycle_target_id");
  const fingerprint = normalizeOptionalText(
    value.fingerprint,
    500,
    "lifecycle_fingerprint",
  );
  if (
    !Object.values(ReviewExecutionLifecycleVerdict).includes(
      value.verdict as ReviewExecutionLifecycleVerdict,
    )
  ) {
    throw new Error("review_execution_checkpoint_lifecycle_verdict_invalid");
  }
  assertOptionalProbability(value.confidence, "lifecycle_confidence");
  const evidence = value.evidence ?? [];
  if (
    !Array.isArray(evidence) ||
    evidence.length > maxEvidencePerRevalidation
  ) {
    throw new Error("review_execution_checkpoint_lifecycle_evidence_invalid");
  }
  const rationale = normalizeOptionalText(
    value.rationale,
    4_000,
    "lifecycle_rationale",
    false,
  );
  return {
    targetId,
    ...(fingerprint !== undefined ? { fingerprint } : {}),
    verdict: value.verdict as ReviewExecutionLifecycleVerdict,
    ...(value.confidence !== undefined
      ? { confidence: value.confidence as number }
      : {}),
    evidence: evidence.map(normalizeLifecycleEvidence),
    ...(rationale !== undefined ? { rationale } : {}),
  };
}

function normalizeLifecycleEvidence(
  value: unknown,
): ReviewExecutionLifecycleEvidence {
  if (!isUnknownRecord(value)) {
    throw new Error("review_execution_checkpoint_lifecycle_evidence_invalid");
  }
  assertExactKeys(
    value,
    ["path", "startLine", "endLine", "reason"],
    "lifecycle_evidence_fields",
  );
  const path = normalizeText(value.path, 4_096, "lifecycle_evidence_path");
  assertOptionalPositiveInteger(
    value.startLine,
    "lifecycle_evidence_start_line",
  );
  assertOptionalPositiveInteger(value.endLine, "lifecycle_evidence_end_line");
  const reason = normalizeText(
    value.reason,
    4_000,
    "lifecycle_evidence_reason",
    false,
  );
  return {
    path,
    ...(value.startLine !== undefined ? { startLine: value.startLine } : {}),
    ...(value.endLine !== undefined ? { endLine: value.endLine } : {}),
    reason,
  };
}

function assertBatchResult(result: ReviewExecutionBatchResult): void {
  assertSha256(result.workKey, "work_key");
  assertSha256(result.batchId, "batch_id");
  assertNonNegativeInteger(result.batchIndex, "batch_index");
  const payload = normalizeReviewExecutionBatchPayload(result.payload);
  const byteCount = reviewExecutionBatchPayloadBytes(payload);
  if (
    byteCount !== result.byteCount ||
    byteCount > reviewExecutionCheckpointMaxBatchBytes
  ) {
    throw new Error("review_execution_checkpoint_batch_byte_count_invalid");
  }
  assertSha256(result.payloadHash, "payload_hash");
  if (hashReviewExecutionBatchPayload(payload) !== result.payloadHash) {
    throw new Error("review_execution_checkpoint_payload_hash_invalid");
  }
  assertIdentifier(result.sourceRunId, "source_run_id");
  assertIdentifier(result.sourceRunAttempt, "source_run_attempt");
  assertDate(result.completedAt, "completed_at");
}

function assertScope(scope: ReviewExecutionCheckpointScope): void {
  assertIdentifier(scope.workspaceId, "workspace_id");
  assertIdentifier(scope.repositoryId, "repository_id");
  assertPositiveInteger(scope.pullRequestNumber, "pull_request_number");
}

function normalizeStringArray(
  value: unknown,
  options: {
    readonly field: string;
    readonly maxItems: number;
    readonly maxLength: number;
    readonly unique?: boolean | undefined;
    readonly itemValidator?:
      | ((value: unknown, field: string) => asserts value is string)
      | undefined;
  },
): readonly string[] {
  if (!Array.isArray(value) || value.length > options.maxItems) {
    throw new Error(`review_execution_checkpoint_${options.field}_invalid`);
  }
  const normalized = value.map((item) => {
    options.itemValidator?.(item, options.field);
    return normalizeText(item, options.maxLength, options.field);
  });
  if (options.unique && new Set(normalized).size !== normalized.length) {
    throw new Error(`review_execution_checkpoint_${options.field}_duplicate`);
  }
  return normalized;
}

function normalizeOptionalStringArray(
  value: unknown,
  options: {
    readonly field: string;
    readonly maxItems: number;
    readonly maxLength: number;
  },
): readonly string[] | undefined {
  return value === undefined ? undefined : normalizeStringArray(value, options);
}

function normalizeText(
  value: unknown,
  maxLength: number,
  field: string,
  trim = true,
): string {
  if (typeof value !== "string") {
    throw new Error(`review_execution_checkpoint_${field}_invalid`);
  }
  const normalized = redactReviewExecutionCheckpointSecrets(
    trim ? value.trim() : value,
  );
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new Error(`review_execution_checkpoint_${field}_invalid`);
  }
  return normalized;
}

function normalizeOptionalText(
  value: unknown,
  maxLength: number,
  field: string,
  trim = true,
): string | undefined {
  return value === undefined
    ? undefined
    : normalizeText(value, maxLength, field, trim);
}

function assertIdentifier(
  value: unknown,
  field: string,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    throw new Error(`review_execution_checkpoint_${field}_invalid`);
  }
}

function assertSha(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) {
    throw new Error(`review_execution_checkpoint_${field}_invalid`);
  }
}

function assertSha256(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`review_execution_checkpoint_${field}_invalid`);
  }
}

function assertPositiveInteger(
  value: unknown,
  field: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`review_execution_checkpoint_${field}_invalid`);
  }
}

function assertNonNegativeInteger(
  value: unknown,
  field: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`review_execution_checkpoint_${field}_invalid`);
  }
}

function assertOptionalPositiveInteger(
  value: unknown,
  field: string,
): asserts value is number | undefined {
  if (value !== undefined) assertPositiveInteger(value, field);
}

function assertOptionalProbability(
  value: unknown,
  field: string,
): asserts value is number | undefined {
  if (
    value !== undefined &&
    (typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 1)
  ) {
    throw new Error(`review_execution_checkpoint_${field}_invalid`);
  }
}

function assertBoundedDuration(value: unknown): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 24 * 60 * 60
  ) {
    throw new Error(
      "review_execution_checkpoint_provider_result_duration_invalid",
    );
  }
}

function assertDate(value: unknown, field: string): asserts value is Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`review_execution_checkpoint_${field}_invalid`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  field: string,
): void {
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(`review_execution_checkpoint_${field}_invalid`);
  }
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function arraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
