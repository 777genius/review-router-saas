import { describe, expect, it, vi } from "vitest";
import { PrismaSetupPullRequestMergeHandler } from "./prisma-setup-pull-request-merge-handler";

describe("PrismaSetupPullRequestMergeHandler", () => {
  it("recovers failed provisioning and accepts a repeated merge delivery idempotently", async () => {
    const repositoryUpdate = vi.fn();
    let status: "failed" | "configured" = "failed";
    const provisioningUpdate = vi.fn(async () => {
      status = "configured";
      return { count: 1 };
    });
    const transactionClient = {
      repositoryConnection: { update: repositoryUpdate },
      workflowProvisioning: {
        findFirst: vi.fn(async () => ({
          id: "provisioning_1",
          status,
          branch: "reviewrouter/setup",
          pullRequestUrl: "https://github.com/acme/widget/pull/7",
          errorMessage: status === "failed" ? "setup_pr_closed" : null,
        })),
        updateMany: provisioningUpdate,
        findUnique: vi.fn(async () => ({ status })),
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
      transactionClient.workflowProvisioning.findFirst,
    ).toHaveBeenCalledWith({
      where: { repositoryId: "repository_1" },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        status: true,
        branch: true,
        pullRequestUrl: true,
        errorMessage: true,
      },
    });
    expect(provisioningUpdate).toHaveBeenCalledTimes(1);
    expect(provisioningUpdate).toHaveBeenLastCalledWith({
      where: {
        id: "provisioning_1",
        status: { in: ["setup_pr_open", "failed"] },
        pullRequestUrl: "https://github.com/acme/widget/pull/7",
      },
      data: { status: "configured", errorMessage: null },
    });
    expect(repositoryUpdate).not.toHaveBeenCalled();
  });

  it("ignores a merged PR when no provisioning row matches", async () => {
    const transactionClient = {
      workflowProvisioning: {
        findFirst: vi.fn(async () => null),
        updateMany: vi.fn(),
        findUnique: vi.fn(),
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
      transactionClient.workflowProvisioning.updateMany,
    ).not.toHaveBeenCalled();
  });
});
