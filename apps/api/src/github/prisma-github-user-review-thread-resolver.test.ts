import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@reviewrouter/platform-db";
import { encryptServerToken } from "@reviewrouter/features-auth";
import { PrismaGitHubUserReviewThreadResolver } from "./prisma-github-user-review-thread-resolver.js";

const env = {
  REVIEW_ROUTER_TOKEN_ENCRYPTION_KEY:
    "0123456789abcdef0123456789abcdef0123456789abcdef",
  GITHUB_APP_SLUG: "review-router-ai",
};

const now = new Date("2026-05-14T12:00:00.000Z");

function createPrismaMock() {
  return {
    repositoryPermissionCache: {
      findMany: vi.fn().mockResolvedValue([{ userId: "user_1" }]),
    },
    workspaceMember: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    gitHubUserAuthorization: {
      findUnique: vi.fn().mockResolvedValue({
        encryptedAccessToken: encryptServerToken("ghu_user_token", env),
        encryptedRefreshToken: null,
        accessTokenExpiresAt: new Date("2026-05-14T13:00:00.000Z"),
        refreshTokenExpiresAt: null,
        revokedAt: null,
        lastErrorCode: null,
      }),
    },
  } as unknown as PrismaClient;
}

function request() {
  return {
    repository: {
      workspaceId: "workspace_1",
      repositoryId: "repo_1",
      githubRepositoryId: "123",
      githubInstallationId: "456",
      fullName: "777genius/example",
      owner: "777genius",
      selected: true,
      installationStatus: "active",
    },
    request: {
      protocolVersion: 1 as const,
      pullRequestNumber: 109,
      reviewedHeadSha: "a".repeat(40),
      target: {
        targetId: "rrt_123",
        threadId: "thread-123",
        fingerprint: "b".repeat(24),
        parentCommentId: "comment-123",
        parentCommentUpdatedAt: "2026-05-14T11:59:00.000Z",
        threadCommentCount: 1,
      },
    },
    now,
  };
}

describe("PrismaGitHubUserReviewThreadResolver", () => {
  it("uses a saved GitHub user token to guard and resolve a review thread", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            repository: {
              pullRequest: {
                headRefOid: "a".repeat(40),
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            node: {
              id: "thread-123",
              isResolved: false,
              viewerCanResolve: true,
              comments: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: "comment-123",
                    author: { login: "review-router-ai[bot]" },
                    body: `<!-- review-router-finding:${"b".repeat(24)} -->`,
                    createdAt: "2026-05-14T11:59:00.000Z",
                    updatedAt: "2026-05-14T11:59:00.000Z",
                  },
                ],
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            resolveReviewThread: {
              thread: {
                id: "thread-123",
                isResolved: true,
              },
            },
          },
        }),
      );
    const resolver = new PrismaGitHubUserReviewThreadResolver(
      createPrismaMock(),
      {
        env,
        fetch: fetch as unknown as typeof globalThis.fetch,
      },
    );

    const result = await resolver.resolveReviewThreadLifecycle(request());

    expect(result).toEqual({
      protocolVersion: 1,
      status: "resolved",
      resolvedBy: "github_user",
      reasonCodes: [],
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[2]![1]!.body).toContain("resolveReviewThread");
  });

  it("keeps the thread open when no authorized workspace user token is available", async () => {
    const prisma = createPrismaMock();
    vi.mocked(prisma.repositoryPermissionCache.findMany).mockResolvedValue([]);
    vi.mocked(prisma.workspaceMember.findMany).mockResolvedValue([]);
    const resolver = new PrismaGitHubUserReviewThreadResolver(prisma, { env });

    const result = await resolver.resolveReviewThreadLifecycle(request());

    expect(result).toEqual({
      protocolVersion: 1,
      status: "missing_user_authorization",
      reasonCodes: ["missing_user_authorization"],
    });
  });
});

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}
