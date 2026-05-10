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
    const handler = new PrismaRepositoryWebhookHandler({
      repositoryConnection,
    } as never);

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
    const handler = new PrismaRepositoryWebhookHandler({
      repositoryConnection,
    } as never);

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
