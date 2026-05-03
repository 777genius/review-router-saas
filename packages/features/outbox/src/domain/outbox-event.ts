import { z } from "zod";

export const outboxEventStatusSchema = z.enum([
  "pending",
  "processing",
  "retry_wait",
  "processed",
  "dead_letter",
]);

export type OutboxEventStatus = z.infer<typeof outboxEventStatusSchema>;

export const outboxEventSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  version: z.number().int().min(1),
  idempotencyKey: z.string().min(1),
  workspaceId: z.string().nullable(),
  repositoryId: z.string().nullable(),
  aggregateId: z.string().nullable(),
  payload: z.unknown(),
  status: outboxEventStatusSchema,
  attempts: z.number().int().min(0),
  maxAttempts: z.number().int().min(1).max(20),
  nextAttemptAt: z.date().nullable(),
  occurredAt: z.date(),
});

export type OutboxEvent = z.infer<typeof outboxEventSchema>;

export const outboxFailureStatusSchema = z.enum([
  "processing",
  "retry_wait",
  "dead_letter",
]);

export type OutboxFailureStatus = z.infer<typeof outboxFailureStatusSchema>;

export type OutboxFailure = {
  readonly id: string;
  readonly type: string;
  readonly version: number;
  readonly workspaceId: string | null;
  readonly repositoryId: string | null;
  readonly status: OutboxFailureStatus;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly nextAttemptAt: Date | null;
  readonly lastErrorCode: string | null;
  readonly safeLastErrorSummary: string | null;
  readonly occurredAt: Date;
  readonly updatedAt: Date;
};

export type NewOutboxEvent = {
  readonly type: string;
  readonly version: number;
  readonly idempotencyKey: string;
  readonly workspaceId?: string | null;
  readonly repositoryId?: string | null;
  readonly aggregateId?: string | null;
  readonly payload: unknown;
  readonly maxAttempts?: number;
  readonly occurredAt: Date;
};

export class OutboxHandlerError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "OutboxHandlerError";
  }
}

export type OutboxHandler = {
  readonly type: string;
  readonly version: number;
  handle(event: OutboxEvent): Promise<void>;
};

export type RetryDeadLetterOutboxEventResult =
  | { readonly status: "queued" }
  | { readonly status: "not_found" }
  | {
      readonly status: "not_dead_letter";
      readonly currentStatus: OutboxEventStatus;
    };

export const defaultOutboxProcessingStaleAfterMs = 15 * 60 * 1000;

export function outboxHandlerKey(type: string, version: number): string {
  return `${type}@v${version}`;
}

export function safeOutboxErrorSummary(error: unknown): {
  readonly code: string;
  readonly summary: string;
  readonly retryable: boolean;
} {
  if (error instanceof OutboxHandlerError) {
    return {
      code: error.code,
      summary: error.message.slice(0, 500),
      retryable: error.retryable,
    };
  }

  const message = error instanceof Error ? error.message : "unknown_error";
  return {
    code: "handler_error",
    summary: message.slice(0, 500),
    retryable: true,
  };
}

export function nextOutboxRetryAt(input: {
  readonly attempts: number;
  readonly now: Date;
}): Date {
  const delaySeconds = Math.min(300, 2 ** Math.max(0, input.attempts - 1) * 5);
  return new Date(input.now.getTime() + delaySeconds * 1000);
}
