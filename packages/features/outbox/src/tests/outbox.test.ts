import { describe, expect, it } from "vitest";
import type { Clock } from "@reviewrouter/shared";
import type { OutboxEventRepositoryPort } from "../application/ports/outbox-event-repository-port";
import type { OutboxMaintenanceRepositoryPort } from "../application/ports/outbox-maintenance-repository-port";
import { enqueueOutboxEvent } from "../application/use-cases/enqueue-outbox-event";
import { listWorkspaceOutboxFailures } from "../application/use-cases/list-workspace-outbox-failures";
import { processOutboxBatch } from "../application/use-cases/process-outbox-batch";
import { retryDeadLetterOutboxEvent } from "../application/use-cases/retry-dead-letter-outbox-event";
import {
  OutboxHandlerError,
  type OutboxFailure,
  type OutboxFailureStatus,
  type NewOutboxEvent,
  type OutboxEvent,
  type OutboxEventStatus,
  type RetryDeadLetterOutboxEventResult,
} from "../domain/outbox-event";

const now = new Date("2026-05-03T12:00:00.000Z");
const clock: Clock = { now: () => now };

class InMemoryOutboxRepository
  implements OutboxEventRepositoryPort, OutboxMaintenanceRepositoryPort
{
  public readonly events = new Map<
    string,
    OutboxEvent & {
      readonly lastErrorCode?: string;
      readonly safeLastErrorSummary?: string;
      readonly updatedAt: Date;
    }
  >();

  async enqueue(event: NewOutboxEvent): Promise<{ readonly created: boolean }> {
    if (
      [...this.events.values()].some(
        (item) => item.idempotencyKey === event.idempotencyKey,
      )
    ) {
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
      occurredAt: event.occurredAt,
      updatedAt: event.occurredAt,
    });
    return { created: true };
  }

  async recoverStaleProcessing(input: {
    readonly staleBefore: Date;
    readonly nextAttemptAt: Date;
    readonly limit: number;
    readonly errorCode: string;
    readonly safeErrorSummary: string;
  }): Promise<{ readonly recovered: number }> {
    const stale = [...this.events.values()]
      .filter(
        (event) =>
          event.status === "processing" && event.updatedAt < input.staleBefore,
      )
      .slice(0, input.limit);

    for (const event of stale) {
      this.events.set(event.idempotencyKey, {
        ...event,
        status: "retry_wait",
        nextAttemptAt: input.nextAttemptAt,
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
  }): Promise<readonly OutboxEvent[]> {
    const due = [...this.events.values()]
      .filter(
        (event) =>
          event.status === "pending" ||
          (event.status === "retry_wait" &&
            event.nextAttemptAt !== null &&
            event.nextAttemptAt <= input.now),
      )
      .slice(0, input.limit);
    for (const event of due) {
      this.events.set(event.idempotencyKey, {
        ...event,
        status: "processing",
        attempts: event.attempts + 1,
        nextAttemptAt: null,
        updatedAt: input.now,
      });
    }
    return due.map((event) => ({
      ...event,
      status: "processing",
      attempts: event.attempts + 1,
      nextAttemptAt: null,
    }));
  }

  async markProcessed(input: { readonly id: string }): Promise<void> {
    this.updateById(input.id, { status: "processed", updatedAt: now });
  }

  async markRetry(input: {
    readonly id: string;
    readonly nextAttemptAt: Date;
    readonly errorCode: string;
    readonly safeErrorSummary: string;
  }): Promise<void> {
    this.updateById(input.id, {
      status: "retry_wait",
      nextAttemptAt: input.nextAttemptAt,
      lastErrorCode: input.errorCode,
      safeLastErrorSummary: input.safeErrorSummary,
      updatedAt: input.nextAttemptAt,
    });
  }

  async markDeadLetter(input: {
    readonly id: string;
    readonly errorCode: string;
    readonly safeErrorSummary: string;
  }): Promise<void> {
    this.updateById(input.id, {
      status: "dead_letter",
      lastErrorCode: input.errorCode,
      safeLastErrorSummary: input.safeErrorSummary,
      updatedAt: now,
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
        lastErrorCode: event.lastErrorCode ?? null,
        safeLastErrorSummary: event.safeLastErrorSummary ?? null,
        occurredAt: event.occurredAt,
        updatedAt: event.updatedAt,
      }));
  }

  async retryDeadLetter(input: {
    readonly workspaceId: string;
    readonly eventId: string;
    readonly retriedAt: Date;
  }): Promise<RetryDeadLetterOutboxEventResult> {
    const existing = [...this.events.values()].find(
      (event) =>
        event.id === input.eventId && event.workspaceId === input.workspaceId,
    );
    if (!existing) {
      return { status: "not_found" };
    }
    if (existing.status !== "dead_letter") {
      return {
        status: "not_dead_letter",
        currentStatus: existing.status as OutboxEventStatus,
      };
    }
    const { lastErrorCode, safeLastErrorSummary, ...cleanExisting } = existing;
    void lastErrorCode;
    void safeLastErrorSummary;
    this.events.set(existing.idempotencyKey, {
      ...cleanExisting,
      status: "pending",
      attempts: 0,
      nextAttemptAt: null,
      updatedAt: input.retriedAt,
    });
    return { status: "queued" };
  }

  private updateById(
    id: string,
    patch: Partial<OutboxEvent> & {
      readonly lastErrorCode?: string;
      readonly safeLastErrorSummary?: string;
      readonly updatedAt?: Date;
    },
  ): void {
    const existing = [...this.events.values()].find((event) => event.id === id);
    if (!existing) throw new Error(`missing_event:${id}`);
    this.events.set(existing.idempotencyKey, { ...existing, ...patch });
  }
}

describe("outbox", () => {
  it("enqueues events idempotently", async () => {
    const outbox = new InMemoryOutboxRepository();
    const event = {
      type: "installation.sync_requested",
      version: 1,
      idempotencyKey: "installation:129:sync",
      payload: { installationId: "129" },
      occurredAt: now,
    };

    await expect(enqueueOutboxEvent(event, { outbox })).resolves.toEqual({
      created: true,
    });
    await expect(enqueueOutboxEvent(event, { outbox })).resolves.toEqual({
      created: false,
    });
  });

  it("processes matching event handlers", async () => {
    const outbox = new InMemoryOutboxRepository();
    await enqueueOutboxEvent(
      {
        type: "installation.sync_requested",
        version: 1,
        idempotencyKey: "installation:129:sync",
        payload: { installationId: "129" },
        occurredAt: now,
      },
      { outbox },
    );

    const result = await processOutboxBatch(
      {
        limit: 10,
        handlers: [
          {
            type: "installation.sync_requested",
            version: 1,
            handle: async () => undefined,
          },
        ],
      },
      { outbox, clock },
    );

    expect(result).toEqual({
      recoveredStale: 0,
      claimed: 1,
      processed: 1,
      retried: 0,
      deadLettered: 0,
    });
    expect(outbox.events.get("installation:129:sync")).toMatchObject({
      status: "processed",
    });
  });

  it("dead-letters unknown event versions", async () => {
    const outbox = new InMemoryOutboxRepository();
    await enqueueOutboxEvent(
      {
        type: "installation.sync_requested",
        version: 99,
        idempotencyKey: "installation:129:sync:v99",
        payload: { installationId: "129" },
        occurredAt: now,
      },
      { outbox },
    );

    const result = await processOutboxBatch(
      { limit: 10, handlers: [] },
      { outbox, clock },
    );

    expect(result.deadLettered).toBe(1);
    expect(outbox.events.get("installation:129:sync:v99")).toMatchObject({
      status: "dead_letter",
      lastErrorCode: "unsupported_event_version",
    });
  });

  it("retries retryable errors and dead-letters permanent errors", async () => {
    const outbox = new InMemoryOutboxRepository();
    await enqueueOutboxEvent(
      {
        type: "repo.workflow_provision_requested",
        version: 1,
        idempotencyKey: "repo:1:provision",
        payload: { repoId: "1" },
        occurredAt: now,
      },
      { outbox },
    );

    await expect(
      processOutboxBatch(
        {
          limit: 10,
          handlers: [
            {
              type: "repo.workflow_provision_requested",
              version: 1,
              handle: async () => {
                throw new OutboxHandlerError(
                  "GitHub rate limit",
                  "rate_limited",
                  true,
                );
              },
            },
          ],
        },
        { outbox, clock },
      ),
    ).resolves.toMatchObject({ retried: 1 });

    expect(outbox.events.get("repo:1:provision")).toMatchObject({
      status: "retry_wait",
      lastErrorCode: "rate_limited",
    });

    outbox.events.set("repo:2:provision", {
      id: "repo:2:provision",
      type: "repo.workflow_provision_requested",
      version: 1,
      idempotencyKey: "repo:2:provision",
      workspaceId: null,
      repositoryId: null,
      aggregateId: null,
      payload: { repoId: "2" },
      status: "pending",
      attempts: 0,
      maxAttempts: 5,
      nextAttemptAt: null,
      occurredAt: now,
      updatedAt: now,
    });

    await expect(
      processOutboxBatch(
        {
          limit: 10,
          handlers: [
            {
              type: "repo.workflow_provision_requested",
              version: 1,
              handle: async () => {
                throw new OutboxHandlerError(
                  "Permission denied",
                  "permission_denied",
                  false,
                );
              },
            },
          ],
        },
        { outbox, clock },
      ),
    ).resolves.toMatchObject({ deadLettered: 1 });

    expect(outbox.events.get("repo:2:provision")).toMatchObject({
      status: "dead_letter",
      lastErrorCode: "permission_denied",
    });
  });

  it("recovers stale processing events before claiming due work", async () => {
    const outbox = new InMemoryOutboxRepository();
    outbox.events.set("repo:stale", {
      id: "repo:stale",
      type: "repo.workflow_provision_requested",
      version: 1,
      idempotencyKey: "repo:stale",
      workspaceId: "workspace_1",
      repositoryId: "repo_1",
      aggregateId: null,
      payload: { repoId: "repo_1" },
      status: "processing",
      attempts: 1,
      maxAttempts: 5,
      nextAttemptAt: null,
      occurredAt: now,
      updatedAt: new Date(now.getTime() - 120_000),
    });

    const result = await processOutboxBatch(
      {
        limit: 10,
        processingStaleAfterMs: 60_000,
        handlers: [
          {
            type: "repo.workflow_provision_requested",
            version: 1,
            handle: async () => undefined,
          },
        ],
      },
      { outbox, clock },
    );

    expect(result).toEqual({
      recoveredStale: 1,
      claimed: 1,
      processed: 1,
      retried: 0,
      deadLettered: 0,
    });
    expect(outbox.events.get("repo:stale")).toMatchObject({
      status: "processed",
      attempts: 2,
    });
  });

  it("lists and retries dead-letter events inside a workspace", async () => {
    const outbox = new InMemoryOutboxRepository();
    outbox.events.set("repo:dead", {
      id: "event_dead",
      type: "repo.workflow_provision_requested",
      version: 1,
      idempotencyKey: "repo:dead",
      workspaceId: "workspace_1",
      repositoryId: "repo_1",
      aggregateId: null,
      payload: { repoId: "repo_1" },
      status: "dead_letter",
      attempts: 5,
      maxAttempts: 5,
      nextAttemptAt: null,
      occurredAt: now,
      updatedAt: now,
      lastErrorCode: "permission_denied",
      safeLastErrorSummary: "Permission denied",
    });

    await expect(
      listWorkspaceOutboxFailures(
        { workspaceId: "workspace_1", limit: 10 },
        { outbox },
      ),
    ).resolves.toMatchObject([
      {
        id: "event_dead",
        status: "dead_letter",
        lastErrorCode: "permission_denied",
      },
    ]);

    await expect(
      retryDeadLetterOutboxEvent(
        { workspaceId: "workspace_1", eventId: "event_dead" },
        { outbox, clock },
      ),
    ).resolves.toEqual({ status: "queued" });

    const retried = outbox.events.get("repo:dead");
    expect(retried).toMatchObject({
      status: "pending",
      attempts: 0,
    });
    expect(retried).not.toHaveProperty("lastErrorCode");
    expect(retried).not.toHaveProperty("safeLastErrorSummary");
  });
});
