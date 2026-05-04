import { describe, expect, it } from "vitest";
import { resolveInstallCodexRedirect } from "./install-codex-redirect";

describe("resolveInstallCodexRedirect", () => {
  it("sends browser requests to the human setup guide", () => {
    const request = new Request("https://reviewrouter.site/install/codex", {
      headers: {
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    expect(resolveInstallCodexRedirect(request)).toBe(
      "https://reviewrouter.site/getting-started#codex-oauth",
    );
  });

  it("keeps curl requests on the raw seed script", () => {
    const request = new Request("https://reviewrouter.site/install/codex", {
      headers: { accept: "*/*" },
    });

    expect(resolveInstallCodexRedirect(request)).toBe(
      "https://raw.githubusercontent.com/777genius/review-router/main/scripts/seed-codex-auth.sh",
    );
  });

  it("keeps requests without accept headers on the raw seed script", () => {
    const request = new Request("https://reviewrouter.site/install/codex");

    expect(resolveInstallCodexRedirect(request)).toBe(
      "https://raw.githubusercontent.com/777genius/review-router/main/scripts/seed-codex-auth.sh",
    );
  });
});
