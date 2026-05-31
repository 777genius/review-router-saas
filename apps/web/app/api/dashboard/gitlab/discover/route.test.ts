import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertDashboardWorkspaceAdminAllowed: vi.fn(),
  discoverGitLabConnectProjects: vi.fn(),
}));

vi.mock("../../../../../src/server/dashboard-mutations", () => ({
  assertDashboardWorkspaceAdminAllowed:
    mocks.assertDashboardWorkspaceAdminAllowed,
}));

vi.mock("../../../../../src/server/gitlab-connect", () => ({
  discoverGitLabConnectProjects: mocks.discoverGitLabConnectProjects,
}));

import { POST } from "./route";

describe("GitLab discover route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertDashboardWorkspaceAdminAllowed.mockResolvedValue({
      userId: "user_1",
    });
    mocks.discoverGitLabConnectProjects.mockResolvedValue({
      source: {
        inputPath: "acme/platform",
        resolvedKind: "group",
        baseUrl: "https://gitlab.com",
        parentGroupPath: null,
      },
      projects: [
        {
          projectId: "101",
          fullName: "acme/platform/api",
          name: "api",
          defaultBranch: "main",
          webUrl: "https://gitlab.com/acme/platform/api",
          archived: false,
        },
      ],
    });
  });

  it("returns discovered projects without echoing the GitLab token", async () => {
    const response = await POST(
      jsonRequest({
        workspaceId: "workspace_1",
        sourceUrl: "https://gitlab.com/acme/platform",
        token: "glpat-secret-token",
      }),
    );

    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.projects).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain("glpat-secret-token");
  });

  it("redacts token-like details from GitLab errors", async () => {
    mocks.discoverGitLabConnectProjects.mockRejectedValueOnce(
      new Error("gitlab_api_error_403: glpat-secret-token"),
    );

    const response = await POST(
      jsonRequest({
        workspaceId: "workspace_1",
        sourceUrl: "https://gitlab.com/acme/platform",
        token: "glpat-secret-token",
      }),
    );

    const body = await response.json();
    expect(response.status).toBe(403);
    expect(body).toEqual({
      error: {
        code: "gitlab_api_error_403",
        message: "gitlab api error 403",
      },
    });
    expect(JSON.stringify(body)).not.toContain("glpat-secret-token");
  });
});

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/dashboard/gitlab/discover", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
