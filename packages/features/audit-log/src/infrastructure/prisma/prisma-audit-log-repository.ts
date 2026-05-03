import type { Prisma, PrismaClient } from "@prisma/client";
import type { AuditLogRepositoryPort } from "../../application/ports/audit-log-repository-port";
import type { AuditEventInput } from "../../domain/audit-event";

export class PrismaAuditLogRepository implements AuditLogRepositoryPort {
  constructor(private readonly prisma: PrismaClient) {}

  async append(event: AuditEventInput): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        workspaceId: event.workspaceId,
        actor: event.actor,
        action: event.action,
        targetType: event.targetType,
        targetId: event.targetId,
        metadata: event.metadata as Prisma.InputJsonValue,
      },
    });
  }
}
