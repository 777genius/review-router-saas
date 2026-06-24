import { describe, expect, it } from "vitest";
import {
  codexRotatingProviderStateCopy,
  dashboardErrorText,
} from "./dashboard-copy";

describe("dashboard Codex rotating OAuth copy", () => {
  it("maps beta recovery states to concrete operator actions", () => {
    expect(codexRotatingProviderStateCopy("permission_required")).toMatchObject(
      {
        tone: "danger",
        title: "GitHub App permission required",
      },
    );
    expect(dashboardErrorText("needs_reconnect")).toContain(
      "Rerun the rotating setup command",
    );
    expect(dashboardErrorText("needs_reconnect")).toContain("--force-reseed");
    expect(dashboardErrorText("unknown_auth_state")).toContain(
      "GitHub secret writeback was confirmed",
    );
    expect(dashboardErrorText("policy_blocked")).toContain(
      "private same-repository PRs",
    );
  });

  it("maps Codex setup PR errors to reconnect guidance", () => {
    expect(
      dashboardErrorText("codex_legacy_auth_requires_reconnect"),
    ).toContain("Reconnect Codex with the rotating setup command");
    expect(dashboardErrorText("codex_api_key_setup_disabled")).toContain(
      "Use Codex OAuth rotating",
    );
    expect(
      dashboardErrorText("codex_rotating_provider_instance_required"),
    ).toContain("Codex rotating setup is incomplete");
  });
});
