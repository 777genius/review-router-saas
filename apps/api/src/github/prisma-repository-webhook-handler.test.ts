import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { GitHubRepositoryWebhookEnvelope } from "@reviewrouter/features-github-installations";
import { describe, expect, it, vi } from "vitest";
import { PrismaRepositoryWebhookHandler } from "./prisma-repository-webhook-handler";

describe("PrismaRepositoryWebhookHandler", () => {
  it("updates synced repository metadata from repository webhook payloads", async () => {
    const repositoryConnection = {
      findFirst: vi.fn().mockResolvedValue({
        id: "repo_1",
        defaultBranch: "master",
        fullName: "777genius/example",
      }),
      update: vi.fn().mockResolvedValue({}),
    };
    const { handler, events } = fixture(repositoryConnection);

    const result = await handler.handleGitHubRepositoryWebhook({
      deliveryId: "delivery_1",
      eventName: "repository",
      payload: {
        action: "renamed",
        installation: {
          id: 129154876,
          account: { login: "777genius", type: "User" },
          repository_selection: "all",
        },
        repository: {
          id: 123456,
          owner: { login: "777genius" },
          name: "renamed-example",
          full_name: "777genius/renamed-example",
          default_branch: "main",
          visibility: "private",
          private: true,
          archived: true,
          stargazers_count: 9,
        },
      },
    });

    expect(events).toEqual(["begin", "guard", "read", "write", "commit"]);
    expect(result).toEqual({
      processed: true,
      repository: "777genius/renamed-example",
      status: "synced",
    });
    expect(repositoryConnection.findFirst).toHaveBeenCalledWith({
      where: {
        githubRepositoryId: 123456n,
        installation: { githubInstallationId: 129154876n },
      },
      select: {
        id: true,
        defaultBranch: true,
        fullName: true,
      },
    });
    expect(repositoryConnection.update).toHaveBeenCalledWith({
      where: { id: "repo_1" },
      data: expect.objectContaining({
        owner: "777genius",
        name: "renamed-example",
        fullName: "777genius/renamed-example",
        defaultBranch: "main",
        visibility: "private",
        archived: true,
        stargazersCount: 9,
      }),
    });
  });

  it("unselects deleted repositories instead of losing historical state", async () => {
    const repositoryConnection = {
      findFirst: vi.fn().mockResolvedValue({
        id: "repo_1",
        defaultBranch: "main",
        fullName: "777genius/example",
      }),
      update: vi.fn().mockResolvedValue({}),
    };
    const { handler, events } = fixture(repositoryConnection);

    const result = await handler.handleGitHubRepositoryWebhook({
      deliveryId: "delivery_2",
      eventName: "repository",
      payload: {
        action: "deleted",
        installation: {
          id: 129154876,
          account: { login: "777genius", type: "User" },
          repository_selection: "all",
        },
        repository: {
          id: 123456,
          owner: { login: "777genius" },
          name: "example",
          full_name: "777genius/example",
          default_branch: "main",
          visibility: "public",
          private: false,
          archived: false,
        },
      },
    });

    expect(events).toEqual(["begin", "guard", "read", "write", "commit"]);
    expect(result).toEqual({
      processed: true,
      repository: "777genius/example",
      status: "unselected",
    });
    expect(repositoryConnection.update).toHaveBeenCalledWith({
      where: { id: "repo_1" },
      data: expect.objectContaining({
        selected: false,
      }),
    });
  });
});

function fixture(
  repositoryConnection = {
    findFirst: vi.fn().mockResolvedValue({
      id: "repo_1",
      defaultBranch: "master",
      fullName: "old/repo",
    }),
    update: vi.fn().mockResolvedValue({}),
  },
) {
  const events: string[] = [];
  const query = vi.fn(async (sql: Prisma.Sql) => {
    events.push("guard");
    expect(sql.text).toContain("pg_advisory_xact_lock(");
    expect(sql.values).toEqual([
      createHash("sha256")
        .update("review-current-scope-v1\0global")
        .digest("hex"),
    ]);
    return [{ locked: 1 }];
  });
  const prisma = {
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => {
      events.push("begin");
      const value = await work({
        $queryRaw: query,
        repositoryConnection: {
          findFirst: async (...args: unknown[]) => {
            events.push("read");
            return repositoryConnection.findFirst(...args);
          },
          update: async (...args: unknown[]) => {
            events.push("write");
            return repositoryConnection.update(...args);
          },
        },
      });
      events.push("commit");
      return value;
    }),
  };
  return {
    handler: new PrismaRepositoryWebhookHandler(prisma as never),
    events,
    query,
    repositoryConnection,
    prisma,
  };
}
function envelope(action: string): GitHubRepositoryWebhookEnvelope {
  return {
    deliveryId: "delivery",
    eventName: "repository",
    payload: {
      action,
      installation: {
        id: 123,
        account: { login: "test", type: "Organization" },
        repository_selection: "all",
      },
      repository: {
        id: 456,
        owner: { login: "new" },
        name: "repo",
        full_name: "new/repo",
        archived: false,
      },
    },
  };
}
describe("repository webhook guard boundaries", () => {
  it.each(["deleted", "renamed"])(
    "%s missing repository remains an ignored no-op",
    async (action) => {
      const f = fixture();
      f.repositoryConnection.findFirst.mockResolvedValue(null);
      expect(
        await f.handler.handleGitHubRepositoryWebhook(envelope(action)),
      ).toEqual({
        processed: false,
        ignored: true,
        reason: "repository_not_synced",
        repository: "new/repo",
      });
      expect(f.events).toEqual(["begin", "guard", "read", "commit"]);
      expect(f.repositoryConnection.update).not.toHaveBeenCalled();
    },
  );
  it.each(["deleted", "renamed"])(
    "%s failed guard prevents discovery and mutation",
    async (action) => {
      const f = fixture();
      f.query.mockRejectedValue(new Error("guard failed"));
      await expect(
        f.handler.handleGitHubRepositoryWebhook(envelope(action)),
      ).rejects.toThrow("guard failed");
      expect(f.repositoryConnection.findFirst).not.toHaveBeenCalled();
      expect(f.repositoryConnection.update).not.toHaveBeenCalled();
    },
  );
  it.each(["deleted", "renamed"])(
    "%s replay uses a fresh guarded transaction",
    async (action) => {
      const f = fixture();
      const first = await f.handler.handleGitHubRepositoryWebhook(
        envelope(action),
      );
      expect(
        await f.handler.handleGitHubRepositoryWebhook(envelope(action)),
      ).toEqual(first);
      expect(f.events).toEqual(
        Array(2).fill(["begin", "guard", "read", "write", "commit"]).flat(),
      );
      expect(f.prisma.$transaction).toHaveBeenCalledTimes(2);
      if (action === "deleted") {
        expect(f.repositoryConnection.update.mock.calls[0]?.[0].data).toEqual({
          selected: false,
          lastSyncedAt: expect.any(Date),
        });
      } else {
        expect(f.repositoryConnection.update.mock.calls[0]?.[0].data).toEqual({
          owner: "new",
          name: "repo",
          fullName: "new/repo",
          defaultBranch: "master",
          visibility: "public",
          archived: false,
          stargazersCount: 0,
          lastSyncedAt: expect.any(Date),
        });
      }
    },
  );
  it.each([
    [
      { visibility: "internal", private: true, watchers_count: 7 },
      "internal",
      7,
    ],
    [{ private: true, stargazers_count: 0, watchers_count: 7 }, "private", 0],
  ] as const)(
    "preserves metadata normalization %j",
    async (fields, visibility, stars) => {
      const f = fixture();
      const input = envelope("edited");
      await f.handler.handleGitHubRepositoryWebhook({
        ...input,
        payload: {
          ...input.payload,
          repository: { ...input.payload.repository, ...fields },
        },
      });
      expect(f.repositoryConnection.update).toHaveBeenCalledWith({
        where: { id: "repo_1" },
        data: expect.objectContaining({ visibility, stargazersCount: stars }),
      });
    },
  );
});
