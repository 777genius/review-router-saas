import type {
  SubscriptionWorker,
  SubscriptionWorkerHealth,
  SubscriptionWorkerPrewarmResult,
  SubscriptionWorkerState,
  WorkerPoolHealth,
  WorkerPoolOptions,
  WorkerPoolRunOptions,
  WorkerPoolStats,
} from "./types";
import { SubscriptionWorkerError } from "./errors";

type Slot<Job, Result> = {
  readonly index: number;
  readonly worker: SubscriptionWorker<Job, Result>;
  busy: boolean;
};

type QueuedRun<Job, Result> = {
  readonly job: Job;
  readonly options: WorkerPoolRunOptions;
  readonly resolve: (result: Result) => void;
  readonly reject: (error: unknown) => void;
};

const defaultMaxQueueSize = 1024;
const defaultShutdownTimeoutMs = 30_000;

export class BoundedSubscriptionWorkerPool<Job, Result> {
  private readonly slots: Slot<Job, Result>[] = [];
  private readonly queue: QueuedRun<Job, Result>[] = [];
  private poolState: SubscriptionWorkerState = "created";
  private completedCount = 0;
  private failedCount = 0;
  private inFlightCount = 0;

  constructor(private readonly options: WorkerPoolOptions<Job, Result>) {
    if (!options.poolId.trim()) {
      throw new SubscriptionWorkerError(
        "subscription_worker_pool_empty",
        "Worker pool id is required.",
      );
    }
    if (!Number.isInteger(options.slots) || options.slots <= 0) {
      throw new SubscriptionWorkerError(
        "subscription_worker_pool_empty",
        "Worker pool must have at least one slot.",
      );
    }
  }

  get poolId(): string {
    return this.options.poolId;
  }

  get state(): SubscriptionWorkerState {
    return this.poolState;
  }

  async start(): Promise<void> {
    if (this.poolState === "disposed") {
      throw new SubscriptionWorkerError(
        "subscription_worker_disposed",
        "Worker pool has been disposed.",
      );
    }
    if (this.poolState !== "created" && this.poolState !== "failed") {
      throw new SubscriptionWorkerError(
        "subscription_worker_already_started",
        "Worker pool is already started.",
      );
    }

    this.poolState = "starting";
    try {
      for (let index = 0; index < this.options.slots; index += 1) {
        const workerId = `${this.options.poolId}:slot-${index + 1}`;
        const worker = this.options.workerFactory({
          slotIndex: index,
          workerId,
        });
        await worker.start();
        this.slots.push({ index, worker, busy: false });
      }
      this.poolState = "started";
      if (this.options.prewarmOnStart) {
        await this.prewarm();
      }
      this.emit("subscription_worker_pool.started");
    } catch (error) {
      this.poolState = "failed";
      await this.disposeStartedSlots();
      throw new SubscriptionWorkerError(
        "subscription_worker_start_failed",
        "Worker pool failed to start.",
        { cause: error },
      );
    }
  }

  async prewarm(): Promise<readonly SubscriptionWorkerPrewarmResult[]> {
    this.assertRunnable();
    this.poolState = "prewarming";
    try {
      const results = await Promise.all(
        this.slots.map((slot) => slot.worker.prewarm()),
      );
      this.poolState = "ready";
      this.emit("subscription_worker_pool.prewarmed");
      return results;
    } catch (error) {
      this.poolState = "failed";
      throw new SubscriptionWorkerError(
        "subscription_worker_prewarm_failed",
        "Worker pool failed to prewarm.",
        { cause: error },
      );
    }
  }

  run(job: Job, options: WorkerPoolRunOptions = {}): Promise<Result> {
    this.assertRunnable();
    if (this.poolState === "draining") {
      return Promise.reject(
        new SubscriptionWorkerError(
          "subscription_worker_pool_draining",
          "Worker pool is draining and does not accept new work.",
        ),
      );
    }

    const available = this.slots.find((slot) => !slot.busy);
    if (available) {
      return this.runOnSlot(available, job, options);
    }

    if (
      this.queue.length >= (this.options.maxQueueSize ?? defaultMaxQueueSize)
    ) {
      return Promise.reject(
        new SubscriptionWorkerError(
          "subscription_worker_pool_queue_full",
          "Worker pool queue is full.",
        ),
      );
    }

    return new Promise((resolve, reject) => {
      const abort = () => {
        const index = this.queue.findIndex((item) => item.reject === reject);
        if (index >= 0) this.queue.splice(index, 1);
        reject(new Error("subscription_worker_pool_run_aborted"));
      };
      options.abortSignal?.addEventListener("abort", abort, { once: true });
      this.queue.push({
        job,
        options,
        resolve: (result) => {
          options.abortSignal?.removeEventListener("abort", abort);
          resolve(result);
        },
        reject: (error) => {
          options.abortSignal?.removeEventListener("abort", abort);
          reject(error);
        },
      });
      this.drainQueue();
    });
  }

  async health(): Promise<WorkerPoolHealth> {
    const slotHealth = await Promise.all(
      this.slots.map((slot) => safeHealth(slot.worker)),
    );
    const unhealthy = slotHealth.filter(
      (health) => health.status === "unhealthy",
    );
    const degraded = slotHealth.filter(
      (health) => health.status === "degraded",
    );
    const status =
      unhealthy.length > 0
        ? "unhealthy"
        : degraded.length > 0 || this.poolState === "failed"
          ? "degraded"
          : "healthy";
    return {
      poolId: this.options.poolId,
      status,
      state: this.poolState,
      checkedAt: new Date(),
      slots: slotHealth,
      queued: this.queue.length,
      inFlight: this.inFlightCount,
    };
  }

  stats(): WorkerPoolStats {
    return {
      poolId: this.options.poolId,
      state: this.poolState,
      slots: this.slots.length,
      queued: this.queue.length,
      inFlight: this.inFlightCount,
      completed: this.completedCount,
      failed: this.failedCount,
    };
  }

  async dispose(): Promise<void> {
    if (this.poolState === "disposed") return;
    this.poolState = "draining";
    const deadline =
      Date.now() + (this.options.shutdownTimeoutMs ?? defaultShutdownTimeoutMs);
    while (this.inFlightCount > 0 && Date.now() < deadline) {
      await delay(25);
    }
    if (this.inFlightCount > 0) {
      this.rejectQueued(
        new SubscriptionWorkerError(
          "subscription_worker_shutdown_timeout",
          "Worker pool shutdown timed out with in-flight work.",
        ),
      );
    } else {
      this.rejectQueued(
        new SubscriptionWorkerError(
          "subscription_worker_pool_draining",
          "Worker pool was disposed before queued work started.",
        ),
      );
    }
    await this.disposeStartedSlots();
    this.poolState = "disposed";
    this.emit("subscription_worker_pool.disposed");
  }

  private runOnSlot(
    slot: Slot<Job, Result>,
    job: Job,
    options: WorkerPoolRunOptions,
  ): Promise<Result> {
    slot.busy = true;
    this.inFlightCount += 1;
    return slot.worker
      .run(job, options.abortSignal ? { abortSignal: options.abortSignal } : {})
      .then((result) => {
        this.completedCount += 1;
        return result;
      })
      .catch((error) => {
        this.failedCount += 1;
        throw new SubscriptionWorkerError(
          "subscription_worker_pool_slot_failed",
          "Worker pool slot failed to run a task.",
          {
            cause: error,
            details: {
              workerId: slot.worker.workerId,
              slotIndex: String(slot.index),
            },
          },
        );
      })
      .finally(() => {
        slot.busy = false;
        this.inFlightCount -= 1;
        this.drainQueue();
      });
  }

  private drainQueue(): void {
    if (this.poolState === "draining" || this.poolState === "disposed") return;
    for (const slot of this.slots) {
      if (slot.busy) continue;
      const next = this.queue.shift();
      if (!next) return;
      void this.runOnSlot(slot, next.job, next.options)
        .then(next.resolve)
        .catch(next.reject);
    }
  }

  private assertRunnable(): void {
    if (this.poolState === "disposed") {
      throw new SubscriptionWorkerError(
        "subscription_worker_disposed",
        "Worker pool has been disposed.",
      );
    }
    if (this.slots.length === 0) {
      throw new SubscriptionWorkerError(
        "subscription_worker_not_started",
        "Worker pool has not been started.",
      );
    }
  }

  private rejectQueued(error: unknown): void {
    const queued = this.queue.splice(0);
    for (const item of queued) item.reject(error);
  }

  private async disposeStartedSlots(): Promise<void> {
    const slots = this.slots.splice(0);
    const results = await Promise.allSettled(
      slots.map((slot) => slot.worker.dispose()),
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (rejected.length > 0) {
      throw new AggregateError(
        rejected.map((result) => result.reason),
        "subscription_worker_pool_dispose_failed",
      );
    }
  }

  private emit(name: string): void {
    this.options.observability?.emit({
      name,
      metadata: {
        poolId: this.options.poolId,
        slots: String(this.options.slots),
      },
    });
  }
}

async function safeHealth<Job, Result>(
  worker: SubscriptionWorker<Job, Result>,
): Promise<SubscriptionWorkerHealth> {
  try {
    return await worker.health();
  } catch (error) {
    return {
      status: "unhealthy",
      state: "failed",
      checkedAt: new Date(),
      failures: [
        {
          code: "subscription_worker_health_failed",
          safeMessage:
            error instanceof Error ? error.message : "Worker health failed.",
        },
      ],
      warnings: [],
    };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
