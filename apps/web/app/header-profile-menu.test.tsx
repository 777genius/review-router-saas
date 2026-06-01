// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HeaderProfileMenu } from "./header-profile-menu";

vi.mock("next-auth/react", () => ({
  signIn: vi.fn(() => Promise.resolve()),
  signOut: vi.fn(() => Promise.resolve()),
}));

beforeEach(() => {
  class MockResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }

  vi.stubGlobal("ResizeObserver", MockResizeObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("HeaderProfileMenu", () => {
  it("shows a sign-in action when no source session is present", () => {
    render(<HeaderProfileMenu login={null} avatarUrl={null} provider={null} />);

    expect(
      screen.getByRole("link", { name: "Sign in" }).getAttribute("href"),
    ).toBe("/auth/signin?callbackUrl=%2Fdashboard");
  });

  it("opens a profile menu with sign-out for signed-in users", () => {
    render(
      <HeaderProfileMenu
        login="777genius"
        avatarUrl="https://avatars.githubusercontent.com/u/1?v=4"
        provider="github"
      />,
    );

    const profileButton = screen.getByRole("button", {
      name: "Open profile menu for 777genius",
    });

    expect(profileButton.getAttribute("aria-expanded")).toBe("false");

    fireEvent.pointerDown(profileButton);

    expect(
      screen.getByRole("menu", {
        name: "Open profile menu for 777genius",
      }),
    ).toBeTruthy();
    expect(profileButton.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByText("777genius")).toHaveLength(2);
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeTruthy();
  });

  it("uses provider-aware avatar alt text", () => {
    render(
      <HeaderProfileMenu
        login="gitlab-user"
        avatarUrl="https://gitlab.com/uploads/avatar.png"
        provider="gitlab"
      />,
    );

    expect(screen.getByAltText("gitlab-user GitLab avatar")).toBeTruthy();
  });
});
