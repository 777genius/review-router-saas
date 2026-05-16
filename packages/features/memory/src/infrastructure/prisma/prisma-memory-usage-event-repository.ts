import { Prisma } from "@prisma/client";
import type { MemoryUsageEventPort } from "../../application/ports/memory-usage-event-port";
import type { MemoryUsageEventRetentionPort } from "../../application/ports/memory-usage-event-retention-port";
import type { MemoryPrismaClient } from "./prisma-memory-mappers";
import { toPrismaJson } from "./prisma-memory-mappers";

export class PrismaMemoryUsageEventRepository
  implements MemoryUsageEventPort, MemoryUsageEventRetentionPort
{
  constructor(private readonly prisma: MemoryPrismaClient) {}

  async recordMany(
    events: Parameters<MemoryUsageEventPort["recordMany"]>[0],
  ): ReturnType<MemoryUsageEventPort["recordMany"]> {
    if (events.length === 0) {
      return { recordedCount: 0, duplicateCount: 0 };
    }
    const result = await this.prisma.memoryUsageEvent.createMany({
      data: events.map((event) => ({
        id: event.id,
        workspaceId: event.workspaceId,
        repositoryId: event.repositoryId,
        memoryItemId: event.memoryItemId,
        eventType: event.eventType,
        bundleVersion: event.bundleVersion,
        dedupeKey: event.dedupeKey,
        metadata: toPrismaJson(event.metadata),
        occurredAt: event.occurredAt,
      })),
      skipDuplicates: true,
    });
    return {
      recordedCount: result.count,
      duplicateCount: events.length - result.count,
    };
  }

  async pruneBefore(
    input: Parameters<MemoryUsageEventRetentionPort["pruneBefore"]>[0],
  ): ReturnType<MemoryUsageEventRetentionPort["pruneBefore"]> {
    const workspaceFilter =
      input.scope.kind === "workspace"
        ? Prisma.sql`AND "workspaceId" = ${input.scope.workspaceId}`
        : Prisma.empty;
    const deletedRows = await this.prisma.$queryRaw<{ readonly id: string }[]>`
      WITH expired AS (
        SELECT "id"
        FROM "MemoryUsageEvent"
        WHERE "occurredAt" < ${input.occurredBefore}
        ${workspaceFilter}
        ORDER BY "occurredAt" ASC, "id" ASC
        LIMIT ${input.limit}
      )
      DELETE FROM "MemoryUsageEvent"
      USING expired
      WHERE "MemoryUsageEvent"."id" = expired."id"
      RETURNING "MemoryUsageEvent"."id"
    `;
    return { deletedCount: deletedRows.length };
  }
}
