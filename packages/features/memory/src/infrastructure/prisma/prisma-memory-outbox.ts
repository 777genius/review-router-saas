import type {
  MemoryOutboxEvent,
  MemoryOutboxPort,
} from "../../application/ports/memory-outbox-port";
import { type MemoryPrismaClient, toPrismaJson } from "./prisma-memory-mappers";

export class PrismaMemoryOutbox implements MemoryOutboxPort {
  constructor(private readonly prisma: MemoryPrismaClient) {}

  async enqueue(
    event: MemoryOutboxEvent,
  ): Promise<{ readonly created: boolean }> {
    try {
      await this.prisma.outboxEvent.create({
        data: {
          type: event.type,
          version: event.version,
          idempotencyKey: event.idempotencyKey,
          workspaceId: event.workspaceId,
          repositoryId: event.repositoryId,
          aggregateId: event.aggregateId,
          payload: toPrismaJson(event.payload),
          occurredAt: event.occurredAt,
        },
      });
      return { created: true };
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return { created: false };
      }
      throw error;
    }
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "P2002"
  );
}
