import {
  evaluatePromotion,
  type InvestigationPromotionReportBody,
  type InvestigationPromotionThresholds,
} from "../../domain/promotion-report";
import type {
  InvestigationOperationsDigestPort,
  InvestigationPromotionReportRepositoryPort,
  InvestigationTelemetryRepositoryPort,
} from "../ports/operations-ports";

export type ImmutableInvestigationPromotionReport = Readonly<{
  body: InvestigationPromotionReportBody;
  canonicalJson: string;
  reportHash: string;
}>;

export class GenerateInvestigationPromotionReport {
  constructor(
    private readonly telemetry: InvestigationTelemetryRepositoryPort,
    private readonly digest: InvestigationOperationsDigestPort,
    private readonly reports: InvestigationPromotionReportRepositoryPort,
  ) {}

  async execute(input: {
    readonly generatedAt: string;
    readonly producerReleaseId: string;
    readonly thresholds: InvestigationPromotionThresholds;
  }): Promise<ImmutableInvestigationPromotionReport> {
    const samples = await this.telemetry.listByProducerRelease(
      input.producerReleaseId,
    );
    const sampleSetCanonicalJson = canonicalJson(
      [...samples].sort((a, b) => a.sampleId.localeCompare(b.sampleId, "en")),
    );
    const sampleSetHash = await this.digest.digestUtf8(sampleSetCanonicalJson);
    const body = evaluatePromotion({ ...input, sampleSetHash, samples });
    const canonical = canonicalJson(body);
    const reportHash = await this.digest.digestUtf8(canonical);
    await this.reports.save({ reportCanonicalJson: canonical, reportHash });
    return Object.freeze({ body, canonicalJson: canonical, reportHash });
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical_number_invalid");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") throw new Error("canonical_value_invalid");
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
