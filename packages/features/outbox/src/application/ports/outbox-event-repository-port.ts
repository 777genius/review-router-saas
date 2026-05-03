import type { NewOutboxEvent, OutboxEvent } from "../../domain/outbox-event.js";

export interface OutboxEventRepositoryPort {
  enqueue(event: NewOutboxEvent): Promise<{ readonly created: boolean }>;
  claimDue(input: {
    readonly limit: number;
    readonly now: Date;
  }): Promise<readonly OutboxEvent[]>;
  markProcessed(input: {
    readonly id: string;
    readonly processedAt: Date;
  }): Promise<void>;
  markRetry(input: {
    readonly id: string;
    readonly nextAttemptAt: Date;
    readonly errorCode: string;
    readonly safeErrorSummary: string;
  }): Promise<void>;
  markDeadLetter(input: {
    readonly id: string;
    readonly deadLetteredAt: Date;
    readonly errorCode: string;
    readonly safeErrorSummary: string;
  }): Promise<void>;
}
