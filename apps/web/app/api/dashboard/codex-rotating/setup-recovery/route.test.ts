import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  findUnique: vi.fn(),
  recoverAndIssue: vi.fn(),
  inspectStatus: vi.fn(),
}));

vi.mock("../../../../../src/server/dashboard-mutations", () => ({
  assertDashboardRepositoryMutationAllowed: mocks.authorize,
}));
vi.mock("../../../../../src/server/prisma", () => ({
  getPrisma: () => ({ repositoryConnection: { findUnique: mocks.findUnique } }),
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

describe("dashboard Codex setup recovery route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUnique.mockResolvedValue({
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
    });
    mocks.authorize.mockResolvedValue({ actor: "user:github:operator" });
    mocks.inspectStatus.mockResolvedValue({ status: "ready" });
  });

  it("rejects an unauthorized repository operator before recovery", async () => {
    mocks.authorize.mockRejectedValueOnce(
      new Error("repository_mutation_forbidden"),
    );
    const response = await POST(recoveryRequest(true));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "repository_mutation_forbidden",
    });
    expect(mocks.recoverAndIssue).not.toHaveBeenCalled();
  });

  it("requires an explicit acknowledgement", async () => {
    const response = await POST(recoveryRequest(false));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "codex_rotating_setup_recovery_acknowledgement_required",
    });
    expect(mocks.authorize).not.toHaveBeenCalled();
  });

  it("returns safe actionable quarantine details without a repair mutation", async () => {
    mocks.inspectStatus.mockResolvedValueOnce({
      status: "identity_quarantined",
      quarantine: {
        providerInstanceRowId: "provider-row-1",
        workspaceId: "workspace_1",
        repositoryId: "repository_1",
        observedProviderInstanceId: "codex-rotating:999",
        expectedProviderInstanceId: "codex-rotating:123",
        reason: "canonical_id_mismatch",
        quarantinedAt: new Date("2026-08-09T10:00:00.000Z"),
      },
    });
    const response = await GET(
      new Request(
        "http://localhost/api/dashboard/codex-rotating/setup-recovery?workspaceId=workspace_1&repositoryId=repository_1",
      ),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "identity_quarantined",
      reason: "canonical_id_mismatch",
      observedProviderInstanceId: "codex-rotating:999",
      expectedProviderInstanceId: "codex-rotating:123",
      quarantinedAt: "2026-08-09T10:00:00.000Z",
      action: expect.stringContaining("will not rewrite immutable identity"),
    });
    expect(mocks.recoverAndIssue).not.toHaveBeenCalled();
  });
});

function recoveryRequest(acknowledge: boolean): Request {
  const body = new FormData();
  body.set("workspaceId", "workspace_1");
  body.set("repositoryId", "repository_1");
  body.set("recoveryRequestId", "recovery-request-1");
  if (acknowledge) {
    body.set("acknowledgement", "github_secret_may_have_changed");
  }
  return new Request(
    "http://localhost/api/dashboard/codex-rotating/setup-recovery",
    { method: "POST", body },
  );
}
