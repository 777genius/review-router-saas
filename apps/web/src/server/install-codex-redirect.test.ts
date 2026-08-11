import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveInstallCodexRedirect } from "./install-codex-redirect";

describe("resolveInstallCodexRedirect", () => {
  beforeEach(() => {
    vi.stubEnv(
      "REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF",
      "777genius/review-router@0123456789abcdef0123456789abcdef01234567",
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sends browser requests to the human setup guide", () => {
    const request = new Request("https://reviewrouter.site/install/codex", {
      headers: {
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    expect(resolveInstallCodexRedirect(request)).toBe(
      "https://reviewrouter.site/getting-started#codex-oauth-rotating",
    );
  });

  it("keeps curl requests on the raw rotating seed script", () => {
    const request = new Request("https://reviewrouter.site/install/codex", {
      headers: { accept: "*/*" },
    });

    expect(resolveInstallCodexRedirect(request)).toBe(
      "https://raw.githubusercontent.com/777genius/review-router/0123456789abcdef0123456789abcdef01234567/scripts/seed-codex-rotating-auth.sh",
    );
  });

  it("keeps requests without accept headers on the raw rotating seed script", () => {
    const request = new Request("https://reviewrouter.site/install/codex");

    expect(resolveInstallCodexRedirect(request)).toBe(
      "https://raw.githubusercontent.com/777genius/review-router/0123456789abcdef0123456789abcdef01234567/scripts/seed-codex-rotating-auth.sh",
    );
  });
});
