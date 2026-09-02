import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  composeHostedCodexRelayRoutes,
  composeProductionHostedCodexRelayRoutes,
  readHostedCodexFeatureFlags,
} from "./hosted-codex-relay-composition";

describe("hosted Codex relay feature flags", () => {
  it("fails closed by default and requires the master switch", () => {
    expect(readHostedCodexFeatureFlags({})).toEqual({
      custody: false,
      admission: false,
      relay: false,
      failover: false,
    });
    expect(
      readHostedCodexFeatureFlags({
        REVIEW_ROUTER_ENABLE_HOSTED_CODEX_CUSTODY: "1",
        REVIEW_ROUTER_ENABLE_HOSTED_CODEX_ADMISSION: "1",
        REVIEW_ROUTER_ENABLE_HOSTED_CODEX_RELAY: "1",
        REVIEW_ROUTER_ENABLE_HOSTED_CODEX_FAILOVER: "1",
      }),
    ).toEqual({
      custody: false,
      admission: false,
      relay: false,
      failover: false,
    });
    expect(
      readHostedCodexFeatureFlags({
        REVIEW_ROUTER_ENABLE_HOSTED_CODEX_POOL: "1",
        REVIEW_ROUTER_ENABLE_HOSTED_CODEX_CUSTODY: "1",
        REVIEW_ROUTER_ENABLE_HOSTED_CODEX_ADMISSION: "1",
        REVIEW_ROUTER_ENABLE_HOSTED_CODEX_RELAY: "1",
        REVIEW_ROUTER_ENABLE_HOSTED_CODEX_FAILOVER: "1",
      }),
    ).toEqual({ custody: true, admission: true, relay: true, failover: true });
  });

  it("keeps relay available to drain issued grants after admission closes", async () => {
    const dependencies = {
      grants: { issue: async () => ({}) as never },
      commentTokens: {} as never,
      authorization: {} as never,
      relay: {} as never,
    };
    const composed = composeHostedCodexRelayRoutes({
      env: {
        REVIEW_ROUTER_ENABLE_HOSTED_CODEX_POOL: "1",
        REVIEW_ROUTER_ENABLE_HOSTED_CODEX_CUSTODY: "1",
        REVIEW_ROUTER_ENABLE_HOSTED_CODEX_ADMISSION: "0",
        REVIEW_ROUTER_ENABLE_HOSTED_CODEX_RELAY: "1",
      },
      dependencies,
    });
    expect(composed.enabled).toBe(true);
    await expect(composed.grants.issue({} as never)).rejects.toThrow(
      "hosted_codex_admission_unavailable",
    );
    expect(composed.authorization).toBe(dependencies.authorization);
    expect(composed.relay).toBe(dependencies.relay);
  });

  it("rejects grant and token admission through the shared custody readiness contract", async () => {
    const grant = vi.fn();
    const token = vi.fn();
    const composed = composeHostedCodexRelayRoutes({
      env: {
        REVIEW_ROUTER_ENABLE_HOSTED_CODEX_POOL: "1",
        REVIEW_ROUTER_ENABLE_HOSTED_CODEX_CUSTODY: "1",
        REVIEW_ROUTER_ENABLE_HOSTED_CODEX_ADMISSION: "1",
        REVIEW_ROUTER_ENABLE_HOSTED_CODEX_RELAY: "1",
      },
      dependencies: {
        grants: { issue: grant },
        commentTokens: { issue: token },
        authorization: {} as never,
        relay: {} as never,
        custodyHealth: () => ({
          ready: false,
          status: "degraded",
          reason: "initial_reconcile_pending",
          metrics: {},
        }),
      },
    });
    await expect(composed.grants.issue({} as never)).rejects.toThrow(
      "hosted_codex_custody_not_ready:initial_reconcile_pending",
    );
    await expect(composed.commentTokens.issue({} as never)).rejects.toThrow(
      "hosted_codex_custody_not_ready:initial_reconcile_pending",
    );
    expect(grant).not.toHaveBeenCalled();
    expect(token).not.toHaveBeenCalled();
  });

  it("starts custody recovery even while relay serving is disabled", async () => {
    const transaction = vi.fn(async () => {
      throw new Error("expected-disposable-database-unavailable");
    });
    const composed = await composeProductionHostedCodexRelayRoutes({
      prisma: { $transaction: transaction } as never,
      custodyPrisma: { $transaction: transaction } as never,
      env: {
        REVIEW_ROUTER_ENABLE_HOSTED_CODEX_POOL: "1",
        REVIEW_ROUTER_ENABLE_HOSTED_CODEX_CUSTODY: "1",
        REVIEW_ROUTER_ENABLE_HOSTED_CODEX_RELAY: "0",
        REVIEW_ROUTER_HOSTED_CODEX_DATABASE_INCARNATION:
          "relay-disabled-test-incarnation",
        REVIEW_ROUTER_HOSTED_CODEX_DATABASE_RESOURCE_IDENTITY:
          "relay-disabled-test-resource",
        REVIEW_ROUTER_HOSTED_CODEX_FINGERPRINT_PEPPER:
          randomBytes(32).toString("base64"),
        REVIEW_ROUTER_HOSTED_CODEX_KEYRING_MODE: "local_env",
        REVIEW_ROUTER_HOSTED_CODEX_KEK_CURRENT_ID: "test-kek",
        REVIEW_ROUTER_HOSTED_CODEX_KEK_KEYRING_JSON: JSON.stringify({
          "test-kek": randomBytes(32).toString("base64"),
        }),
      },
      githubAppId: "123",
      githubAppPrivateKey: "disposable-test-private-key",
    });
    expect(composed.enabled).toBe(false);
    expect(composed.shutdown).toEqual(expect.any(Function));
    expect(composed.custodyHealth).toEqual(expect.any(Function));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(composed.custodyHealth?.().metrics.attempts).toBe(1);
    expect(transaction).toHaveBeenCalled();
    await composed.shutdown?.();
  });
});
