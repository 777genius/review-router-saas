import type { OutboxEventRepositoryPort } from "@reviewrouter/features-outbox";
import type {
  InstallationSyncRequest,
  InstallationSyncRequestPort,
} from "../../application/ports/installation-sync-request-port.js";

export class OutboxInstallationSyncRequester implements InstallationSyncRequestPort {
  constructor(private readonly outbox: OutboxEventRepositoryPort) {}

  async requestInstallationSync(
    input: InstallationSyncRequest,
  ): Promise<{ readonly created: boolean }> {
    return this.outbox.enqueue({
      type: "installation.sync_requested",
      version: 1,
      idempotencyKey: `installation:${input.githubInstallationId}:sync:${input.deliveryId}`,
      aggregateId: `github-installation:${input.githubInstallationId}`,
      payload: {
        installationId: input.githubInstallationId,
        reason: input.reason,
      },
      maxAttempts: 5,
      occurredAt: input.occurredAt,
    });
  }
}
