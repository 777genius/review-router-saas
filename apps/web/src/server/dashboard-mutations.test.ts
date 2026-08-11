import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertWorkspaceMutationAllowed: vi.fn(),
  getPrisma: vi.fn(),
  getServerSession: vi.fn(),
  getValidGitHubUserAccessToken: vi.fn(),
  octokitRequest: vi.fn(),
  updateRepositoryPermissionCacheFromLiveCheck: vi.fn(),
}));

vi.mock("next-auth", () => ({
  getServerSession: mocks.getServerSession,
}));

vi.mock("@reviewrouter/features-auth", () => ({
  assertWorkspaceMutationAllowed: mocks.assertWorkspaceMutationAllowed,
  listVisibleWorkspaceScope: vi.fn(),
  PrismaWorkspaceAccessRepository: class PrismaWorkspaceAccessRepository {},
}));

vi.mock("@reviewrouter/platform-config", () => ({
  requireGitHubAppPrivateKey: () => "test-private-key",
}));

vi.mock("@octokit/app", () => ({
  App: class App {
    getInstallationOctokit() {
      return { request: mocks.octokitRequest };
    }
  },
}));

vi.mock("../auth/auth-env", () => ({
  getAuthEnvironmentStatus: () => ({ configured: true, missing: [] }),
}));

vi.mock("../auth/auth-options", () => ({
  authOptions: {},
}));

vi.mock("./github-user-repository-access", () => ({
  updateRepositoryPermissionCacheFromLiveCheck:
    mocks.updateRepositoryPermissionCacheFromLiveCheck,
}));

vi.mock("./github-user-authorization", () => ({
  getValidGitHubUserAccessToken: mocks.getValidGitHubUserAccessToken,
}));

vi.mock("./prisma", () => ({
  getPrisma: mocks.getPrisma,
}));

import {
  assertDashboardMutationAllowed,
  assertDashboardRepositoryConfigMutationAllowed,
  assertDashboardRepositoryMutationAllowed,
  assertDashboardRepositoryRecoveryAllowed,
  createGitHubUserOctokit,
  getDashboardSignedInActor,
} from "./dashboard-mutations";

const repository = {
  id: "repo_1",
  owner: "fin-int",
  name: "tvaity",
  githubRepositoryId: 1001n,
  installation: { githubInstallationId: 101n },
};

describe("dashboard repository mutations", () => {
  beforeEach(() => {
    vi.stubEnv("GITHUB_APP_ID", "12345");
    vi.stubEnv("REVIEW_ROUTER_ENABLE_DASHBOARD_MUTATIONS", "1");
    mocks.getServerSession.mockResolvedValue({
      user: {
        sourceProvider: "github",
        externalUserId: "123",
        sourceLogin: "maintainer",
        githubUserId: "123",
        githubLogin: "maintainer",
      },
    });
    mocks.getPrisma.mockReturnValue({
      userExternalIdentity: {
        findUnique: vi.fn().mockResolvedValue({ userId: "user_1" }),
      },
    });
    mocks.assertWorkspaceMutationAllowed.mockRejectedValue(
      new Error("workspace_mutation_forbidden:missing_role"),
    );
    mocks.updateRepositoryPermissionCacheFromLiveCheck.mockResolvedValue(
      undefined,
    );
    mocks.getValidGitHubUserAccessToken.mockResolvedValue({
      status: "ready",
      accessToken: "ghu_user",
      refreshed: false,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("rejects repo-only mutations when the live collaborator permission no longer allows management", async () => {
    mocks.octokitRequest.mockResolvedValue({
      data: {
        permission: "read",
        role_name: "read",
        user: { id: 123, login: "maintainer" },
      },
    });

    await expect(
      assertDashboardRepositoryMutationAllowed("workspace_1", repository),
    ).rejects.toThrow("repository_mutation_forbidden");

    expect(mocks.octokitRequest).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/collaborators/{username}/permission",
      {
        owner: "fin-int",
        repo: "tvaity",
        username: "maintainer",
      },
    );
    expect(
      mocks.updateRepositoryPermissionCacheFromLiveCheck,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: expect.objectContaining({ userId: "user_1" }),
        repositoryId: "repo_1",
        githubInstallationId: 101n,
        permission: "read",
        roleName: "read",
        canManage: false,
      }),
    );
  });

  it("allows repo-only mutations for live write, maintain, or admin repository roles", async () => {
    mocks.octokitRequest.mockResolvedValue({
      data: {
        permission: "write",
        role_name: "write",
        user: { id: "123", login: "maintainer" },
      },
    });

    await expect(
      assertDashboardRepositoryMutationAllowed("workspace_1", repository),
    ).resolves.toMatchObject({
      userId: "user_1",
      githubUserId: "123",
      githubLogin: "maintainer",
      accessSource: {
        source: "repo_manager",
        capability: "repo_manager",
        permission: "write",
        roleName: "write",
      },
    });

    expect(
      mocks.updateRepositoryPermissionCacheFromLiveCheck,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryId: "repo_1",
        permission: "write",
        roleName: "write",
        canManage: true,
      }),
    );
  });

  it("rejects direct repository config changes for write-only repo access", async () => {
    mocks.octokitRequest.mockResolvedValue({
      data: {
        permission: "write",
        role_name: "write",
        user: { id: "123", login: "maintainer" },
      },
    });

    await expect(
      assertDashboardRepositoryConfigMutationAllowed("workspace_1", repository),
    ).rejects.toThrow("repository_config_mutation_forbidden");

    expect(
      mocks.updateRepositoryPermissionCacheFromLiveCheck,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryId: "repo_1",
        permission: "write",
        roleName: "write",
        canManage: true,
      }),
    );
  });

  it("allows direct repository config changes for maintain or admin repo access", async () => {
    mocks.octokitRequest.mockResolvedValue({
      data: {
        permission: "write",
        role_name: "maintain",
        user: { id: "123", login: "maintainer" },
      },
    });

    await expect(
      assertDashboardRepositoryConfigMutationAllowed("workspace_1", repository),
    ).resolves.toMatchObject({
      userId: "user_1",
      githubUserId: "123",
      githubLogin: "maintainer",
      accessSource: {
        source: "repo_manager",
        capability: "direct_config",
        permission: "write",
        roleName: "maintain",
      },
    });
  });

  it("allows direct repository config changes for workspace admins without repo checks", async () => {
    mocks.assertWorkspaceMutationAllowed.mockResolvedValue({
      allowed: true,
      reason: "allowed",
    });

    await expect(
      assertDashboardRepositoryConfigMutationAllowed("workspace_1", repository),
    ).resolves.toMatchObject({
      userId: "user_1",
      githubUserId: "123",
      githubLogin: "maintainer",
      accessSource: { source: "workspace_admin" },
    });

    expect(mocks.octokitRequest).not.toHaveBeenCalled();
  });

  it("rejects a collaborator response for a different GitHub user id", async () => {
    mocks.octokitRequest.mockResolvedValue({
      data: {
        permission: "write",
        role_name: "write",
        user: { id: 999, login: "maintainer" },
      },
    });

    await expect(
      assertDashboardRepositoryMutationAllowed("workspace_1", repository),
    ).rejects.toThrow("repository_mutation_forbidden");

    expect(
      mocks.updateRepositoryPermissionCacheFromLiveCheck,
    ).not.toHaveBeenCalled();
  });

  it("downshifts the repository permission cache when GitHub rejects the live check", async () => {
    const error = new Error("Not Found") as Error & { status: number };
    error.status = 404;
    mocks.octokitRequest.mockRejectedValue(error);

    await expect(
      assertDashboardRepositoryMutationAllowed("workspace_1", repository),
    ).rejects.toThrow("repository_mutation_forbidden");

    expect(
      mocks.updateRepositoryPermissionCacheFromLiveCheck,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryId: "repo_1",
        permission: "",
        roleName: "",
        canManage: false,
      }),
    );
  });

  it("authorizes recovery from the live permission without mutating the durable cache", async () => {
    mocks.octokitRequest.mockResolvedValue({
      data: {
        permission: "write",
        role_name: "write",
        user: { id: "123", login: "maintainer" },
      },
    });

    await expect(
      assertDashboardRepositoryRecoveryAllowed("workspace_1", repository),
    ).resolves.toMatchObject({
      accessSource: {
        source: "repo_manager",
        capability: "repo_manager",
      },
    });

    expect(mocks.octokitRequest).toHaveBeenCalledTimes(1);
    expect(
      mocks.updateRepositoryPermissionCacheFromLiveCheck,
    ).not.toHaveBeenCalled();
  });

  it("requires a successful live repository-manager check for a workspace admin", async () => {
    mocks.assertWorkspaceMutationAllowed.mockResolvedValueOnce(undefined);
    mocks.octokitRequest.mockResolvedValue({
      data: {
        permission: "admin",
        role_name: "admin",
        user: { id: "123", login: "maintainer" },
      },
    });

    await expect(
      assertDashboardRepositoryRecoveryAllowed("workspace_1", repository),
    ).resolves.toMatchObject({
      accessSource: {
        source: "repo_manager",
        capability: "repo_manager",
        permission: "admin",
      },
    });

    expect(mocks.assertWorkspaceMutationAllowed).not.toHaveBeenCalled();
    expect(mocks.octokitRequest).toHaveBeenCalledTimes(1);
    expect(
      mocks.updateRepositoryPermissionCacheFromLiveCheck,
    ).not.toHaveBeenCalled();
  });

  it("rejects a workspace admin whose live repository permission was revoked", async () => {
    mocks.assertWorkspaceMutationAllowed.mockResolvedValueOnce(undefined);
    mocks.octokitRequest.mockResolvedValue({
      data: {
        permission: "read",
        role_name: "read",
        user: { id: "123", login: "maintainer" },
      },
    });

    await expect(
      assertDashboardRepositoryRecoveryAllowed("workspace_1", repository),
    ).rejects.toThrow("repository_mutation_forbidden");

    expect(mocks.assertWorkspaceMutationAllowed).not.toHaveBeenCalled();
    expect(mocks.octokitRequest).toHaveBeenCalledTimes(1);
    expect(
      mocks.updateRepositoryPermissionCacheFromLiveCheck,
    ).not.toHaveBeenCalled();
  });

  it("rejects recovery after a failed live permission check without downshifting the durable cache", async () => {
    const error = new Error("Not Found") as Error & { status: number };
    error.status = 404;
    mocks.octokitRequest.mockRejectedValue(error);

    await expect(
      assertDashboardRepositoryRecoveryAllowed("workspace_1", repository),
    ).rejects.toThrow("repository_mutation_forbidden");

    expect(
      mocks.updateRepositoryPermissionCacheFromLiveCheck,
    ).not.toHaveBeenCalled();
  });

  it("creates a GitHub user-token requester for user-triggered repository writes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const octokit = await createGitHubUserOctokit({
      userId: "user_1",
      sourceProvider: "github",
      externalUserId: "123",
      sourceLogin: "maintainer",
      githubUserId: "123",
      githubLogin: "maintainer",
      actor: "user:github:maintainer",
    });

    await expect(
      octokit.request("PUT /repos/{owner}/{repo}/contents/{path}", {
        owner: "fin-int",
        repo: "tvaity",
        path: ".github/workflows/reviewrouter.yml",
        branch: "reviewrouter/setup",
        message: "chore: add ReviewRouter workflows",
        content: "Y29udGVudA==",
      }),
    ).resolves.toEqual({ data: { ok: true } });

    expect(mocks.getValidGitHubUserAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_1",
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      new URL(
        "https://api.github.com/repos/fin-int/tvaity/contents/.github/workflows/reviewrouter.yml",
      ),
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          Authorization: "Bearer ghu_user",
        }),
        body: JSON.stringify({
          branch: "reviewrouter/setup",
          message: "chore: add ReviewRouter workflows",
          content: "Y29udGVudA==",
        }),
      }),
    );
  });

  it("derives source identity from legacy GitHub-only session fields", async () => {
    mocks.getServerSession.mockResolvedValue({
      user: {
        githubUserId: "123",
        githubLogin: "maintainer",
        githubAvatarUrl: "https://avatars.githubusercontent.com/u/123",
      },
    });

    await expect(getDashboardSignedInActor()).resolves.toMatchObject({
      userId: "user_1",
      sourceProvider: "github",
      externalUserId: "123",
      sourceLogin: "maintainer",
      githubUserId: "123",
      githubLogin: "maintainer",
    });
  });

  it("does not copy GitLab external ids into GitHub actor fields", async () => {
    mocks.getServerSession.mockResolvedValue({
      user: {
        sourceProvider: "gitlab",
        externalUserId: "456",
        sourceLogin: "gitlab-maintainer",
        gitlabUserId: "456",
        gitlabLogin: "gitlab-maintainer",
      },
    });
    mocks.assertWorkspaceMutationAllowed.mockResolvedValue({
      allowed: true,
      reason: "allowed",
    });

    await expect(
      assertDashboardMutationAllowed("workspace_1"),
    ).resolves.toMatchObject({
      userId: "user_1",
      sourceProvider: "gitlab",
      externalUserId: "456",
      sourceLogin: "gitlab-maintainer",
      githubUserId: null,
      githubLogin: null,
      accessSource: { source: "workspace_admin" },
    });
    expect(mocks.assertWorkspaceMutationAllowed).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace_1",
        userId: "user_1",
        githubUserId: "",
        githubLogin: "",
      }),
      expect.any(Object),
    );
  });
});
