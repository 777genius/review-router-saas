import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDashboardSignedInActor: vi.fn(),
  getDashboardWorkspaceScope: vi.fn(),
  listGitHubUserRepositoryAccess: vi.fn(),
  listWorkspaceRepositoryHealth: vi.fn(),
  providerSetupFindMany: vi.fn(),
  reviewConfigurationFindUnique: vi.fn(),
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
    reviewConfiguration: { findUnique: mocks.reviewConfigurationFindUnique },
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
    mocks.reviewConfigurationFindUnique.mockResolvedValue(null);
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
      directConfigRepositoryIds: new Set<string>(),
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
      directConfigRepositoryIds: new Set<string>(),
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

  it("does not count legacy Codex setup as ready for rotating Codex policy", async () => {
    mocks.getDashboardWorkspaceScope.mockResolvedValue({
      kind: "workspace_ids",
      workspaceIds: ["workspace_1"],
    });
    mocks.listGitHubUserRepositoryAccess.mockResolvedValue({
      status: "ready",
      workspaceIds: [],
      repositoryIds: new Set<string>(),
      directConfigRepositoryIds: new Set<string>(),
      checkedAt: null,
    });
    mocks.repositoryConnectionFindMany.mockResolvedValue([
      repositoryRow({ id: "repo_legacy", fullName: "fin-int/legacy" }),
      repositoryRow({ id: "repo_rotating", fullName: "fin-int/rotating" }),
    ]);
    mocks.listWorkspaceRepositoryHealth.mockResolvedValue([
      staleProviderReport("repo_legacy"),
      staleProviderReport("repo_rotating"),
    ]);
    mocks.providerSetupFindMany.mockResolvedValue([
      providerSetupRow({
        repositoryId: "repo_legacy",
        authMode: "codex_subscription_oauth",
      }),
      providerSetupRow({
        repositoryId: "repo_rotating",
        authMode: "codex_subscription_oauth_rotating",
      }),
    ]);

    const response = await GET(
      nextRequest(
        "http://localhost/api/dashboard/repositories/search?workspace=fin-int&setup=ready",
      ),
    );

    await expect(response.json()).resolves.toMatchObject({
      repositoryIds: ["repo_rotating"],
      total: 2,
      filter: "ready",
    });
  });

  it("does not let a stale healthy report hide a legacy provider setup mismatch", async () => {
    mocks.getDashboardWorkspaceScope.mockResolvedValue({
      kind: "workspace_ids",
      workspaceIds: ["workspace_1"],
    });
    mocks.listGitHubUserRepositoryAccess.mockResolvedValue({
      status: "ready",
      workspaceIds: [],
      repositoryIds: new Set<string>(),
      directConfigRepositoryIds: new Set<string>(),
      checkedAt: null,
    });
    mocks.repositoryConnectionFindMany.mockResolvedValue([
      repositoryRow({ id: "repo_legacy", fullName: "fin-int/legacy" }),
      repositoryRow({ id: "repo_rotating", fullName: "fin-int/rotating" }),
    ]);
    mocks.listWorkspaceRepositoryHealth.mockResolvedValue([
      healthyReport("repo_legacy"),
      healthyReport("repo_rotating"),
    ]);
    mocks.providerSetupFindMany.mockResolvedValue([
      providerSetupRow({
        repositoryId: "repo_legacy",
        authMode: "codex_subscription_oauth",
      }),
      providerSetupRow({
        repositoryId: "repo_rotating",
        authMode: "codex_subscription_oauth_rotating",
      }),
    ]);

    const response = await GET(
      nextRequest(
        "http://localhost/api/dashboard/repositories/search?workspace=fin-int&setup=ready",
      ),
    );

    await expect(response.json()).resolves.toMatchObject({
      repositoryIds: ["repo_rotating"],
      total: 2,
      filter: "ready",
    });
  });

  it("loads repository policies for non-configured provider setup rows", async () => {
    mocks.reviewConfigurationFindUnique.mockImplementation(
      async (input: ReviewConfigurationFindUniqueInput) => {
        const targetKey = input.where?.workspaceId_targetKey?.targetKey;
        if (targetKey !== "repo:repo_missing") return null;

        return {
          versions: [
            reviewConfigurationVersionRow({
              providerKind: "openrouter",
              providerAuthMode: "openrouter_api_key",
              model: "poolside/laguna-m.1:free",
            }),
          ],
        };
      },
    );
    mocks.getDashboardWorkspaceScope.mockResolvedValue({
      kind: "workspace_ids",
      workspaceIds: ["workspace_1"],
    });
    mocks.listGitHubUserRepositoryAccess.mockResolvedValue({
      status: "ready",
      workspaceIds: [],
      repositoryIds: new Set<string>(),
      directConfigRepositoryIds: new Set<string>(),
      checkedAt: null,
    });
    mocks.repositoryConnectionFindMany.mockResolvedValue([
      repositoryRow({ id: "repo_missing", fullName: "fin-int/missing" }),
    ]);
    mocks.listWorkspaceRepositoryHealth.mockResolvedValue([
      healthyReport("repo_missing"),
    ]);
    mocks.providerSetupFindMany.mockResolvedValue([
      providerSetupRow({
        repositoryId: "repo_missing",
        authMode: "openrouter_api_key",
        providerKind: "openrouter",
        state: "missing",
      }),
    ]);

    const response = await GET(
      nextRequest(
        "http://localhost/api/dashboard/repositories/search?workspace=fin-int&setup=ready",
      ),
    );

    await expect(response.json()).resolves.toMatchObject({
      repositoryIds: [],
      total: 1,
      filter: "ready",
    });
    expect(mocks.reviewConfigurationFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workspaceId_targetKey: {
            workspaceId: "workspace_1",
            targetKey: "repo:repo_missing",
          },
        },
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

function staleProviderReport(repositoryId: string) {
  return {
    repositoryId,
    status: "provider_report_stale",
    summary: "No recent provider report",
    latestActionHealthReceivedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

function healthyReport(repositoryId: string) {
  return {
    repositoryId,
    status: "healthy",
    summary: "Ready",
    latestActionHealthReceivedAt: new Date("2026-01-02T00:00:00Z"),
  };
}

function providerSetupRow(input: {
  readonly repositoryId: string;
  readonly authMode: string;
  readonly providerKind?: string;
  readonly state?: string;
}) {
  return {
    repositoryId: input.repositoryId,
    providerKind: input.providerKind ?? "codex",
    authMode: input.authMode,
    state: input.state ?? "configured",
    updatedAt: new Date("2026-01-02T00:00:00Z"),
  };
}

type ReviewConfigurationFindUniqueInput = {
  readonly where?: {
    readonly workspaceId_targetKey?: {
      readonly targetKey?: string;
    };
  };
};

function reviewConfigurationVersionRow(input: {
  readonly providerKind: "codex" | "claude" | "openrouter";
  readonly providerAuthMode:
    | "claude_code_oauth"
    | "codex_subscription_oauth_rotating"
    | "openrouter_api_key";
  readonly model: string;
}) {
  return {
    version: 1,
    schemaVersion: 2,
    providerKind: input.providerKind,
    providerAuthMode: input.providerAuthMode,
    model: input.model,
    reasoningEffort: "medium",
    agenticContext: true,
    fastMode: false,
    failOnSeverity: "critical",
    inlineMaxComments: 5,
    providerLimit: 1,
    providerMaxParallel: 1,
    inlineMinAgreement: 1,
    targetTokensPerBatch: 50000,
    providers: [
      {
        providerKind: input.providerKind,
        providerAuthMode: input.providerAuthMode,
        model: input.model,
        reasoningEffort: "medium",
        agenticContext: true,
        fastMode: false,
        requiredHealthy: true,
      },
    ],
  };
}
