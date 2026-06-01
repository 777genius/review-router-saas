import { createHash } from "node:crypto";
import {
  createReviewFindingsArtifact,
  type ReviewFindingsArtifact,
} from "./review-findings-artifact";
import type {
  ReviewFinding,
  ReviewFindingSeverity,
} from "./review-publication";

export type ReviewModelOutputFinding = {
  readonly severity: ReviewFindingSeverity;
  readonly title: string;
  readonly body: string;
  readonly path?: string | null | undefined;
  readonly startLine?: number | null | undefined;
  readonly endLine?: number | null | undefined;
};

export type ReviewModelOutput = {
  readonly protocolVersion: 1;
  readonly summaryMarkdown: string;
  readonly findings: readonly ReviewModelOutputFinding[];
};

export function createReviewFindingsArtifactFromModelOutput(input: {
  readonly generatedAt: Date;
  readonly modelOutput: unknown;
}): ReviewFindingsArtifact {
  const modelOutput = normalizeReviewModelOutput(input.modelOutput);
  return createReviewFindingsArtifact({
    generatedAt: input.generatedAt,
    summaryMarkdown: modelOutput.summaryMarkdown,
    findings: modelOutput.findings.map(toReviewFinding),
  });
}

function normalizeReviewModelOutput(value: unknown): ReviewModelOutput {
  if (!isRecord(value)) {
    throw new Error("review_model_output_invalid");
  }
  if (value.protocolVersion !== 1) {
    throw new Error("review_model_output_protocol_version_invalid");
  }
  if (
    typeof value.summaryMarkdown !== "string" ||
    value.summaryMarkdown.trim().length === 0 ||
    value.summaryMarkdown.length > 60_000
  ) {
    throw new Error("review_model_output_summary_invalid");
  }
  if (!Array.isArray(value.findings) || value.findings.length > 50) {
    throw new Error("review_model_output_findings_invalid");
  }
  return {
    protocolVersion: 1,
    summaryMarkdown: value.summaryMarkdown.trim(),
    findings: value.findings.map(normalizeModelFinding),
  };
}

function normalizeModelFinding(value: unknown): ReviewModelOutputFinding {
  if (!isRecord(value)) {
    throw new Error("review_model_output_finding_invalid");
  }
  if (!isReviewFindingSeverity(value.severity)) {
    throw new Error("review_model_output_severity_invalid");
  }
  const title = normalizeText(value.title, {
    errorCode: "review_model_output_title_invalid",
    maxLength: 200,
  });
  const body = normalizeText(value.body, {
    errorCode: "review_model_output_body_invalid",
    maxLength: 8_000,
  });
  const path =
    value.path === undefined || value.path === null
      ? undefined
      : normalizeText(value.path, {
          errorCode: "review_model_output_path_invalid",
          maxLength: 500,
        });
  return {
    severity: value.severity,
    title,
    body,
    ...(path ? { path } : {}),
    ...optionalLine("startLine", value.startLine),
    ...optionalLine("endLine", value.endLine),
  };
}

function toReviewFinding(finding: ReviewModelOutputFinding): ReviewFinding {
  const line = finding.startLine ?? finding.endLine;
  return {
    fingerprint: buildFindingFingerprint(finding),
    severity: finding.severity,
    title: finding.title,
    body: finding.body,
    ...(finding.path && line
      ? { location: { filePath: finding.path, newLine: line } }
      : {}),
  };
}

function buildFindingFingerprint(finding: ReviewModelOutputFinding): string {
  return `rr-${sha256(
    JSON.stringify({
      severity: finding.severity,
      title: finding.title,
      body: finding.body,
      path: finding.path ?? null,
      startLine: finding.startLine ?? null,
      endLine: finding.endLine ?? null,
    }),
  ).slice(0, 40)}`;
}

function optionalLine(
  key: "startLine" | "endLine",
  value: unknown,
): Partial<Pick<ReviewModelOutputFinding, "startLine" | "endLine">> {
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`review_model_output_${key}_invalid`);
  }
  return key === "startLine" ? { startLine: value } : { endLine: value };
}

function normalizeText(
  value: unknown,
  options: { readonly errorCode: string; readonly maxLength: number },
): string {
  if (typeof value !== "string") {
    throw new Error(options.errorCode);
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > options.maxLength) {
    throw new Error(options.errorCode);
  }
  return trimmed;
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
