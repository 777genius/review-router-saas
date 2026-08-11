import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  events: [] as string[],
  inspectStatus: vi.fn(),
  recoverAndIssue: vi.fn(),
  updatePermissionCache: vi.fn(),
}));

vi.mock("next-auth", () => ({
  getServerSession: () =>
    Promise.resolve({
      user: {
        sourceProvider: "github",
        externalUserId: "123",
        sourceLogin: "maintainer",
        githubUserId: "123",
        githubLogin: "maintainer",
      },
    }),
}));
vi.mock("@reviewrouter/features-auth", () => ({
  assertWorkspaceMutationAllowed: () =>
    Promise.reject(new Error("workspace_mutation_forbidden:missing_role")),
  listVisibleWorkspaceScope: vi.fn(),
  PrismaWorkspaceAccessRepository: class PrismaWorkspaceAccessRepository {},
}));
vi.mock("@reviewrouter/platform-config", () => ({
  requireGitHubAppPrivateKey: () => "test-private-key",
  requireReviewRouterDatabaseRecoveryWitness: () => "w".repeat(43),
}));
vi.mock("@octokit/app", () => ({
  App: class App {
    getInstallationOctokit() {
      return {
        request: () => {
          mocks.events.push("live-permission-admission");
          return Promise.resolve({
            data: {
              permission: "write",
              role_name: "write",
              user: { id: "123", login: "maintainer" },
            },
          });
        },
      };
    }
  },
}));
vi.mock("../../../../../src/auth/auth-env", () => ({
  getAuthEnvironmentStatus: () => ({ configured: true, missing: [] }),
}));
vi.mock("../../../../../src/auth/auth-options", () => ({ authOptions: {} }));
vi.mock("../../../../../src/server/github-user-repository-access", () => ({
  updateRepositoryPermissionCacheFromLiveCheck: mocks.updatePermissionCache,
}));
vi.mock("../../../../../src/server/github-user-authorization", () => ({
  getValidGitHubUserAccessToken: vi.fn(),
}));

const prisma = {
  userExternalIdentity: {
    findUnique: () => Promise.resolve({ userId: "user_1" }),
  },
  repositoryConnection: {
    findUnique: () =>
      Promise.resolve({
        id: "repository_1",
        workspaceId: "workspace_1",
        provider: "github",
        githubRepositoryId: 123n,
        owner: "owner",
        name: "repo",
        fullName: "owner/repo",
        selected: true,
        archived: false,
        installation: { status: "active", githubInstallationId: 456n },
      }),
  },
};

vi.mock("../../../../../src/server/prisma", () => ({
  getPrisma: () => prisma,
}));
vi.mock("../../../../../src/server/codex-rotating-setup-recovery", () => ({
  recoverAndIssueCodexRotatingSetup: mocks.recoverAndIssue,
}));
vi.mock(
  "../../../../../src/server/prisma-codex-rotating-setup-recovery",
  () => ({
    PrismaCodexRotatingSetupRecovery: class {
      inspectStatus = mocks.inspectStatus;
    },
  }),
);

import { GET, POST } from "./route";

describe("dashboard recovery authorization ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.events.length = 0;
    vi.stubEnv("GITHUB_APP_ID", "12345");
    vi.stubEnv("REVIEW_ROUTER_ENABLE_DASHBOARD_MUTATIONS", "1");
    mocks.inspectStatus.mockImplementation(() => {
      mocks.events.push("recovery-witness-inspection");
      return Promise.resolve({ status: "ready" });
    });
    mocks.recoverAndIssue.mockImplementation(() => {
      mocks.events.push("recovery-witness-admission");
      return Promise.resolve({
        command: "safe recovery command",
        expiresAt: "2026-08-10T01:00:00.000Z",
        providerInstanceId: "codex-rotating:123",
        recoveryStatus: "recovered",
      });
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("GET performs the real live authorization decision without a durable cache write before witness inspection", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/dashboard/codex-rotating/setup-recovery?workspaceId=workspace_1&repositoryId=repository_1",
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.events).toEqual([
      "live-permission-admission",
      "recovery-witness-inspection",
    ]);
    expect(mocks.updatePermissionCache).not.toHaveBeenCalled();
  });

  it("POST performs the real live authorization decision without a durable cache write before recovery admission", async () => {
    const body = new FormData();
    body.set("workspaceId", "workspace_1");
    body.set("repositoryId", "repository_1");
    body.set("recoveryRequestId", "recovery-request-1");
    body.set("acknowledgement", "all_prior_installers_and_writers_are_stopped");

    const response = await POST(
      new Request(
        "http://localhost/api/dashboard/codex-rotating/setup-recovery",
        { method: "POST", body },
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.events).toEqual([
      "live-permission-admission",
      "recovery-witness-admission",
    ]);
    expect(mocks.updatePermissionCache).not.toHaveBeenCalled();
  });
});
