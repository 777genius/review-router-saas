import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertReviewConfigSaveAllowed: vi.fn(),
  issueCodexRotatingSetupCommand: vi.fn(),
}));

vi.mock("./dashboard-rate-limits", () => ({
  createDashboardRateLimitPolicy: () => ({
    assertReviewConfigSaveAllowed: mocks.assertReviewConfigSaveAllowed,
  }),
}));

vi.mock("./codex-rotating-seed-script", () => ({
  resolveCodexRotatingPublicWebUrl: () => "https://reviewrouter.site/",
  resolveCodexRotatingSeedScriptDescriptor: () => ({
    url: "https://reviewrouter.site/install/codex-rotating",
    version: "composition-test",
    sha256: "a".repeat(64),
  }),
}));

vi.mock("./codex-rotating-setup-manifest", () => ({
  issueCodexRotatingSetupCommand: mocks.issueCodexRotatingSetupCommand,
}));

vi.mock("@reviewrouter/platform-config", () => ({
  isCodexRotatingOAuthAllowedForRepository: () => true,
  requireReviewRouterDatabaseRecoveryWitness: () =>
    process.env.REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS,
}));

import { issueCodexRotatingSetupForRepository } from "./codex-rotating-setup-command";

const repository = {
  id: "repository_1",
  workspaceId: "workspace_1",
  provider: "github",
  githubRepositoryId: 123456n,
  fullName: "777genius/review-router-saas-e2e",
  selected: true,
  archived: false,
  installation: { status: "active" },
} as const;

describe("Codex rotating setup command composition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS", "w".repeat(43));
    mocks.assertReviewConfigSaveAllowed.mockResolvedValue(undefined);
    mocks.issueCodexRotatingSetupCommand.mockImplementation(async (input) => {
      await input.admittedOperation({ transaction: "setup" });
      return {
        command: "safe command",
        expiresAt: "2026-08-10T12:00:00.000Z",
        providerInstanceId: "codex-rotating:123456",
      };
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("passes the configured current recovery witness into ordinary dashboard and CLI issuance", async () => {
    await issueCodexRotatingSetupForRepository({
      prisma: {} as never,
      repository,
    });
    await issueCodexRotatingSetupForRepository({
      prisma: {} as never,
      repository,
      installerArguments: ["--force-reseed"],
    });

    expect(mocks.issueCodexRotatingSetupCommand).toHaveBeenCalledTimes(2);
    expect(mocks.issueCodexRotatingSetupCommand.mock.calls[0]![0]).toEqual(
      expect.objectContaining({
        workspaceId: repository.workspaceId,
        repositoryId: repository.id,
        githubRepositoryId: "123456",
        databaseRecoveryWitness: "w".repeat(43),
        runtimeEnvironment: process.env,
      }),
    );
    expect(mocks.issueCodexRotatingSetupCommand.mock.calls[1]![0]).toEqual(
      expect.objectContaining({
        databaseRecoveryWitness: "w".repeat(43),
        installerArguments: ["--force-reseed"],
      }),
    );
    for (const [issuance] of mocks.issueCodexRotatingSetupCommand.mock.calls) {
      expect(issuance).not.toHaveProperty("recovery");
      expect(issuance.admittedOperation).toEqual(expect.any(Function));
    }
    expect(mocks.assertReviewConfigSaveAllowed).toHaveBeenCalledTimes(2);
    expect(mocks.assertReviewConfigSaveAllowed).toHaveBeenNthCalledWith(1, {
      workspaceId: repository.workspaceId,
      resourceId: `codex-rotating-setup:${repository.id}`,
    });
  });
});
