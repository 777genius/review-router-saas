import { describe, expect, it } from "vitest";
import { buildGitHubAppInstallUrl } from "./github-app-install-url";

describe("buildGitHubAppInstallUrl", () => {
  it("builds a GitHub App installation URL from a safe slug", () => {
    expect(
      buildGitHubAppInstallUrl({ appSlug: "reviewrouter-local-777genius" }),
    ).toBe(
      "https://github.com/apps/reviewrouter-local-777genius/installations/new",
    );
  });

  it("returns null for missing or unsafe slugs", () => {
    expect(buildGitHubAppInstallUrl({ appSlug: "" })).toBeNull();
    expect(buildGitHubAppInstallUrl({ appSlug: "../bad" })).toBeNull();
  });
});
