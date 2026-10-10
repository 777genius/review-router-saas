// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  DASHBOARD_SECTIONS,
  dashboardSectionHref,
  dashboardSectionMeta,
} from "./dashboard-section";
import {
  DashboardSectionCompactNav,
  DashboardSectionTabs,
} from "./dashboard-section-tabs";

afterEach(() => {
  cleanup();
});

describe("DashboardSectionTabs", () => {
  it("links Setup to its own page and renders icons for every nav item", () => {
    const items = DASHBOARD_SECTIONS.map((section) => ({
      section,
      label: dashboardSectionMeta[section].title,
      description: dashboardSectionMeta[section].navDescription,
      href: dashboardSectionHref(section, "acme"),
    }));

    render(<DashboardSectionTabs items={items} selectedSection="setup" />);

    expect(DASHBOARD_SECTIONS.at(-1)).toBe("memory");
    expect(dashboardSectionMeta.memory.navDescription).toMatch(
      /in development/i,
    );
    expect(dashboardSectionMeta.memory.description).toMatch(/in development/i);
    expect(
      screen.getByRole("tab", { name: /^Memory\s*In development$/i }),
    ).toBeTruthy();
    const setupLink = screen.getByRole("tab", {
      name: /AccountsWorkspace provider accounts/i,
    });
    expect(setupLink.getAttribute("href")).toBe(
      "/dashboard/setup?workspace=acme",
    );
    expect(setupLink.getAttribute("aria-current")).toBe("page");
    expect(setupLink.className).toContain("border-cyan-200");

    for (const section of items) {
      expect(
        document.querySelector(`[data-section-icon="${section.section}"]`),
      ).toBeTruthy();
      expect(screen.getByText(section.label)).toBeTruthy();
    }
  });

  it("renders the same section icons in the compact nav", () => {
    const items = DASHBOARD_SECTIONS.map((section) => ({
      section,
      label: dashboardSectionMeta[section].title,
      description: dashboardSectionMeta[section].navDescription,
      href: dashboardSectionHref(section, "acme"),
    }));

    render(
      <DashboardSectionCompactNav items={items} selectedSection="setup" />,
    );

    for (const section of items) {
      expect(
        document.querySelector(`[data-section-icon="${section.section}"]`),
      ).toBeTruthy();
    }
    expect(
      screen.getByRole("link", { name: /Accounts/i }).querySelector("svg"),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /MemoryIn development/i }),
    ).toBeTruthy();
  });
});
