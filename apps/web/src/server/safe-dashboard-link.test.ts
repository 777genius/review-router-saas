import { describe, expect, it } from "vitest";
import { safeGitHubDashboardLink } from "./safe-dashboard-link";

describe("safeGitHubDashboardLink", () => {
  it("allows canonical HTTPS GitHub URLs", () => {
    expect(
      safeGitHubDashboardLink("https://github.com/777genius/example/pull/1"),
    ).toBe("https://github.com/777genius/example/pull/1");
  });

  it("rejects user-controlled non-GitHub or script-like links", () => {
    expect(safeGitHubDashboardLink("javascript:alert(1)")).toBeNull();
    expect(safeGitHubDashboardLink("https://evil.example/pr")).toBeNull();
    expect(
      safeGitHubDashboardLink("http://github.com/owner/repo/pull/1"),
    ).toBeNull();
  });
});
