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
