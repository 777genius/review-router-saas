import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  findUnique: vi.fn(),
  recoverAndIssue: vi.fn(),
  inspectStatus: vi.fn(),
  recoveryConstructor: vi.fn(),
}));

vi.mock("../../../../../src/server/dashboard-mutations", () => ({
  assertDashboardRepositoryRecoveryAllowed: mocks.authorize,
}));
vi.mock("../../../../../src/server/prisma", () => ({
  getPrisma: () => ({ repositoryConnection: { findUnique: mocks.findUnique } }),
}));
vi.mock("../../../../../src/server/codex-rotating-setup-recovery", () => ({
  recoverAndIssueCodexRotatingSetup: mocks.recoverAndIssue,
}));
vi.mock("@reviewrouter/platform-config", () => ({
  requireReviewRouterDatabaseRecoveryWitness: () => "w".repeat(43),
}));
vi.mock(
  "../../../../../src/server/prisma-codex-rotating-setup-recovery",
  () => ({
    PrismaCodexRotatingSetupRecovery: class {
      constructor(...args: unknown[]) {
        mocks.recoveryConstructor(...args);
      }
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
    mocks.recoverAndIssue.mockResolvedValue({
      command: "safe recovery command",
      expiresAt: "2026-08-10T01:00:00.000Z",
      providerInstanceId: "codex-rotating:123",
      recoveryStatus: "recovered",
    });
  });

  it("does not advertise the retired stable secret in recovery responses", async () => {
    const response = await POST(recoveryRequest(true));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      command: "safe recovery command",
      expiresAt: "2026-08-10T01:00:00.000Z",
      providerInstanceId: "codex-rotating:123",
      recoveryStatus: "recovered",
    });
    expect(JSON.stringify(body)).not.toContain("REVIEWROUTER_CODEX_AUTH_JSON");
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

  it("returns 401 when dashboard authentication is missing", async () => {
    mocks.authorize.mockRejectedValueOnce(
      new Error("dashboard_mutation_requires_sign_in"),
    );
    const response = await POST(recoveryRequest(true));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "dashboard_mutation_requires_sign_in",
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

  it("maps a malformed recovery request id through the shared contract", async () => {
    const response = await POST(recoveryRequest(true, "bad id"));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "codex_rotating_setup_recovery_request_invalid",
    });
    expect(mocks.recoverAndIssue).not.toHaveBeenCalled();
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

  it("passes the configured database recovery witness into status inspection", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/dashboard/codex-rotating/setup-recovery?workspaceId=workspace_1&repositoryId=repository_1",
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.recoveryConstructor).toHaveBeenCalledWith(
      expect.anything(),
      "w".repeat(43),
    );
    expect(mocks.inspectStatus).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      repositoryId: "repository_1",
      issuanceEnabled: false,
    });
  });

  it("exposes only the sanitized versioned-namespace action for unknown PUTs", async () => {
    mocks.inspectStatus.mockResolvedValueOnce({
      status: "remote_outcome_unknown",
      reason: "github_secret_put_may_have_completed",
      action: "use_versioned_secret_namespace_or_prove_no_overwrite",
    });
    const response = await GET(
      new Request(
        "http://localhost/api/dashboard/codex-rotating/setup-recovery?workspaceId=workspace_1&repositoryId=repository_1",
      ),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "remote_outcome_unknown",
      reason: "github_secret_put_may_have_completed",
      action: "use_versioned_secret_namespace_or_prove_no_overwrite",
    });
  });

  it.each([
    ["codex_rotating_setup_issuance_quiesced", 503],
    ["rate_limit_exceeded:setup-recovery", 429],
    ["codex_rotating_mutation_still_active", 409],
    ["codex_rotating_setup_recovery_request_conflict", 409],
    ["codex_rotating_provider_identity_mismatch", 409],
    ["codex_rotating_provider_not_found", 404],
  ] as const)("maps %s to HTTP %i", async (error, status) => {
    mocks.recoverAndIssue.mockRejectedValueOnce(new Error(error));
    const response = await POST(recoveryRequest(true));
    expect(response.status).toBe(status);
  });
});

function recoveryRequest(
  acknowledge: boolean,
  recoveryRequestId = "recovery-request-1",
): Request {
  const body = new FormData();
  body.set("workspaceId", "workspace_1");
  body.set("repositoryId", "repository_1");
  body.set("recoveryRequestId", recoveryRequestId);
  if (acknowledge) {
    body.set("acknowledgement", "all_prior_installers_and_writers_are_stopped");
  }
  return new Request(
    "http://localhost/api/dashboard/codex-rotating/setup-recovery",
    { method: "POST", body },
  );
}
