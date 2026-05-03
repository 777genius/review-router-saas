import type { NewOutboxEvent, OutboxEvent } from "../../domain/outbox-event";

export interface OutboxEventRepositoryPort {
  enqueue(event: NewOutboxEvent): Promise<{ readonly created: boolean }>;
  recoverStaleProcessing(input: {
    readonly staleBefore: Date;
    readonly nextAttemptAt: Date;
    readonly limit: number;
    readonly errorCode: string;
    readonly safeErrorSummary: string;
  }): Promise<{ readonly recovered: number }>;
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
