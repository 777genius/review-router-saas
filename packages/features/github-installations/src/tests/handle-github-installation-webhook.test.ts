import { describe, expect, it } from "vitest";
import type { GitHubInstallationSnapshot } from "../domain/github-installation.js";
import type { GitHubInstallationRepositoryPort } from "../application/ports/github-installation-repository-port.js";
import type {
  WebhookDeliveryRecord,
  WebhookDeliveryRepositoryPort,
} from "../application/ports/webhook-delivery-repository-port.js";
import { handleGitHubInstallationWebhook } from "../application/use-cases/handle-github-installation-webhook.js";

class InMemoryInstallations implements GitHubInstallationRepositoryPort {
  public readonly snapshots = new Map<string, GitHubInstallationSnapshot>();

  async upsertInstallation(
    snapshot: GitHubInstallationSnapshot,
  ): Promise<void> {
    this.snapshots.set(snapshot.githubInstallationId, snapshot);
  }

  async markInstallationRemoved(githubInstallationId: string): Promise<void> {
    const existing = this.snapshots.get(githubInstallationId);
    if (existing) {
      this.snapshots.set(githubInstallationId, {
        ...existing,
        status: "removed",
      });
    }
  }
}

class InMemoryDeliveries implements WebhookDeliveryRepositoryPort {
  public readonly deliveries = new Map<string, WebhookDeliveryRecord>();

  async wasProcessed(deliveryId: string): Promise<boolean> {
    return this.deliveries.has(deliveryId);
  }

  async recordProcessed(delivery: WebhookDeliveryRecord): Promise<void> {
    this.deliveries.set(delivery.deliveryId, delivery);
  }
}

describe("handleGitHubInstallationWebhook", () => {
  it("upserts installation events and dedupes delivery ids", async () => {
    const installations = new InMemoryInstallations();
    const deliveries = new InMemoryDeliveries();
    const envelope = {
      deliveryId: "delivery-1",
      eventName: "installation",
      payload: {
        action: "created",
        installation: {
          id: 129,
          account: { login: "agent-teams-ai", type: "Organization" },
          repository_selection: "selected",
        },
      },
    };

    const first = await handleGitHubInstallationWebhook(envelope, {
      installations,
      deliveries,
    });
    const second = await handleGitHubInstallationWebhook(envelope, {
      installations,
      deliveries,
    });

    expect(first).toEqual({ processed: true, status: "active" });
    expect(second).toEqual({ processed: false });
    expect(installations.snapshots.get("129")).toMatchObject({
      accountLogin: "agent-teams-ai",
      status: "active",
    });
  });
});
