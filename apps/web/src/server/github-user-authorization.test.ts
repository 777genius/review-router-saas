import type { PrismaClient } from "@reviewrouter/platform-db";
import { describe, expect, it, vi } from "vitest";
import {
  getValidGitHubUserAccessToken,
  saveGitHubUserAuthorizationFromAccount,
} from "./github-user-authorization";
import { decryptServerToken, encryptServerToken } from "./token-crypto";

const env = {
  GITHUB_APP_CLIENT_ID: "Iv23liTestClient",
  GITHUB_APP_CLIENT_SECRET: "github-app-client-secret",
  GITHUB_APP_SLUG: "reviewrouter-test",
  REVIEW_ROUTER_TOKEN_ENCRYPTION_KEY:
    "test-token-encryption-secret-0123456789abcdef",
};

describe("GitHub user authorization", () => {
  it("persists encrypted GitHub App user tokens from NextAuth account data", async () => {
    const upsert = vi.fn().mockResolvedValue({});
    const prisma = {
      gitHubUserAuthorization: { upsert },
    } as unknown as PrismaClient;
    const now = new Date("2026-05-12T10:00:00Z");

    await expect(
      saveGitHubUserAuthorizationFromAccount({
        prisma,
        now,
        env,
        principal: {
          provider: "github",
          userId: "user_1",
          externalUserId: "123",
          login: "maintainer",
          githubUserId: "123",
          githubLogin: "maintainer",
          primaryEmail: null,
          avatarUrl: null,
        },
        account: {
          access_token: "ghu_access",
          refresh_token: "ghr_refresh",
          expires_at: 1_768_000_000,
          refresh_token_expires_in: 60,
        },
      }),
    ).resolves.toBe("saved");

    const args = upsert.mock.calls[0]?.[0];
    expect(args.where.userId_appSlug).toEqual({
      userId: "user_1",
      appSlug: "reviewrouter-test",
    });
    expect(args.create.encryptedAccessToken).not.toContain("ghu_access");
    expect(decryptServerToken(args.create.encryptedAccessToken, env)).toBe(
      "ghu_access",
    );
    expect(args.create.accessTokenExpiresAt).toEqual(
      new Date(1_768_000_000_000),
    );
    expect(args.create.refreshTokenExpiresAt).toEqual(
      new Date("2026-05-12T10:01:00Z"),
    );
  });

  it("refreshes expiring access tokens and stores the rotated refresh token", async () => {
    const update = vi.fn().mockResolvedValue({});
    const prisma = {
      gitHubUserAuthorization: {
        findUnique: vi.fn().mockResolvedValue({
          encryptedAccessToken: encryptServerToken("ghu_old", env),
          encryptedRefreshToken: encryptServerToken("ghr_old", env),
          accessTokenExpiresAt: new Date("2026-05-12T10:01:00Z"),
          refreshTokenExpiresAt: new Date("2026-06-12T10:00:00Z"),
          revokedAt: null,
          lastErrorCode: null,
        }),
        update,
      },
    } as unknown as PrismaClient;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "ghu_new",
          refresh_token: "ghr_new",
          expires_in: 28_800,
          refresh_token_expires_in: 15_897_600,
        }),
        { status: 200 },
      ),
    );

    const result = await getValidGitHubUserAccessToken({
      prisma,
      env,
      userId: "user_1",
      now: new Date("2026-05-12T10:00:00Z"),
      fetch: fetchMock,
    });

    expect(result).toEqual({
      status: "ready",
      accessToken: "ghu_new",
      refreshed: true,
    });
    const updateArgs = update.mock.calls[0]?.[0];
    expect(decryptServerToken(updateArgs.data.encryptedAccessToken, env)).toBe(
      "ghu_new",
    );
    expect(decryptServerToken(updateArgs.data.encryptedRefreshToken, env)).toBe(
      "ghr_new",
    );
  });

  it("marks authorization revoked when refresh fails", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const deleteMany = vi.fn().mockResolvedValue({ count: 2 });
    const prisma = {
      gitHubUserAuthorization: {
        findUnique: vi.fn().mockResolvedValue({
          encryptedAccessToken: encryptServerToken("ghu_old", env),
          encryptedRefreshToken: encryptServerToken("ghr_old", env),
          accessTokenExpiresAt: new Date("2026-05-12T10:01:00Z"),
          refreshTokenExpiresAt: new Date("2026-06-12T10:00:00Z"),
          revokedAt: null,
          lastErrorCode: null,
        }),
        updateMany,
      },
      repositoryPermissionCache: { deleteMany },
    } as unknown as PrismaClient;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "bad_verification_code" }), {
        status: 400,
      }),
    );

    await expect(
      getValidGitHubUserAccessToken({
        prisma,
        env,
        userId: "user_1",
        now: new Date("2026-05-12T10:00:00Z"),
        fetch: fetchMock,
      }),
    ).resolves.toMatchObject({
      status: "refresh_failed",
      errorCode: "github_user_token_refresh_bad_verification_code",
    });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          revokedAt: expect.any(Date),
          lastErrorCode: "github_user_token_refresh_bad_verification_code",
        }),
      }),
    );
    expect(deleteMany).toHaveBeenCalledWith({ where: { userId: "user_1" } });
  });

  it("marks authorization revoked and clears cache when refresh token expired", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const deleteMany = vi.fn().mockResolvedValue({ count: 2 });
    const prisma = {
      gitHubUserAuthorization: {
        findUnique: vi.fn().mockResolvedValue({
          encryptedAccessToken: encryptServerToken("ghu_old", env),
          encryptedRefreshToken: encryptServerToken("ghr_old", env),
          accessTokenExpiresAt: new Date("2026-05-12T10:01:00Z"),
          refreshTokenExpiresAt: new Date("2026-05-12T09:59:59Z"),
          revokedAt: null,
          lastErrorCode: null,
        }),
        updateMany,
      },
      repositoryPermissionCache: { deleteMany },
      $transaction: vi
        .fn()
        .mockImplementation((operations) => Promise.all(operations)),
    } as unknown as PrismaClient;
    const fetchMock = vi.fn();

    await expect(
      getValidGitHubUserAccessToken({
        prisma,
        env,
        userId: "user_1",
        now: new Date("2026-05-12T10:00:00Z"),
        fetch: fetchMock,
      }),
    ).resolves.toMatchObject({
      status: "expired",
      errorCode: "github_user_refresh_token_expired",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          revokedAt: expect.any(Date),
          lastErrorCode: "github_user_refresh_token_expired",
        }),
      }),
    );
    expect(deleteMany).toHaveBeenCalledWith({ where: { userId: "user_1" } });
  });
});
