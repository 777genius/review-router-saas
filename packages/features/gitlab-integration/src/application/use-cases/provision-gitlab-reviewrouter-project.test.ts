import { describe, expect, it } from "vitest";
import type { Clock } from "@reviewrouter/shared";
import type { GitLabInstallationPort } from "../ports/gitlab-installation-port";
import {
  type GitLabCiLintResult,
  type GitLabCiVariableSpec,
  type GitLabGroupProjectsPage,
  type GitLabProjectInstallationSettings,
  type GitLabSetupMergeRequestFile,
} from "../../domain/gitlab-installation";
import { discoverGitLabGroupProjects } from "./discover-gitlab-group-projects";
import { provisionGitLabReviewRouterProject } from "./provision-gitlab-reviewrouter-project";
import { provisionGitLabReviewRouterProjects } from "./provision-gitlab-reviewrouter-projects";

const fixedNow = new Date("2026-05-30T12:00:00.000Z");
const clock: Clock = { now: () => fixedNow };

const project: GitLabProjectInstallationSettings = {
  projectId: "123",
  fullName: "group/project",
  defaultBranch: "main",
  ciConfigPath: null,
  canEditProjectSettings: true,
  canCreateMergeRequest: true,
};

class InMemoryInstallation implements GitLabInstallationPort {
  public project: GitLabProjectInstallationSettings = project;
  public failingProjectIds = new Set<string>();
  public lint: GitLabCiLintResult = { valid: true, errors: [] };
  public lintCalls = 0;
  public updatedCiConfigPath: string | null = null;
  public updatedProjectIds: string[] = [];
  public variables: GitLabCiVariableSpec[] = [];
  public groupProjectsCalls: Array<{
    readonly groupIdOrPath: string;
    readonly includeSubgroups: boolean;
    readonly archived: boolean;
    readonly withShared: boolean;
    readonly page: number;
    readonly perPage: number;
    readonly search?: string | undefined;
  }> = [];
  public groupProjectsPage: GitLabGroupProjectsPage = {
    groupIdOrPath: "12",
    page: 1,
    perPage: 100,
    nextPage: null,
    total: 2,
    totalPages: 1,
    projects: [
      {
        projectId: "123",
        fullName: "group/project-a",
        name: "project-a",
        defaultBranch: "main",
        webUrl: "https://gitlab.com/group/project-a",
        archived: false,
      },
      {
        projectId: "456",
        fullName: "group/sub/project-b",
        name: "project-b",
        defaultBranch: "main",
        webUrl: "https://gitlab.com/group/sub/project-b",
        archived: false,
      },
    ],
  };
  public setupMergeRequest: {
    readonly sourceBranch: string;
    readonly files: readonly GitLabSetupMergeRequestFile[];
  } | null = null;

  async listGroupProjects(input: {
    readonly groupIdOrPath: string;
    readonly includeSubgroups: boolean;
    readonly archived: boolean;
    readonly withShared: boolean;
    readonly page: number;
    readonly perPage: number;
    readonly search?: string | undefined;
  }): Promise<GitLabGroupProjectsPage> {
    this.groupProjectsCalls.push(input);
    return {
      ...this.groupProjectsPage,
      groupIdOrPath: input.groupIdOrPath,
      page: input.page,
      perPage: input.perPage,
    };
  }

  async getProjectSettings(input: {
    readonly projectId: string;
  }): Promise<GitLabProjectInstallationSettings> {
    if (this.failingProjectIds.has(input.projectId)) {
      throw new Error("gitlab_api_error_503");
    }
    return {
      ...this.project,
      projectId: input.projectId,
    };
  }

  async lintCiConfig(): Promise<GitLabCiLintResult> {
    this.lintCalls += 1;
    return this.lint;
  }

  async updateProjectCiConfigPath(input: {
    readonly projectId: string;
    readonly ciConfigPath: string;
  }): Promise<void> {
    this.updatedProjectIds.push(input.projectId);
    this.updatedCiConfigPath = input.ciConfigPath;
  }

  async upsertCiVariable(input: {
    readonly variable: GitLabCiVariableSpec;
  }): Promise<void> {
    this.variables.push(input.variable);
  }

  async createSetupMergeRequest(input: {
    readonly sourceBranch: string;
    readonly files: readonly GitLabSetupMergeRequestFile[];
  }) {
    this.setupMergeRequest = {
      sourceBranch: input.sourceBranch,
      files: input.files,
    };
    return {
      iid: "8",
      webUrl: "https://gitlab.com/group/project/-/merge_requests/8",
    };
  }
}

describe("discoverGitLabGroupProjects", () => {
  it("discovers GitLab group projects with safe onboarding defaults", async () => {
    const installation = new InMemoryInstallation();

    await expect(
      discoverGitLabGroupProjects(
        {
          groupIdOrPath: "group/platform",
          search: "project",
        },
        { installation },
      ),
    ).resolves.toEqual({
      protocolVersion: 1,
      groupIdOrPath: "group/platform",
      page: 1,
      perPage: 100,
      nextPage: null,
      total: 2,
      totalPages: 1,
      projectIds: ["123", "456"],
      projects: installation.groupProjectsPage.projects,
    });
    expect(installation.groupProjectsCalls).toEqual([
      {
        groupIdOrPath: "group/platform",
        includeSubgroups: true,
        archived: false,
        withShared: false,
        page: 1,
        perPage: 100,
        search: "project",
      },
    ]);
  });

  it("rejects invalid GitLab group discovery input before calling GitLab", async () => {
    const installation = new InMemoryInstallation();

    await expect(
      discoverGitLabGroupProjects(
        {
          groupIdOrPath: "/group",
        },
        { installation },
      ),
    ).rejects.toThrow("gitlab_group_id_or_path_invalid");

    await expect(
      discoverGitLabGroupProjects(
        {
          groupIdOrPath: "group",
          perPage: 101,
        },
        { installation },
      ),
    ).rejects.toThrow("gitlab_group_projects_per_page_invalid");

    expect(installation.groupProjectsCalls).toEqual([]);
  });
});

describe("provisionGitLabReviewRouterProject", () => {
  it("uses ci_config_path after CI lint dry-run succeeds", async () => {
    const installation = new InMemoryInstallation();

    await expect(
      provisionGitLabReviewRouterProject(
        {
          projectId: "123",
          controlProjectPath: "reviewrouter/control",
          controlProjectRef: "main",
          reviewRouterApiBaseUrl: "https://reviewrouter.example.com",
          idTokenAudience: "reviewrouter",
          variableTarget: { kind: "group", id: "12" },
          reviewToken: "glpat-review-token",
        },
        { installation, clock },
      ),
    ).resolves.toEqual({
      mode: "ci_config_path",
      ciConfigPath: ".gitlab/reviewrouter.yml@reviewrouter/control:main",
      variablesConfigured: 3,
    });

    expect(installation.updatedCiConfigPath).toBe(
      ".gitlab/reviewrouter.yml@reviewrouter/control:main",
    );
    expect(installation.setupMergeRequest).toBeNull();
    expect(installation.variables.map((variable) => variable.key)).toEqual([
      "REVIEWROUTER_API_URL",
      "REVIEWROUTER_ID_TOKEN_AUDIENCE",
      "REVIEWROUTER_GITLAB_TOKEN",
    ]);
  });

  it("does not overwrite a non-ReviewRouter ci_config_path", async () => {
    const installation = new InMemoryInstallation();
    installation.project = {
      ...project,
      ciConfigPath: "custom/gitlab-ci.yml@platform/pipelines",
    };

    const result = await provisionGitLabReviewRouterProject(
      {
        projectId: "123",
        controlProjectPath: "reviewrouter/control",
        reviewRouterApiBaseUrl: "https://reviewrouter.example.com",
        idTokenAudience: "reviewrouter",
      },
      { installation, clock },
    );

    expect(result).toMatchObject({
      mode: "setup_merge_request",
      reason: "existing_ci_config_path_not_owned",
      mergeRequestIid: "8",
    });
    expect(installation.lintCalls).toBe(0);
    expect(installation.updatedCiConfigPath).toBeNull();
    expect(installation.setupMergeRequest?.files[0]?.content).toContain(
      "reviewrouter/control",
    );
  });

  it("falls back to setup MR when CI lint fails", async () => {
    const installation = new InMemoryInstallation();
    installation.lint = {
      valid: false,
      errors: ["Project `reviewrouter/control` not found"],
    };

    await expect(
      provisionGitLabReviewRouterProject(
        {
          projectId: "123",
          controlProjectPath: "reviewrouter/control",
          reviewRouterApiBaseUrl: "https://reviewrouter.example.com",
          idTokenAudience: "reviewrouter",
        },
        { installation, clock },
      ),
    ).resolves.toMatchObject({
      mode: "setup_merge_request",
      reason: "ci_lint_invalid",
      lintErrors: ["Project `reviewrouter/control` not found"],
    });
    expect(installation.updatedCiConfigPath).toBeNull();
  });

  it("skips without partial variables when settings and MR permissions are missing", async () => {
    const installation = new InMemoryInstallation();
    installation.project = {
      ...project,
      canEditProjectSettings: false,
      canCreateMergeRequest: false,
    };

    await expect(
      provisionGitLabReviewRouterProject(
        {
          projectId: "123",
          controlProjectPath: "reviewrouter/control",
          reviewRouterApiBaseUrl: "https://reviewrouter.example.com",
          idTokenAudience: "reviewrouter",
          variableTarget: { kind: "group", id: "12" },
          reviewToken: "glpat-review-token",
        },
        { installation, clock },
      ),
    ).resolves.toEqual({
      mode: "skipped",
      reason: "project_settings_permission_missing",
      lintErrors: [],
    });
    expect(installation.variables).toEqual([]);
    expect(installation.updatedCiConfigPath).toBeNull();
  });
});

describe("provisionGitLabReviewRouterProjects", () => {
  it("provisions unique project ids and returns per-project failures", async () => {
    const installation = new InMemoryInstallation();
    installation.failingProjectIds.add("456");

    const result = await provisionGitLabReviewRouterProjects(
      {
        projectIds: ["123", "456", "123"],
        controlProjectPath: "reviewrouter/control",
        controlProjectRef: "main",
        reviewRouterApiBaseUrl: "https://reviewrouter.example.com",
        idTokenAudience: "reviewrouter",
        variableTarget: { kind: "group", id: "12" },
      },
      { installation, clock },
    );

    expect(result).toEqual({
      protocolVersion: 1,
      requested: 2,
      succeeded: 1,
      failed: 1,
      sharedVariablesConfigured: 2,
      results: [
        {
          projectId: "123",
          status: "fulfilled",
          result: {
            mode: "ci_config_path",
            ciConfigPath: ".gitlab/reviewrouter.yml@reviewrouter/control:main",
            variablesConfigured: 0,
          },
        },
        {
          projectId: "456",
          status: "rejected",
          error: {
            code: "gitlab_api_error_503",
            retryable: true,
          },
        },
      ],
    });
    expect(installation.updatedProjectIds).toEqual(["123"]);
    expect(installation.variables.map((variable) => variable.key)).toEqual([
      "REVIEWROUTER_API_URL",
      "REVIEWROUTER_ID_TOKEN_AUDIENCE",
    ]);
  });

  it("rejects invalid or excessive project id lists before provisioning", async () => {
    const installation = new InMemoryInstallation();

    await expect(
      provisionGitLabReviewRouterProjects(
        {
          projectIds: ["123", "bad"],
          controlProjectPath: "reviewrouter/control",
          reviewRouterApiBaseUrl: "https://reviewrouter.example.com",
          idTokenAudience: "reviewrouter",
        },
        { installation, clock },
      ),
    ).rejects.toThrow("gitlab_bulk_project_id_invalid");

    await expect(
      provisionGitLabReviewRouterProjects(
        {
          projectIds: Array.from({ length: 101 }, (_, index) =>
            String(index + 1),
          ),
          controlProjectPath: "reviewrouter/control",
          reviewRouterApiBaseUrl: "https://reviewrouter.example.com",
          idTokenAudience: "reviewrouter",
        },
        { installation, clock },
      ),
    ).rejects.toThrow("gitlab_bulk_project_limit_exceeded");

    expect(installation.updatedProjectIds).toEqual([]);
  });
});
