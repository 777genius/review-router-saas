import { describe, expect, it, vi } from "vitest";
import { PrismaSetupPullRequestMergeHandler } from "./prisma-setup-pull-request-merge-handler";

describe("PrismaSetupPullRequestMergeHandler", () => {
  it("recovers failed provisioning and accepts a repeated merge delivery idempotently", async () => {
    const repositoryUpdate = vi.fn();
    const provisioningUpdate = vi.fn(async () => undefined);
    const transactionClient = {
      repositoryConnection: { update: repositoryUpdate },
      workflowProvisioning: {
        findMany: vi.fn(async () => [{ id: "provisioning_1" }]),
        update: provisioningUpdate,
      },
    };
    const prisma = {
      repositoryConnection: {
        findFirst: vi.fn(async () => ({
          id: "repository_1",
          fullName: "acme/widget",
        })),
      },
      $transaction: vi.fn(
        async (callback: (tx: typeof transactionClient) => unknown) =>
          callback(transactionClient),
      ),
    };
    const handler = new PrismaSetupPullRequestMergeHandler(prisma as never);

    const envelope = {
      deliveryId: "delivery_1",
      eventName: "pull_request",
      payload: {
        action: "closed",
        installation: { id: 123 },
        repository: {
          id: 456,
          name: "widget",
          full_name: "acme/widget",
        },
        pull_request: {
          number: 7,
          html_url: "https://github.com/acme/widget/pull/7",
          state: "closed",
          merged: true,
          draft: false,
          base: { ref: "main" },
          head: { ref: "reviewrouter/setup" },
        },
      },
    } as const;

    await expect(
      handler.handleGitHubPullRequestWebhook(envelope),
    ).resolves.toMatchObject({
      processed: true,
      status: "configured",
    });
    await expect(
      handler.handleGitHubPullRequestWebhook(envelope),
    ).resolves.toMatchObject({
      processed: true,
      status: "configured",
    });

    expect(
      transactionClient.workflowProvisioning.findMany,
    ).toHaveBeenCalledWith({
      where: {
        repositoryId: "repository_1",
        OR: [
          { branch: "reviewrouter/setup" },
          { pullRequestUrl: { endsWith: "/pull/7" } },
        ],
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: 2,
      select: { id: true },
    });
    expect(provisioningUpdate).toHaveBeenCalledTimes(2);
    expect(provisioningUpdate).toHaveBeenLastCalledWith({
      where: { id: "provisioning_1" },
      data: { status: "configured", errorMessage: null },
    });
    expect(repositoryUpdate).not.toHaveBeenCalled();
  });

  it("ignores a merged PR when no provisioning row matches", async () => {
    const transactionClient = {
      workflowProvisioning: {
        findMany: vi.fn(async () => []),
        update: vi.fn(),
      },
    };
    const prisma = {
      repositoryConnection: {
        findFirst: vi.fn(async () => ({
          id: "repository_1",
          fullName: "acme/widget",
        })),
      },
      $transaction: vi.fn(
        async (callback: (tx: typeof transactionClient) => unknown) =>
          callback(transactionClient),
      ),
    };
    const handler = new PrismaSetupPullRequestMergeHandler(prisma as never);

    await expect(
      handler.handleGitHubPullRequestWebhook({
        deliveryId: "delivery_2",
        eventName: "pull_request",
        payload: {
          action: "closed",
          installation: { id: 123 },
          repository: {
            id: 456,
            name: "widget",
            full_name: "acme/widget",
          },
          pull_request: {
            number: 8,
            html_url: "https://github.com/acme/widget/pull/8",
            state: "closed",
            merged: true,
            draft: false,
            base: { ref: "main" },
            head: { ref: "reviewrouter/setup" },
          },
        },
      }),
    ).resolves.toMatchObject({
      processed: false,
      ignored: true,
      reason: "not_reviewrouter_setup_pr",
    });
    expect(
      transactionClient.workflowProvisioning.update,
    ).not.toHaveBeenCalled();
  });
});
