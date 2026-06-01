import {
  createReviewPublicationPlan,
  type ReviewFinding,
  type ReviewFindingLocation,
  type ReviewFindingSeverity,
  type ReviewPublicationMode,
  type ReviewPublicationPlan,
  type ReviewPublicationTarget,
} from "./review-publication";

export const reviewFindingsArtifactFileName = "reviewrouter-findings.json";

export type ReviewFindingsArtifact = {
  readonly protocolVersion: 1;
  readonly generatedAt: string;
  readonly summaryMarkdown?: string | undefined;
  readonly findings: readonly ReviewFinding[];
};

export function createReviewFindingsArtifact(input: {
  readonly generatedAt: Date;
  readonly findings: readonly ReviewFinding[];
  readonly summaryMarkdown?: string | undefined;
}): ReviewFindingsArtifact {
  return normalizeReviewFindingsArtifact({
    protocolVersion: 1,
    generatedAt: input.generatedAt.toISOString(),
    ...(input.summaryMarkdown !== undefined
      ? { summaryMarkdown: input.summaryMarkdown }
      : {}),
    findings: input.findings,
  });
}

export function parseReviewFindingsArtifactJson(
  json: string,
): ReviewFindingsArtifact {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new Error("review_findings_artifact_json_invalid", {
      cause: error,
    });
  }
  return normalizeReviewFindingsArtifact(value);
}

export function stringifyReviewFindingsArtifact(
  artifact: ReviewFindingsArtifact,
): string {
  return `${JSON.stringify(normalizeReviewFindingsArtifact(artifact), null, 2)}\n`;
}

export function createReviewPublicationPlanFromArtifact(input: {
  readonly target: ReviewPublicationTarget;
  readonly artifact: ReviewFindingsArtifact;
  readonly marker: string;
  readonly mode?: ReviewPublicationMode | undefined;
  readonly maxInlineComments?: number | undefined;
}): ReviewPublicationPlan {
  return createReviewPublicationPlan({
    target: input.target,
    findings: input.artifact.findings,
    marker: input.marker,
    mode: input.mode,
    maxInlineComments: input.maxInlineComments,
  });
}

function normalizeReviewFindingsArtifact(
  value: unknown,
): ReviewFindingsArtifact {
  if (!isRecord(value)) {
    throw new Error("review_findings_artifact_invalid");
  }
  if (value.protocolVersion !== 1) {
    throw new Error("review_findings_artifact_protocol_version_invalid");
  }
  if (typeof value.generatedAt !== "string" || !isIsoDate(value.generatedAt)) {
    throw new Error("review_findings_artifact_generated_at_invalid");
  }
  if (
    value.summaryMarkdown !== undefined &&
    typeof value.summaryMarkdown !== "string"
  ) {
    throw new Error("review_findings_artifact_summary_invalid");
  }
  if (!Array.isArray(value.findings)) {
    throw new Error("review_findings_artifact_findings_invalid");
  }
  return {
    protocolVersion: 1,
    generatedAt: value.generatedAt,
    ...(value.summaryMarkdown !== undefined
      ? { summaryMarkdown: value.summaryMarkdown }
      : {}),
    findings: value.findings.map(normalizeArtifactFinding),
  };
}

function normalizeArtifactFinding(value: unknown): ReviewFinding {
  if (!isRecord(value)) {
    throw new Error("review_findings_artifact_finding_invalid");
  }
  if (typeof value.fingerprint !== "string") {
    throw new Error("review_findings_artifact_fingerprint_invalid");
  }
  if (!isReviewFindingSeverity(value.severity)) {
    throw new Error("review_findings_artifact_severity_invalid");
  }
  if (typeof value.title !== "string") {
    throw new Error("review_findings_artifact_title_invalid");
  }
  if (typeof value.body !== "string") {
    throw new Error("review_findings_artifact_body_invalid");
  }
  return {
    fingerprint: value.fingerprint,
    severity: value.severity,
    title: value.title,
    body: value.body,
    ...(value.location !== undefined
      ? { location: normalizeArtifactLocation(value.location) }
      : {}),
  };
}

function normalizeArtifactLocation(value: unknown): ReviewFindingLocation {
  if (!isRecord(value)) {
    throw new Error("review_findings_artifact_location_invalid");
  }
  if (typeof value.filePath !== "string") {
    throw new Error("review_findings_artifact_file_path_invalid");
  }
  return {
    filePath: value.filePath,
    ...(value.oldLine !== undefined
      ? { oldLine: normalizeOptionalLine(value.oldLine, "old_line") }
      : {}),
    ...(value.newLine !== undefined
      ? { newLine: normalizeOptionalLine(value.newLine, "new_line") }
      : {}),
  };
}

function normalizeOptionalLine(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`review_findings_artifact_${label}_invalid`);
  }
  return value;
}

function isReviewFindingSeverity(
  value: unknown,
): value is ReviewFindingSeverity {
  return (
    value === "critical" ||
    value === "major" ||
    value === "minor" ||
    value === "info"
  );
}

function isIsoDate(value: string): boolean {
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
