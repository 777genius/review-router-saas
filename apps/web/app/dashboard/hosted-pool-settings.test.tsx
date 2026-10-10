// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostedPoolSettingsPanel } from "./hosted-pool-settings";
import type { HostedPoolDashboardView } from "../../src/server/hosted-pool-dashboard";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const action = vi.fn(async () => ({ params: {} }));

type SettingsActions = Parameters<typeof HostedPoolSettingsPanel>[0]["actions"];

const actions: SettingsActions = {
  importAccount: action,
  startDeviceLogin: async () => ({
    ok: false as const,
    params: { error: "hosted_pool_action_failed" },
  }),
  pollDeviceLogin: async () => ({
    ok: false as const,
    params: { error: "hosted_pool_action_failed" },
  }),
  setAccountState: action,
  removeAccount: action,
  setRepositorySource: action,
};

function expectNoCredentialLeak(): void {
  expect(document.body.textContent).not.toMatch(
    /token|fingerprint|credentialRef/iu,
  );
}

function expectNoRawPriority(): void {
  expect(document.body.textContent).not.toMatch(/Priority \d+/u);
}

function fallbackPriorityInput(): HTMLInputElement | null {
  return document.querySelector('input[name="priority"][type="hidden"]');
}

function account(
  overrides: Partial<HostedPoolDashboardView["accounts"][number]> &
    Pick<HostedPoolDashboardView["accounts"][number], "id" | "label">,
): HostedPoolDashboardView["accounts"][number] {
  return {
    priority: 10,
    availability: { status: "healthy" },
    authGeneration: 2,
    healthVersion: 1,
    validatedAt: new Date("2026-09-14T12:00:00.000Z"),
    credentialExpiresAt: null,
    refreshDue: false,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-14T12:00:00.000Z"),
    ...overrides,
  };
}

function renderPanel(
  view: HostedPoolDashboardView,
  mutationsEnabled = true,
  actionOverrides: Partial<SettingsActions> = {},
) {
  return render(
    <HostedPoolSettingsPanel
      workspaceId="workspace-1"
      mutationsEnabled={mutationsEnabled}
      actions={{ ...actions, ...actionOverrides }}
      view={view}
    />,
  );
}

afterEach(() => {
  cleanup();
});

describe("HostedPoolSettingsPanel", () => {
  it("reconnects only the selected paused UUID even when labels are identical", async () => {
    const startDeviceLogin = vi.fn(actions.startDeviceLogin);
    renderPanel(
      {
        gate: "enabled",
        pool: null,
        accounts: [
          account({ id: "healthy-id" as never, label: "Same label" }),
          account({
            id: "paused-id" as never,
            label: "Same label",
            authGeneration: 3,
            healthVersion: 9,
            availability: { status: "paused", reason: "operator" },
          }),
        ],
        repositories: [],
      },
      true,
      { startDeviceLogin },
    );
    expect(
      screen.getAllByRole("button", { name: "Reconnect ChatGPT" }),
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Reconnect ChatGPT" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Start reconnect sign-in" }),
    );
    await waitFor(() => expect(startDeviceLogin).toHaveBeenCalledTimes(1));
    const submitted = startDeviceLogin.mock.calls[0]![0];
    expect(submitted.get("accountId")).toBe("paused-id");
    expect(submitted.get("expectedGeneration")).toBe("3");
    expect(submitted.get("expectedHealthVersion")).toBe("9");
    expect(document.body.textContent).toContain("It stays paused");
  });

  it("keeps ChatGPT as the empty-state hero and hides auth.json behind a fallback", () => {
    renderPanel({
      gate: "enabled",
      pool: null,
      accounts: [],
      repositories: [],
    });

    expect(
      screen.getByRole("heading", { name: "ChatGPT accounts for reviews" }),
    ).toBeTruthy();
    expect(screen.getByText("Connect ChatGPT")).toBeTruthy();
    expect(screen.getByText("Sign in with ChatGPT")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Start ChatGPT sign-in" }),
    ).toBeTruthy();
    expect(screen.queryByText("Add another ChatGPT account")).toBeNull();
    expect(screen.queryByRole("heading", { name: "1 account" })).toBeNull();
    expect(
      screen.getByText(
        /Connect ChatGPT so ReviewRouter can run hosted reviews/,
      ),
    ).toBeTruthy();
    expect(screen.getByText("Upload auth.json fallback")).toBeTruthy();
    expect(screen.getByPlaceholderText("Fallback session")).toBeTruthy();
    expect(screen.queryByPlaceholderText("Work laptop")).toBeTruthy();
    expect(fallbackPriorityInput()?.value).toBe("100");
    expect(screen.queryByText(/encrypted at rest/i)).toBeNull();
    expectNoRawPriority();
    expectNoCredentialLeak();
  });

  it("puts enrolled accounts first and de-emphasizes the empty start form", () => {
    renderPanel({
      gate: "enabled",
      pool: {
        id: "pool-1" as never,
        workspaceId: "workspace-1" as never,
        status: "active",
        isDefault: true,
        revision: 1,
        accountCount: 1,
        healthyAccountCount: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      accounts: [account({ id: "account-1" as never, label: "Primary" })],
      repositories: [],
    });

    expect(
      screen.getByRole("heading", { name: "ChatGPT accounts for reviews" }),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "1 account" })).toBeTruthy();
    expect(screen.getByText("ChatGPT")).toBeTruthy();
    expect(screen.getByText("Primary")).toBeTruthy();
    expect(screen.getByText("1st in line")).toBeTruthy();
    expect(screen.getAllByText("Ready").length).toBeGreaterThan(0);
    expect(screen.getByText(/Last validated/)).toBeTruthy();
    expect(screen.getByText("Added")).toBeTruthy();
    expect(screen.getByText("Sep 1, 2026, 12:00 AM")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    expect(
      screen.getAllByRole("button", { name: "Remove account" }).length,
    ).toBe(1);
    expect(
      screen.getByRole("button", { name: "Add another ChatGPT account" }),
    ).toBeTruthy();
    expect(screen.queryByPlaceholderText("Work laptop")).toBeNull();
    expect(screen.queryByText(/Connect ChatGPT to get started/)).toBeNull();
    expect(screen.getByPlaceholderText("Fallback session")).toBeTruthy();
    expect(fallbackPriorityInput()?.value).toBe("100");
    expect(screen.queryByText(/encrypted at rest/i)).toBeNull();
    expect(screen.queryByText(/We encrypt each ChatGPT session/i)).toBeNull();
    expectNoRawPriority();
    expectNoCredentialLeak();
  });

  it("adds a newly connected account before the dashboard refresh finishes", async () => {
    const connected = account({
      id: "account-2" as never,
      label: "Connected now",
      priority: 20,
      createdAt: new Date("2026-09-21T15:30:00.000Z"),
      validatedAt: new Date("2026-09-21T15:30:00.000Z"),
    });
    renderPanel(
      {
        gate: "enabled",
        pool: null,
        accounts: [account({ id: "account-1" as never, label: "Primary" })],
        repositories: [],
      },
      true,
      {
        startDeviceLogin: async () => ({
          ok: true,
          loginId: "login-1",
          userCode: "ABCD-EFGH",
          verificationUrl: "https://auth.openai.com/codex/device",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          intervalSeconds: 3,
        }),
        pollDeviceLogin: async () => ({
          ok: true,
          status: "imported",
          account: connected,
          params: {},
        }),
      },
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Add another ChatGPT account" }),
    );
    fireEvent.change(screen.getByPlaceholderText("Work laptop"), {
      target: { value: "Connected now" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Start ChatGPT sign-in" }),
    );

    expect(await screen.findByText("Connected now")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "2 accounts" })).toBeTruthy(),
    );
    expect(
      screen.getAllByText("Sep 21, 2026, 3:30 PM").length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("opens the ChatGPT add panel from the enrolled list header", () => {
    renderPanel({
      gate: "enabled",
      pool: null,
      accounts: [account({ id: "account-1" as never, label: "Primary" })],
      repositories: [],
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Add another ChatGPT account" }),
    );
    expect(screen.getByText("Sign in with ChatGPT")).toBeTruthy();
    expect(screen.getByPlaceholderText("Work laptop")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Start ChatGPT sign-in" }),
    ).toBeTruthy();
    expectNoCredentialLeak();
  });

  it("marks the first-used account and keeps backup cards secondary", () => {
    renderPanel({
      gate: "enabled",
      pool: null,
      accounts: [
        account({
          id: "account-backup" as never,
          label: "Backup",
          priority: 20,
        }),
        account({
          id: "account-primary" as never,
          label: "Primary",
          priority: 10,
        }),
      ],
      repositories: [],
    });

    expect(screen.getByText("1st in line")).toBeTruthy();
    expect(screen.getByText("2nd in line")).toBeTruthy();
    expect(screen.getByText("Backup")).toBeTruthy();
    expectNoRawPriority();
    expectNoCredentialLeak();
  });

  it("lets a paused account be used for reviews again", () => {
    renderPanel({
      gate: "enabled",
      pool: null,
      accounts: [
        account({
          id: "account-1" as never,
          label: "Primary",
          availability: { status: "paused", reason: "operator" },
        }),
      ],
      repositories: [],
    });

    expect(screen.getByText("Not ready")).toBeTruthy();
    expect(screen.queryByText("1st in line")).toBeNull();
    expect(
      screen.getByText(/none of these accounts are ready for reviews/i),
    ).toBeTruthy();
    expect(screen.queryByText(/These ChatGPT accounts run reviews/)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Use for reviews again" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(screen.getByText(/You paused this account/)).toBeTruthy();
    expectNoRawPriority();
    expectNoCredentialLeak();
  });

  it("surfaces refresh-due and session expiry without credential metadata", () => {
    renderPanel({
      gate: "enabled",
      pool: null,
      accounts: [
        account({
          id: "account-1" as never,
          label: "Primary",
          refreshDue: true,
          credentialExpiresAt: new Date("2026-12-01T15:30:00.000Z"),
        }),
      ],
      repositories: [],
    });

    expect(
      screen.getByText(
        /This ChatGPT needs a refresh before ReviewRouter can keep using it/,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Session expires/)).toBeTruthy();
    expect(screen.getByText(/Dec 1, 2026/)).toBeTruthy();
    expectNoCredentialLeak();
  });

  it("shows a human reason for quarantined sessions", () => {
    renderPanel({
      gate: "enabled",
      pool: null,
      accounts: [
        account({
          id: "account-1" as never,
          label: "Expired session",
          availability: { status: "quarantined", reason: "real_401" },
        }),
      ],
      repositories: [],
    });

    expect(screen.getByText("Needs reconnect")).toBeTruthy();
    expect(screen.getByText(/ChatGPT rejected this login/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Use for reviews again" }),
    ).toBeNull();
    expectNoCredentialLeak();
  });

  it("asks before removing an account", () => {
    renderPanel({
      gate: "enabled",
      pool: null,
      accounts: [account({ id: "account-1" as never, label: "Primary" })],
      repositories: [],
    });

    expect(screen.queryByRole("button", { name: "Yes, remove" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove account" }));
    expect(screen.getByText(/Remove Primary/)).toBeTruthy();
    expect(
      screen.getByText(/cannot add this same ChatGPT later/i),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Yes, remove" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep account" }));
    expect(screen.queryByRole("button", { name: "Yes, remove" })).toBeNull();
    expect(screen.getByRole("button", { name: "Remove account" })).toBeTruthy();
  });

  it("disables pause and add when mutations are off", () => {
    renderPanel(
      {
        gate: "enabled",
        pool: null,
        accounts: [account({ id: "account-1" as never, label: "Primary" })],
        repositories: [],
      },
      false,
    );

    expect(
      (
        screen.getByRole("button", {
          name: "Pause",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "Remove account",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "Add another ChatGPT account",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expectNoCredentialLeak();
  });

  it("shows safe labels and state without rendering credential metadata", () => {
    renderPanel({
      gate: "enabled",
      pool: null,
      accounts: [account({ id: "account-1" as never, label: "Primary" })],
      repositories: [],
    });
    expect(screen.getByText("Primary")).toBeTruthy();
    expectNoRawPriority();
    expectNoCredentialLeak();
  });

  it("scopes unavailable enrollment to the hosted ChatGPT pool", () => {
    renderPanel({
      gate: "feature_disabled",
      pool: null,
      accounts: [],
      repositories: [],
    });
    expect(
      screen.getByRole("heading", {
        name: "Hosted ChatGPT pool is not enabled",
      }),
    ).toBeTruthy();
    expect(
      screen.getByText(/Manage gateway accounts in Workspace accounts above/i),
    ).toBeTruthy();
  });
});
