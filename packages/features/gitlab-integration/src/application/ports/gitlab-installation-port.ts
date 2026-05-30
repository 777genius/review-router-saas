import type {
  GitLabCiLintResult,
  GitLabCiVariableSpec,
  GitLabProjectInstallationSettings,
  GitLabSetupMergeRequestFile,
} from "../../domain/gitlab-installation";

export type GitLabSetupMergeRequestResult = {
  readonly iid: string;
  readonly webUrl: string;
};

export interface GitLabInstallationPort {
  getProjectSettings(input: {
    readonly projectId: string;
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
