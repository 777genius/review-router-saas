// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HostedPoolSettingsPanel } from "./hosted-pool-settings";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const action = vi.fn(async () => ({ params: {} }));

describe("HostedPoolSettingsPanel", () => {
  it("shows safe labels and state without rendering credential metadata", () => {
    render(
      <HostedPoolSettingsPanel
        workspaceId="workspace-1"
        mutationsEnabled
        actions={{
          importAccount: action,
          setAccountState: action,
          setRepositorySource: action,
        }}
        view={{
          gate: "enabled",
          pool: null,
          accounts: [
            {
              id: "account-1" as never,
              label: "Primary",
              priority: 10,
              availability: { status: "healthy" },
              authGeneration: 2,
              healthVersion: 1,
              validatedAt: new Date(),
              credentialExpiresAt: null,
              refreshDue: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          repositories: [],
        }}
      />,
    );
    expect(screen.getByText("Primary")).toBeTruthy();
    expect(screen.getByText(/Priority 10/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(
      /token|fingerprint|credentialRef/iu,
    );
  });

  it("keeps the custody UI absent when the feature gate is off", () => {
    const { container } = render(
      <HostedPoolSettingsPanel
        workspaceId="workspace-1"
        mutationsEnabled
        actions={{
          importAccount: action,
          setAccountState: action,
          setRepositorySource: action,
        }}
        view={{
          gate: "feature_disabled",
          pool: null,
          accounts: [],
          repositories: [],
        }}
      />,
    );
    expect(container.innerHTML).toBe("");
  });
});
