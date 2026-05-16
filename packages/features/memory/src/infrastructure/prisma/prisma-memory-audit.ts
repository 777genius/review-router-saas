import type { Prisma } from "@prisma/client";
import type {
  MemoryAuditEvent,
  MemoryAuditPort,
} from "../../application/ports/memory-audit-port";
import { type MemoryPrismaClient, toPrismaJson } from "./prisma-memory-mappers";

export class PrismaMemoryAudit implements MemoryAuditPort {
  constructor(private readonly prisma: MemoryPrismaClient) {}

  async record(event: MemoryAuditEvent): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        workspaceId: event.workspaceId,
        actor: event.actor,
        action: event.action,
        targetType: event.targetType,
        targetId: event.targetId,
        metadata: toPrismaJson(event.metadata) as Prisma.InputJsonValue,
      },
    });
  }
}
