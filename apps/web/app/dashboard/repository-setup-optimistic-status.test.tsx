// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RepositorySetupDisclosureToggle } from "./repository-setup-optimistic-status";
import {
  providerSetupConfirmedEvent,
  providerSetupConfirmedEventName,
  setupPullRequestMergedEvent,
} from "./repository-setup-optimistic-events";

afterEach(() => {
  cleanup();
});

describe("RepositorySetupDisclosureToggle", () => {
  it("updates to complete when provider setup is confirmed for the repository", async () => {
    render(
      <RepositorySetupDisclosureToggle
        repositoryId="repo_1"
        disclosureId="setup_repo_1"
        currentStep={3}
      />,
    );

    window.dispatchEvent(
      providerSetupConfirmedEvent({
        repositoryId: "repo_1",
        repositoryFullName: "777genius/example",
      }),
    );

    await waitFor(() => {
      expect(screen.getByText("4/4")).toBeTruthy();
    });
  });

  it("ignores malformed provider setup events", () => {
    render(
      <RepositorySetupDisclosureToggle
        repositoryId="repo_1"
        disclosureId="setup_repo_1"
        currentStep={3}
      />,
    );

    window.dispatchEvent(new Event(providerSetupConfirmedEventName));

    expect(screen.getByText("3/4")).toBeTruthy();
  });

  it("updates to provider setup when setup PR merge is confirmed", async () => {
    render(
      <RepositorySetupDisclosureToggle
        repositoryId="repo_1"
        disclosureId="setup_repo_1"
        currentStep={2}
      />,
    );

    window.dispatchEvent(
      setupPullRequestMergedEvent({ repositoryId: "repo_1" }),
    );

    await waitFor(() => {
      expect(screen.getByText("3/4")).toBeTruthy();
    });
  });
});
