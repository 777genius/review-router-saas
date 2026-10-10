// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { DashboardShell, DashboardShellSnapshot } from "./dashboard-shell";
import { DashboardSectionLoading } from "./dashboard-section-loading";
import { NavigationFeedbackProvider } from "../navigation-feedback";
import type { DashboardWorkspaceSummary } from "./dashboard-workspace-navigation";

const route = vi.hoisted(() => ({
  pathname: "/dashboard",
  search: "workspace=one&section=repositories",
}));
vi.mock("next/navigation", () => ({
  usePathname: () => route.pathname,
  useSearchParams: () => new URLSearchParams(route.search),
}));
vi.mock("next/link", () => ({
  default: ({
    onClick,
    onNavigate,
    ...props
  }: ComponentProps<"a"> & { readonly onNavigate?: () => void }) => (
    <a
      {...props}
      data-next-link="true"
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) onNavigate?.();
        event.preventDefault();
      }}
    />
  ),
}));
vi.mock("../connect-source-dialog", () => ({
  ConnectSourceDialog: () => <button type="button">Add repos</button>,
}));

function workspace(id: string, repositoryCount = 3): DashboardWorkspaceSummary {
  return {
    workspace: {
      id,
      name: id,
      slug: id,
      installations: [],
      gitLabInstallations: [],
      auditEvents: [],
    },
    repositoryCount,
    hasWorkspaceWideAccess: true,
  };
}
const workspaces = [workspace("one"), workspace("two")];
const shellProps = {
  workspaces,
  appInstallUrl: null,
  fallbackUser: { githubLogin: null, githubAvatarUrl: null },
};

beforeEach(() => {
  route.pathname = "/dashboard";
  route.search = "workspace=one&section=repositories";
});
afterEach(cleanup);

describe("persistent dashboard shell", () => {
  it("keeps the workspace switcher and sidebar mounted while only content loads", () => {
    const view = render(
      <DashboardShell {...shellProps}>
        <div>Repository content</div>
      </DashboardShell>,
    );
    const switcher = screen.getByRole("tablist", { name: "Workspace" });
    const sidebar = document.getElementById("dashboard-section-sidebar");

    route.search = "workspace=two&section=memory";
    view.rerender(
      <DashboardShell {...shellProps}>
        <DashboardSectionLoading />
      </DashboardShell>,
    );
    expect(screen.getByRole("tablist", { name: "Workspace" })).toBe(switcher);
    expect(document.getElementById("dashboard-section-sidebar")).toBe(sidebar);
    expect(
      screen
        .getByRole("tab", { name: /two\s*3 repos/ })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(
      screen
        .getByRole("tab", { name: /Memory\s*In development/ })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(document.querySelectorAll('[aria-busy="true"]')).toHaveLength(1);
    expect(screen.getByLabelText("Loading dashboard section").id).toBe(
      "dashboard-section-content",
    );
    expect(screen.getByRole("main").getAttribute("aria-busy")).toBeNull();
    expect(sidebar?.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it("shows the content skeleton immediately when a section link starts navigation", () => {
    render(
      <NavigationFeedbackProvider>
        <DashboardShell {...shellProps}>
          <div>Repository content</div>
        </DashboardShell>
      </NavigationFeedbackProvider>,
    );
    const workspaceSwitcher = screen.getByRole("tablist", {
      name: "Workspace",
    });
    const sidebar = document.getElementById("dashboard-section-sidebar");

    fireEvent.click(
      screen.getByRole("tab", {
        name: /Memory\s*In development/,
      }),
    );

    expect(screen.getByRole("tablist", { name: "Workspace" })).toBe(
      workspaceSwitcher,
    );
    expect(document.getElementById("dashboard-section-sidebar")).toBe(sidebar);
    expect(screen.queryByText("Repository content")).toBeNull();
    expect(screen.getByLabelText("Loading dashboard section")).toBeTruthy();
    expect(
      screen
        .getByRole("tab", { name: /Memory\s*In development/ })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(screen.getByRole("progressbar")).toBeTruthy();
  });

  it("shows the same content-only skeleton when switching workspaces", () => {
    render(
      <NavigationFeedbackProvider>
        <DashboardShell {...shellProps}>
          <div>Workspace one content</div>
        </DashboardShell>
      </NavigationFeedbackProvider>,
    );
    const sidebar = document.getElementById("dashboard-section-sidebar");

    fireEvent.click(screen.getByRole("tab", { name: /two\s*3 repos/ }));

    expect(screen.queryByText("Workspace one content")).toBeNull();
    expect(screen.getByLabelText("Loading dashboard section")).toBeTruthy();
    expect(document.getElementById("dashboard-section-sidebar")).toBe(sidebar);
    expect(
      screen
        .getByRole("tab", { name: /two\s*3 repos/ })
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  it("uses fragment-free client links across Accounts and workspace changes", () => {
    route.pathname = "/dashboard/setup";
    route.search = "workspace=two&section=memory";
    render(
      <DashboardShell {...shellProps}>
        <div>Accounts content</div>
      </DashboardShell>,
    );
    const workspaceTab = screen.getByRole("tab", { name: /one\s*3 repos/ });
    expect(workspaceTab.getAttribute("href")).toBe(
      "/dashboard/setup?workspace=one",
    );
    const accountTab = screen.getByRole("tab", {
      name: /Accounts\s*Workspace provider accounts/,
    });
    expect(accountTab.getAttribute("aria-current")).toBe("page");
    for (const link of document.querySelectorAll('a[href^="/dashboard"]')) {
      expect(link.getAttribute("data-next-link")).toBe("true");
    }
  });

  it("refreshes summaries without remounting navigation and keeps repeated-query first-value semantics", () => {
    route.search = "workspace=one&workspace=two";
    const view = render(
      <DashboardShell {...shellProps}>
        <div>Content</div>
      </DashboardShell>,
    );
    const sidebar = document.getElementById("dashboard-section-sidebar");
    view.rerender(
      <DashboardShell {...shellProps}>
        <DashboardShellSnapshot
          workspaces={[workspace("one", 4), workspace("two")]}
        />
        <div>Updated content</div>
      </DashboardShell>,
    );
    expect(document.getElementById("dashboard-section-sidebar")).toBe(sidebar);
    expect(
      screen
        .getByRole("tab", { name: /one\s*4 repos/ })
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  it("shows empty-access content without a fabricated workspace", () => {
    render(
      <DashboardShell {...shellProps} workspaces={[]}>
        <div>Connect a source</div>
      </DashboardShell>,
    );
    expect(screen.getByText("Connect a source")).toBeTruthy();
    expect(screen.queryByRole("tablist", { name: "Workspace" })).toBeNull();
    expect(document.getElementById("dashboard-section-sidebar")).toBeNull();
  });
});
