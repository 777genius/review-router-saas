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
    expect(dashboardErrorText("unknown_auth_state")).toContain(
      "GitHub secret writeback was confirmed",
    );
    expect(dashboardErrorText("policy_blocked")).toContain(
      "private same-repository PRs",
    );
  });
});
