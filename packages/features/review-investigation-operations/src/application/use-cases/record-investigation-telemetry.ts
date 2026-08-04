import {
  InvestigationTelemetryEvidenceCompleteness,
  type InvestigationTerminalOperationalTelemetrySample,
  validateTelemetrySample,
} from "../../domain/investigation-telemetry";
import type { InvestigationTelemetryRepositoryPort } from "../ports/operations-ports";

export class RecordInvestigationTelemetry {
  constructor(
    private readonly repository: InvestigationTelemetryRepositoryPort,
  ) {}

  async execute(
    sample: InvestigationTerminalOperationalTelemetrySample,
  ): Promise<void> {
    validateTelemetrySample(sample);
    if (
      sample.evidenceCompleteness !==
      InvestigationTelemetryEvidenceCompleteness.TerminalOperational
    ) {
      throw new Error("telemetry_trusted_evaluation_required");
    }
    await this.repository.append(Object.freeze({ ...sample }));
  }
}
