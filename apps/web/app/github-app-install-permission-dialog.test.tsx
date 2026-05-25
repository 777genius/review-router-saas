// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { githubSecretPermissionDocs } from "./github-app-permission-doc-links";
import { GitHubAppInstallPermissionDialog } from "./github-app-install-permission-dialog";

const installUrl =
  "https://github.com/apps/reviewrouter-ai/installations/new?state=setup";

afterEach(() => {
  cleanup();
});

describe("GitHubAppInstallPermissionDialog", () => {
  it("opens the permission explainer instead of rendering a direct GitHub link", () => {
    render(
      <GitHubAppInstallPermissionDialog href={installUrl}>
        Install GitHub App
      </GitHubAppInstallPermissionDialog>,
    );

    expect(
      screen.queryByRole("link", { name: "Install GitHub App" }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Install GitHub App" }));

    const dialog = screen.getByRole("dialog", {
      name: "Review GitHub permissions",
    });

    expect(within(dialog).getByText("Secrets: write")).toBeTruthy();
    expect(within(dialog).getByText("Organization secrets: read")).toBeTruthy();
    expect(
      within(dialog).getByText(/encrypted refreshed auth payload/),
    ).toBeTruthy();
  });

  it("closes the explainer when Cancel is clicked", () => {
    render(
      <GitHubAppInstallPermissionDialog href={installUrl}>
        Install GitHub App
      </GitHubAppInstallPermissionDialog>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Install GitHub App" }));
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders the GitHub documentation source links", () => {
    render(
      <GitHubAppInstallPermissionDialog href={installUrl}>
        Install GitHub App
      </GitHubAppInstallPermissionDialog>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Install GitHub App" }));

    expect(
      screen
        .getByRole("link", { name: "GitHub Docs: Get a repository secret" })
        .getAttribute("href"),
    ).toBe(githubSecretPermissionDocs.repositorySecret);
    expect(
      screen
        .getByRole("link", { name: "GitHub Docs: Get an organization secret" })
        .getAttribute("href"),
    ).toBe(githubSecretPermissionDocs.organizationSecret);
    expect(
      screen
        .getByRole("link", { name: "GitHub Docs: List selected repositories" })
        .getAttribute("href"),
    ).toBe(githubSecretPermissionDocs.organizationSecretRepositories);
  });

  it("keeps the exact install URL on the continue button", () => {
    render(
      <GitHubAppInstallPermissionDialog href={installUrl}>
        Install GitHub App
      </GitHubAppInstallPermissionDialog>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Install GitHub App" }));

    expect(
      screen
        .getByRole("link", { name: "Continue to GitHub install" })
        .getAttribute("href"),
    ).toBe(installUrl);
  });
});
