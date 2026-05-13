// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DashboardWorkspaceTabs } from "./dashboard-workspace-tabs";

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});

describe("DashboardWorkspaceTabs", () => {
  it("renders a GitHub redirect request as an ephemeral pending workspace tab", async () => {
    Object.defineProperty(document, "referrer", {
      value: "https://github.com/apps/review-router-ai/installations/select_target",
      configurable: true,
    });

    render(
      <DashboardWorkspaceTabs
        selectedWorkspaceId="workspace-personal"
        items={[
          {
            id: "workspace-personal",
            label: "777genius",
            repositoryCount: 268,
            href: "/dashboard?workspace=777genius",
          },
        ]}
        pendingInstallRequest={{
          id: "github-app-organization-request-pending",
          label: "Padelapp-Club",
          statusLabel: "Request pending",
          href: "/dashboard?section=repositories",
        }}
      />,
    );

    expect(screen.getByText("777genius")).toBeTruthy();
    expect(screen.getByText("268 repos")).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText("Padelapp-Club")).toBeTruthy();
      expect(screen.getByText("Request pending")).toBeTruthy();
    });
    expect(screen.queryByText("0 repos")).toBeNull();
  });
});
