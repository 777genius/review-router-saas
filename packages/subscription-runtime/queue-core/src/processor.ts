import type { BoundedSubscriptionWorkerPool } from "@reviewrouter/subscription-runtime-worker-core";
import type {
  QueueProcessorState,
  QueueProcessorStats,
  SubscriptionRetryPolicy,
  SubscriptionTaskQueuePort,
} from "./types";
import { defaultSubscriptionRetryPolicy } from "./validation";
import { SubscriptionQueueError } from "./errors";

export type SubscriptionQueueProcessorOptions<Job, Result> = {
  readonly queue: SubscriptionTaskQueuePort<Job, Result>;
  readonly workerPool: Pick<
    BoundedSubscriptionWorkerPool<Job, Result>,
    "run" | "stats"
  >;
  readonly retryPolicy?: SubscriptionRetryPolicy;
  readonly leaseTtlMs?: number;
  readonly idleDelayMs?: number;
  readonly abortSignal?: AbortSignal;
};

export class SubscriptionQueueProcessor<Job, Result> {
  private processorState: QueueProcessorState = "created";
  private loop: Promise<void> | null = null;
  private stopController: AbortController | null = null;
  private readonly counters = {
    claimed: 0,
    completed: 0,
    retried: 0,
    deadLettered: 0,
    failed: 0,
  };

  constructor(
    private readonly options: SubscriptionQueueProcessorOptions<Job, Result>,
  ) {}

  get state(): QueueProcessorState {
    return this.processorState;
  }

  start(): void {
    if (this.processorState === "running") return;
    this.stopController = new AbortController();
    this.processorState = "running";
    this.loop = this.runLoop(this.stopController.signal);
  }

  async stop(): Promise<void> {
    if (this.processorState === "created") {
      this.processorState = "stopped";
      return;
    }
    if (!this.stopController) {
      throw new SubscriptionQueueError(
        "subscription_queue_processor_not_started",
        "Queue processor has not been started.",
      );
    }
    this.processorState = "stopping";
    this.stopController.abort();
    await this.loop;
    this.processorState = "stopped";
  }

  stats(): QueueProcessorStats {
    return {
      state: this.processorState,
      ...this.counters,
    };
  }

  private async runLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && !this.options.abortSignal?.aborted) {
      const claimed = await this.options.queue.claim({
        leaseTtlMs: this.options.leaseTtlMs ?? 10 * 60_000,
      });
      if (!claimed) {
        await delay(this.options.idleDelayMs ?? 250, signal);
        continue;
      }
      this.counters.claimed += 1;
      try {
        const result = await this.options.workerPool.run(claimed.task.job, {
          ...(claimed.task.idempotencyKey
            ? { idempotencyKey: claimed.task.idempotencyKey }
            : {}),
          abortSignal: signal,
        });
        await this.options.queue.complete({
          taskId: claimed.task.taskId,
          leaseId: claimed.leaseId,
          result,
        });
        this.counters.completed += 1;
      } catch (error) {
        this.counters.failed += 1;
        const failed = await this.options.queue.fail({
          taskId: claimed.task.taskId,
          leaseId: claimed.leaseId,
          error,
          retryPolicy:
            this.options.retryPolicy ?? defaultSubscriptionRetryPolicy,
        });
        if (failed.status === "retry_scheduled") {
          this.counters.retried += 1;
        } else {
          this.counters.deadLettered += 1;
        }
      }
    }
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
