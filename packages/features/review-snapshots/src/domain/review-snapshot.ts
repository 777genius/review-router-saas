import { createHash } from "node:crypto";

export const reviewSnapshotSchemaVersion = 1;
export const reviewSnapshotTtlMs = 7 * 24 * 60 * 60 * 1000;
export const reviewSnapshotMaxPayloadBytes = 512 * 1024;
export const reviewSnapshotMaxFindings = 500;

export enum ReviewSnapshotSeverity {
  Critical = "critical",
  Major = "major",
  Minor = "minor",
  Info = "info",
}

export enum ReviewSnapshotRestoreStatus {
  Found = "found",
  Missing = "missing",
  Expired = "expired",
  BaseChanged = "base_changed",
}

export enum ReviewSnapshotCommitStatus {
  Committed = "committed",
  Idempotent = "idempotent",
  Conflict = "conflict",
}

export type ReviewSnapshotFinding = {
  readonly file: string;
  readonly startLine?: number | undefined;
  readonly line: number;
  readonly endLine?: number | undefined;
  readonly severity: ReviewSnapshotSeverity;
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

export type ReviewSnapshotPayload = {
  readonly reviewSummary: string;
  readonly findings: readonly ReviewSnapshotFinding[];
};

export type ReviewSnapshotRecord = {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly pullRequestNumber: number;
  readonly version: number;
  readonly schemaVersion: number;
  readonly reviewedHeadSha: string;
  readonly baseSha: string;
  readonly compatibilityKey: string;
  readonly payload: ReviewSnapshotPayload;
  readonly payloadHash: string;
  readonly sourceRunId: string;
  readonly sourceRunAttempt: string;
  readonly reviewedAt: Date;
  readonly expiresAt: Date;
};

export type ReviewSnapshotCandidate = Omit<
  ReviewSnapshotRecord,
  "version" | "payloadHash" | "reviewedAt" | "expiresAt"
>;

export function decideReviewSnapshotRestore(
  record: ReviewSnapshotRecord | null,
  input: { readonly baseSha: string; readonly now: Date },
):
  | {
      readonly status: ReviewSnapshotRestoreStatus.Found;
      readonly expectedVersion: number;
      readonly snapshot: ReviewSnapshotRecord;
    }
  | {
      readonly status:
        | ReviewSnapshotRestoreStatus.Missing
        | ReviewSnapshotRestoreStatus.Expired
        | ReviewSnapshotRestoreStatus.BaseChanged;
      readonly expectedVersion: number;
    } {
  if (!record) {
    return {
      status: ReviewSnapshotRestoreStatus.Missing,
      expectedVersion: 0,
    };
  }
  if (record.expiresAt <= input.now) {
    return {
      status: ReviewSnapshotRestoreStatus.Expired,
      expectedVersion: record.version,
    };
  }
  if (record.baseSha !== input.baseSha) {
    return {
      status: ReviewSnapshotRestoreStatus.BaseChanged,
      expectedVersion: record.version,
    };
  }
  return {
    status: ReviewSnapshotRestoreStatus.Found,
    expectedVersion: record.version,
    snapshot: record,
  };
}

export function prepareReviewSnapshotRecord(
  candidate: ReviewSnapshotCandidate,
  input: { readonly now: Date; readonly version: number },
): ReviewSnapshotRecord {
  assertReviewSnapshotCandidate(candidate);
  const payload = sanitizeReviewSnapshotPayload(candidate.payload);
  return {
    ...candidate,
    payload,
    version: input.version,
    payloadHash: hashReviewSnapshotPayload(payload),
    reviewedAt: input.now,
    expiresAt: new Date(input.now.getTime() + reviewSnapshotTtlMs),
  };
}

export function hashReviewSnapshotPayload(
  payload: ReviewSnapshotPayload,
): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function assertReviewSnapshotCandidate(
  candidate: ReviewSnapshotCandidate,
): void {
  assertIdentifier(candidate.workspaceId, "workspace_id");
  assertIdentifier(candidate.repositoryId, "repository_id");
  assertPositiveInteger(candidate.pullRequestNumber, "pull_request_number");
  if (candidate.schemaVersion !== reviewSnapshotSchemaVersion) {
    throw new Error("review_snapshot_schema_version_unsupported");
  }
  assertSha(candidate.reviewedHeadSha, "reviewed_head_sha");
  assertSha(candidate.baseSha, "base_sha");
  if (!/^[a-f0-9]{64}$/i.test(candidate.compatibilityKey)) {
    throw new Error("review_snapshot_compatibility_key_invalid");
  }
  assertIdentifier(candidate.sourceRunId, "source_run_id");
  assertIdentifier(candidate.sourceRunAttempt, "source_run_attempt");
  assertReviewSnapshotPayload(candidate.payload);
}

export function assertReviewSnapshotPayload(
  payload: ReviewSnapshotPayload,
): void {
  if (!payload || typeof payload !== "object") {
    throw new Error("review_snapshot_payload_invalid");
  }
  assertBoundedString(payload.reviewSummary, 100_000, "review_summary");
  if (
    !Array.isArray(payload.findings) ||
    payload.findings.length > reviewSnapshotMaxFindings
  ) {
    throw new Error("review_snapshot_findings_invalid");
  }
  for (const finding of payload.findings) {
    assertReviewSnapshotFinding(finding);
  }
  if (
    Buffer.byteLength(JSON.stringify(payload), "utf8") >
    reviewSnapshotMaxPayloadBytes
  ) {
    throw new Error("review_snapshot_payload_too_large");
  }
}

function assertReviewSnapshotFinding(finding: ReviewSnapshotFinding): void {
  if (!finding || typeof finding !== "object") {
    throw new Error("review_snapshot_finding_invalid");
  }
  assertBoundedString(finding.file, 4_096, "finding_file");
  assertPositiveInteger(finding.line, "finding_line");
  assertOptionalPositiveInteger(finding.startLine, "finding_start_line");
  assertOptionalPositiveInteger(finding.endLine, "finding_end_line");
  if (!Object.values(ReviewSnapshotSeverity).includes(finding.severity)) {
    throw new Error("review_snapshot_finding_severity_invalid");
  }
  assertBoundedString(finding.title, 1_000, "finding_title");
  assertBoundedString(finding.message, 20_000, "finding_message");
  assertOptionalBoundedString(finding.provider, 500, "finding_provider");
  assertOptionalBoundedString(finding.actualModel, 500, "finding_actual_model");
  assertOptionalBoundedString(finding.category, 500, "finding_category");
  assertOptionalStringArray(finding.providers, "finding_providers");
  assertOptionalStringArray(
    finding.providerVoteKeys,
    "finding_provider_vote_keys",
  );
  assertOptionalPositiveInteger(
    finding.providerPoolSize,
    "finding_provider_pool_size",
  );
  if (
    finding.confidence !== undefined &&
    (!Number.isFinite(finding.confidence) ||
      finding.confidence < 0 ||
      finding.confidence > 1)
  ) {
    throw new Error("review_snapshot_finding_confidence_invalid");
  }
  if (
    finding.hasConsensus !== undefined &&
    typeof finding.hasConsensus !== "boolean"
  ) {
    throw new Error("review_snapshot_finding_consensus_invalid");
  }
}

function sanitizeReviewSnapshotPayload(
  payload: ReviewSnapshotPayload,
): ReviewSnapshotPayload {
  return {
    reviewSummary: redactReviewSnapshotSecrets(payload.reviewSummary),
    findings: payload.findings.map((finding) => ({
      ...finding,
      title: redactReviewSnapshotSecrets(finding.title),
      message: redactReviewSnapshotSecrets(finding.message),
      ...(finding.provider
        ? { provider: redactReviewSnapshotSecrets(finding.provider) }
        : {}),
      ...(finding.providers
        ? {
            providers: finding.providers.map(redactReviewSnapshotSecrets),
          }
        : {}),
      ...(finding.actualModel
        ? { actualModel: redactReviewSnapshotSecrets(finding.actualModel) }
        : {}),
      ...(finding.providerVoteKeys
        ? {
            providerVoteKeys: finding.providerVoteKeys.map(
              redactReviewSnapshotSecrets,
            ),
          }
        : {}),
      ...(finding.category
        ? { category: redactReviewSnapshotSecrets(finding.category) }
        : {}),
    })),
  };
}

function redactReviewSnapshotSecrets(value: string): string {
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

function assertIdentifier(value: string, field: string): void {
  assertBoundedString(value, 200, field);
}

function assertSha(value: string, field: string): void {
  if (!/^[a-f0-9]{40}$/i.test(value)) {
    throw new Error(`review_snapshot_${field}_invalid`);
  }
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`review_snapshot_${field}_invalid`);
  }
}

function assertOptionalPositiveInteger(
  value: number | undefined,
  field: string,
): void {
  if (value !== undefined) assertPositiveInteger(value, field);
}

function assertBoundedString(
  value: string,
  maxLength: number,
  field: string,
): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength
  ) {
    throw new Error(`review_snapshot_${field}_invalid`);
  }
}

function assertOptionalBoundedString(
  value: string | undefined,
  maxLength: number,
  field: string,
): void {
  if (value !== undefined) assertBoundedString(value, maxLength, field);
}

function assertOptionalStringArray(
  value: readonly string[] | undefined,
  field: string,
): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 50) {
    throw new Error(`review_snapshot_${field}_invalid`);
  }
  for (const entry of value) assertBoundedString(entry, 500, field);
}
