import type { GitLabMergeRequestPort } from "../../application/ports/gitlab-repository-port";
import type { GitLabMergeRequestIdentity } from "../../domain/gitlab-ci-identity";

const defaultGitLabApiBaseUrl = "https://gitlab.com/api/v4";
type GitLabTokenAuthMode = "private-token" | "bearer";

type GitLabMergeRequestApiResponse = {
  readonly project_id: number;
  readonly iid: number;
  readonly sha: string;
  readonly source_project_id: number;
  readonly target_project_id: number;
  readonly state: string;
};

export type GitLabMergeRequestGatewayOptions = {
  readonly token: string;
  readonly tokenAuthMode?: GitLabTokenAuthMode | undefined;
  readonly apiBaseUrl?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
};

export class GitLabMergeRequestGateway implements GitLabMergeRequestPort {
  private readonly token: string;
  private readonly tokenAuthMode: GitLabTokenAuthMode;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GitLabMergeRequestGatewayOptions) {
    if (options.token.length === 0) {
      throw new Error("gitlab_token_required");
    }
    this.token = options.token;
    this.tokenAuthMode = options.tokenAuthMode ?? "private-token";
    this.apiBaseUrl = (options.apiBaseUrl ?? defaultGitLabApiBaseUrl).replace(
      /\/+$/,
      "",
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getMergeRequest(input: {
    readonly projectId: string;
    readonly mergeRequestIid: string;
  }): Promise<GitLabMergeRequestIdentity> {
    const mergeRequest = await this.requestJson<GitLabMergeRequestApiResponse>(
      `/projects/${encodeURIComponent(input.projectId)}/merge_requests/${encodeURIComponent(input.mergeRequestIid)}`,
    );

    return {
      projectId: String(mergeRequest.project_id),
      mergeRequestIid: String(mergeRequest.iid),
      headSha: mergeRequest.sha,
      sourceProjectId: String(mergeRequest.source_project_id),
      targetProjectId: String(mergeRequest.target_project_id),
      state: mergeRequest.state,
    };
  }

  private async requestJson<T>(path: string): Promise<T> {
    const response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
      headers: {
        Accept: "application/json",
        ...this.authHeaders(),
      },
    });
    if (!response.ok) {
      throw new Error(`gitlab_api_error_${response.status}`);
    }
    return (await response.json()) as T;
  }

  private authHeaders(): Record<string, string> {
    if (this.tokenAuthMode === "bearer") {
      return { Authorization: `Bearer ${this.token}` };
    }
    return { "PRIVATE-TOKEN": this.token };
  }
}
