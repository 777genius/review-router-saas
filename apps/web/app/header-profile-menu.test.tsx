// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HeaderProfileMenu } from "./header-profile-menu";

vi.mock("next-auth/react", () => ({
  signIn: vi.fn(() => Promise.resolve()),
  signOut: vi.fn(() => Promise.resolve()),
}));

afterEach(() => {
  cleanup();
});

describe("HeaderProfileMenu", () => {
  it("shows a sign-in action when no GitHub session is present", () => {
    render(<HeaderProfileMenu githubLogin={null} githubAvatarUrl={null} />);

    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
  });

  it("opens a profile menu with sign-out for signed-in users", () => {
    render(
      <HeaderProfileMenu
        githubLogin="777genius"
        githubAvatarUrl="https://avatars.githubusercontent.com/u/1?v=4"
      />,
    );

    const profileButton = screen.getByRole("button", {
      name: "Open profile menu for 777genius",
    });

    expect(profileButton.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(profileButton);

    expect(screen.getByRole("menu", { name: "Profile menu" })).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Close profile menu for 777genius",
      }),
    ).toBeTruthy();
    expect(profileButton.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByText("777genius")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });
});
