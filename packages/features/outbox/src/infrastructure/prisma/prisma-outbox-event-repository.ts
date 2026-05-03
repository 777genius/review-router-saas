import type { Prisma, PrismaClient } from "@prisma/client";
import type {
  NewOutboxEvent,
  OutboxEvent,
  OutboxFailure,
  OutboxFailureStatus,
  OutboxEventStatus,
  RetryDeadLetterOutboxEventResult,
} from "../../domain/outbox-event";
import type { OutboxEventRepositoryPort } from "../../application/ports/outbox-event-repository-port";
import type { OutboxMaintenanceRepositoryPort } from "../../application/ports/outbox-maintenance-repository-port";

export class PrismaOutboxEventRepository
  implements OutboxEventRepositoryPort, OutboxMaintenanceRepositoryPort
{
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

  async recoverStaleProcessing(input: {
    readonly staleBefore: Date;
    readonly nextAttemptAt: Date;
    readonly limit: number;
    readonly errorCode: string;
    readonly safeErrorSummary: string;
  }): Promise<{ readonly recovered: number }> {
    const stale = await this.prisma.outboxEvent.findMany({
      where: {
        status: "processing",
        updatedAt: { lt: input.staleBefore },
      },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take: input.limit,
      select: { id: true },
    });

    if (stale.length === 0) {
      return { recovered: 0 };
    }

    const updated = await this.prisma.outboxEvent.updateMany({
      where: {
        id: { in: stale.map((event) => event.id) },
        status: "processing",
        updatedAt: { lt: input.staleBefore },
      },
      data: {
        status: "retry_wait",
        nextAttemptAt: input.nextAttemptAt,
        lastErrorCode: input.errorCode,
        safeLastErrorSummary: input.safeErrorSummary.slice(0, 500),
      },
    });

    return { recovered: updated.count };
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

  async listWorkspaceFailures(input: {
    readonly workspaceId: string;
    readonly limit: number;
  }): Promise<readonly OutboxFailure[]> {
    const failures = await this.prisma.outboxEvent.findMany({
      where: {
        workspaceId: input.workspaceId,
        status: { in: ["processing", "retry_wait", "dead_letter"] },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      take: input.limit,
    });
    return failures.map(toOutboxFailure);
  }

  async retryDeadLetter(input: {
    readonly workspaceId: string;
    readonly eventId: string;
    readonly retriedAt: Date;
  }): Promise<RetryDeadLetterOutboxEventResult> {
    const existing = await this.prisma.outboxEvent.findFirst({
      where: { id: input.eventId, workspaceId: input.workspaceId },
      select: { status: true },
    });
    if (!existing) {
      return { status: "not_found" };
    }
    if (existing.status !== "dead_letter") {
      return {
        status: "not_dead_letter",
        currentStatus: existing.status as OutboxEventStatus,
      };
    }

    const updated = await this.prisma.outboxEvent.updateMany({
      where: {
        id: input.eventId,
        workspaceId: input.workspaceId,
        status: "dead_letter",
      },
      data: {
        status: "pending",
        attempts: 0,
        nextAttemptAt: null,
        processedAt: null,
        deadLetteredAt: null,
        lastErrorCode: null,
        safeLastErrorSummary: null,
        updatedAt: input.retriedAt,
      },
    });

    return updated.count === 1 ? { status: "queued" } : { status: "not_found" };
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

function toOutboxFailure(record: {
  readonly id: string;
  readonly type: string;
  readonly version: number;
  readonly workspaceId: string | null;
  readonly repositoryId: string | null;
  readonly status: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly nextAttemptAt: Date | null;
  readonly lastErrorCode: string | null;
  readonly safeLastErrorSummary: string | null;
  readonly occurredAt: Date;
  readonly updatedAt: Date;
}): OutboxFailure {
  return {
    id: record.id,
    type: record.type,
    version: record.version,
    workspaceId: record.workspaceId,
    repositoryId: record.repositoryId,
    status: record.status as OutboxFailureStatus,
    attempts: record.attempts,
    maxAttempts: record.maxAttempts,
    nextAttemptAt: record.nextAttemptAt,
    lastErrorCode: record.lastErrorCode,
    safeLastErrorSummary: record.safeLastErrorSummary,
    occurredAt: record.occurredAt,
    updatedAt: record.updatedAt,
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
