import type { NewOutboxEvent } from "../../domain/outbox-event";
import type { OutboxEventRepositoryPort } from "../ports/outbox-event-repository-port";

export async function enqueueOutboxEvent(
  event: NewOutboxEvent,
  dependencies: { readonly outbox: OutboxEventRepositoryPort },
): Promise<{ readonly created: boolean }> {
  return dependencies.outbox.enqueue(event);
}
