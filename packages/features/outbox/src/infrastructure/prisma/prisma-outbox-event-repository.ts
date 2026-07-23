import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  NewOutboxEvent,
  OutboxClaimTerm,
  OutboxClaimTransitionResult,
  OutboxEvent,
  OutboxFailure,
  OutboxFailureStatus,
  OutboxEventStatus,
  RetryDeadLetterOutboxEventResult,
} from "../../domain/outbox-event";
import type { OutboxEventRepositoryPort } from "../../application/ports/outbox-event-repository-port";
import type { OutboxEventStatusQueryPort } from "../../application/ports/outbox-event-repository-port";
import type { OutboxMaintenanceRepositoryPort } from "../../application/ports/outbox-maintenance-repository-port";

export class PrismaOutboxEventRepository
  implements
    OutboxEventRepositoryPort,
    OutboxEventStatusQueryPort,
    OutboxMaintenanceRepositoryPort
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
        const existing = await this.prisma.outboxEvent.findUnique({
          where: { idempotencyKey: event.idempotencyKey },
          select: {
            type: true,
            version: true,
            workspaceId: true,
            repositoryId: true,
            aggregateId: true,
            payload: true,
          },
        });
        if (!existing || !sameImmutableEvent(existing, event)) {
          throw new Error("outbox_idempotency_conflict", { cause: error });
        }
        return { created: false };
      }
      throw error;
    }
  }

  async findStatusByIdempotencyKey(idempotencyKey: string) {
    const event = await this.prisma.outboxEvent.findUnique({
      where: { idempotencyKey },
      select: { id: true, status: true },
    });
    return event
      ? { id: event.id, status: event.status as OutboxEventStatus }
      : null;
  }

  async recoverStaleProcessing(input: {
    readonly now: Date;
    readonly legacyStaleBefore: Date;
    readonly nextAttemptAt: Date;
    readonly limit: number;
    readonly errorCode: string;
    readonly safeErrorSummary: string;
  }): Promise<{ readonly recovered: number }> {
    const stale = await this.prisma.outboxEvent.findMany({
      where: {
        status: "processing",
        OR: [
          { claimUntil: { lte: input.now } },
          { claimId: null, updatedAt: { lt: input.legacyStaleBefore } },
        ],
      },
      orderBy: [{ claimUntil: "asc" }, { updatedAt: "asc" }, { id: "asc" }],
      take: input.limit,
      select: { id: true, claimId: true, claimVersion: true },
    });

    if (stale.length === 0) {
      return { recovered: 0 };
    }

    let recovered = 0;
    for (const event of stale) {
      const updated: { readonly count: number } = await this.withClaimContext(
        event.claimId === null || event.claimVersion === null
          ? null
          : { claimId: event.claimId, claimVersion: event.claimVersion },
        (transaction) =>
          transaction.outboxEvent.updateMany({
            where: {
              id: event.id,
              status: "processing",
              claimId: event.claimId,
              claimVersion: event.claimVersion,
              OR: [
                { claimUntil: { lte: input.now } },
                {
                  claimId: null,
                  updatedAt: { lt: input.legacyStaleBefore },
                },
              ],
            },
            data: {
              status: "retry_wait",
              nextAttemptAt: input.nextAttemptAt,
              claimId: null,
              claimOwnerHash: null,
              claimUntil: null,
              lastErrorCode: input.errorCode,
              safeLastErrorSummary: input.safeErrorSummary.slice(0, 500),
            },
          }),
      );
      recovered += updated.count;
    }

    return { recovered };
  }

  async claimDue(input: {
    readonly limit: number;
    readonly now: Date;
    readonly claimOwnerHash: string;
    readonly claimForMs: number;
    readonly availableHandlers: readonly {
      readonly type: string;
      readonly version: number;
    }[];
    readonly knownHandlers: readonly {
      readonly type: string;
      readonly version: number;
    }[];
  }): Promise<readonly OutboxEvent[]> {
    void input.now;
    const eligibility = handlerEligibilitySql({
      available: input.availableHandlers,
      known: input.knownHandlers,
    });
    const claimed = await this.prisma.$queryRaw<OutboxEventRecord[]>(Prisma.sql`
      WITH candidates AS (
        SELECT event."id"
        FROM "OutboxEvent" event
        WHERE (
          event."status" = 'pending'::"OutboxEventStatus"
          OR (
            event."status" = 'retry_wait'::"OutboxEventStatus"
            AND event."nextAttemptAt" <= statement_timestamp()
          )
        )
          AND ${eligibility}
        ORDER BY event."occurredAt" ASC, event."id" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${input.limit}
      ), claimed_terms AS (
        SELECT
          candidates."id",
          nextval('"OutboxEvent_claimVersion_seq"') AS "claimVersion"
        FROM candidates
      )
      UPDATE "OutboxEvent" event
      SET
        "status" = 'processing'::"OutboxEventStatus",
        "attempts" = event."attempts" + 1,
        "nextAttemptAt" = NULL,
        "claimId" = 'outbox-claim-' || claimed_terms."claimVersion"::text,
        "claimVersion" = claimed_terms."claimVersion",
        "claimOwnerHash" = ${input.claimOwnerHash},
        "claimUntil" = statement_timestamp()
          + (${input.claimForMs} * INTERVAL '1 millisecond'),
        "updatedAt" = statement_timestamp()
      FROM claimed_terms
      WHERE event."id" = claimed_terms."id"
      RETURNING event.*
    `);
    return claimed.map(toOutboxEvent);
  }

  async renewClaim(
    input: OutboxClaimTerm,
  ): Promise<OutboxClaimTransitionResult> {
    return this.transitionClaim(
      { claimId: input.claimId, claimVersion: input.claimVersion },
      (transaction) =>
        transaction.outboxEvent.updateMany({
          where: {
            claimId: input.claimId,
            claimVersion: input.claimVersion,
            claimOwnerHash: input.claimOwnerHash,
            status: "processing",
          },
          data: { claimUntil: input.claimUntil },
        }),
    );
  }

  async markProcessed(input: {
    readonly id: string;
    readonly claimId: string;
    readonly claimVersion: bigint;
    readonly processedAt: Date;
  }): Promise<OutboxClaimTransitionResult> {
    return this.transitionClaim(input, (transaction) =>
      transaction.outboxEvent.updateMany({
        where: claimWhere(input),
        data: {
          status: "processed",
          processedAt: input.processedAt,
          claimId: null,
          claimOwnerHash: null,
          claimUntil: null,
          safeLastErrorSummary: null,
          lastErrorCode: null,
        },
      }),
    );
  }

  async markRetry(input: {
    readonly id: string;
    readonly claimId: string;
    readonly claimVersion: bigint;
    readonly nextAttemptAt: Date;
    readonly errorCode: string;
    readonly safeErrorSummary: string;
  }): Promise<OutboxClaimTransitionResult> {
    return this.transitionClaim(input, (transaction) =>
      transaction.outboxEvent.updateMany({
        where: claimWhere(input),
        data: {
          status: "retry_wait",
          nextAttemptAt: input.nextAttemptAt,
          claimId: null,
          claimOwnerHash: null,
          claimUntil: null,
          lastErrorCode: input.errorCode,
          safeLastErrorSummary: input.safeErrorSummary.slice(0, 500),
        },
      }),
    );
  }

  async markDeadLetter(input: {
    readonly id: string;
    readonly claimId: string;
    readonly claimVersion: bigint;
    readonly deadLetteredAt: Date;
    readonly errorCode: string;
    readonly safeErrorSummary: string;
  }): Promise<OutboxClaimTransitionResult> {
    return this.transitionClaim(input, (transaction) =>
      transaction.outboxEvent.updateMany({
        where: claimWhere(input),
        data: {
          status: "dead_letter",
          deadLetteredAt: input.deadLetteredAt,
          claimId: null,
          claimOwnerHash: null,
          claimUntil: null,
          lastErrorCode: input.errorCode,
          safeLastErrorSummary: input.safeErrorSummary.slice(0, 500),
        },
      }),
    );
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
        claimId: null,
        claimOwnerHash: null,
        claimUntil: null,
        lastErrorCode: null,
        safeLastErrorSummary: null,
        updatedAt: input.retriedAt,
      },
    });

    return updated.count === 1 ? { status: "queued" } : { status: "not_found" };
  }

  private async transitionClaim(
    claim: { readonly claimId: string; readonly claimVersion: bigint },
    transition: (
      transaction: Prisma.TransactionClient,
    ) => Promise<{ readonly count: number }>,
  ): Promise<OutboxClaimTransitionResult> {
    const updated = await this.withClaimContext(claim, transition);
    return updated.count === 1
      ? { status: "applied" }
      : { status: "stale_claim" };
  }

  private async withClaimContext<T>(
    claim: {
      readonly claimId: string;
      readonly claimVersion: bigint;
    } | null,
    operation: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (transaction) => {
      if (claim) {
        await transaction.$executeRaw`
          SELECT set_config('reviewrouter.outbox_claim_id', ${claim.claimId}, true)
        `;
        await transaction.$executeRaw`
          SELECT set_config('reviewrouter.outbox_claim_version', ${claim.claimVersion.toString()}, true)
        `;
      }
      return operation(transaction);
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
  readonly claimId: string | null;
  readonly claimVersion: bigint | null;
  readonly claimOwnerHash: string | null;
  readonly claimUntil: Date | null;
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
    claimId: record.claimId,
    claimVersion: record.claimVersion,
    claimOwnerHash: record.claimOwnerHash,
    claimUntil: record.claimUntil,
    occurredAt: record.occurredAt,
  };
}

function claimWhere(input: {
  readonly id: string;
  readonly claimId: string;
  readonly claimVersion: bigint;
}) {
  return {
    id: input.id,
    status: "processing" as const,
    claimId: input.claimId,
    claimVersion: input.claimVersion,
  };
}

type OutboxEventRecord = Parameters<typeof toOutboxEvent>[0];

function handlerEligibilitySql(input: {
  readonly available: readonly {
    readonly type: string;
    readonly version: number;
  }[];
  readonly known: readonly {
    readonly type: string;
    readonly version: number;
  }[];
}): Prisma.Sql {
  const available = handlerPairsSql(input.available);
  const known = handlerPairsSql(input.known);
  const knownTypes = handlerTypesSql(input.known);
  const unknownOwnedVersion =
    known && knownTypes
      ? Prisma.sql`((${knownTypes}) AND NOT (${known}))`
      : null;
  if (!available && !unknownOwnedVersion) return Prisma.sql`FALSE`;
  if (!available) return unknownOwnedVersion!;
  if (!unknownOwnedVersion) return available;
  return Prisma.sql`(${available}) OR (${unknownOwnedVersion})`;
}

function handlerPairsSql(
  handlers: readonly { readonly type: string; readonly version: number }[],
): Prisma.Sql | null {
  if (handlers.length === 0) return null;
  return Prisma.join(
    handlers.map(
      (handler) =>
        Prisma.sql`(event."type" = ${handler.type} AND event."version" = ${handler.version})`,
    ),
    " OR ",
  );
}

function handlerTypesSql(
  handlers: readonly { readonly type: string }[],
): Prisma.Sql | null {
  const types = [...new Set(handlers.map((handler) => handler.type))];
  if (types.length === 0) return null;
  return Prisma.join(
    types.map((type) => Prisma.sql`event."type" = ${type}`),
    " OR ",
  );
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

function sameImmutableEvent(
  existing: {
    readonly type: string;
    readonly version: number;
    readonly workspaceId: string | null;
    readonly repositoryId: string | null;
    readonly aggregateId: string | null;
    readonly payload: unknown;
  },
  candidate: NewOutboxEvent,
): boolean {
  return (
    existing.type === candidate.type &&
    existing.version === candidate.version &&
    existing.workspaceId === (candidate.workspaceId ?? null) &&
    existing.repositoryId === (candidate.repositoryId ?? null) &&
    existing.aggregateId === (candidate.aggregateId ?? null) &&
    canonicalJson(existing.payload) === canonicalJson(candidate.payload)
  );
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right, "en"))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}
