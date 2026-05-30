import type {
  ReviewFinding,
  ReviewPublicationPlan,
} from "./review-publication";

const maxPublicationBodyBytes = 60_000;

export function reviewSummaryMarker(marker: string): string {
  return `<!-- ${marker} summary -->`;
}

export function reviewFindingMarker(input: {
  readonly marker: string;
  readonly fingerprint: string;
}): string {
  return `<!-- ${input.marker} finding=${input.fingerprint} -->`;
}

export function renderReviewSummaryMarkdown(input: {
  readonly plan: ReviewPublicationPlan;
}): string {
  const counts = countFindingsBySeverity(input.plan.findings);
  const lines = [
    reviewSummaryMarker(input.plan.marker),
    "# ReviewRouter",
    "",
    `Findings: ${input.plan.findings.length}`,
    `Critical: ${counts.critical} | Major: ${counts.major} | Minor: ${counts.minor} | Info: ${counts.info}`,
  ];

  if (input.plan.findings.length > 0) {
    lines.push("", "## Findings");
    for (const finding of input.plan.findings) {
      lines.push(
        `- [${finding.severity}] ${escapeMarkdownInline(finding.title)}${formatFindingLocation(finding)}`,
      );
    }
  }

  return limitUtf8(lines.join("\n"), maxPublicationBodyBytes);
}

export function renderReviewFindingMarkdown(input: {
  readonly plan: ReviewPublicationPlan;
  readonly finding: ReviewFinding;
}): string {
  return limitUtf8(
    [
      reviewFindingMarker({
        marker: input.plan.marker,
        fingerprint: input.finding.fingerprint,
      }),
      `**[${input.finding.severity}] ${input.finding.title}**`,
      "",
      input.finding.body,
    ].join("\n"),
    maxPublicationBodyBytes,
  );
}

function countFindingsBySeverity(findings: readonly ReviewFinding[]) {
  return findings.reduce(
    (counts, finding) => ({
      ...counts,
      [finding.severity]: counts[finding.severity] + 1,
    }),
    { critical: 0, major: 0, minor: 0, info: 0 },
  );
}

function formatFindingLocation(finding: ReviewFinding): string {
  if (!finding.location) {
    return "";
  }
  const line = finding.location.newLine ?? finding.location.oldLine;
  return line
    ? ` (${escapeMarkdownInline(finding.location.filePath)}:${line})`
    : ` (${escapeMarkdownInline(finding.location.filePath)})`;
}

function escapeMarkdownInline(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("`", "\\`");
}

function limitUtf8(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) {
    return value;
  }
  return `${buffer.subarray(0, maxBytes - 20).toString("utf8")}\n\n[truncated]`;
}
