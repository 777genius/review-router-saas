import {
  recordAuditEvent,
  type AuditLogRepositoryPort,
} from "@reviewrouter/features-audit-log";
import type {
  ReviewConfigurationOperatorAuditEvent,
  ReviewConfigurationOperatorAuditPort,
} from "@reviewrouter/features-review-config";

export class ReviewConfigurationOperatorAudit implements ReviewConfigurationOperatorAuditPort {
  constructor(private readonly auditLog: AuditLogRepositoryPort) {}

  async record(event: ReviewConfigurationOperatorAuditEvent): Promise<void> {
    await recordAuditEvent(event, { auditLog: this.auditLog });
  }
}
