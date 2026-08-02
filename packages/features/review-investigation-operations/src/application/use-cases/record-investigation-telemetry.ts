import type { InvestigationTelemetrySample } from "../../domain/investigation-telemetry";
import { validateTelemetrySample } from "../../domain/investigation-telemetry";
import type { InvestigationTelemetryRepositoryPort } from "../ports/operations-ports";

export class RecordInvestigationTelemetry {
  constructor(
    private readonly repository: InvestigationTelemetryRepositoryPort,
  ) {}

  async execute(sample: InvestigationTelemetrySample): Promise<void> {
    validateTelemetrySample(sample);
    await this.repository.append(Object.freeze({ ...sample }));
  }
}
