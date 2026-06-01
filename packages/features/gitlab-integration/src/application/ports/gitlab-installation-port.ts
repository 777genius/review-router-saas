import type {
  GitLabCiLintResult,
  GitLabGroupProjectsPage,
  GitLabCiVariableSpec,
  GitLabProjectInstallationSettings,
  GitLabSetupMergeRequestFile,
} from "../../domain/gitlab-installation";

export type GitLabSetupMergeRequestResult = {
  readonly iid: string;
  readonly webUrl: string;
};

export interface GitLabInstallationPort {
  listGroupProjects(input: {
    readonly groupIdOrPath: string;
    readonly includeSubgroups: boolean;
    readonly archived: boolean;
    readonly withShared: boolean;
    readonly page: number;
    readonly perPage: number;
    readonly search?: string | undefined;
  }): Promise<GitLabGroupProjectsPage>;

  getProjectSettings(input: {
    readonly projectId: string;
  }): Promise<GitLabProjectInstallationSettings>;

  getProjectSettingsByPathOrId(input: {
    readonly projectPathOrId: string;
  }): Promise<GitLabProjectInstallationSettings>;

  lintCiConfig(input: {
    readonly projectId: string;
    readonly content: string;
    readonly ref: string;
  }): Promise<GitLabCiLintResult>;

  updateProjectCiConfigPath(input: {
    readonly projectId: string;
    readonly ciConfigPath: string;
  }): Promise<void>;

  upsertCiVariable(input: {
    readonly variable: GitLabCiVariableSpec;
  }): Promise<void>;

  createSetupMergeRequest(input: {
    readonly projectId: string;
    readonly sourceBranch: string;
    readonly targetBranch: string;
    readonly title: string;
    readonly description: string;
    readonly files: readonly GitLabSetupMergeRequestFile[];
  }): Promise<GitLabSetupMergeRequestResult>;
}
