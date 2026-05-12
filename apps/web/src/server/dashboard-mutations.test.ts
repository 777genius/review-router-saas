import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertWorkspaceMutationAllowed: vi.fn(),
  getPrisma: vi.fn(),
  getServerSession: vi.fn(),
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

vi.mock("./prisma", () => ({
  getPrisma: mocks.getPrisma,
}));

import { assertDashboardRepositoryMutationAllowed } from "./dashboard-mutations";

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
        githubUserId: "123",
        githubLogin: "maintainer",
      },
    });
    mocks.getPrisma.mockReturnValue({
      user: {
        findUnique: vi.fn().mockResolvedValue({ id: "user_1" }),
      },
    });
    mocks.assertWorkspaceMutationAllowed.mockRejectedValue(
      new Error("workspace_mutation_forbidden:missing_role"),
    );
    mocks.updateRepositoryPermissionCacheFromLiveCheck.mockResolvedValue(
      undefined,
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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
});
