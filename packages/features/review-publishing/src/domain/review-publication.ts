import { isScmProvider, type ScmProvider } from "@reviewrouter/shared";

export type ReviewFindingSeverity = "critical" | "major" | "minor" | "info";

const defaultMaxInlineComments = 20;
const hardMaxInlineComments = 50;
const maxMarkerLength = 200;
const maxFingerprintLength = 160;
const maxTitleLength = 200;
const maxBodyLength = 8_000;

export type ReviewFindingLocation = {
  readonly filePath: string;
  readonly oldLine?: number | undefined;
  readonly newLine?: number | undefined;
};

export type ReviewFinding = {
  readonly fingerprint: string;
  readonly severity: ReviewFindingSeverity;
  readonly title: string;
  readonly body: string;
  readonly location?: ReviewFindingLocation | undefined;
};

export type ReviewPublicationTarget = {
  readonly provider: ScmProvider;
  readonly repositoryExternalId: string;
  readonly repositoryFullName: string;
  readonly changeRequestExternalId: string;
  readonly headSha: string;
  readonly baseSha?: string | undefined;
  readonly startSha?: string | undefined;
};

export type ReviewPublicationMode = "inline-and-summary" | "summary-only";

export type ReviewInlineSkipReason =
  | "summary_only"
  | "inline_limit_reached"
  | "missing_location"
  | "low_severity"
  | "provider_position_unavailable";

export type ReviewPublicationPlan = {
  readonly target: ReviewPublicationTarget;
  readonly mode: ReviewPublicationMode;
  readonly marker: string;
  readonly maxInlineComments: number;
  readonly findings: readonly ReviewFinding[];
};

export function createReviewPublicationPlan(input: {
  readonly target: ReviewPublicationTarget;
  readonly findings: readonly ReviewFinding[];
  readonly mode?: ReviewPublicationMode | undefined;
  readonly marker: string;
  readonly maxInlineComments?: number | undefined;
}): ReviewPublicationPlan {
  const marker = input.marker.trim();
  if (!marker) {
    throw new Error("review_publication_marker_required");
  }
  if (marker.length > maxMarkerLength) {
    throw new Error("review_publication_marker_too_large");
  }
  if (!isSafeHtmlCommentToken(marker, { allowWhitespace: true })) {
    throw new Error("review_publication_marker_invalid");
  }
  return {
    target: normalizeTarget(input.target),
    mode: input.mode ?? "inline-and-summary",
    marker,
    maxInlineComments: normalizeMaxInlineComments(input.maxInlineComments),
    findings: input.findings.map(normalizeFinding),
  };
}

export function shouldPublishFindingInline(input: {
  readonly finding: ReviewFinding;
  readonly plan: ReviewPublicationPlan;
  readonly inlineIndex: number;
}): boolean {
  return reviewFindingInlineSkipReason(input) === null;
}

export function reviewFindingInlineSkipReason(input: {
  readonly finding: ReviewFinding;
  readonly plan: ReviewPublicationPlan;
  readonly inlineIndex: number;
}): ReviewInlineSkipReason | null {
  if (input.plan.mode === "summary-only") {
    return "summary_only";
  }
  if (input.inlineIndex < 0) {
    return "inline_limit_reached";
  }
  if (input.inlineIndex >= input.plan.maxInlineComments) {
    return "inline_limit_reached";
  }
  if (!hasProviderRequiredInlineRefs(input.plan.target)) {
    return "provider_position_unavailable";
  }
  if (!input.finding.location) {
    return "missing_location";
  }
  if (!hasSingleLineLocation(input.finding.location)) {
    return "missing_location";
  }
  if (input.finding.severity === "info") {
    return "low_severity";
  }
  return null;
}

function normalizeTarget(
  target: ReviewPublicationTarget,
): ReviewPublicationTarget {
  if (!isScmProvider(target.provider)) {
    throw new Error("review_publication_provider_invalid");
  }
  if (!target.repositoryExternalId.trim()) {
    throw new Error("review_publication_repository_external_id_required");
  }
  if (!target.repositoryFullName.trim()) {
    throw new Error("review_publication_repository_full_name_required");
  }
  if (!target.changeRequestExternalId.trim()) {
    throw new Error("review_publication_change_request_external_id_required");
  }
  if (!/^[1-9][0-9]*$/.test(target.changeRequestExternalId.trim())) {
    throw new Error("review_publication_change_request_external_id_invalid");
  }
  if (!/^[a-fA-F0-9]{40}$/.test(target.headSha)) {
    throw new Error("review_publication_head_sha_invalid");
  }
  if (
    target.baseSha !== undefined &&
    !/^[a-fA-F0-9]{40}$/.test(target.baseSha)
  ) {
    throw new Error("review_publication_base_sha_invalid");
  }
  if (
    target.startSha !== undefined &&
    !/^[a-fA-F0-9]{40}$/.test(target.startSha)
  ) {
    throw new Error("review_publication_start_sha_invalid");
  }
  return {
    provider: target.provider,
    repositoryExternalId: target.repositoryExternalId.trim(),
    repositoryFullName: target.repositoryFullName.trim(),
    changeRequestExternalId: target.changeRequestExternalId.trim(),
    headSha: target.headSha.toLowerCase(),
    ...(target.baseSha ? { baseSha: target.baseSha.toLowerCase() } : {}),
    ...(target.startSha ? { startSha: target.startSha.toLowerCase() } : {}),
  };
}

function hasProviderRequiredInlineRefs(
  target: ReviewPublicationTarget,
): boolean {
  switch (target.provider) {
    case "github":
      return Boolean(target.headSha);
    case "gitlab":
      return Boolean(target.headSha && target.baseSha && target.startSha);
  }
}

function normalizeMaxInlineComments(value: number | undefined): number {
  if (value === undefined) {
    return defaultMaxInlineComments;
  }
  if (!Number.isFinite(value)) {
    throw new Error("review_publication_max_inline_comments_invalid");
  }
  const normalized = Math.floor(value);
  if (normalized < 0) {
    throw new Error("review_publication_max_inline_comments_invalid");
  }
  return Math.min(normalized, hardMaxInlineComments);
}

function normalizeFinding(finding: ReviewFinding): ReviewFinding {
  const fingerprint = finding.fingerprint.trim();
  if (!fingerprint) {
    throw new Error("review_finding_fingerprint_required");
  }
  if (fingerprint.length > maxFingerprintLength) {
    throw new Error("review_finding_fingerprint_too_large");
  }
  if (!isSafeHtmlCommentToken(fingerprint, { allowWhitespace: false })) {
    throw new Error("review_finding_fingerprint_invalid");
  }
  const title = finding.title.trim();
  if (!title) {
    throw new Error("review_finding_title_required");
  }
  if (title.length > maxTitleLength) {
    throw new Error("review_finding_title_too_large");
  }
  const body = finding.body.trim();
  if (!body) {
    throw new Error("review_finding_body_required");
  }
  if (body.length > maxBodyLength) {
    throw new Error("review_finding_body_too_large");
  }
  return {
    ...finding,
    fingerprint,
    title,
    body,
    ...(finding.location
      ? { location: normalizeLocation(finding.location) }
      : {}),
  };
}

function normalizeLocation(
  location: ReviewFindingLocation,
): ReviewFindingLocation {
  const filePath = location.filePath.trim();
  if (!isSafeRepositoryRelativePath(filePath)) {
    throw new Error("review_finding_location_file_path_required");
  }
  assertOptionalPositiveInteger(location.oldLine, "old_line");
  assertOptionalPositiveInteger(location.newLine, "new_line");
  return {
    filePath,
    ...(location.oldLine !== undefined ? { oldLine: location.oldLine } : {}),
    ...(location.newLine !== undefined ? { newLine: location.newLine } : {}),
  };
}

function hasSingleLineLocation(location: ReviewFindingLocation): boolean {
  return (
    isPositiveInteger(location.oldLine) || isPositiveInteger(location.newLine)
  );
}

function assertOptionalPositiveInteger(
  value: number | undefined,
  label: string,
): void {
  if (value !== undefined && !isPositiveInteger(value)) {
    throw new Error(`review_finding_location_${label}_invalid`);
  }
}

function isPositiveInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value > 0;
}

function isSafeRepositoryRelativePath(filePath: string): boolean {
  if (!filePath || filePath.includes("\0")) {
    return false;
  }
  if (
    filePath.startsWith("/") ||
    filePath.startsWith("\\") ||
    /^[a-zA-Z]:[\\/]/.test(filePath)
  ) {
    return false;
  }
  return filePath
    .split(/[\\/]+/)
    .every(
      (segment) => segment.length > 0 && segment !== "." && segment !== "..",
    );
}

function isSafeHtmlCommentToken(
  value: string,
  options: { readonly allowWhitespace: boolean },
): boolean {
  if (value.includes("<") || value.includes(">") || value.includes("--")) {
    return false;
  }
  if (/[\r\n\t]/.test(value)) {
    return false;
  }
  return options.allowWhitespace ? !/\s{2,}/.test(value) : !/\s/.test(value);
}
