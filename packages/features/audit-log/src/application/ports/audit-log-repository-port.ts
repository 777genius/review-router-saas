import type { AuditEventInput } from "../../domain/audit-event.js";

export interface AuditLogRepositoryPort {
  append(event: AuditEventInput): Promise<void>;
}
