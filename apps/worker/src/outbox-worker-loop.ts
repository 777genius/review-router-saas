import type { ProcessOutboxBatchResult } from "@reviewrouter/features-outbox";
import type { Logger } from "@reviewrouter/platform-logger";

export type OutboxWorkerLoopResult = ProcessOutboxBatchResult & {
  readonly iterations: number;
  readonly errors: number;
};

export interface OutboxWorkerBatchProcessorPort {
  processBatch(): Promise<ProcessOutboxBatchResult>;
}

export type SleepPort = (
  milliseconds: number,
  signal: AbortSignal,
) => Promise<void>;

export type RunOutboxWorkerLoopInput = {
  readonly signal: AbortSignal;
  readonly idleDelayMs: number;
  readonly busyDelayMs: number;
  readonly errorDelayMs: number;
  readonly maxIterations?: number;
};

export async function runOutboxWorkerLoop(
  input: RunOutboxWorkerLoopInput,
  dependencies: {
    readonly processor: OutboxWorkerBatchProcessorPort;
    readonly logger: Logger;
    readonly sleep: SleepPort;
  },
): Promise<OutboxWorkerLoopResult> {
  const total = {
    iterations: 0,
    recoveredStale: 0,
    claimed: 0,
    processed: 0,
    retried: 0,
    deadLettered: 0,
    errors: 0,
  } satisfies OutboxWorkerLoopResult;

  while (shouldContinue(input, total.iterations)) {
    total.iterations += 1;
    try {
      const result = await dependencies.processor.processBatch();
      total.recoveredStale += result.recoveredStale;
      total.claimed += result.claimed;
      total.processed += result.processed;
      total.retried += result.retried;
      total.deadLettered += result.deadLettered;
      dependencies.logger.info(
        "ReviewRouter worker processed outbox batch",
        result,
      );

      const delayMs =
        result.claimed > 0 || result.recoveredStale > 0
          ? input.busyDelayMs
          : input.idleDelayMs;
      if (shouldContinue(input, total.iterations)) {
        await dependencies.sleep(delayMs, input.signal);
      }
    } catch (error) {
      total.errors += 1;
      dependencies.logger.error("ReviewRouter worker batch failed", {
        safeErrorSummary: safeWorkerErrorSummary(error),
      });
      if (shouldContinue(input, total.iterations)) {
        await dependencies.sleep(input.errorDelayMs, input.signal);
      }
    }
  }

  return total;
}

export const sleep: SleepPort = (milliseconds, signal) =>
  new Promise((resolve) => {
    if (signal.aborted || milliseconds <= 0) {
      resolve();
      return;
    }

    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });

export function safeWorkerErrorSummary(error: unknown): string {
  const message =
    error instanceof Error ? error.message : "unknown_worker_error";
  return redactSensitiveText(message).slice(0, 500);
}

function shouldContinue(
  input: RunOutboxWorkerLoopInput,
  iterations: number,
): boolean {
  return (
    !input.signal.aborted &&
    (input.maxIterations === undefined || iterations < input.maxIterations)
  );
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/(postgres(?:ql)?:\/\/)([^:@\s/]+):([^@\s/]+)@/gi, "$1<redacted>@")
    .replace(
      /\b(gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g,
      "<redacted>",
    )
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, "<redacted>")
    .replace(/([?&](?:access_)?token=)[^&\s]+/gi, "$1<redacted>");
}
