import type {
  InvestigationOperatorStatusRepositoryPort,
  InvestigationPromotionReportRepositoryPort,
  InvestigationTelemetryRepositoryPort,
} from "../../application/ports/operations-ports";
import type { InvestigationTelemetrySample } from "../../domain/investigation-telemetry";
import type { InvestigationOperatorStatus } from "../../domain/operator-status";

export class InMemoryInvestigationOperations
  implements
    InvestigationTelemetryRepositoryPort,
    InvestigationOperatorStatusRepositoryPort,
    InvestigationPromotionReportRepositoryPort
{
  private readonly samples = new Map<string, InvestigationTelemetrySample>();
  private readonly statuses = new Map<string, InvestigationOperatorStatus>();
  readonly reports = new Map<string, string>();

  async append(sample: InvestigationTelemetrySample): Promise<void> {
    const existing = this.samples.get(sample.sampleId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(sample)) {
      throw new Error("telemetry_sample_id_conflict");
    }
    this.samples.set(sample.sampleId, Object.freeze({ ...sample }));
  }

  async listByProducerRelease(
    producerReleaseId: string,
  ): Promise<readonly InvestigationTelemetrySample[]> {
    return [...this.samples.values()]
      .filter((item) => item.producerReleaseId === producerReleaseId)
      .sort((a, b) => a.sampleId.localeCompare(b.sampleId, "en"));
  }

  async find(
    investigationId: string,
  ): Promise<InvestigationOperatorStatus | null> {
    return this.statuses.get(investigationId) ?? null;
  }

  setStatus(status: InvestigationOperatorStatus): void {
    this.statuses.set(status.investigationId, Object.freeze({ ...status }));
  }

  async save(input: {
    readonly reportCanonicalJson: string;
    readonly reportHash: string;
  }): Promise<void> {
    const existing = this.reports.get(input.reportHash);
    if (existing && existing !== input.reportCanonicalJson) {
      throw new Error("promotion_report_hash_conflict");
    }
    this.reports.set(input.reportHash, input.reportCanonicalJson);
  }
}
