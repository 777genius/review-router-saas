import { describe, expect, it } from "vitest";
import { GitLabInstallationGateway } from "./gitlab-installation-gateway";

type RecordedRequest = {
  readonly url: string;
  readonly init: RequestInit | undefined;
};

describe("GitLabInstallationGateway", () => {
  it("maps project permissions from the GitLab Projects API", async () => {
    const fetchImpl = async () =>
      jsonResponse({
        id: 123,
        path_with_namespace: "group/project",
        default_branch: "main",
        ci_config_path: null,
        permissions: {
          project_access: { access_level: 40 },
          group_access: null,
        },
      });
    const gateway = new GitLabInstallationGateway({
      token: "token",
      fetchImpl,
    });

    await expect(
      gateway.getProjectSettings({ projectId: "123" }),
    ).resolves.toEqual({
      projectId: "123",
      fullName: "group/project",
      defaultBranch: "main",
      ciConfigPath: null,
      canEditProjectSettings: true,
      canCreateMergeRequest: true,
    });
  });

  it("appends the setup include instead of replacing an existing GitLab CI file", async () => {
    const requests: RecordedRequest[] = [];
    const fetchImpl = async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      requests.push({ url: String(url), init });
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/repository/branches")) {
        return jsonResponse({ name: "reviewrouter/setup-123" }, 201);
      }
      if (path.includes("/repository/files/")) {
        return jsonResponse({
          file_path: ".gitlab-ci.yml",
          encoding: "base64",
          content: Buffer.from("test:\n  script: npm test\n").toString(
            "base64",
          ),
        });
      }
      if (path.endsWith("/repository/commits")) {
        return jsonResponse({ id: "commit" }, 201);
      }
      if (path.endsWith("/merge_requests")) {
        return jsonResponse(
          {
            iid: 8,
            web_url: "https://gitlab.com/group/project/-/merge_requests/8",
          },
          201,
        );
      }
      return jsonResponse({ message: "unexpected" }, 500);
    };
    const gateway = new GitLabInstallationGateway({
      token: "token",
      fetchImpl,
    });

    await expect(
      gateway.createSetupMergeRequest({
        projectId: "123",
        sourceBranch: "reviewrouter/setup-123",
        targetBranch: "main",
        title: "Install ReviewRouter",
        description: "setup",
        files: [
          {
            path: ".gitlab-ci.yml",
            content: 'include:\n  - project: "reviewrouter/control"\n',
          },
        ],
      }),
    ).resolves.toEqual({
      iid: "8",
      webUrl: "https://gitlab.com/group/project/-/merge_requests/8",
    });

    const commitRequest = requests.find((request) =>
      request.url.endsWith("/repository/commits"),
    );
    const body = JSON.parse(String(commitRequest?.init?.body)) as {
      readonly actions: readonly [{ readonly content: string }];
    };
    expect(body.actions[0].content).toContain("test:\n  script: npm test");
    expect(body.actions[0].content).toContain("ReviewRouter");
    expect(body.actions[0].content).toContain("reviewrouter/control");
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
