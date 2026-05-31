import { describe, expect, it } from "vitest";
import { BoundedSubscriptionWorkerPool } from "@reviewrouter/subscription-runtime-worker-core";
import {
  InMemorySubscriptionTaskQueue,
  SubscriptionQueueProcessor,
  computeBackoffDelayMs,
} from "../index";
import type { SubscriptionWorker } from "@reviewrouter/subscription-runtime-worker-core";

describe("subscription queue core", () => {
  it("deduplicates enqueue by idempotency key", async () => {
    const queue = new InMemorySubscriptionTaskQueue<string, string>({
      queueId: "test",
    });

    const first = await queue.enqueue({
      job: "a",
      idempotencyKey: "idem",
    });
    const second = await queue.enqueue({
      job: "b",
      idempotencyKey: "idem",
    });

    expect(second).toEqual({
      status: "idempotent_replay",
      taskId: first.taskId,
    });
  });

  it("claims, retries with backoff, then completes", async () => {
    const queue = new InMemorySubscriptionTaskQueue<string, string>({
      queueId: "test",
    });
    await queue.enqueue({ taskId: "task-1", job: "job", maxAttempts: 2 });
    const claim = await queue.claim({ leaseTtlMs: 60_000 });
    expect(claim?.task.taskId).toBe("task-1");
    if (!claim) throw new Error("missing_claim");

    await expect(
      queue.fail({
        taskId: claim.task.taskId,
        leaseId: claim.leaseId,
        error: new Error("boom"),
        retryPolicy: {
          maxAttempts: 2,
          baseDelayMs: 10,
          maxDelayMs: 10,
          jitterRatio: 0,
        },
        now: new Date("2026-05-31T00:00:00.000Z"),
      }),
    ).resolves.toMatchObject({
      status: "retry_scheduled",
      nextAttempt: 2,
    });

    const retry = await queue.claim({
      leaseTtlMs: 60_000,
      now: new Date("2026-05-31T00:00:00.010Z"),
    });
    expect(retry?.task.attempt).toBe(2);
    if (!retry) throw new Error("missing_retry");
    await queue.complete({
      taskId: retry.task.taskId,
      leaseId: retry.leaseId,
      result: "ok",
    });
    await expect(queue.size({ includeDelayed: true })).resolves.toBe(0);
  });

  it("processes queued work through a bounded worker pool", async () => {
    const queue = new InMemorySubscriptionTaskQueue<string, string>({
      queueId: "test",
    });
    await queue.enqueue({ job: "a" });
    await queue.enqueue({ job: "b" });
    const pool = new BoundedSubscriptionWorkerPool<string, string>({
      poolId: "pool",
      slots: 2,
      workerFactory: ({ workerId }) => new EchoWorker(workerId),
    });
    await pool.start();
    const processor = new SubscriptionQueueProcessor({
      queue,
      workerPool: pool,
      idleDelayMs: 5,
    });
    processor.start();

    await eventually(async () => {
      expect(processor.stats().completed).toBe(2);
    });
    await processor.stop();
    await pool.dispose();
  });

  it("computes bounded exponential backoff", () => {
    expect(
      computeBackoffDelayMs({
        attempt: 3,
        policy: {
          maxAttempts: 5,
          baseDelayMs: 100,
          maxDelayMs: 250,
          jitterRatio: 0,
        },
      }),
    ).toBe(250);
  });
});

class EchoWorker implements SubscriptionWorker<string, string> {
  state = "created" as const;

  constructor(readonly workerId: string) {}

  async start(): Promise<void> {}

  async prewarm() {
    return { status: "ready" as const, warmedAt: new Date(), warnings: [] };
  }

  async run(job: string): Promise<string> {
    return `ok:${job}`;
  }

  async health() {
    return {
      status: "healthy" as const,
      state: this.state,
      checkedAt: new Date(),
      warnings: [],
    };
  }

  async dispose(): Promise<void> {}
}

async function eventually(
  assertion: () => Promise<void> | void,
): Promise<void> {
  const deadline = Date.now() + 1_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}
