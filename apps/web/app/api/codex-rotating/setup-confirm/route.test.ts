import { describe, expect, it } from "vitest";
import { POST } from "./route";

describe("legacy Codex rotating setup confirmation endpoint", () => {
  it("is permanently removed and cannot be re-enabled by environment state", async () => {
    const previous =
      process.env.REVIEW_ROUTER_CODEX_ROTATING_LEGACY_STABLE_SECRET_ENABLED;
    process.env.REVIEW_ROUTER_CODEX_ROTATING_LEGACY_STABLE_SECRET_ENABLED = "1";
    try {
      const response = await POST();
      expect(response.status).toBe(410);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual({
        error: "codex_rotating_legacy_stable_secret_removed",
      });
    } finally {
      if (previous === undefined) {
        delete process.env
          .REVIEW_ROUTER_CODEX_ROTATING_LEGACY_STABLE_SECRET_ENABLED;
      } else {
        process.env.REVIEW_ROUTER_CODEX_ROTATING_LEGACY_STABLE_SECRET_ENABLED =
          previous;
      }
    }
  });
});
