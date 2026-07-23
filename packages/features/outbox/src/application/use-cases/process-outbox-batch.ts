import type { Clock } from "@reviewrouter/shared";
import {
  defaultOutboxProcessingStaleAfterMs,
  nextOutboxRetryAt,
  outboxHandlerKey,
  safeOutboxErrorSummary,
  type OutboxEvent,
  type OutboxHandler,
  type OutboxHandlerDefinition,
} from "../../domain/outbox-event";
import type { OutboxEventRepositoryPort } from "../ports/outbox-event-repository-port";

export type ProcessOutboxBatchResult = {
  readonly recoveredStale: number;
  readonly claimed: number;
  readonly processed: number;
  readonly retried: number;
  readonly deadLettered: number;
  readonly staleClaims: number;
};

export async function processOutboxBatch(
  input: {
    readonly limit: number;
    readonly handlers: readonly OutboxHandler[];
    readonly knownHandlers?: readonly OutboxHandlerDefinition[];
    readonly claimOwnerHash: string;
    readonly processingLeaseMs?: number;
    readonly heartbeatIntervalMs?: number;
    readonly takeoverEnabled?: boolean;
  },
  dependencies: {
    readonly outbox: OutboxEventRepositoryPort;
    readonly clock: Clock;
  },
): Promise<ProcessOutboxBatchResult> {
  const now = dependencies.clock.now();
  const processingLeaseMs =
    input.processingLeaseMs ?? defaultOutboxProcessingStaleAfterMs;
  const recoveredStale = input.takeoverEnabled
    ? await dependencies.outbox.recoverStaleProcessing({
        now,
        legacyStaleBefore: new Date(now.getTime() - processingLeaseMs),
        nextAttemptAt: now,
        limit: input.limit,
        errorCode: "processing_stale",
        safeErrorSummary: `Processing claim expired after ${processingLeaseMs}ms and was requeued for retry.`,
      })
    : { recovered: 0 };
  const events = await dependencies.outbox.claimDue({
    limit: input.limit,
    now,
    claimOwnerHash: input.claimOwnerHash,
    claimForMs: processingLeaseMs,
    availableHandlers: input.handlers,
    knownHandlers: input.knownHandlers ?? input.handlers,
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
  let staleClaims = 0;

  for (const event of events) {
    const claim = requireClaim(event);
    const handler = handlers.get(outboxHandlerKey(event.type, event.version));
    if (!handler) {
      const result = await dependencies.outbox.markDeadLetter({
        id: event.id,
        claimId: claim.claimId,
        claimVersion: claim.claimVersion,
        deadLetteredAt: dependencies.clock.now(),
        errorCode: "unsupported_event_version",
        safeErrorSummary: `No handler registered for ${event.type}@v${event.version}`,
      });
      if (result.status === "applied") deadLettered += 1;
      else staleClaims += 1;
      continue;
    }

    try {
      const heartbeat = startClaimHeartbeat({
        outbox: dependencies.outbox,
        clock: dependencies.clock,
        claim: {
          ...claim,
          claimOwnerHash: event.claimOwnerHash!,
        },
        processingLeaseMs,
        heartbeatIntervalMs:
          input.heartbeatIntervalMs ?? Math.max(1_000, processingLeaseMs / 3),
      });
      try {
        await handler.handle(event);
      } finally {
        await heartbeat.stop();
      }
      if (heartbeat.isStale()) {
        staleClaims += 1;
        continue;
      }
      const result = await dependencies.outbox.markProcessed({
        id: event.id,
        claimId: claim.claimId,
        claimVersion: claim.claimVersion,
        processedAt: dependencies.clock.now(),
      });
      if (result.status === "applied") processed += 1;
      else staleClaims += 1;
    } catch (error) {
      const safeError = safeOutboxErrorSummary(error);
      if (event.attempts >= event.maxAttempts || !safeError.retryable) {
        const result = await dependencies.outbox.markDeadLetter({
          id: event.id,
          claimId: claim.claimId,
          claimVersion: claim.claimVersion,
          deadLetteredAt: dependencies.clock.now(),
          errorCode: safeError.code,
          safeErrorSummary: safeError.summary,
        });
        if (result.status === "applied") deadLettered += 1;
        else staleClaims += 1;
      } else {
        const result = await dependencies.outbox.markRetry({
          id: event.id,
          claimId: claim.claimId,
          claimVersion: claim.claimVersion,
          nextAttemptAt: nextOutboxRetryAt({
            attempts: event.attempts,
            now: dependencies.clock.now(),
          }),
          errorCode: safeError.code,
          safeErrorSummary: safeError.summary,
        });
        if (result.status === "applied") retried += 1;
        else staleClaims += 1;
      }
    }
  }

  return {
    recoveredStale: recoveredStale.recovered,
    claimed: events.length,
    processed,
    retried,
    deadLettered,
    staleClaims,
  };
}

function requireClaim(event: OutboxEvent): {
  readonly claimId: string;
  readonly claimVersion: bigint;
} {
  if (!event.claimId || event.claimVersion === null) {
    throw new Error("outbox_claim_term_missing");
  }
  return { claimId: event.claimId, claimVersion: event.claimVersion };
}

function startClaimHeartbeat(input: {
  readonly outbox: OutboxEventRepositoryPort;
  readonly clock: Clock;
  readonly claim: {
    readonly claimId: string;
    readonly claimVersion: bigint;
    readonly claimOwnerHash: string;
  };
  readonly processingLeaseMs: number;
  readonly heartbeatIntervalMs: number;
}): { readonly stop: () => Promise<void>; readonly isStale: () => boolean } {
  let stopped = false;
  let stale = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let currentRenewal = Promise.resolve();

  const renew = () => {
    if (stopped) return;
    currentRenewal = (async () => {
      const result = await input.outbox.renewClaim({
        ...input.claim,
        claimUntil: new Date(
          input.clock.now().getTime() + input.processingLeaseMs,
        ),
      });
      stale ||= result.status === "stale_claim";
    })()
      .catch(() => {
        // A transient heartbeat failure cannot authorize an unfenced completion.
        stale = true;
      })
      .finally(() => {
        if (!stopped && !stale) schedule();
      });
  };

  const schedule = () => {
    timer = setTimeout(renew, input.heartbeatIntervalMs);
    timer.unref?.();
  };

  schedule();

  return {
    isStale: () => stale,
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await currentRenewal;
    },
  };
}
