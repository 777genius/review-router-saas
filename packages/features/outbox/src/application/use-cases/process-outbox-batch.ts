import type { Clock } from "@reviewrouter/shared";
import {
  defaultOutboxProcessingStaleAfterMs,
  nextOutboxRetryAt,
  outboxHandlerKey,
  safeOutboxErrorSummary,
  type OutboxHandler,
} from "../../domain/outbox-event";
import type { OutboxEventRepositoryPort } from "../ports/outbox-event-repository-port";

export type ProcessOutboxBatchResult = {
  readonly recoveredStale: number;
  readonly claimed: number;
  readonly processed: number;
  readonly retried: number;
  readonly deadLettered: number;
};

export async function processOutboxBatch(
  input: {
    readonly limit: number;
    readonly handlers: readonly OutboxHandler[];
    readonly processingStaleAfterMs?: number;
  },
  dependencies: {
    readonly outbox: OutboxEventRepositoryPort;
    readonly clock: Clock;
  },
): Promise<ProcessOutboxBatchResult> {
  const now = dependencies.clock.now();
  const processingStaleAfterMs =
    input.processingStaleAfterMs ?? defaultOutboxProcessingStaleAfterMs;
  const recoveredStale = await dependencies.outbox.recoverStaleProcessing({
    staleBefore: new Date(now.getTime() - processingStaleAfterMs),
    nextAttemptAt: now,
    limit: input.limit,
    errorCode: "processing_stale",
    safeErrorSummary: `Processing exceeded ${processingStaleAfterMs}ms and was requeued for retry.`,
  });
  const events = await dependencies.outbox.claimDue({
    limit: input.limit,
    now,
  });
  const handlers = new Map(
    input.handlers.map((handler) => [
      outboxHandlerKey(handler.type, handler.version),
      handler,
    ]),
  );
  let processed = 0;
  let retried = 0;
  let deadLettered = 0;

  for (const event of events) {
    const handler = handlers.get(outboxHandlerKey(event.type, event.version));
    if (!handler) {
      await dependencies.outbox.markDeadLetter({
        id: event.id,
        deadLetteredAt: dependencies.clock.now(),
        errorCode: "unsupported_event_version",
        safeErrorSummary: `No handler registered for ${event.type}@v${event.version}`,
      });
      deadLettered += 1;
      continue;
    }

    try {
      await handler.handle(event);
      await dependencies.outbox.markProcessed({
        id: event.id,
        processedAt: dependencies.clock.now(),
      });
      processed += 1;
    } catch (error) {
      const safeError = safeOutboxErrorSummary(error);
      if (event.attempts >= event.maxAttempts || !safeError.retryable) {
        await dependencies.outbox.markDeadLetter({
          id: event.id,
          deadLetteredAt: dependencies.clock.now(),
          errorCode: safeError.code,
          safeErrorSummary: safeError.summary,
        });
        deadLettered += 1;
      } else {
        await dependencies.outbox.markRetry({
          id: event.id,
          nextAttemptAt: nextOutboxRetryAt({
            attempts: event.attempts,
            now: dependencies.clock.now(),
          }),
          errorCode: safeError.code,
          safeErrorSummary: safeError.summary,
        });
        retried += 1;
      }
    }
  }

  return {
    recoveredStale: recoveredStale.recovered,
    claimed: events.length,
    processed,
    retried,
    deadLettered,
  };
}
