import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDashboardSignedInActor: vi.fn(),
  getDashboardWorkspaceScope: vi.fn(),
  listGitHubUserRepositoryAccess: vi.fn(),
  listWorkspaceRepositoryHealth: vi.fn(),
  providerSetupFindMany: vi.fn(),
  repositoryConnectionFindMany: vi.fn(),
  workspaceFindMany: vi.fn(),
}));

vi.mock("@reviewrouter/features-repo-health", () => ({
  listWorkspaceRepositoryHealth: mocks.listWorkspaceRepositoryHealth,
  PrismaRepositoryHealthRepository: class PrismaRepositoryHealthRepository {},
}));

vi.mock("@reviewrouter/platform-config", () => ({
  resolveReviewRouterActionRef: () => "reviewrouter/action@v1",
}));

vi.mock("../../../../../src/server/dashboard-mutations", () => ({
  getDashboardSignedInActor: mocks.getDashboardSignedInActor,
  getDashboardWorkspaceScope: mocks.getDashboardWorkspaceScope,
}));

vi.mock("../../../../../src/server/github-user-repository-access", () => ({
  listGitHubUserRepositoryAccess: mocks.listGitHubUserRepositoryAccess,
}));

vi.mock("../../../../../src/server/prisma", () => ({
  getPrisma: () => ({
    providerSetupState: { findMany: mocks.providerSetupFindMany },
    repositoryConnection: { findMany: mocks.repositoryConnectionFindMany },
    workspace: { findMany: mocks.workspaceFindMany },
  }),
}));

import { GET } from "./route";

describe("dashboard repository search route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDashboardSignedInActor.mockResolvedValue({
      userId: "user_1",
      githubUserId: "123",
      githubLogin: "maintainer",
      actor: "user:maintainer",
    });
    mocks.workspaceFindMany.mockResolvedValue([
      {
        id: "workspace_1",
        slug: "fin-int",
        name: "Fin Int",
        installations: [{ accountLogin: "fin-int" }],
      },
    ]);
    mocks.providerSetupFindMany.mockResolvedValue([]);
    mocks.listWorkspaceRepositoryHealth.mockResolvedValue([]);
  });

  it("filters repo-only search results to repositories the GitHub user can manage", async () => {
    mocks.getDashboardWorkspaceScope.mockResolvedValue({
      kind: "workspace_ids",
      workspaceIds: [],
    });
    mocks.listGitHubUserRepositoryAccess.mockResolvedValue({
      status: "ready",
      workspaceIds: ["workspace_1"],
      repositoryIds: new Set(["repo_allowed"]),
      checkedAt: new Date("2026-05-12T10:00:00Z"),
    });
    mocks.repositoryConnectionFindMany.mockResolvedValue([
      repositoryRow({ id: "repo_allowed", fullName: "fin-int/tvaity" }),
    ]);

    const response = await GET(
      nextRequest(
        "http://localhost/api/dashboard/repositories/search?workspace=fin-int&q=tvaity",
      ),
    );

    await expect(response.json()).resolves.toMatchObject({
      repositoryIds: ["repo_allowed"],
      total: 1,
      query: "tvaity",
      filter: "all",
    });
    expect(mocks.repositoryConnectionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workspaceId: "workspace_1",
          id: { in: ["repo_allowed"] },
        },
      }),
    );
  });

  it("keeps workspace-admin search unrestricted by repository permission cache", async () => {
    mocks.getDashboardWorkspaceScope.mockResolvedValue({
      kind: "workspace_ids",
      workspaceIds: ["workspace_1"],
    });
    mocks.listGitHubUserRepositoryAccess.mockResolvedValue({
      status: "ready",
      workspaceIds: [],
      repositoryIds: new Set<string>(),
      checkedAt: null,
    });
    mocks.repositoryConnectionFindMany.mockResolvedValue([
      repositoryRow({ id: "repo_admin", fullName: "fin-int/admin-repo" }),
    ]);

    const response = await GET(
      nextRequest(
        "http://localhost/api/dashboard/repositories/search?workspace=fin-int&q=admin",
      ),
    );

    await expect(response.json()).resolves.toMatchObject({
      repositoryIds: ["repo_admin"],
      total: 1,
      query: "admin",
    });
    expect(mocks.repositoryConnectionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: "workspace_1" },
      }),
    );
  });

  it("does not discover repositories for signed-out search requests", async () => {
    mocks.getDashboardWorkspaceScope.mockResolvedValue({
      kind: "none",
      reason: "signed_out",
    });

    const response = await GET(
      nextRequest("http://localhost/api/dashboard/repositories/search"),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "sign_in_required",
    });
    expect(mocks.listGitHubUserRepositoryAccess).not.toHaveBeenCalled();
    expect(mocks.repositoryConnectionFindMany).not.toHaveBeenCalled();
  });
});

function nextRequest(url: string) {
  return { nextUrl: new URL(url) } as Parameters<typeof GET>[0];
}

function repositoryRow(input: {
  readonly id: string;
  readonly fullName: string;
}) {
  const [owner = "", name = ""] = input.fullName.split("/");
  return {
    id: input.id,
    fullName: input.fullName,
    owner,
    name,
    defaultBranch: "main",
    visibility: "private",
    setupStatus: "configured",
    selected: true,
    archived: false,
    stargazersCount: 0,
  };
}
