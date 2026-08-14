import { describe, expect, it } from "vitest";
import { readinessTimingPolicyFromEnvironment } from "./readiness-config";

describe("release authority readiness config adapter", () => {
  it("uses independent validated timeout values without making lease mutable", () => {
    const policy = readinessTimingPolicyFromEnvironment({
      REVIEW_ROUTER_READINESS_POOL_WAIT_MS: "3",
      REVIEW_ROUTER_READINESS_LOCK_TIMEOUT_MS: "4",
      REVIEW_ROUTER_READINESS_STATEMENT_TIMEOUT_MS: "15",
      REVIEW_ROUTER_READINESS_TRANSACTION_TIMEOUT_MS: "17",
      REVIEW_ROUTER_READINESS_OBSERVATION_DEADLINE_MS: "20",
    });
    expect(policy).toMatchObject({
      poolWaitMilliseconds: 3,
      lockTimeoutMilliseconds: 4,
      statementTimeoutMilliseconds: 15,
      transactionTimeoutMilliseconds: 17,
      observationDeadlineMilliseconds: 20,
      leaseMilliseconds: 60_000,
      refreshAfterMilliseconds: 40_000,
    });
  });

  it.each([
    { REVIEW_ROUTER_READINESS_POOL_WAIT_MS: "0" },
    { REVIEW_ROUTER_READINESS_LOCK_TIMEOUT_MS: "secret" },
    {
      REVIEW_ROUTER_READINESS_STATEMENT_TIMEOUT_MS: "18000",
      REVIEW_ROUTER_READINESS_TRANSACTION_TIMEOUT_MS: "17000",
    },
  ])("rejects malformed or unsafe ordering: %o", (environment) => {
    expect(() => readinessTimingPolicyFromEnvironment(environment)).toThrow(
      /release_authority_readiness_(?:config_|timing_)invalid/u,
    );
  });
});
