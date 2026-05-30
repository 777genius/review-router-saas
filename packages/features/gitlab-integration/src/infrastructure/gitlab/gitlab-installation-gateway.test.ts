import { describe, expect, it } from "vitest";
import { GitLabInstallationGateway } from "./gitlab-installation-gateway";

type RecordedRequest = {
  readonly url: string;
  readonly init: RequestInit | undefined;
};

describe("GitLabInstallationGateway", () => {
  it("lists group projects with safe filters and pagination metadata", async () => {
    const requests: RecordedRequest[] = [];
    const fetchImpl = async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      requests.push({ url: String(url), init });
      return jsonResponse(
        [
          {
            id: 123,
            path_with_namespace: "platform/review/api",
            name: "api",
            default_branch: "main",
            web_url: "https://gitlab.com/platform/review/api",
            archived: false,
          },
        ],
        200,
        {
          "x-page": "2",
          "x-per-page": "50",
          "x-next-page": "3",
          "x-total": "101",
          "x-total-pages": "3",
        },
      );
    };
    const gateway = new GitLabInstallationGateway({
      token: "token",
      fetchImpl,
    });

    await expect(
      gateway.listGroupProjects({
        groupIdOrPath: "platform/review",
        includeSubgroups: true,
        archived: false,
        withShared: false,
        page: 2,
        perPage: 50,
        search: "api",
      }),
    ).resolves.toEqual({
      groupIdOrPath: "platform/review",
      page: 2,
      perPage: 50,
      nextPage: 3,
      total: 101,
      totalPages: 3,
      projects: [
        {
          projectId: "123",
          fullName: "platform/review/api",
          name: "api",
          defaultBranch: "main",
          webUrl: "https://gitlab.com/platform/review/api",
          archived: false,
        },
      ],
    });

    const request = requests[0];
    expect(request?.init?.headers).toMatchObject({
      "PRIVATE-TOKEN": "token",
    });
    const url = new URL(request?.url ?? "");
    expect(url.pathname).toBe("/api/v4/groups/platform%2Freview/projects");
    expect(url.searchParams.get("simple")).toBe("true");
    expect(url.searchParams.get("include_subgroups")).toBe("true");
    expect(url.searchParams.get("archived")).toBe("false");
    expect(url.searchParams.get("with_shared")).toBe("false");
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("per_page")).toBe("50");
    expect(url.searchParams.get("search")).toBe("api");
  });

  it("keeps empty GitLab group project totals as zero", async () => {
    const fetchImpl = async () =>
      jsonResponse([], 200, {
        "x-page": "1",
        "x-per-page": "100",
        "x-total": "0",
        "x-total-pages": "0",
      });
    const gateway = new GitLabInstallationGateway({
      token: "token",
      fetchImpl,
    });

    await expect(
      gateway.listGroupProjects({
        groupIdOrPath: "platform",
        includeSubgroups: true,
        archived: false,
        withShared: false,
        page: 1,
        perPage: 100,
      }),
    ).resolves.toMatchObject({
      total: 0,
      totalPages: 0,
      projects: [],
    });
  });

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

  it("uses static CI lint for MR-only ReviewRouter configs", async () => {
    const requests: RecordedRequest[] = [];
    const fetchImpl = async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      requests.push({ url: String(url), init });
      return jsonResponse({ valid: true, errors: [] });
    };
    const gateway = new GitLabInstallationGateway({
      token: "token",
      fetchImpl,
    });

    await expect(
      gateway.lintCiConfig({
        projectId: "123",
        content: "reviewrouter:review:\n  script: reviewrouter-gitlab-review\n",
        ref: "main",
      }),
    ).resolves.toEqual({
      valid: true,
      errors: [],
    });

    const body = JSON.parse(String(requests[0]?.init?.body)) as {
      readonly content: string;
      readonly dry_run?: boolean;
      readonly include_jobs?: boolean;
      readonly include_merged_yaml?: boolean;
      readonly ref?: string;
    };
    expect(body.dry_run).toBeUndefined();
    expect(body.include_jobs).toBe(false);
    expect(body.include_merged_yaml).toBe(true);
    expect(body.ref).toBe("main");
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

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
