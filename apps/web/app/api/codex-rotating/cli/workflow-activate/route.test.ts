import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  activate: vi.fn(),
  authorize: vi.fn(),
  createOctokit: vi.fn(),
  findFirst: vi.fn(),
}));

vi.mock("../../../../../src/server/codex-rotating-workflow-activation", () => ({
  activateConfirmedCodexNamespaceAfterWorkflowMerge: mocks.activate,
}));
vi.mock("../../../../../src/server/dashboard-mutations", () => ({
  createGitHubAppInstallationOctokit: mocks.createOctokit,
}));
vi.mock(
  "../../../../../src/server/github-cli-repository-authorization",
  () => ({ authorizeGitHubCliRepository: mocks.authorize }),
);
vi.mock("../../../../../src/server/prisma", () => ({
  getPrisma: () => ({ repositoryConnection: { findFirst: mocks.findFirst } }),
}));
vi.mock("../../../../../src/server/workflow-public-api-url", () => ({
  resolveWorkflowPublicApiUrl: () => "https://api.reviewrouter.test",
}));

import { POST } from "./route";

describe("Codex rotating CLI workflow activation route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorize.mockResolvedValue({
      githubRepositoryId: "1228051727",
      fullName: "777genius/review-router-saas-e2e",
    });
    mocks.findFirst.mockResolvedValue({
      id: "repo_1",
      workspaceId: "workspace_1",
      githubRepositoryId: 1228051727n,
      owner: "777genius",
      name: "review-router-saas-e2e",
      fullName: "777genius/review-router-saas-e2e",
      defaultBranch: "main",
      selected: true,
      archived: false,
      installation: {
        status: "active",
        githubInstallationId: 130834037n,
      },
    });
    mocks.createOctokit.mockResolvedValue({ request: vi.fn() });
    mocks.activate.mockResolvedValue({
      status: "activated",
      namespaceEpoch: "2",
      workflowSourceCommitSha: "a".repeat(40),
    });
  });

  it("reauthorizes repository management and activates through the App", async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.authorize).toHaveBeenCalledWith({
      accessToken: "github-token-value",
      repositoryFullName: "777genius/review-router-saas-e2e",
    });
    expect(mocks.createOctokit).toHaveBeenCalledWith("130834037");
    expect(mocks.activate).toHaveBeenCalledWith(
      expect.objectContaining({
        githubRepositoryId: "1228051727",
        expectedApiUrl: "https://api.reviewrouter.test",
      }),
    );
    await expect(response.json()).resolves.toEqual({
      status: "activated",
      namespaceEpoch: "2",
      workflowSourceCommitSha: "a".repeat(40),
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects missing bearer auth before repository access", async () => {
    const response = await POST(
      new Request("https://reviewrouter.test/activate", {
        method: "POST",
        body: JSON.stringify({
          repository: "777genius/review-router-saas-e2e",
        }),
      }),
    );

    expect(response.status).toBe(401);
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.findFirst).not.toHaveBeenCalled();
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it("fails before activation when the stored repository identity differs", async () => {
    mocks.findFirst.mockResolvedValueOnce({
      ...(await repositoryFixture()),
      fullName: "777genius/a-different-repository",
    });

    const response = await POST(request());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "repository_mismatch",
    });
    expect(mocks.createOctokit).not.toHaveBeenCalled();
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it("fails closed when no rotating provider is configured", async () => {
    mocks.activate.mockResolvedValueOnce({ status: "not_configured" });

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "codex_rotating_not_enabled",
    });
  });

  it("does not expose unexpected internal errors", async () => {
    mocks.activate.mockRejectedValueOnce(
      new Error("database-password-should-not-escape"),
    );

    const response = await POST(request());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_request",
    });
  });
});

function request(): Request {
  return new Request("https://reviewrouter.test/activate", {
    method: "POST",
    headers: {
      Authorization: "Bearer github-token-value",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      repository: "777genius/review-router-saas-e2e",
    }),
  });
}

async function repositoryFixture() {
  return {
    id: "repo_1",
    workspaceId: "workspace_1",
    githubRepositoryId: 1228051727n,
    owner: "777genius",
    name: "review-router-saas-e2e",
    fullName: "777genius/review-router-saas-e2e",
    defaultBranch: "main",
    selected: true,
    archived: false,
    installation: {
      status: "active",
      githubInstallationId: 130834037n,
    },
  };
}
