import type { PrismaClient } from "@reviewrouter/platform-db";
import { describe, expect, it, vi } from "vitest";
import {
  listGitHubUserRepositoryAccess,
  repositoryPermissionAllowsDashboardMutation,
  refreshGitHubUserRepositoryAccess,
} from "./github-user-repository-access";
import { encryptServerToken } from "./token-crypto";

const env = {
  GITHUB_APP_SLUG: "reviewrouter-test",
  REVIEW_ROUTER_TOKEN_ENCRYPTION_KEY:
    "test-token-encryption-secret-0123456789abcdef",
};

describe("GitHub user repository access", () => {
  it("allows admin, maintain, and write permissions only", () => {
    expect(repositoryPermissionAllowsDashboardMutation("admin")).toBe(true);
    expect(repositoryPermissionAllowsDashboardMutation("maintain")).toBe(true);
    expect(repositoryPermissionAllowsDashboardMutation("write")).toBe(true);
    expect(repositoryPermissionAllowsDashboardMutation("read")).toBe(false);
    expect(repositoryPermissionAllowsDashboardMutation(null)).toBe(false);
  });

  it("discovers manageable installed repositories from the user access token", async () => {
    const cacheRows: {
      checkedAt: Date;
      canManage: boolean;
      permission: string | null;
      roleName: string | null;
      repositoryId: string;
      repository: { workspaceId: string };
    }[] = [];
    const createMany = vi.fn().mockImplementation(({ data }) => {
      cacheRows.push(
        ...data.map(
          (row: {
            checkedAt: Date;
            canManage: boolean;
            permission?: string | null;
            roleName?: string | null;
            repositoryId: string;
          }) => ({
            checkedAt: row.checkedAt,
            canManage: row.canManage,
            permission: row.permission ?? null,
            roleName: row.roleName ?? null,
            repositoryId: row.repositoryId,
            repository: { workspaceId: "workspace_1" },
          }),
        ),
      );
      return Promise.resolve({ count: data.length });
    });
    const prisma = {
      repositoryPermissionCache: {
        findMany: vi.fn().mockImplementation(() => Promise.resolve(cacheRows)),
        deleteMany: vi.fn().mockImplementation(() => {
          cacheRows.length = 0;
          return Promise.resolve({ count: 0 });
        }),
        createMany,
      },
      gitHubUserAuthorization: {
        findUnique: vi.fn().mockResolvedValue({
          encryptedAccessToken: encryptServerToken("ghu_access", env),
          encryptedRefreshToken: null,
          accessTokenExpiresAt: new Date("2026-05-12T12:00:00Z"),
          refreshTokenExpiresAt: null,
          revokedAt: null,
          lastErrorCode: null,
        }),
      },
      gitHubInstallation: {
        findMany: vi.fn().mockResolvedValue([{ githubInstallationId: 101n }]),
      },
      repositoryConnection: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "repo_1",
            githubRepositoryId: 1001n,
            installation: { githubInstallationId: 101n },
          },
          {
            id: "repo_2",
            githubRepositoryId: 1002n,
            installation: { githubInstallationId: 101n },
          },
        ]),
      },
      $transaction: vi
        .fn()
        .mockImplementation((operations) => Promise.all(operations)),
    } as unknown as PrismaClient;
    const fetchMock = vi.fn().mockImplementation((url: URL) => {
      if (url.pathname === "/user/installations") {
        return Promise.resolve(
          new Response(JSON.stringify({ installations: [{ id: 101 }] }), {
            status: 200,
          }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            repositories: [
              { id: 1001, permissions: { push: true, pull: true } },
              { id: 1002, permissions: { pull: true } },
            ],
          }),
          { status: 200 },
        ),
      );
    });

    const result = await listGitHubUserRepositoryAccess({
      prisma,
      env,
      actor: {
        userId: "user_1",
        githubUserId: "123",
        githubLogin: "maintainer",
      },
      now: new Date("2026-05-12T10:00:00Z"),
      fetch: fetchMock,
    });

    expect(result.status).toBe("ready");
    expect([...result.repositoryIds]).toEqual(["repo_1"]);
    expect([...result.directConfigRepositoryIds]).toEqual([]);
    expect(result.workspaceIds).toEqual(["workspace_1"]);
    expect(createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({
            repositoryId: "repo_1",
            permission: "write",
            canManage: true,
          }),
          expect.objectContaining({
            repositoryId: "repo_2",
            permission: "read",
            canManage: false,
          }),
        ]),
      }),
    );
  });

  it("uses fresh cache for normal reads and force-refresh updates the cached repository list", async () => {
    const cacheRows: {
      checkedAt: Date;
      canManage: boolean;
      permission: string | null;
      roleName: string | null;
      repositoryId: string;
      repository: { workspaceId: string };
    }[] = [
      {
        checkedAt: new Date("2026-05-12T10:00:00Z"),
        canManage: true,
        permission: "maintain",
        roleName: null,
        repositoryId: "repo_old",
        repository: { workspaceId: "workspace_1" },
      },
    ];
    const createMany = vi.fn().mockImplementation(({ data }) => {
      cacheRows.push(
        ...data.map(
          (row: {
            checkedAt: Date;
            canManage: boolean;
            permission?: string | null;
            roleName?: string | null;
            repositoryId: string;
          }) => ({
            checkedAt: row.checkedAt,
            canManage: row.canManage,
            permission: row.permission ?? null,
            roleName: row.roleName ?? null,
            repositoryId: row.repositoryId,
            repository: { workspaceId: "workspace_1" },
          }),
        ),
      );
      return Promise.resolve({ count: data.length });
    });
    const prisma = {
      repositoryPermissionCache: {
        findMany: vi.fn().mockImplementation(() => Promise.resolve(cacheRows)),
        deleteMany: vi.fn().mockImplementation(() => {
          cacheRows.length = 0;
          return Promise.resolve({ count: 1 });
        }),
        createMany,
      },
      gitHubUserAuthorization: {
        findUnique: vi.fn().mockResolvedValue({
          encryptedAccessToken: encryptServerToken("ghu_access", env),
          encryptedRefreshToken: null,
          accessTokenExpiresAt: new Date("2026-05-12T12:00:00Z"),
          refreshTokenExpiresAt: null,
          revokedAt: null,
          lastErrorCode: null,
        }),
      },
      gitHubInstallation: {
        findMany: vi.fn().mockResolvedValue([{ githubInstallationId: 101n }]),
      },
      repositoryConnection: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "repo_new",
            githubRepositoryId: 1001n,
            installation: { githubInstallationId: 101n },
          },
        ]),
      },
      $transaction: vi
        .fn()
        .mockImplementation((operations) => Promise.all(operations)),
    } as unknown as PrismaClient;
    const fetchMock = vi.fn().mockImplementation((url: URL) => {
      if (url.pathname === "/user/installations") {
        return Promise.resolve(
          new Response(JSON.stringify({ installations: [{ id: 101 }] }), {
            status: 200,
          }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            repositories: [
              { id: 1001, permissions: { maintain: true, pull: true } },
            ],
          }),
          { status: 200 },
        ),
      );
    });
    const actor = {
      userId: "user_1",
      githubUserId: "123",
      githubLogin: "maintainer",
    };

    await expect(
      listGitHubUserRepositoryAccess({
        prisma,
        env,
        actor,
        now: new Date("2026-05-12T10:01:00Z"),
        fetch: fetchMock,
      }),
    ).resolves.toMatchObject({
      status: "ready",
      workspaceIds: ["workspace_1"],
    });
    expect(fetchMock).not.toHaveBeenCalled();

    const refreshed = await refreshGitHubUserRepositoryAccess({
      prisma,
      env,
      actor,
      now: new Date("2026-05-12T10:02:00Z"),
      fetch: fetchMock,
    });

    expect([...refreshed.repositoryIds]).toEqual(["repo_new"]);
    expect([...refreshed.directConfigRepositoryIds]).toEqual(["repo_new"]);
    expect(createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            repositoryId: "repo_new",
            permission: "maintain",
            canManage: true,
          }),
        ],
      }),
    );
  });
});
