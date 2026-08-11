import { describe, expect, it, vi } from "vitest";
import type { CodexRotatingSetupReadinessPort } from "@reviewrouter/features-provider-setup";
import { deriveDashboardProviderSetupReadiness } from "./dashboard-codex-rotating-setup-readiness";

const updatedAt = new Date("2026-08-10T00:00:00.000Z");
const rotatingConfigured = {
  repositoryId: "repository_1",
  providerKind: "codex",
  authMode: "codex_subscription_oauth_rotating",
  state: "configured",
  updatedAt,
} as const;

describe("dashboard rotating setup readiness", () => {
  it("keeps configured only after exact versioned evidence inspection", async () => {
    const readiness = port();
    await expect(
      deriveDashboardProviderSetupReadiness({
        providerSetup: [rotatingConfigured],
        repositories: [{ id: "repository_1", githubRepositoryId: 900001n }],
        workspaceId: "workspace_1",
        readiness,
      }),
    ).resolves.toEqual([rotatingConfigured]);
    expect(readiness.inspectReady).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      repositoryId: "repository_1",
      githubRepositoryId: "900001",
      providerInstanceId: "codex-rotating:900001",
    });
  });

  it("invalidates a cached false configured row without exact evidence", async () => {
    const readiness = port();
    vi.mocked(readiness.inspectReady).mockRejectedValueOnce(
      new Error("codex_rotating_setup_not_ready"),
    );
    await expect(
      deriveDashboardProviderSetupReadiness({
        providerSetup: [rotatingConfigured],
        repositories: [{ id: "repository_1", githubRepositoryId: 900001n }],
        workspaceId: "workspace_1",
        readiness,
      }),
    ).resolves.toEqual([{ ...rotatingConfigured, state: "stale_or_invalid" }]);
  });

  it("leaves generic provider setup behavior unchanged", async () => {
    const readiness = port();
    const openRouter = {
      ...rotatingConfigured,
      providerKind: "openrouter",
      authMode: "openrouter_api_key",
    };
    await expect(
      deriveDashboardProviderSetupReadiness({
        providerSetup: [openRouter],
        repositories: [{ id: "repository_1", githubRepositoryId: 900001n }],
        workspaceId: "workspace_1",
        readiness,
      }),
    ).resolves.toEqual([openRouter]);
    expect(readiness.inspectReady).not.toHaveBeenCalled();
  });
});

function port(): CodexRotatingSetupReadinessPort {
  return {
    inspectReady: vi.fn().mockResolvedValue({
      claimId: "claim_1",
      attemptId: "attempt_1",
      namespaceId: "namespace_1",
      namespaceEpoch: 1n,
    }),
    confirmConfigured: vi.fn(),
  };
}
