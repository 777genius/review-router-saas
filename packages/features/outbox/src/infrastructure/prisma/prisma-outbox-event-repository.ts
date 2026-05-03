import type { Prisma, PrismaClient } from "@prisma/client";
import type {
  NewOutboxEvent,
  OutboxEvent,
  OutboxEventStatus,
} from "../../domain/outbox-event";
import type { OutboxEventRepositoryPort } from "../../application/ports/outbox-event-repository-port";

export class PrismaOutboxEventRepository implements OutboxEventRepositoryPort {
  constructor(private readonly prisma: PrismaClient) {}

  async enqueue(event: NewOutboxEvent): Promise<{ readonly created: boolean }> {
    try {
      await this.prisma.outboxEvent.create({
        data: {
          type: event.type,
          version: event.version,
          idempotencyKey: event.idempotencyKey,
          workspaceId: event.workspaceId ?? null,
          repositoryId: event.repositoryId ?? null,
          aggregateId: event.aggregateId ?? null,
          payload: toPrismaJson(event.payload),
          maxAttempts: event.maxAttempts ?? 5,
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

  async claimDue(input: {
    readonly limit: number;
    readonly now: Date;
  }): Promise<readonly OutboxEvent[]> {
    const candidates = await this.prisma.outboxEvent.findMany({
      where: {
        OR: [
          { status: "pending" },
          { status: "retry_wait", nextAttemptAt: { lte: input.now } },
        ],
      },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
      take: input.limit,
    });

    const claimed: OutboxEvent[] = [];
    for (const candidate of candidates) {
      const updated = await this.prisma.outboxEvent.updateMany({
        where: {
          id: candidate.id,
          status: { in: ["pending", "retry_wait"] },
        },
        data: {
          status: "processing",
          attempts: { increment: 1 },
          nextAttemptAt: null,
        },
      });
      if (updated.count === 1) {
        claimed.push(
          toOutboxEvent({
            ...candidate,
            status: "processing",
            attempts: candidate.attempts + 1,
            nextAttemptAt: null,
          }),
        );
      }
    }

    return claimed;
  }

  async markProcessed(input: {
    readonly id: string;
    readonly processedAt: Date;
  }): Promise<void> {
    await this.prisma.outboxEvent.update({
      where: { id: input.id },
      data: {
        status: "processed",
        processedAt: input.processedAt,
        safeLastErrorSummary: null,
        lastErrorCode: null,
      },
    });
  }

  async markRetry(input: {
    readonly id: string;
    readonly nextAttemptAt: Date;
    readonly errorCode: string;
    readonly safeErrorSummary: string;
  }): Promise<void> {
    await this.prisma.outboxEvent.update({
      where: { id: input.id },
      data: {
        status: "retry_wait",
        nextAttemptAt: input.nextAttemptAt,
        lastErrorCode: input.errorCode,
        safeLastErrorSummary: input.safeErrorSummary.slice(0, 500),
      },
    });
  }

  async markDeadLetter(input: {
    readonly id: string;
    readonly deadLetteredAt: Date;
    readonly errorCode: string;
    readonly safeErrorSummary: string;
  }): Promise<void> {
    await this.prisma.outboxEvent.update({
      where: { id: input.id },
      data: {
        status: "dead_letter",
        deadLetteredAt: input.deadLetteredAt,
        lastErrorCode: input.errorCode,
        safeLastErrorSummary: input.safeErrorSummary.slice(0, 500),
      },
    });
  }
}

function toOutboxEvent(record: {
  readonly id: string;
  readonly type: string;
  readonly version: number;
  readonly idempotencyKey: string;
  readonly workspaceId: string | null;
  readonly repositoryId: string | null;
  readonly aggregateId: string | null;
  readonly payload: unknown;
  readonly status: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly nextAttemptAt: Date | null;
  readonly occurredAt: Date;
}): OutboxEvent {
  return {
    id: record.id,
    type: record.type,
    version: record.version,
    idempotencyKey: record.idempotencyKey,
    workspaceId: record.workspaceId,
    repositoryId: record.repositoryId,
    aggregateId: record.aggregateId,
    payload: record.payload,
    status: record.status as OutboxEventStatus,
    attempts: record.attempts,
    maxAttempts: record.maxAttempts,
    nextAttemptAt: record.nextAttemptAt,
    occurredAt: record.occurredAt,
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "P2002"
  );
}

function toPrismaJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
