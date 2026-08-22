import { describe, expect, it } from "vitest";
import {
  composeHostedCodexRelayRoutes,
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
});
