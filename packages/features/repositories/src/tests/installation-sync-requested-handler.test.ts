import { describe, expect, it } from "vitest";
import {
  OutboxHandlerError,
  type OutboxEvent,
} from "@reviewrouter/features-outbox";
import type { Clock } from "@reviewrouter/shared";
import type {
  GitHubRepositorySnapshot,
  RepositorySyncResult,
} from "../domain/repository-connection";
import type { GitHubRepositorySourcePort } from "../application/ports/github-repository-source-port";
import type { RepositoryConnectionRepositoryPort } from "../application/ports/repository-connection-repository-port";
import { createInstallationSyncRequestedHandler } from "../infrastructure/outbox/installation-sync-requested-handler";

class StaticGitHubSource implements GitHubRepositorySourcePort {
  constructor(
    private readonly repositories: readonly GitHubRepositorySnapshot[],
  ) {}

  async listInstallationRepositories(): Promise<
    readonly GitHubRepositorySnapshot[]
  > {
    return this.repositories;
  }
}

class CapturingRepositoryStore implements RepositoryConnectionRepositoryPort {
  public lastInput: {
    githubInstallationId: string;
    repositories: readonly GitHubRepositorySnapshot[];
    syncedAt: Date;
  } | null = null;

  async syncInstallationRepositories(input: {
    githubInstallationId: string;
    repositories: readonly GitHubRepositorySnapshot[];
    syncedAt: Date;
  }): Promise<RepositorySyncResult> {
    this.lastInput = input;
    return {
      installationId: input.githubInstallationId,
      seen: input.repositories.length,
      upserted: input.repositories.length,
      unselected: 0,
      skippedDueToLimit: 0,
    };
  }

  async listWorkspaceRepositories() {
    return [];
  }
}

const fixedClock: Clock = {
  now: () => new Date("2026-05-03T15:00:00.000Z"),
};

const outboxEvent = (payload: unknown): OutboxEvent => ({
  id: "event_1",
  type: "installation.sync_requested",
  version: 1,
  idempotencyKey: "installation:129:sync:delivery-1",
  workspaceId: null,
  repositoryId: null,
  aggregateId: "github-installation:129",
  payload,
  status: "processing",
  attempts: 1,
  maxAttempts: 5,
  nextAttemptAt: null,
  occurredAt: fixedClock.now(),
});

describe("installation sync requested outbox handler", () => {
  it("syncs repositories for a valid installation sync event", async () => {
    const repositories = [
      {
        githubRepositoryId: "1",
        owner: "777genius",
        name: "review-router",
        fullName: "777genius/review-router",
        defaultBranch: "main",
        visibility: "public",
        archived: false,
        stargazersCount: 42,
      } satisfies GitHubRepositorySnapshot,
    ];
    const store = new CapturingRepositoryStore();
    const handler = createInstallationSyncRequestedHandler({
      github: new StaticGitHubSource(repositories),
      repositories: store,
      clock: fixedClock,
    });

    await handler.handle(
      outboxEvent({
        installationId: "129",
        reason: "manual_dashboard_sync",
      }),
    );

    expect(store.lastInput).toMatchObject({
      githubInstallationId: "129",
      repositories,
    });
  });

  it("dead-letters malformed installation sync payloads", async () => {
    const handler = createInstallationSyncRequestedHandler({
      github: new StaticGitHubSource([]),
      repositories: new CapturingRepositoryStore(),
      clock: fixedClock,
    });

    await expect(
      handler.handle(outboxEvent({ reason: "missing_id" })),
    ).rejects.toMatchObject({
      name: "OutboxHandlerError",
      code: "invalid_event_payload",
      retryable: false,
    } satisfies Partial<OutboxHandlerError>);
  });
});
