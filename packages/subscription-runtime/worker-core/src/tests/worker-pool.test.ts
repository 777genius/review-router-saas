import { describe, expect, it } from "vitest";
import {
  BoundedSubscriptionWorkerPool,
  type SubscriptionWorker,
  type SubscriptionWorkerPrewarmResult,
  type SubscriptionWorkerState,
} from "../index";

describe("BoundedSubscriptionWorkerPool", () => {
  it("runs no more than the configured slot count concurrently", async () => {
    let active = 0;
    let maxActive = 0;
    const pool = new BoundedSubscriptionWorkerPool<string, string>({
      poolId: "test-pool",
      slots: 2,
      workerFactory: ({ workerId }) =>
        new FakeWorker(workerId, async (job) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await delay(20);
          active -= 1;
          return `done:${job}`;
        }),
    });

    await pool.start();
    const results = await Promise.all([
      pool.run("a"),
      pool.run("b"),
      pool.run("c"),
      pool.run("d"),
    ]);
    await pool.dispose();

    expect(results).toEqual(["done:a", "done:b", "done:c", "done:d"]);
    expect(maxActive).toBe(2);
    expect(pool.stats()).toMatchObject({
      completed: 4,
      failed: 0,
      state: "disposed",
    });
  });

  it("rejects work when the bounded queue is full", async () => {
    const pool = new BoundedSubscriptionWorkerPool<string, string>({
      poolId: "bounded",
      slots: 1,
      maxQueueSize: 1,
      workerFactory: ({ workerId }) =>
        new FakeWorker(workerId, async (job) => {
          await delay(50);
          return job;
        }),
    });

    await pool.start();
    const first = pool.run("first");
    const queued = pool.run("queued");
    await expect(pool.run("overflow")).rejects.toThrow(
      "Worker pool queue is full.",
    );
    await expect(first).resolves.toBe("first");
    await expect(queued).resolves.toBe("queued");
    await pool.dispose();
  });

  it("prewarms all slots and aggregates health", async () => {
    const pool = new BoundedSubscriptionWorkerPool<string, string>({
      poolId: "health",
      slots: 3,
      prewarmOnStart: true,
      workerFactory: ({ workerId }) => new FakeWorker(workerId),
    });

    await pool.start();
    const health = await pool.health();
    await pool.dispose();

    expect(health).toMatchObject({
      status: "healthy",
      slots: [
        { status: "healthy" },
        { status: "healthy" },
        { status: "healthy" },
      ],
    });
  });
});

class FakeWorker implements SubscriptionWorker<string, string> {
  state: SubscriptionWorkerState = "created";
  prewarmed = false;

  constructor(
    readonly workerId: string,
    private readonly handler: (job: string) => Promise<string> = async (job) =>
      `ok:${job}`,
  ) {}

  async start(): Promise<void> {
    this.state = "started";
  }

  async prewarm(): Promise<SubscriptionWorkerPrewarmResult> {
    this.prewarmed = true;
    this.state = "ready";
    return {
      status: "ready",
      warmedAt: new Date(),
      warnings: [],
    };
  }

  async run(job: string): Promise<string> {
    return this.handler(job);
  }

  async health() {
    return {
      status: "healthy" as const,
      state: this.state,
      checkedAt: new Date(),
      warnings: [],
    };
  }

  async dispose(): Promise<void> {
    this.state = "disposed";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
