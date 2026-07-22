import type { OutboxEventRepositoryPort } from "../../application/ports/outbox-event-repository-port";
import type { OutboxMaintenanceRepositoryPort } from "../../application/ports/outbox-maintenance-repository-port";
import {
  outboxHandlerKey,
  type NewOutboxEvent,
  type OutboxClaimTerm,
  type OutboxClaimTransitionResult,
  type OutboxEvent,
  type OutboxFailure,
  type OutboxFailureStatus,
  type OutboxEventStatus,
  type RetryDeadLetterOutboxEventResult,
} from "../../domain/outbox-event";

type StoredOutboxEvent = OutboxEvent & {
  readonly processedAt: Date | null;
  readonly deadLetteredAt: Date | null;
  readonly lastErrorCode: string | null;
  readonly safeLastErrorSummary: string | null;
  readonly updatedAt: Date;
};

export class InMemoryOutboxEventRepository
  implements OutboxEventRepositoryPort, OutboxMaintenanceRepositoryPort
{
  readonly events = new Map<string, StoredOutboxEvent>();
  private nextClaimVersion = 1n;

  async enqueue(event: NewOutboxEvent): Promise<{ readonly created: boolean }> {
    const existing = [...this.events.values()].find(
      (candidate) => candidate.idempotencyKey === event.idempotencyKey,
    );
    if (existing) {
      if (!sameImmutableEvent(existing, event)) {
        throw new Error("outbox_idempotency_conflict");
      }
      return { created: false };
    }

    this.events.set(event.idempotencyKey, {
      id: event.idempotencyKey,
      type: event.type,
      version: event.version,
      idempotencyKey: event.idempotencyKey,
      workspaceId: event.workspaceId ?? null,
      repositoryId: event.repositoryId ?? null,
      aggregateId: event.aggregateId ?? null,
      payload: event.payload,
      status: "pending",
      attempts: 0,
      maxAttempts: event.maxAttempts ?? 5,
      nextAttemptAt: null,
      claimId: null,
      claimVersion: null,
      claimOwnerHash: null,
      claimUntil: null,
      processedAt: null,
      deadLetteredAt: null,
      lastErrorCode: null,
      safeLastErrorSummary: null,
      occurredAt: event.occurredAt,
      updatedAt: event.occurredAt,
    });
    return { created: true };
  }

  async recoverStaleProcessing(input: {
    readonly now: Date;
    readonly legacyStaleBefore: Date;
    readonly nextAttemptAt: Date;
    readonly limit: number;
    readonly errorCode: string;
    readonly safeErrorSummary: string;
  }): Promise<{ readonly recovered: number }> {
    const stale = [...this.events.values()]
      .filter(
        (event) =>
          event.status === "processing" &&
          ((event.claimUntil !== null && event.claimUntil <= input.now) ||
            (event.claimId === null &&
              event.updatedAt < input.legacyStaleBefore)),
      )
      .slice(0, input.limit);
    for (const event of stale) {
      this.store(event, {
        status: "retry_wait",
        nextAttemptAt: input.nextAttemptAt,
        claimId: null,
        claimOwnerHash: null,
        claimUntil: null,
        lastErrorCode: input.errorCode,
        safeLastErrorSummary: input.safeErrorSummary,
        updatedAt: input.nextAttemptAt,
      });
    }
    return { recovered: stale.length };
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
    const available = new Set(
      input.availableHandlers.map((handler) =>
        outboxHandlerKey(handler.type, handler.version),
      ),
    );
    const known = new Set(
      input.knownHandlers.map((handler) =>
        outboxHandlerKey(handler.type, handler.version),
      ),
    );
    const knownTypes = new Set(
      input.knownHandlers.map((handler) => handler.type),
    );
    const due = [...this.events.values()]
      .filter((event) => {
        const isDue =
          event.status === "pending" ||
          (event.status === "retry_wait" &&
            event.nextAttemptAt !== null &&
            event.nextAttemptAt <= input.now);
        const key = outboxHandlerKey(event.type, event.version);
        return (
          isDue &&
          (available.has(key) ||
            (knownTypes.has(event.type) && !known.has(key)))
        );
      })
      .slice(0, input.limit);

    return due.map((event) => {
      const claimVersion = this.nextClaimVersion++;
      const claimed: StoredOutboxEvent = {
        ...event,
        status: "processing",
        attempts: event.attempts + 1,
        nextAttemptAt: null,
        claimId: `outbox-claim-${claimVersion}`,
        claimVersion,
        claimOwnerHash: input.claimOwnerHash,
        claimUntil: new Date(input.now.getTime() + input.claimForMs),
        updatedAt: input.now,
      };
      this.events.set(event.idempotencyKey, claimed);
      return claimed;
    });
  }

  async renewClaim(
    input: OutboxClaimTerm,
  ): Promise<OutboxClaimTransitionResult> {
    const event = this.findClaim(input);
    if (!event || event.claimOwnerHash !== input.claimOwnerHash) {
      return { status: "stale_claim" };
    }
    this.store(event, { claimUntil: input.claimUntil });
    return { status: "applied" };
  }

  async markProcessed(input: {
    readonly id: string;
    readonly claimId: string;
    readonly claimVersion: bigint;
    readonly processedAt: Date;
  }): Promise<OutboxClaimTransitionResult> {
    return this.transition(input, {
      status: "processed",
      processedAt: input.processedAt,
      claimId: null,
      claimOwnerHash: null,
      claimUntil: null,
      lastErrorCode: null,
      safeLastErrorSummary: null,
      updatedAt: input.processedAt,
    });
  }

  async markRetry(input: {
    readonly id: string;
    readonly claimId: string;
    readonly claimVersion: bigint;
    readonly nextAttemptAt: Date;
    readonly errorCode: string;
    readonly safeErrorSummary: string;
  }): Promise<OutboxClaimTransitionResult> {
    return this.transition(input, {
      status: "retry_wait",
      nextAttemptAt: input.nextAttemptAt,
      claimId: null,
      claimOwnerHash: null,
      claimUntil: null,
      lastErrorCode: input.errorCode,
      safeLastErrorSummary: input.safeErrorSummary,
      updatedAt: input.nextAttemptAt,
    });
  }

  async markDeadLetter(input: {
    readonly id: string;
    readonly claimId: string;
    readonly claimVersion: bigint;
    readonly deadLetteredAt: Date;
    readonly errorCode: string;
    readonly safeErrorSummary: string;
  }): Promise<OutboxClaimTransitionResult> {
    return this.transition(input, {
      status: "dead_letter",
      deadLetteredAt: input.deadLetteredAt,
      claimId: null,
      claimOwnerHash: null,
      claimUntil: null,
      lastErrorCode: input.errorCode,
      safeLastErrorSummary: input.safeErrorSummary,
      updatedAt: input.deadLetteredAt,
    });
  }

  async listWorkspaceFailures(input: {
    readonly workspaceId: string;
    readonly limit: number;
  }): Promise<readonly OutboxFailure[]> {
    return [...this.events.values()]
      .filter(
        (event) =>
          event.workspaceId === input.workspaceId &&
          ["processing", "retry_wait", "dead_letter"].includes(event.status),
      )
      .slice(0, input.limit)
      .map((event) => ({
        id: event.id,
        type: event.type,
        version: event.version,
        workspaceId: event.workspaceId,
        repositoryId: event.repositoryId,
        status: event.status as OutboxFailureStatus,
        attempts: event.attempts,
        maxAttempts: event.maxAttempts,
        nextAttemptAt: event.nextAttemptAt,
        lastErrorCode: event.lastErrorCode,
        safeLastErrorSummary: event.safeLastErrorSummary,
        occurredAt: event.occurredAt,
        updatedAt: event.updatedAt,
      }));
  }

  async retryDeadLetter(input: {
    readonly workspaceId: string;
    readonly eventId: string;
    readonly retriedAt: Date;
  }): Promise<RetryDeadLetterOutboxEventResult> {
    const event = [...this.events.values()].find(
      (candidate) =>
        candidate.id === input.eventId &&
        candidate.workspaceId === input.workspaceId,
    );
    if (!event) return { status: "not_found" };
    if (event.status !== "dead_letter") {
      return {
        status: "not_dead_letter",
        currentStatus: event.status as OutboxEventStatus,
      };
    }
    this.store(event, {
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
    });
    return { status: "queued" };
  }

  private findClaim(input: {
    readonly claimId: string;
    readonly claimVersion: bigint;
  }): StoredOutboxEvent | undefined {
    return [...this.events.values()].find(
      (event) =>
        event.status === "processing" &&
        event.claimId === input.claimId &&
        event.claimVersion === input.claimVersion,
    );
  }

  private transition(
    input: {
      readonly id: string;
      readonly claimId: string;
      readonly claimVersion: bigint;
    },
    patch: Partial<StoredOutboxEvent>,
  ): OutboxClaimTransitionResult {
    const event = this.findClaim(input);
    if (!event || event.id !== input.id) return { status: "stale_claim" };
    this.store(event, patch);
    return { status: "applied" };
  }

  private store(
    event: StoredOutboxEvent,
    patch: Partial<StoredOutboxEvent>,
  ): void {
    this.events.set(event.idempotencyKey, { ...event, ...patch });
  }
}

function sameImmutableEvent(
  existing: StoredOutboxEvent,
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
