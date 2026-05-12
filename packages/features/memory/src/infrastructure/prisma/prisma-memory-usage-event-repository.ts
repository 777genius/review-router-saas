import type { MemoryUsageEventPort } from "../../application/ports/memory-usage-event-port";
import type { MemoryPrismaClient } from "./prisma-memory-mappers";
import { toPrismaJson } from "./prisma-memory-mappers";

export class PrismaMemoryUsageEventRepository
  implements MemoryUsageEventPort
{
  constructor(private readonly prisma: MemoryPrismaClient) {}

  async recordMany(
    events: Parameters<MemoryUsageEventPort["recordMany"]>[0],
  ): Promise<void> {
    if (events.length === 0) return;
    await this.prisma.memoryUsageEvent.createMany({
      data: events.map((event) => ({
        id: event.id,
        workspaceId: event.workspaceId,
        repositoryId: event.repositoryId,
        memoryItemId: event.memoryItemId,
        eventType: event.eventType,
        bundleVersion: event.bundleVersion,
        metadata: toPrismaJson(event.metadata),
        occurredAt: event.occurredAt,
      })),
    });
  }
}
