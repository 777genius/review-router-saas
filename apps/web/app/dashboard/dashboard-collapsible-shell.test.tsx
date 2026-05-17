// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DashboardCollapsibleShell } from "./dashboard-collapsible-shell";

afterEach(() => {
  cleanup();
});

describe("DashboardCollapsibleShell", () => {
  it("starts collapsed when requested and lets users reopen the dashboard sidebar", () => {
    render(
      <DashboardCollapsibleShell
        defaultCollapsed
        nav={<nav>Current account</nav>}
      >
        <main>Memory content</main>
      </DashboardCollapsibleShell>,
    );

    expect(screen.getByText("Memory content")).toBeTruthy();
    expect(
      document
        .getElementById("dashboard-section-sidebar")
        ?.className.includes("hidden"),
    ).toBe(true);

    const toggle = screen.getByRole("button", { name: "Show sidebar" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(toggle);

    expect(screen.getByText("Current account")).toBeTruthy();
    expect(
      document
        .getElementById("dashboard-section-sidebar")
        ?.className.includes("block"),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Hide sidebar" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
  });
});
