import type { BoundedSubscriptionWorkerPool } from "@reviewrouter/subscription-runtime-worker-core";
import type { BullLikeJob } from "./bull-types";

export type BullSubscriptionProcessorOptions<Job, Result> = {
  readonly workerPool: Pick<
    BoundedSubscriptionWorkerPool<Job, Result>,
    "run" | "stats"
  >;
  readonly mapJob?: (job: BullLikeJob<Job>) => Job;
};

export function createBullSubscriptionProcessor<Job, Result>(
  options: BullSubscriptionProcessorOptions<Job, Result>,
): (job: BullLikeJob<Job>) => Promise<Result> {
  return async (job) => {
    const task = options.mapJob ? options.mapJob(job) : job.data;
    return options.workerPool.run(
      task,
      job.id === undefined ? {} : { idempotencyKey: String(job.id) },
    );
  };
}
