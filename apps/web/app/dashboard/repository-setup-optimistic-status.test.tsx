// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  RepositorySetupDisclosureToggle,
  RepositorySetupReadyGate,
  RepositorySetupRowDisclosureController,
} from "./repository-setup-optimistic-status";
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

describe("RepositorySetupReadyGate", () => {
  it("shows ready-only children when provider setup is confirmed", async () => {
    render(
      <RepositorySetupReadyGate repositoryId="repo_1" currentStep={3}>
        <button type="button">Edit settings</button>
      </RepositorySetupReadyGate>,
    );

    expect(screen.queryByRole("button", { name: "Edit settings" })).toBeNull();

    window.dispatchEvent(
      providerSetupConfirmedEvent({
        repositoryId: "repo_1",
        repositoryFullName: "777genius/example",
      }),
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Edit settings" }),
      ).toBeTruthy();
    });
  });

  it("ignores provider setup confirmations that do not match effective auth", () => {
    render(
      <RepositorySetupReadyGate
        repositoryId="repo_1"
        currentStep={3}
        expectedProviderAuthModes={["codex_subscription_oauth_rotating"]}
      >
        <button type="button">Edit settings</button>
      </RepositorySetupReadyGate>,
    );

    window.dispatchEvent(
      providerSetupConfirmedEvent({
        repositoryId: "repo_1",
        repositoryFullName: "777genius/example",
        providerKind: "openrouter",
        authMode: "openrouter_api_key",
      }),
    );

    expect(screen.queryByRole("button", { name: "Edit settings" })).toBeNull();
  });

  it("does not complete multi-auth setup after a single provider confirmation", () => {
    render(
      <RepositorySetupReadyGate
        repositoryId="repo_1"
        currentStep={3}
        expectedProviderAuthModes={["openrouter_api_key", "claude_code_oauth"]}
      >
        <button type="button">Edit settings</button>
      </RepositorySetupReadyGate>,
    );

    window.dispatchEvent(
      providerSetupConfirmedEvent({
        repositoryId: "repo_1",
        repositoryFullName: "777genius/example",
        providerKind: "openrouter",
        authMode: "openrouter_api_key",
      }),
    );

    expect(screen.queryByRole("button", { name: "Edit settings" })).toBeNull();
  });
});

describe("RepositorySetupRowDisclosureController", () => {
  it("toggles setup details when the repository row is clicked", () => {
    render(
      <>
        <RepositorySetupRowDisclosureController />
        <div data-repository-setup-row data-disclosure-id="setup_repo_1">
          <input id="setup_repo_1" type="checkbox" />
          <span>Repository row</span>
        </div>
      </>,
    );

    fireEvent.click(screen.getByText("Repository row"));

    expect(
      (document.getElementById("setup_repo_1") as HTMLInputElement).checked,
    ).toBe(true);
  });

  it("keeps nested links from toggling setup details", () => {
    render(
      <>
        <RepositorySetupRowDisclosureController />
        <div data-repository-setup-row data-disclosure-id="setup_repo_1">
          <input id="setup_repo_1" type="checkbox" />
          <a href="https://github.com/777genius/example">Repository link</a>
        </div>
      </>,
    );

    const link = screen.getByRole("link", { name: "Repository link" });
    link.addEventListener("click", (event) => event.preventDefault());

    fireEvent.click(link);

    expect(
      (document.getElementById("setup_repo_1") as HTMLInputElement).checked,
    ).toBe(false);
  });
});
