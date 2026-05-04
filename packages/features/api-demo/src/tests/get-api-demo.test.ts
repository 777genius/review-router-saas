import { describe, expect, it } from "vitest";
import type { Clock } from "@reviewrouter/shared";
import { getApiDemo } from "../application/get-api-demo.js";

const fixedClock: Clock = {
  now: () => new Date("2026-05-04T09:00:00.000Z"),
};

describe("getApiDemo", () => {
  it("describes the hosted control plane without claiming SaaS sees code or secrets", () => {
    const demo = getApiDemo({
      clock: fixedClock,
      webUrl: "https://web.example.com/",
      apiUrl: "https://api.example.com/",
      actionVersion: "main",
      model: "gpt-5.5",
      effort: "medium",
    });

    expect(demo.status).toBe("demo_ready");
    expect(demo.executionModel.reviewRunsIn).toBe("customer_github_actions");
    expect(demo.executionModel.controlPlaneDoesNotStore).toContain(
      "repository source code",
    );
    expect(demo.executionModel.controlPlaneDoesNotStore).toContain(
      "Codex OAuth auth.json",
    );
    expect(demo.providers.every((provider) => !provider.sentToSaas)).toBe(true);
    expect(demo.links.dashboard).toBe("https://web.example.com/dashboard");
    expect(demo.endpoints.map((endpoint) => endpoint.path)).toContain(
      "/api/action/v1/session/exchange",
    );
  });
});
