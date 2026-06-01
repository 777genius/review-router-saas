import { describe, expect, it } from "vitest";
import type { GitLabInstallationPort } from "../ports/gitlab-installation-port";
import type {
  GitLabCiLintResult,
  GitLabGroupProjectsPage,
  GitLabProjectInstallationSettings,
} from "../../domain/gitlab-installation";
import { discoverGitLabSourceProjects } from "./discover-gitlab-source-projects";

class DiscoveryInstallation implements GitLabInstallationPort {
  public projectSettingsByPath = new Map<
    string,
    GitLabProjectInstallationSettings
  >();
  public listedGroups: string[] = [];
  public projectNotFoundMessage = "gitlab_api_error_404";

  async listGroupProjects(input: {
    readonly groupIdOrPath: string;
    readonly includeSubgroups: boolean;
    readonly archived: boolean;
    readonly withShared: boolean;
    readonly page: number;
    readonly perPage: number;
  }): Promise<GitLabGroupProjectsPage> {
    this.listedGroups.push(input.groupIdOrPath);
    return {
      groupIdOrPath: input.groupIdOrPath,
      page: input.page,
      perPage: input.perPage,
      nextPage: null,
      total: 2,
      totalPages: 1,
      projects: [
        {
          projectId: "101",
          fullName: `${input.groupIdOrPath}/api`,
          name: "api",
          defaultBranch: "main",
          webUrl: `https://gitlab.com/${input.groupIdOrPath}/api`,
          archived: false,
        },
        {
          projectId: "102",
          fullName: `${input.groupIdOrPath}/worker`,
          name: "worker",
          defaultBranch: "main",
          webUrl: `https://gitlab.com/${input.groupIdOrPath}/worker`,
          archived: false,
        },
      ],
    };
  }

  async getProjectSettings(input: {
    readonly projectId: string;
  }): Promise<GitLabProjectInstallationSettings> {
    return this.getProjectSettingsByPathOrId({
      projectPathOrId: input.projectId,
    });
  }

  async getProjectSettingsByPathOrId(input: {
    readonly projectPathOrId: string;
  }): Promise<GitLabProjectInstallationSettings> {
    const project = this.projectSettingsByPath.get(input.projectPathOrId);
    if (!project) throw new Error(this.projectNotFoundMessage);
    return project;
  }

  async lintCiConfig(): Promise<GitLabCiLintResult> {
    return { valid: true, errors: [] };
  }

  async updateProjectCiConfigPath(): Promise<void> {}

  async upsertCiVariable(): Promise<void> {}

  async createSetupMergeRequest() {
    return {
      iid: "1",
      webUrl: "https://gitlab.com/acme/api/-/merge_requests/1",
    };
  }
}

describe("discoverGitLabSourceProjects", () => {
  it("returns one project and its parent group for a project URL", async () => {
    const installation = new DiscoveryInstallation();
    installation.projectSettingsByPath.set("acme/platform/api", {
      projectId: "101",
      fullName: "acme/platform/api",
      defaultBranch: "main",
      ciConfigPath: null,
      canEditProjectSettings: true,
      canCreateMergeRequest: true,
    });

    await expect(
      discoverGitLabSourceProjects(
        {
          sourceUrl: "https://gitlab.com/acme/platform/api",
          workspaceId: "workspace_1",
        },
        { installation },
      ),
    ).resolves.toMatchObject({
      source: {
        inputPath: "acme/platform/api",
        resolvedKind: "project",
        baseUrl: "https://gitlab.com",
      },
      projectIds: ["101"],
      parentGroupPath: "acme/platform",
      projects: [
        {
          projectId: "101",
          fullName: "acme/platform/api",
          name: "api",
          webUrl: "https://gitlab.com/acme/platform/api",
        },
      ],
    });
    expect(installation.listedGroups).toEqual([]);
  });

  it("lists a group with subgroups when the URL is not a project", async () => {
    const installation = new DiscoveryInstallation();

    const result = await discoverGitLabSourceProjects(
      {
        sourceUrl: "https://gitlab.com/acme/platform",
        workspaceId: "workspace_1",
      },
      { installation },
    );

    expect(result.source.resolvedKind).toBe("group");
    expect(result.projectIds).toEqual(["101", "102"]);
    expect(result.parentGroupPath).toBe("acme/platform");
    expect(installation.listedGroups).toEqual(["acme/platform"]);
  });

  it("falls back to group discovery when project lookup returns a detailed GitLab 404", async () => {
    const installation = new DiscoveryInstallation();
    installation.projectNotFoundMessage = "gitlab_api_error_404: Not Found";

    const result = await discoverGitLabSourceProjects(
      {
        sourceUrl: "https://gitlab.com/acme/platform",
        workspaceId: "workspace_1",
      },
      { installation },
    );

    expect(result.source.resolvedKind).toBe("group");
    expect(result.projectIds).toEqual(["101", "102"]);
    expect(installation.listedGroups).toEqual(["acme/platform"]);
  });
});
