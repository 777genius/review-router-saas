import { describe, expect, it } from "vitest";
import type { Clock } from "@reviewrouter/shared";
import type {
  GitHubRepositorySnapshot,
  RepositorySyncResult,
} from "../domain/repository-connection";
import type { GitHubRepositorySourcePort } from "../application/ports/github-repository-source-port";
import type { RepositoryConnectionRepositoryPort } from "../application/ports/repository-connection-repository-port";
import { syncInstallationRepositories } from "../application/use-cases/sync-installation-repositories";

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
    };
  }

  async listWorkspaceRepositories() {
    return [];
  }
}

const fixedClock: Clock = {
  now: () => new Date("2026-05-03T15:00:00.000Z"),
};

describe("syncInstallationRepositories", () => {
  it("fetches installation repos and persists one sync batch", async () => {
    const repositories = [
      {
        githubRepositoryId: "1",
        owner: "777genius",
        name: "review-router",
        fullName: "777genius/review-router",
        defaultBranch: "main",
        visibility: "public",
        archived: false,
      } satisfies GitHubRepositorySnapshot,
    ];
    const store = new CapturingRepositoryStore();

    const result = await syncInstallationRepositories("129154876", {
      github: new StaticGitHubSource(repositories),
      repositories: store,
      clock: fixedClock,
    });

    expect(result).toEqual({
      installationId: "129154876",
      seen: 1,
      upserted: 1,
      unselected: 0,
    });
    expect(store.lastInput?.syncedAt.toISOString()).toBe(
      "2026-05-03T15:00:00.000Z",
    );
  });
});
