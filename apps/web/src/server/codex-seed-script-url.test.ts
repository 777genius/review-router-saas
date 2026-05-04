import { describe, expect, it } from "vitest";
import { resolveCodexSeedScriptUrl } from "./codex-seed-script-url";

describe("resolveCodexSeedScriptUrl", () => {
  it("defaults to localhost for local beta", () => {
    expect(resolveCodexSeedScriptUrl({} as NodeJS.ProcessEnv)).toBe(
      "http://localhost:3000/install/codex",
    );
  });

  it("uses the configured hosted web URL", () => {
    expect(
      resolveCodexSeedScriptUrl({
        NODE_ENV: "test",
        REVIEW_ROUTER_WEB_URL: "https://app.reviewrouter.dev/",
      } as NodeJS.ProcessEnv),
    ).toBe("https://app.reviewrouter.dev/install/codex");
  });

  it("rejects non-local http URLs", () => {
    expect(() =>
      resolveCodexSeedScriptUrl({
        NODE_ENV: "test",
        REVIEW_ROUTER_WEB_URL: "http://app.reviewrouter.dev",
      } as NodeJS.ProcessEnv),
    ).toThrow("invalid_review_router_web_url");
  });

  it("rejects URL credentials, query, or fragment", () => {
    for (const url of [
      "https://token@app.reviewrouter.dev",
      "https://app.reviewrouter.dev?x=1",
      "https://app.reviewrouter.dev#setup",
    ]) {
      expect(() =>
        resolveCodexSeedScriptUrl({
          NODE_ENV: "test",
          REVIEW_ROUTER_WEB_URL: url,
        } as NodeJS.ProcessEnv),
      ).toThrow("invalid_review_router_web_url");
    }
  });
});
