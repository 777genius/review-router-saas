import type { NewOutboxEvent } from "../../domain/outbox-event.js";
import type { OutboxEventRepositoryPort } from "../ports/outbox-event-repository-port.js";

export async function enqueueOutboxEvent(
  event: NewOutboxEvent,
  dependencies: { readonly outbox: OutboxEventRepositoryPort },
): Promise<{ readonly created: boolean }> {
  return dependencies.outbox.enqueue(event);
}
