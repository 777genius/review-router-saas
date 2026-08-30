import { describe, expect, it, vi } from "vitest";
import { PrismaSetupPullRequestMergeHandler } from "./prisma-setup-pull-request-merge-handler";

describe("PrismaSetupPullRequestMergeHandler", () => {
  it("marks only WorkflowProvisioning configured after a setup PR merge", async () => {
    const repositoryUpdate = vi.fn();
    const provisioningUpdate = vi.fn(async () => undefined);
    const transactionClient = {
      repositoryConnection: { update: repositoryUpdate },
      workflowProvisioning: {
        findFirst: vi.fn(async () => ({ id: "provisioning_1" })),
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

    await expect(
      handler.handleGitHubPullRequestWebhook({
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
      }),
    ).resolves.toMatchObject({ processed: true, status: "configured" });

    expect(provisioningUpdate).toHaveBeenCalledWith({
      where: { id: "provisioning_1" },
      data: { status: "configured", errorMessage: null },
    });
    expect(repositoryUpdate).not.toHaveBeenCalled();
  });
});
