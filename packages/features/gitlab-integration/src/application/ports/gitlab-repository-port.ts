import type {
  GitLabMergeRequestIdentity,
  GitLabRepositoryContext,
} from "../../domain/gitlab-ci-identity";

export interface GitLabRepositoryPort {
  findSelectedRepositoryByGitLabProjectId(
    gitlabProjectId: string,
  ): Promise<GitLabRepositoryContext | null>;
}

export interface GitLabMergeRequestPort {
  getMergeRequest(input: {
    readonly projectId: string;
    readonly mergeRequestIid: string;
  }): Promise<GitLabMergeRequestIdentity>;
}
