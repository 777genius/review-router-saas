import {
  auditEventSchema,
  sanitizeAuditMetadata,
  type AuditEventInput,
} from "../../domain/audit-event";
import type { AuditLogRepositoryPort } from "../ports/audit-log-repository-port";

export async function recordAuditEvent(
  input: AuditEventInput,
  dependencies: { readonly auditLog: AuditLogRepositoryPort },
): Promise<void> {
  const event = auditEventSchema.parse(input);
  await dependencies.auditLog.append({
    ...event,
    metadata: sanitizeAuditMetadata(event.metadata),
  });
}
