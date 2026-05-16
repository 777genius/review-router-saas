import type { PrismaClient } from "@reviewrouter/platform-db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrismaGitHubAppAuthorizationWebhookHandler } from "./prisma-github-app-authorization-webhook-handler";

describe("PrismaGitHubAppAuthorizationWebhookHandler", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("revokes stored user authorization and clears repository access cache", async () => {
    vi.stubEnv("GITHUB_APP_SLUG", "reviewrouter-test");
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const deleteMany = vi.fn().mockResolvedValue({ count: 2 });
    const prisma = {
      user: {
        findMany: vi.fn().mockResolvedValue([{ id: "user_1" }]),
      },
      gitHubUserAuthorization: { updateMany },
      repositoryPermissionCache: { deleteMany },
      $transaction: vi
        .fn()
        .mockImplementation((operations) => Promise.all(operations)),
    } as unknown as PrismaClient;

    await expect(
      new PrismaGitHubAppAuthorizationWebhookHandler(
        prisma,
      ).handleGitHubAppAuthorizationWebhook({
        deliveryId: "delivery_1",
        eventName: "github_app_authorization",
        payload: {
          action: "revoked",
          sender: { id: 123, login: "maintainer" },
        },
      }),
    ).resolves.toEqual({
      processed: true,
      appSlug: "reviewrouter-test",
      githubUserId: "123",
      userCount: 1,
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        appSlug: "reviewrouter-test",
        userId: { in: ["user_1"] },
        revokedAt: null,
      },
      data: {
        revokedAt: expect.any(Date),
        lastErrorCode: "github_app_authorization_revoked",
      },
    });
    expect(deleteMany).toHaveBeenCalledWith({
      where: { userId: { in: ["user_1"] } },
    });
  });
});
