import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  reviewV2ContextApiEnvKeys,
  reviewV2ContextEnvForRole,
  reviewV2ContextWorkerEnvKeys,
} from "./review-v2-render-env.mjs";

const configuredEnv = Object.fromEntries(
  reviewV2ContextApiEnvKeys.map((key) => [key, `value-for-${key}`]),
);

describe("Review v2 Render context environment", () => {
  it("keeps cryptographic material API-only", () => {
    expect(reviewV2ContextEnvForRole(configuredEnv, "api")).toEqual(
      configuredEnv,
    );
    expect(reviewV2ContextEnvForRole(configuredEnv, "worker")).toEqual(
      Object.fromEntries(
        reviewV2ContextWorkerEnvKeys.map((key) => [key, configuredEnv[key]]),
      ),
    );
    expect(reviewV2ContextEnvForRole(configuredEnv, "web")).toEqual({});
  });

  it("declares every required value in the Render blueprint", () => {
    const blueprint = readFileSync(
      new URL("../render.yaml", import.meta.url),
      "utf8",
    );
    for (const key of reviewV2ContextApiEnvKeys) {
      expect(blueprint).toContain(`- key: ${key}`);
    }
  });
});
