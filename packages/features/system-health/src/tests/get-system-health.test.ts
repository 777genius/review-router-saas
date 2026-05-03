import { describe, expect, it } from "vitest";
import type { Clock } from "@reviewrouter/shared";
import { getSystemHealth } from "../application/get-system-health.js";
import { StaticHealthDependency } from "../infrastructure/static-health-dependency.js";

const fixedClock: Clock = {
  now: () => new Date("2026-05-03T12:00:00.000Z"),
};

describe("getSystemHealth", () => {
  it("returns ok when every dependency is ok", async () => {
    const health = await getSystemHealth({
      clock: fixedClock,
      dependencies: [
        new StaticHealthDependency({ name: "database", status: "ok" }),
      ],
    });

    expect(health.status).toBe("ok");
    expect(health.checkedAt.toISOString()).toBe("2026-05-03T12:00:00.000Z");
  });

  it("returns degraded when a dependency is degraded", async () => {
    const health = await getSystemHealth({
      clock: fixedClock,
      dependencies: [
        new StaticHealthDependency({ name: "database", status: "degraded" }),
      ],
    });

    expect(health.status).toBe("degraded");
  });
});
