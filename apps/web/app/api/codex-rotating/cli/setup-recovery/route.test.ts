import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  findFirst: vi.fn(),
  recoverAndIssue: vi.fn(),
}));

vi.mock(
  "../../../../../src/server/github-cli-repository-authorization",
  () => ({
    authorizeGitHubCliRepository: mocks.authorize,
  }),
);
vi.mock("../../../../../src/server/prisma", () => ({
  getPrisma: () => ({ repositoryConnection: { findFirst: mocks.findFirst } }),
}));
vi.mock("../../../../../src/server/codex-rotating-setup-recovery", () => ({
  recoverAndIssueCodexRotatingSetup: mocks.recoverAndIssue,
}));

import { POST } from "./route";

describe("Codex rotating CLI setup recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorize.mockResolvedValue({
      githubRepositoryId: "123",
      fullName: "owner/repo",
    });
    mocks.findFirst.mockResolvedValue({
      id: "repository_1",
      workspaceId: "workspace_1",
      provider: "github",
      githubRepositoryId: 123n,
      fullName: "owner/repo",
      selected: true,
      archived: false,
      installation: { status: "active" },
    });
    mocks.recoverAndIssue.mockResolvedValue({
      command: "safe forced reseed command",
      expiresAt: "2026-08-09T12:15:00.000Z",
      providerInstanceId: "codex-rotating:123",
      recoveryStatus: "recovered",
    });
  });

  it("rejects unauthorized recovery", async () => {
    mocks.authorize.mockRejectedValueOnce(
      new Error("github_cli_repository_forbidden"),
    );
    const response = await POST(request(true));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "github_cli_repository_forbidden",
    });
    expect(mocks.recoverAndIssue).not.toHaveBeenCalled();
  });

  it("requires the exact acknowledgement", async () => {
    const response = await POST(request(false));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "codex_rotating_setup_recovery_acknowledgement_required",
    });
    expect(mocks.authorize).not.toHaveBeenCalled();
  });

  it("audits a safe token fingerprint without returning the token", async () => {
    const response = await POST(request(true));
    expect(response.status).toBe(200);
    expect(mocks.recoverAndIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: expect.stringMatching(/^github-cli:token-sha256:[0-9a-f]{64}$/),
      }),
    );
    const call = mocks.recoverAndIssue.mock.calls[0]![0];
    expect(call.actor).not.toContain("github-token-value");
    expect(JSON.stringify(await response.json())).not.toContain(
      "github-token-value",
    );
  });
});

function request(acknowledge: boolean): Request {
  return new Request(
    "https://reviewrouter.site/api/codex-rotating/cli/setup-recovery",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer github-token-value",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        repository: "owner/repo",
        recoveryRequestId: "recovery-request-1",
        ...(acknowledge
          ? { acknowledgement: "github_secret_may_have_changed" }
          : {}),
      }),
    },
  );
}
