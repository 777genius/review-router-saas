import type {
  OutboxFailure,
  RetryDeadLetterOutboxEventResult,
} from "../../domain/outbox-event";

export interface OutboxMaintenanceRepositoryPort {
  listWorkspaceFailures(input: {
    readonly workspaceId: string;
    readonly limit: number;
  }): Promise<readonly OutboxFailure[]>;

  retryDeadLetter(input: {
    readonly workspaceId: string;
    readonly eventId: string;
    readonly retriedAt: Date;
  }): Promise<RetryDeadLetterOutboxEventResult>;
}
