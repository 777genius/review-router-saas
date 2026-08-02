import type { InvestigationOperatorStatus } from "../../domain/operator-status";
import type { InvestigationTelemetrySample } from "../../domain/investigation-telemetry";

export interface InvestigationTelemetryRepositoryPort {
  append(sample: InvestigationTelemetrySample): Promise<void>;
  listByProducerRelease(
    producerReleaseId: string,
  ): Promise<readonly InvestigationTelemetrySample[]>;
}

export interface InvestigationOperatorStatusRepositoryPort {
  find(investigationId: string): Promise<InvestigationOperatorStatus | null>;
}

export interface InvestigationOperationsDigestPort {
  digestUtf8(value: string): Promise<string>;
}

export interface InvestigationPromotionReportRepositoryPort {
  save(input: {
    readonly reportCanonicalJson: string;
    readonly reportHash: string;
  }): Promise<void>;
}
