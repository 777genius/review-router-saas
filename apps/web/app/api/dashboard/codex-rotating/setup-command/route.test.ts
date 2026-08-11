import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCodexRotatingSetupManifest,
  renderCodexRotatingInstallerCommand,
} from "@reviewrouter/features-provider-setup";

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

const setupCommand = renderCodexRotatingInstallerCommand({
  manifest: buildCodexRotatingSetupManifest({
    repositoryFullName: "777genius/review-router-saas-e2e",
    repositoryId: "123456",
    installerUrl: "https://reviewrouter.site/install/codex-rotating",
    installerVersion: "route-test",
    installerSha256: "a".repeat(64),
    now: new Date("2026-08-10T00:45:00.000Z"),
  }),
  setupManifestUrl:
    "https://reviewrouter.site/api/codex-rotating/setup-manifest",
});

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
    mocks.issueCodexRotatingSetupForRepository.mockResolvedValue({
      command: setupCommand,
      expiresAt: "2026-08-10T01:00:00.000Z",
      providerInstanceId: "codex-rotating:123456",
    });
  });

  it("does not advertise the retired stable secret in setup responses", async () => {
    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      command: setupCommand,
      expiresAt: "2026-08-10T01:00:00.000Z",
      providerInstanceId: "codex-rotating:123456",
    });
    expect(body.command).toContain(
      "REVIEW_ROUTER_CODEX_ROTATING_SETUP_URL=https://reviewrouter.site/api/codex-rotating/setup-manifest",
    );
    expect(body.command).not.toContain(
      "REVIEW_ROUTER_CODEX_ROTATING_SETUP_MANIFEST_B64",
    );
    expect(JSON.stringify(body)).not.toContain("REVIEWROUTER_CODEX_AUTH_JSON");
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

  it("returns the stable recovery-required conflict across a witness generation", async () => {
    mocks.issueCodexRotatingSetupForRepository.mockRejectedValueOnce(
      new Error("codex_rotating_setup_recovery_required"),
    );

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "codex_rotating_setup_recovery_required",
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
