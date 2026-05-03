import type { AuditEventInput } from "../../domain/audit-event";

export interface AuditLogRepositoryPort {
  append(event: AuditEventInput): Promise<void>;
}
