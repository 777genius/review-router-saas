import { describe, expect, it } from "vitest";
import type { GitHubInstallationSnapshot } from "../domain/github-installation";
import type { GitHubInstallationRepositoryPort } from "../application/ports/github-installation-repository-port";
import type {
  InstallationSyncRequest,
  InstallationSyncRequestPort,
} from "../application/ports/installation-sync-request-port";
import type {
  InstallationWorkspaceOwnerGrant,
  InstallationWorkspaceOwnerGrantPort,
} from "../application/ports/installation-workspace-owner-grant-port";
import type {
  WebhookDeliveryRecord,
  WebhookDeliveryRepositoryPort,
  WebhookDeliveryStatus,
} from "../application/ports/webhook-delivery-repository-port";
import { handleGitHubInstallationWebhook } from "../application/use-cases/handle-github-installation-webhook";
import type { Clock } from "@reviewrouter/shared";

class InMemoryInstallations implements GitHubInstallationRepositoryPort {
  public readonly snapshots = new Map<string, GitHubInstallationSnapshot>();
  public readonly removed = new Set<string>();

  async upsertInstallation(
    snapshot: GitHubInstallationSnapshot,
  ): Promise<void> {
    this.snapshots.set(snapshot.githubInstallationId, snapshot);
  }

  async markInstallationRemoved(githubInstallationId: string): Promise<void> {
    this.removed.add(githubInstallationId);
    const existing = this.snapshots.get(githubInstallationId);
    if (existing) {
      this.snapshots.set(githubInstallationId, {
        ...existing,
        status: "removed",
      });
    }
  }
}

class InMemorySyncRequests implements InstallationSyncRequestPort {
  public readonly requests: InstallationSyncRequest[] = [];

  async requestInstallationSync(
    input: InstallationSyncRequest,
  ): Promise<{ readonly created: boolean }> {
    this.requests.push(input);
    return { created: true };
  }
}

class InMemoryOwnerGrants implements InstallationWorkspaceOwnerGrantPort {
  public readonly grants: InstallationWorkspaceOwnerGrant[] = [];

  async grantInstallationActorOwner(
    grant: InstallationWorkspaceOwnerGrant,
  ): Promise<void> {
    this.grants.push(grant);
  }
}

class InMemoryDeliveries implements WebhookDeliveryRepositoryPort {
  public readonly deliveries = new Map<
    string,
    WebhookDeliveryRecord & {
      readonly status: WebhookDeliveryStatus;
      readonly errorSummary?: string;
    }
  >();

  async tryStartProcessing(delivery: WebhookDeliveryRecord): Promise<boolean> {
    if (this.deliveries.has(delivery.deliveryId)) {
      return false;
    }
    this.deliveries.set(delivery.deliveryId, {
      ...delivery,
      status: "processing",
    });
    return true;
  }

  async markProcessed(deliveryId: string): Promise<void> {
    const existing = this.deliveries.get(deliveryId);
    if (existing) {
      this.deliveries.set(deliveryId, { ...existing, status: "processed" });
    }
  }

  async markFailed(input: {
    readonly deliveryId: string;
    readonly errorSummary: string;
  }): Promise<void> {
    const existing = this.deliveries.get(input.deliveryId);
    if (existing) {
      this.deliveries.set(input.deliveryId, {
        ...existing,
        status: "failed",
        errorSummary: input.errorSummary,
      });
    }
  }
}

describe("handleGitHubInstallationWebhook", () => {
  it("upserts installation events and dedupes delivery ids before side effects", async () => {
    const installations = new InMemoryInstallations();
    const deliveries = new InMemoryDeliveries();
    const syncRequests = new InMemorySyncRequests();
    const ownerGrants = new InMemoryOwnerGrants();
    const envelope = {
      deliveryId: "delivery-1",
      eventName: "installation",
      payloadHash: "payload-hash",
      payload: {
        action: "created",
        installation: {
          id: 129,
          account: {
            login: "agent-teams-ai",
            type: "Organization",
            avatar_url: "https://avatars.githubusercontent.com/u/129?v=4",
          },
          repository_selection: "selected",
        },
        sender: {
          id: 777,
          login: "777genius",
          avatar_url: "https://avatars.githubusercontent.com/u/777?v=4",
        },
        repositories_added: [],
        repositories_removed: [],
      },
    };

    const first = await handleGitHubInstallationWebhook(envelope, {
      installations,
      deliveries,
      ownerGrants,
      syncRequests,
      clock: fixedClock,
    });
    const second = await handleGitHubInstallationWebhook(envelope, {
      installations,
      deliveries,
      ownerGrants,
      syncRequests,
      clock: fixedClock,
    });

    expect(first).toEqual({ processed: true, status: "active" });
    expect(second).toEqual({ processed: false });
    expect(installations.snapshots.get("129")).toMatchObject({
      accountLogin: "agent-teams-ai",
      accountAvatarUrl: "https://avatars.githubusercontent.com/u/129?v=4",
      status: "active",
    });
    expect(deliveries.deliveries.get("delivery-1")).toMatchObject({
      status: "processed",
      payloadHash: "payload-hash",
      normalizedEvent: {
        type: "github.installation",
        version: 1,
        installationId: "129",
        senderGithubUserId: "777",
        senderGithubLogin: "777genius",
      },
    });
    expect(ownerGrants.grants).toEqual([
      {
        githubInstallationId: "129",
        githubUserId: "777",
        githubLogin: "777genius",
        avatarUrl: "https://avatars.githubusercontent.com/u/777?v=4",
      },
    ]);
    expect(syncRequests.requests).toEqual([
      {
        githubInstallationId: "129",
        deliveryId: "delivery-1",
        reason: "installation_access_changed",
        occurredAt: fixedClock.now(),
      },
    ]);
  });

  it("requests a repository sync when installation repository access changes", async () => {
    const installations = new InMemoryInstallations();
    const deliveries = new InMemoryDeliveries();
    const syncRequests = new InMemorySyncRequests();

    const result = await handleGitHubInstallationWebhook(
      {
        deliveryId: "delivery-repos-1",
        eventName: "installation_repositories",
        payloadHash: "payload-hash",
        payload: {
          action: "added",
          repository_selection: "selected",
          repositories_added: [{ id: 101, name: "api" }],
          repositories_removed: [{ id: 102, name: "old" }],
          installation: {
            id: 129,
            account: {
              login: "agent-teams-ai",
              type: "Organization",
              avatar_url: "https://avatars.githubusercontent.com/u/129?v=4",
            },
            repository_selection: "selected",
          },
        },
      },
      {
        installations,
        deliveries,
        syncRequests,
        clock: fixedClock,
      },
    );

    expect(result).toEqual({ processed: true, status: "active" });
    expect(installations.snapshots.get("129")).toMatchObject({
      accountAvatarUrl: "https://avatars.githubusercontent.com/u/129?v=4",
      status: "active",
      repositorySelection: "selected",
    });
    expect(deliveries.deliveries.get("delivery-repos-1")).toMatchObject({
      normalizedEvent: {
        type: "github.installation_repositories",
        repositoriesAdded: 1,
        repositoriesRemoved: 1,
        repositoryIdsAdded: ["101"],
        repositoryIdsRemoved: ["102"],
      },
    });
    expect(syncRequests.requests).toEqual([
      {
        githubInstallationId: "129",
        deliveryId: "delivery-repos-1",
        reason: "installation_repositories_changed",
        occurredAt: fixedClock.now(),
      },
    ]);
  });

  it("marks deleted installations removed without requesting a GitHub sync", async () => {
    const installations = new InMemoryInstallations();
    const deliveries = new InMemoryDeliveries();
    const syncRequests = new InMemorySyncRequests();

    await handleGitHubInstallationWebhook(
      {
        deliveryId: "delivery-delete-1",
        eventName: "installation",
        payload: {
          action: "deleted",
          installation: {
            id: 129,
            account: { login: "agent-teams-ai", type: "Organization" },
            repository_selection: "selected",
          },
          repositories_added: [],
          repositories_removed: [],
        },
      },
      {
        installations,
        deliveries,
        syncRequests,
        clock: fixedClock,
      },
    );

    expect(installations.removed.has("129")).toBe(true);
    expect(syncRequests.requests).toHaveLength(0);
  });
});

const fixedClock: Clock = {
  now: () => new Date("2026-05-03T12:00:00.000Z"),
};
