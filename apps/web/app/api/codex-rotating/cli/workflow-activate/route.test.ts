import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  activate: vi.fn(),
  assertEntitlement: vi.fn(),
  assertRateLimit: vi.fn(),
  authorize: vi.fn(),
  createOctokit: vi.fn(),
  findFirst: vi.fn(),
  rolloverLedger: vi.fn(),
  runtimeRepository: vi.fn(),
}));

vi.mock("@reviewrouter/features-action-control-plane", () => ({
  PrismaCodexRotatingOAuthRepository: class {
    constructor(...args: unknown[]) {
      mocks.runtimeRepository(...args);
    }
  },
  PrismaCodexZeroLoginRolloverLedger: class {
    constructor(...args: unknown[]) {
      mocks.rolloverLedger(...args);
    }
  },
}));

vi.mock("@reviewrouter/platform-config", () => ({
  requireReviewRouterDatabaseRecoveryWitness: () => "test-witness",
  resolveReviewRouterCodexRotatingActionRef: () =>
    `777genius/review-router@${"d".repeat(40)}`,
  resolveReviewRouterCodexRotatingTrustedActionRefs: () => [
    `777genius/review-router@${"d".repeat(40)}`,
  ],
  REVIEW_ROUTER_ACTION_REPOSITORY: "777genius/review-router",
}));

vi.mock("@reviewrouter/features-entitlements", () => ({
  assertWorkspaceFeatureEntitlement: mocks.assertEntitlement,
  PrismaEntitlementRepository: class {},
}));

vi.mock("../../../../../src/server/codex-rotating-workflow-activation", () => ({
  activateConfirmedCodexNamespaceAfterWorkflowMerge: mocks.activate,
}));
vi.mock("../../../../../src/server/dashboard-mutations", () => ({
  createGitHubAppInstallationOctokit: mocks.createOctokit,
}));
vi.mock("../../../../../src/server/dashboard-rate-limits", () => ({
  createDashboardRateLimitPolicy: () => ({
    assertWorkflowActivationAllowed: mocks.assertRateLimit,
  }),
}));
vi.mock(
  "../../../../../src/server/github-cli-repository-authorization",
  () => ({ authorizeGitHubCliRepository: mocks.authorize }),
);
vi.mock("../../../../../src/server/prisma", () => ({
  getPrisma: () => ({ repositoryConnection: { findFirst: mocks.findFirst } }),
  getCodexEffectAuthorityPrisma: () => ({ authority: true }),
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
    mocks.findFirst.mockResolvedValue(repositoryFixture());
    mocks.assertEntitlement.mockResolvedValue(undefined);
    mocks.assertRateLimit.mockResolvedValue(undefined);
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
    expect(mocks.assertEntitlement).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace_1",
        feature: "workflow_provisioning",
      }),
      expect.any(Object),
    );
    expect(mocks.assertRateLimit).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      repositoryId: "repo_1",
    });
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

  it("passes exact rollover activation evidence to the supported endpoint", async () => {
    const response = await POST(
      request("777genius/review-router-saas-e2e", {
        rolloverOperationId: "campaign-1:repo-1",
        expectedNamespaceEpoch: "8",
        expectedDefaultHeadSha: "a".repeat(40),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.runtimeRepository).toHaveBeenCalledOnce();
    expect(mocks.rolloverLedger).toHaveBeenCalledOnce();
    expect(mocks.activate).toHaveBeenCalledWith(
      expect.objectContaining({
        zeroLoginRollover: expect.objectContaining({
          operationId: "campaign-1:repo-1",
          expectedNamespaceEpoch: 8n,
          expectedDefaultHeadSha: "a".repeat(40),
          ledger: expect.any(Object),
        }),
      }),
    );
  });

  it("rejects partial rollover evidence before authorization", async () => {
    const response = await POST(
      request("777genius/review-router-saas-e2e", {
        rolloverOperationId: "campaign-1:repo-1",
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.activate).not.toHaveBeenCalled();
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
      ...repositoryFixture(),
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

  it.each([
    ["repository_not_selected", { selected: false }],
    ["repository_archived", { archived: true }],
    [
      "installation_not_active",
      {
        installation: { status: "suspended", githubInstallationId: 130834037n },
      },
    ],
  ])("blocks %s before GitHub App access", async (error, override) => {
    mocks.findFirst.mockResolvedValueOnce({
      ...repositoryFixture(),
      ...override,
    });

    const response = await POST(request());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error });
    expect(mocks.createOctokit).not.toHaveBeenCalled();
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it.each([
    ["github_cli_repository_forbidden", 403],
    ["github_cli_repository_not_found", 404],
  ])("maps %s without repository lookup", async (error, status) => {
    mocks.authorize.mockRejectedValueOnce(new Error(error));

    const response = await POST(request());

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error });
    expect(mocks.findFirst).not.toHaveBeenCalled();
    expect(mocks.createOctokit).not.toHaveBeenCalled();
  });

  it("rejects dot-only repository path segments", async () => {
    const response = await POST(request("../.."));

    expect(response.status).toBe(400);
    expect(mocks.authorize).not.toHaveBeenCalled();
  });

  it("stops before GitHub App access when entitlement is denied", async () => {
    mocks.assertEntitlement.mockRejectedValueOnce(
      new Error("entitlement_denied:workflow_provisioning:paused"),
    );

    const response = await POST(request());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "entitlement_denied",
    });
    expect(mocks.createOctokit).not.toHaveBeenCalled();
  });

  it("stops before GitHub App access when activation is rate limited", async () => {
    mocks.assertRateLimit.mockRejectedValueOnce(
      new Error("rate_limit_exceeded:workflow_activation"),
    );

    const response = await POST(request());

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({ error: "rate_limited" });
    expect(mocks.createOctokit).not.toHaveBeenCalled();
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

  it("extracts only an allowlisted activation invariant from wrapped errors", async () => {
    mocks.activate.mockRejectedValueOnce(
      new Error(
        "Raw query failed. Code: 23514. Message: codex_oauth_setup_recovery_evidence_immutable; private detail omitted",
      ),
    );

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "codex_oauth_setup_recovery_evidence_immutable",
    });
  });

  it.each([
    "prefix_codex_oauth_setup_recovery_evidence_immutable",
    "codex_oauth_setup_recovery_evidence_immutable_suffix",
  ])("does not classify allowlisted substrings in %s", async (wrappedCode) => {
    mocks.activate.mockRejectedValueOnce(
      new Error(`Raw query failed with ${wrappedCode}`),
    );

    const response = await POST(request());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_request",
    });
  });
});

function request(
  repository = "777genius/review-router-saas-e2e",
  rollover?: Readonly<Record<string, string>>,
): Request {
  return new Request("https://reviewrouter.test/activate", {
    method: "POST",
    headers: {
      Authorization: "Bearer github-token-value",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      repository,
      ...rollover,
    }),
  });
}

function repositoryFixture() {
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
