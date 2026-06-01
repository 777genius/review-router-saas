import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertDashboardWorkspaceAdminAllowed: vi.fn(),
  buildGitLabCodexSeedCommand: vi.fn(),
}));

vi.mock("../../../../../src/server/dashboard-mutations", () => ({
  assertDashboardWorkspaceAdminAllowed:
    mocks.assertDashboardWorkspaceAdminAllowed,
}));

vi.mock("../../../../../src/server/gitlab-codex-seed-command", () => ({
  buildGitLabCodexSeedCommand: mocks.buildGitLabCodexSeedCommand,
}));

import { POST } from "./route";

describe("GitLab Codex command route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertDashboardWorkspaceAdminAllowed.mockResolvedValue({
      userId: "user_1",
    });
    mocks.buildGitLabCodexSeedCommand.mockResolvedValue({
      command: "export GITLAB_TOKEN=...",
      secretName: "CODEX_AUTH_JSON",
      sendsSecretToReviewRouter: false,
      targetLabel: "GitLab group acme/platform",
    });
  });

  it("marks that CODEX_AUTH_JSON is written directly to GitLab, not ReviewRouter", async () => {
    const response = await POST(
      new Request("http://localhost/api/dashboard/gitlab/codex-command", {
        method: "POST",
        body: JSON.stringify({
          workspaceId: "workspace_1",
          installationId: "gitlab_install_1",
        }),
      }),
    );

    await expect(response.json()).resolves.toMatchObject({
      secretName: "CODEX_AUTH_JSON",
      sendsSecretToReviewRouter: false,
      targetLabel: "GitLab group acme/platform",
    });
    expect(mocks.buildGitLabCodexSeedCommand).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      installationId: "gitlab_install_1",
    });
  });

  it("keeps installation lookup errors mapped to not found", async () => {
    mocks.buildGitLabCodexSeedCommand.mockRejectedValueOnce(
      new Error("gitlab_installation_not_found:gitlab_install_1"),
    );

    const response = await POST(
      new Request("http://localhost/api/dashboard/gitlab/codex-command", {
        method: "POST",
        body: JSON.stringify({
          workspaceId: "workspace_1",
          installationId: "gitlab_install_1",
        }),
      }),
    );

    await expect(response.json()).resolves.toEqual({
      error: "gitlab_installation_not_found",
    });
    expect(response.status).toBe(404);
  });
});
