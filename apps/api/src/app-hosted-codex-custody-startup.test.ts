import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ compose: vi.fn() }));

vi.mock("./hosted-codex-relay-composition.js", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("./hosted-codex-relay-composition.js")
    >();
  return {
    ...original,
    composeProductionHostedCodexRelayRoutes: mocks.compose,
  };
});

vi.mock("@reviewrouter/platform-config", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@reviewrouter/platform-config")>();
  return {
    ...original,
    assertHostedCodexProductionReadiness: vi.fn(),
    readGitHubAppPrivateKey: vi.fn(() => "test-private-key"),
  };
});

import { createApiApp } from "./app.js";

describe("hosted Codex custody startup", () => {
  afterEach(() => mocks.compose.mockReset());

  it("starts custody reconciliation after restart with custody=1 relay=0", async () => {
    mocks.compose.mockResolvedValueOnce({ enabled: false });
    const app = await createApiApp({
      prisma: {} as never,
      commentTokenCustodyPrisma: {} as never,
      healthDependencies: [],
      reviewActionV2Env: {
        REVIEW_ROUTER_ENABLE_HOSTED_CODEX_POOL: "1",
        REVIEW_ROUTER_ENABLE_HOSTED_CODEX_CUSTODY: "1",
        REVIEW_ROUTER_ENABLE_HOSTED_CODEX_RELAY: "0",
        GITHUB_APP_ID: "123",
      },
    });
    try {
      expect(mocks.compose).toHaveBeenCalledOnce();
      expect(mocks.compose).toHaveBeenCalledWith(
        expect.objectContaining({
          prisma: expect.anything(),
          custodyPrisma: expect.anything(),
          githubAppId: "123",
          githubAppPrivateKey: "test-private-key",
        }),
      );
    } finally {
      await app.close();
    }
  });
});
