import type { Clock } from "@reviewrouter/shared";
import type { RetryDeadLetterOutboxEventResult } from "../../domain/outbox-event";
import type { OutboxMaintenanceRepositoryPort } from "../ports/outbox-maintenance-repository-port";

export async function retryDeadLetterOutboxEvent(
  input: { readonly workspaceId: string; readonly eventId: string },
  dependencies: {
    readonly outbox: OutboxMaintenanceRepositoryPort;
    readonly clock: Clock;
  },
): Promise<RetryDeadLetterOutboxEventResult> {
  return dependencies.outbox.retryDeadLetter({
    workspaceId: input.workspaceId,
    eventId: input.eventId,
    retriedAt: dependencies.clock.now(),
  });
}
