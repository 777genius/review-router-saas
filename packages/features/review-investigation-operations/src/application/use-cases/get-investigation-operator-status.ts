import { sanitizeOperatorStatus } from "../../domain/operator-status";
import type { InvestigationOperatorStatusRepositoryPort } from "../ports/operations-ports";

export class GetInvestigationOperatorStatus {
  constructor(
    private readonly repository: InvestigationOperatorStatusRepositoryPort,
  ) {}

  async execute(investigationId: string) {
    const status = await this.repository.find(investigationId);
    return status === null ? null : sanitizeOperatorStatus(status);
  }
}
