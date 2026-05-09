import { describe, expect, it } from "vitest";
import { buildGitHubAppSetupNotice } from "./github-app-setup-notice";

describe("buildGitHubAppSetupNotice", () => {
  it("builds a signed-out post-install notice", () => {
    expect(
      buildGitHubAppSetupNotice({
        installationId: "123",
        setupAction: "install",
        signedIn: false,
      }),
    ).toEqual({
      title: "GitHub App installed",
      body: "Sign in once so ReviewRouter can show the repositories you just installed the App on.",
      installationId: "123",
    });
  });

  it("builds a signed-in update notice", () => {
    expect(
      buildGitHubAppSetupNotice({
        installationId: "456",
        setupAction: "update",
        signedIn: true,
      }),
    ).toEqual({
      title: "GitHub App access updated",
      body: "Repository metadata should refresh from the signed GitHub webhook. If repositories do not appear within a minute, request a refresh from the dashboard.",
      installationId: "456",
    });
  });

  it("ignores invalid installation ids and unexpected setup actions", () => {
    expect(
      buildGitHubAppSetupNotice({
        installationId: "../bad",
        setupAction: "install",
        signedIn: true,
      }),
    ).toBeNull();
    expect(
      buildGitHubAppSetupNotice({
        installationId: "123",
        setupAction: "unknown",
        signedIn: true,
      }),
    ).toBeNull();
  });
});
