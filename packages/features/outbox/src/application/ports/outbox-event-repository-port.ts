import type {
  NewOutboxEvent,
  OutboxClaimTerm,
  OutboxClaimTransitionResult,
  OutboxEvent,
} from "../../domain/outbox-event";

export interface OutboxEventRepositoryPort {
  enqueue(event: NewOutboxEvent): Promise<{ readonly created: boolean }>;
  recoverStaleProcessing(input: {
    readonly now: Date;
    readonly legacyStaleBefore: Date;
    readonly nextAttemptAt: Date;
    readonly limit: number;
    readonly errorCode: string;
    readonly safeErrorSummary: string;
  }): Promise<{ readonly recovered: number }>;
  claimDue(input: {
    readonly limit: number;
    readonly now: Date;
    readonly claimOwnerHash: string;
    readonly claimForMs: number;
    readonly availableHandlers: readonly {
      readonly type: string;
      readonly version: number;
    }[];
    readonly knownHandlers: readonly {
      readonly type: string;
      readonly version: number;
    }[];
  }): Promise<readonly OutboxEvent[]>;
  renewClaim(input: OutboxClaimTerm): Promise<OutboxClaimTransitionResult>;
  markProcessed(input: {
    readonly id: string;
    readonly claimId: string;
    readonly claimVersion: bigint;
    readonly processedAt: Date;
  }): Promise<OutboxClaimTransitionResult>;
  markRetry(input: {
    readonly id: string;
    readonly claimId: string;
    readonly claimVersion: bigint;
    readonly nextAttemptAt: Date;
    readonly errorCode: string;
    readonly safeErrorSummary: string;
  }): Promise<OutboxClaimTransitionResult>;
  markDeadLetter(input: {
    readonly id: string;
    readonly claimId: string;
    readonly claimVersion: bigint;
    readonly deadLetteredAt: Date;
    readonly errorCode: string;
    readonly safeErrorSummary: string;
  }): Promise<OutboxClaimTransitionResult>;
}
