import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertDashboardRepositoryMutationAllowed: vi.fn(),
  findUnique: vi.fn(),
  issueCodexRotatingSetupForRepository: vi.fn(),
}));

vi.mock("../../../../../src/server/dashboard-mutations", () => ({
  assertDashboardRepositoryMutationAllowed:
    mocks.assertDashboardRepositoryMutationAllowed,
}));

vi.mock("../../../../../src/server/prisma", () => ({
  getPrisma: () => ({
    repositoryConnection: { findUnique: mocks.findUnique },
  }),
}));

vi.mock("../../../../../src/server/codex-rotating-setup-command", () => ({
  issueCodexRotatingSetupForRepository:
    mocks.issueCodexRotatingSetupForRepository,
}));

import { POST } from "./route";

describe("dashboard Codex rotating setup command route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUnique.mockResolvedValue({
      id: "repository_1",
      workspaceId: "workspace_1",
      provider: "github",
      githubRepositoryId: 123456n,
      owner: "777genius",
      name: "review-router-saas-e2e",
      fullName: "777genius/review-router-saas-e2e",
      visibility: "private",
      selected: true,
      archived: false,
      installation: {
        status: "active",
        githubInstallationId: 987654n,
      },
    });
    mocks.assertDashboardRepositoryMutationAllowed.mockResolvedValue(undefined);
  });

  it("reports an active setup reservation as a retryable conflict", async () => {
    mocks.issueCodexRotatingSetupForRepository.mockRejectedValueOnce(
      new Error("codex_rotating_setup_in_progress"),
    );

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "codex_rotating_setup_in_progress",
    });
  });

  it("reports setup lock contention as a retryable conflict", async () => {
    mocks.issueCodexRotatingSetupForRepository.mockRejectedValueOnce(
      new Error("codex_rotating_setup_lock_failed"),
    );

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "codex_rotating_setup_lock_failed",
    });
  });

  it("returns an actionable unavailable response while issuance is quiesced", async () => {
    mocks.issueCodexRotatingSetupForRepository.mockRejectedValueOnce(
      new Error("codex_rotating_setup_issuance_quiesced"),
    );
    const response = await POST(request());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "codex_rotating_setup_issuance_quiesced",
    });
  });
});

function request(): Request {
  const body = new FormData();
  body.set("workspaceId", "workspace_1");
  body.set("repositoryId", "repository_1");
  return new Request(
    "http://localhost/api/dashboard/codex-rotating/setup-command",
    { method: "POST", body },
  );
}
