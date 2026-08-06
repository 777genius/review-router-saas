import { readFileSync } from "node:fs";
import {
  resolveReviewActionV2ProjectionPolicyVersion,
  reviewActionV2ProjectionPolicyVersion,
} from "../apps/api/src/review-action-v2-projection-policy.js";
import { describe, expect, it } from "vitest";
import {
  reviewV2ContextApiEnvKeys,
  reviewV2ContextEnvForRole,
  reviewV2ContextWorkerEnvKeys,
  reviewV2ProjectionPolicyVersion,
  reviewV2ProjectionPolicyVersionEnvKey,
} from "./review-v2-render-env.mjs";

const configuredEnv = Object.fromEntries(
  reviewV2ContextApiEnvKeys.map((key) => [key, `value-for-${key}`]),
);

describe("Review v2 Render context environment", () => {
  it("keeps cryptographic material API-only", () => {
    expect(reviewV2ContextEnvForRole(configuredEnv, "api")).toEqual({
      ...configuredEnv,
      [reviewV2ProjectionPolicyVersionEnvKey]: reviewV2ProjectionPolicyVersion,
    });
    expect(reviewV2ContextEnvForRole(configuredEnv, "worker")).toEqual(
      Object.fromEntries(
        reviewV2ContextWorkerEnvKeys.map((key) => [key, configuredEnv[key]]),
      ),
    );
    expect(reviewV2ContextEnvForRole(configuredEnv, "web")).toEqual({});
    expect(reviewV2ProjectionPolicyVersion).toBe(
      reviewActionV2ProjectionPolicyVersion,
    );
    expect(
      resolveReviewActionV2ProjectionPolicyVersion(
        reviewV2ProjectionPolicyVersion,
      ),
    ).toBe(reviewV2ProjectionPolicyVersion);
  });

  it("declares every required value in the Render blueprint", () => {
    const blueprint = readFileSync(
      new URL("../render.yaml", import.meta.url),
      "utf8",
    );
    for (const key of reviewV2ContextApiEnvKeys) {
      expect(blueprint).toContain(`- key: ${key}`);
    }
    expect(blueprint).toContain(
      `- key: REVIEW_ROUTER_REVIEW_V2_PROJECTION_POLICY_VERSION\n        value: "${reviewV2ProjectionPolicyVersion}"`,
    );
  });
});
