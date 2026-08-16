import { describe, expect, it } from "vitest";
import { readHostedCodexFeatureFlags } from "./hosted-codex-relay-composition";

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
});
