import { describe, expect, it } from "vitest";
import type { Clock } from "@reviewrouter/shared";
import { enqueueOutboxEvent } from "../application/use-cases/enqueue-outbox-event";
import { listWorkspaceOutboxFailures } from "../application/use-cases/list-workspace-outbox-failures";
import { processOutboxBatch } from "../application/use-cases/process-outbox-batch";
import { retryDeadLetterOutboxEvent } from "../application/use-cases/retry-dead-letter-outbox-event";
import {
  OutboxHandlerError,
  type OutboxClaimTerm,
  type OutboxClaimTransitionResult,
} from "../domain/outbox-event";
import { InMemoryOutboxEventRepository } from "../infrastructure/memory/in-memory-outbox-event-repository";

const now = new Date("2026-05-03T12:00:00.000Z");
const clock: Clock = { now: () => now };
const worker = { claimOwnerHash: "worker-a" };
const handler = {
  type: "installation.sync_requested",
  version: 1,
  handle: async () => undefined,
};

describe("outbox", () => {
  it("enqueues events idempotently", async () => {
    const outbox = new InMemoryOutboxEventRepository();
    const event = {
      type: handler.type,
      version: handler.version,
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
    await expect(
      enqueueOutboxEvent(
        { ...event, payload: { installationId: "different" } },
        { outbox },
      ),
    ).rejects.toThrow("outbox_idempotency_conflict");
  });

  it("processes matching event handlers with a fenced claim", async () => {
    const outbox = new InMemoryOutboxEventRepository();
    await seed(outbox, "installation:129:sync", handler.type, 1);

    await expect(
      processOutboxBatch(
        { limit: 10, handlers: [handler], ...worker },
        { outbox, clock },
      ),
    ).resolves.toEqual({
      recoveredStale: 0,
      claimed: 1,
      processed: 1,
      retried: 0,
      deadLettered: 0,
      staleClaims: 0,
    });
    expect(outbox.events.get("installation:129:sync")).toMatchObject({
      status: "processed",
      claimId: null,
      claimVersion: 1n,
    });
  });

  it("heartbeats a long-running handler without overlapping renewals", async () => {
    const outbox = new CountingHeartbeatOutbox();
    await seed(outbox, "heartbeat", handler.type, 1);

    await processOutboxBatch(
      {
        limit: 1,
        handlers: [
          {
            ...handler,
            handle: () => new Promise((resolve) => setTimeout(resolve, 25)),
          },
        ],
        heartbeatIntervalMs: 5,
        processingLeaseMs: 100,
        ...worker,
      },
      { outbox, clock },
    );

    expect(outbox.renewals).toBeGreaterThan(0);
    expect(outbox.maxConcurrentRenewals).toBe(1);
    expect(outbox.events.get("heartbeat")).toMatchObject({
      status: "processed",
    });
  });

  it("quarantines unknown owned versions without claiming disabled or unrelated events", async () => {
    const outbox = new InMemoryOutboxEventRepository();
    await seed(outbox, "unknown-version", handler.type, 99);
    await seed(outbox, "known-disabled", "org_ruleset.provision_requested", 1);
    await seed(outbox, "unrelated", "review.run.authorized", 1);

    const result = await processOutboxBatch(
      {
        limit: 10,
        handlers: [handler],
        knownHandlers: [
          handler,
          { type: "org_ruleset.provision_requested", version: 1 },
        ],
        ...worker,
      },
      { outbox, clock },
    );

    expect(result).toMatchObject({ claimed: 1, deadLettered: 1 });
    expect(outbox.events.get("unknown-version")).toMatchObject({
      status: "dead_letter",
      lastErrorCode: "unsupported_event_version",
    });
    expect(outbox.events.get("known-disabled")).toMatchObject({
      status: "pending",
      attempts: 0,
    });
    expect(outbox.events.get("unrelated")).toMatchObject({
      status: "pending",
      attempts: 0,
    });
  });

  it("retries retryable errors and dead-letters permanent errors", async () => {
    const outbox = new InMemoryOutboxEventRepository();
    await seed(outbox, "retryable", "repo.workflow_provision_requested", 1);
    const retrying = {
      type: "repo.workflow_provision_requested",
      version: 1,
      handle: async () => {
        throw new OutboxHandlerError("GitHub rate limit", "rate_limited", true);
      },
    };
    await expect(
      processOutboxBatch(
        { limit: 10, handlers: [retrying], ...worker },
        { outbox, clock },
      ),
    ).resolves.toMatchObject({ retried: 1, staleClaims: 0 });

    await seed(outbox, "permanent", retrying.type, 1);
    await expect(
      processOutboxBatch(
        {
          limit: 10,
          handlers: [
            {
              ...retrying,
              handle: async () => {
                throw new OutboxHandlerError(
                  "Permission denied",
                  "permission_denied",
                  false,
                );
              },
            },
          ],
          ...worker,
        },
        { outbox, clock },
      ),
    ).resolves.toMatchObject({ deadLettered: 1, staleClaims: 0 });
  });

  it("recovers an expired claim and allocates a never-reused takeover term", async () => {
    const outbox = new InMemoryOutboxEventRepository();
    await seed(outbox, "takeover", handler.type, 1);
    const [oldClaim] = await outbox.claimDue({
      limit: 1,
      now,
      claimOwnerHash: "worker-old",
      claimForMs: 1,
      availableHandlers: [handler],
      knownHandlers: [handler],
    });
    expect(oldClaim?.claimVersion).toBe(1n);

    const afterExpiry = new Date(now.getTime() + 2);
    await outbox.recoverStaleProcessing({
      now: afterExpiry,
      legacyStaleBefore: afterExpiry,
      nextAttemptAt: afterExpiry,
      limit: 1,
      errorCode: "processing_stale",
      safeErrorSummary: "expired",
    });
    const [newClaim] = await outbox.claimDue({
      limit: 1,
      now: afterExpiry,
      claimOwnerHash: "worker-new",
      claimForMs: 60_000,
      availableHandlers: [handler],
      knownHandlers: [handler],
    });
    expect(newClaim).toMatchObject({
      claimVersion: 2n,
      claimOwnerHash: "worker-new",
    });

    const oldTerm = {
      id: oldClaim!.id,
      claimId: oldClaim!.claimId!,
      claimVersion: oldClaim!.claimVersion!,
    };
    await expect(
      outbox.markProcessed({ ...oldTerm, processedAt: afterExpiry }),
    ).resolves.toEqual({ status: "stale_claim" });
    await expect(
      outbox.markRetry({
        ...oldTerm,
        nextAttemptAt: afterExpiry,
        errorCode: "old",
        safeErrorSummary: "old",
      }),
    ).resolves.toEqual({ status: "stale_claim" });
    await expect(
      outbox.markDeadLetter({
        ...oldTerm,
        deadLetteredAt: afterExpiry,
        errorCode: "old",
        safeErrorSummary: "old",
      }),
    ).resolves.toEqual({ status: "stale_claim" });
    await expect(
      outbox.markProcessed({
        id: newClaim!.id,
        claimId: newClaim!.claimId!,
        claimVersion: newClaim!.claimVersion!,
        processedAt: afterExpiry,
      }),
    ).resolves.toEqual({ status: "applied" });
  });

  it("lists and retries dead-letter events inside a workspace", async () => {
    const outbox = new InMemoryOutboxEventRepository();
    await outbox.enqueue({
      type: handler.type,
      version: 1,
      idempotencyKey: "dead",
      workspaceId: "workspace_1",
      payload: {},
      occurredAt: now,
      maxAttempts: 1,
    });
    await processOutboxBatch(
      {
        limit: 1,
        handlers: [
          {
            ...handler,
            handle: async () => {
              throw new OutboxHandlerError("denied", "denied", false);
            },
          },
        ],
        ...worker,
      },
      { outbox, clock },
    );

    await expect(
      listWorkspaceOutboxFailures(
        { workspaceId: "workspace_1", limit: 10 },
        { outbox },
      ),
    ).resolves.toMatchObject([{ id: "dead", status: "dead_letter" }]);
    await expect(
      retryDeadLetterOutboxEvent(
        { workspaceId: "workspace_1", eventId: "dead" },
        { outbox, clock },
      ),
    ).resolves.toEqual({ status: "queued" });
    expect(outbox.events.get("dead")).toMatchObject({
      status: "pending",
      attempts: 0,
    });
  });
});

async function seed(
  outbox: InMemoryOutboxEventRepository,
  idempotencyKey: string,
  type: string,
  version: number,
): Promise<void> {
  await outbox.enqueue({
    type,
    version,
    idempotencyKey,
    payload: {},
    occurredAt: now,
  });
}

class CountingHeartbeatOutbox extends InMemoryOutboxEventRepository {
  renewals = 0;
  maxConcurrentRenewals = 0;
  private concurrentRenewals = 0;

  override async renewClaim(
    input: OutboxClaimTerm,
  ): Promise<OutboxClaimTransitionResult> {
    this.renewals += 1;
    this.concurrentRenewals += 1;
    this.maxConcurrentRenewals = Math.max(
      this.maxConcurrentRenewals,
      this.concurrentRenewals,
    );
    await new Promise((resolve) => setTimeout(resolve, 2));
    try {
      return await super.renewClaim(input);
    } finally {
      this.concurrentRenewals -= 1;
    }
  }
}
