import { describe, expect, it } from "vitest";
import type { Clock } from "@reviewrouter/shared";
import type { GitLabInstallationPort } from "../ports/gitlab-installation-port";
import {
  type GitLabCiLintResult,
  type GitLabCiVariableSpec,
  type GitLabProjectInstallationSettings,
  type GitLabSetupMergeRequestFile,
} from "../../domain/gitlab-installation";
import { provisionGitLabReviewRouterProject } from "./provision-gitlab-reviewrouter-project";

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
  public lint: GitLabCiLintResult = { valid: true, errors: [] };
  public lintCalls = 0;
  public updatedCiConfigPath: string | null = null;
  public variables: GitLabCiVariableSpec[] = [];
  public setupMergeRequest: {
    readonly sourceBranch: string;
    readonly files: readonly GitLabSetupMergeRequestFile[];
  } | null = null;

  async getProjectSettings(): Promise<GitLabProjectInstallationSettings> {
    return this.project;
  }

  async lintCiConfig(): Promise<GitLabCiLintResult> {
    this.lintCalls += 1;
    return this.lint;
  }

  async updateProjectCiConfigPath(input: {
    readonly ciConfigPath: string;
  }): Promise<void> {
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
