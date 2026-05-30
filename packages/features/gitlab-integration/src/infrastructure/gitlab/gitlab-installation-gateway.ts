import type { GitLabInstallationPort } from "../../application/ports/gitlab-installation-port";
import type {
  GitLabCiLintResult,
  GitLabGroupProjectsPage,
  GitLabCiVariableSpec,
  GitLabProjectInstallationSettings,
  GitLabSetupMergeRequestFile,
} from "../../domain/gitlab-installation";

const defaultGitLabApiBaseUrl = "https://gitlab.com/api/v4";
const maintainerAccessLevel = 40;
const developerAccessLevel = 30;

type GitLabTokenAuthMode = "private-token" | "bearer";

type GitLabProjectApiResponse = {
  readonly id: number;
  readonly path_with_namespace: string;
  readonly default_branch: string | null;
  readonly ci_config_path?: string | null | undefined;
  readonly permissions?:
    | {
        readonly project_access?:
          | { readonly access_level?: number | null | undefined }
          | null
          | undefined;
        readonly group_access?:
          | { readonly access_level?: number | null | undefined }
          | null
          | undefined;
      }
    | null
    | undefined;
};

type GitLabGroupProjectApiResponse = {
  readonly id: number;
  readonly path_with_namespace: string;
  readonly name: string;
  readonly default_branch?: string | null | undefined;
  readonly web_url?: string | null | undefined;
  readonly archived?: boolean | undefined;
};

type GitLabCiLintApiResponse = {
  readonly status?: string | undefined;
  readonly valid?: boolean | undefined;
  readonly errors?: readonly string[] | undefined;
};

type GitLabRepositoryFileApiResponse = {
  readonly file_path: string;
  readonly content: string;
  readonly encoding: string;
};

type GitLabMergeRequestApiResponse = {
  readonly iid: number;
  readonly web_url: string;
};

type GitLabCommitAction = {
  readonly action: "create" | "update";
  readonly file_path: string;
  readonly content: string;
};

export type GitLabInstallationGatewayOptions = {
  readonly token: string;
  readonly tokenAuthMode?: GitLabTokenAuthMode | undefined;
  readonly apiBaseUrl?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
};

export class GitLabInstallationGateway implements GitLabInstallationPort {
  private readonly token: string;
  private readonly tokenAuthMode: GitLabTokenAuthMode;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GitLabInstallationGatewayOptions) {
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

  async listGroupProjects(input: {
    readonly groupIdOrPath: string;
    readonly includeSubgroups: boolean;
    readonly archived: boolean;
    readonly withShared: boolean;
    readonly page: number;
    readonly perPage: number;
    readonly search?: string | undefined;
  }): Promise<GitLabGroupProjectsPage> {
    const params = new URLSearchParams({
      simple: "true",
      include_subgroups: String(input.includeSubgroups),
      archived: String(input.archived),
      with_shared: String(input.withShared),
      page: String(input.page),
      per_page: String(input.perPage),
    });
    if (input.search) {
      params.set("search", input.search);
    }
    const response = await this.request({
      method: "GET",
      path: `/groups/${encodeURIComponent(input.groupIdOrPath)}/projects?${params.toString()}`,
    });
    await ensureOk(response);
    const projects =
      (await response.json()) as readonly GitLabGroupProjectApiResponse[];

    return {
      groupIdOrPath: input.groupIdOrPath,
      page:
        parsePositiveIntegerHeader(response.headers, "x-page") ?? input.page,
      perPage:
        parsePositiveIntegerHeader(response.headers, "x-per-page") ??
        input.perPage,
      nextPage: parsePositiveIntegerHeader(response.headers, "x-next-page"),
      total: parseNonNegativeIntegerHeader(response.headers, "x-total"),
      totalPages: parseNonNegativeIntegerHeader(
        response.headers,
        "x-total-pages",
      ),
      projects: projects.map((project) => ({
        projectId: String(project.id),
        fullName: project.path_with_namespace,
        name: project.name,
        defaultBranch: project.default_branch ?? null,
        webUrl: project.web_url ?? null,
        archived: project.archived ?? false,
      })),
    };
  }

  async getProjectSettings(input: {
    readonly projectId: string;
  }): Promise<GitLabProjectInstallationSettings> {
    const project = await this.requestJson<GitLabProjectApiResponse>({
      method: "GET",
      path: `/projects/${encodeURIComponent(input.projectId)}`,
    });
    const accessLevel = Math.max(
      project.permissions?.project_access?.access_level ?? 0,
      project.permissions?.group_access?.access_level ?? 0,
    );

    return {
      projectId: String(project.id),
      fullName: project.path_with_namespace,
      defaultBranch: project.default_branch ?? "main",
      ciConfigPath: project.ci_config_path?.trim() || null,
      canEditProjectSettings: accessLevel >= maintainerAccessLevel,
      canCreateMergeRequest: accessLevel >= developerAccessLevel,
    };
  }

  async lintCiConfig(input: {
    readonly projectId: string;
    readonly content: string;
    readonly ref: string;
  }): Promise<GitLabCiLintResult> {
    const lint = await this.requestJson<GitLabCiLintApiResponse>({
      method: "POST",
      path: `/projects/${encodeURIComponent(input.projectId)}/ci/lint`,
      body: {
        content: input.content,
        dry_run: true,
        include_jobs: false,
        ref: input.ref,
      },
    });
    const valid = lint.valid === true || lint.status === "valid";
    return {
      valid,
      errors: lint.errors ?? [],
    };
  }

  async updateProjectCiConfigPath(input: {
    readonly projectId: string;
    readonly ciConfigPath: string;
  }): Promise<void> {
    await this.requestJson({
      method: "PUT",
      path: `/projects/${encodeURIComponent(input.projectId)}`,
      body: { ci_config_path: input.ciConfigPath },
    });
  }

  async upsertCiVariable(input: {
    readonly variable: GitLabCiVariableSpec;
  }): Promise<void> {
    const endpoint = variableEndpoint(input.variable);
    const body = variableBody(input.variable);
    const updated = await this.request({
      method: "PUT",
      path: `${endpoint}/${encodeURIComponent(input.variable.key)}`,
      body,
      allowNotFound: true,
    });
    if (updated.status !== 404) {
      await ensureOk(updated);
      return;
    }
    const created = await this.request({
      method: "POST",
      path: endpoint,
      body: {
        key: input.variable.key,
        ...body,
      },
    });
    await ensureOk(created);
  }

  async createSetupMergeRequest(input: {
    readonly projectId: string;
    readonly sourceBranch: string;
    readonly targetBranch: string;
    readonly title: string;
    readonly description: string;
    readonly files: readonly GitLabSetupMergeRequestFile[];
  }): Promise<{ readonly iid: string; readonly webUrl: string }> {
    await this.createBranch({
      projectId: input.projectId,
      sourceBranch: input.sourceBranch,
      targetBranch: input.targetBranch,
    });
    const actions = await this.buildCommitActions({
      projectId: input.projectId,
      ref: input.sourceBranch,
      files: input.files,
    });
    await this.requestJson({
      method: "POST",
      path: `/projects/${encodeURIComponent(input.projectId)}/repository/commits`,
      body: {
        branch: input.sourceBranch,
        commit_message: "Install ReviewRouter GitLab CI include",
        actions,
      },
    });
    const mergeRequest = await this.requestJson<GitLabMergeRequestApiResponse>({
      method: "POST",
      path: `/projects/${encodeURIComponent(input.projectId)}/merge_requests`,
      body: {
        source_branch: input.sourceBranch,
        target_branch: input.targetBranch,
        title: input.title,
        description: input.description,
        remove_source_branch: true,
      },
    });
    return {
      iid: String(mergeRequest.iid),
      webUrl: mergeRequest.web_url,
    };
  }

  private async createBranch(input: {
    readonly projectId: string;
    readonly sourceBranch: string;
    readonly targetBranch: string;
  }): Promise<void> {
    const params = new URLSearchParams({
      branch: input.sourceBranch,
      ref: input.targetBranch,
    });
    await this.requestJson({
      method: "POST",
      path: `/projects/${encodeURIComponent(input.projectId)}/repository/branches?${params.toString()}`,
    });
  }

  private async buildCommitActions(input: {
    readonly projectId: string;
    readonly ref: string;
    readonly files: readonly GitLabSetupMergeRequestFile[];
  }): Promise<readonly GitLabCommitAction[]> {
    const actions: GitLabCommitAction[] = [];
    for (const file of input.files) {
      const existing = await this.getRepositoryFile({
        projectId: input.projectId,
        path: file.path,
        ref: input.ref,
      });
      actions.push({
        action: existing ? "update" : "create",
        file_path: file.path,
        content: existing
          ? mergeReviewRouterInclude(existing.content, file.content)
          : file.content,
      });
    }
    return actions;
  }

  private async getRepositoryFile(input: {
    readonly projectId: string;
    readonly path: string;
    readonly ref: string;
  }): Promise<{ readonly content: string } | null> {
    const params = new URLSearchParams({ ref: input.ref });
    const response = await this.request({
      method: "GET",
      path: `/projects/${encodeURIComponent(input.projectId)}/repository/files/${encodeURIComponent(input.path)}?${params.toString()}`,
      allowNotFound: true,
    });
    if (response.status === 404) {
      return null;
    }
    await ensureOk(response);
    const file = (await response.json()) as GitLabRepositoryFileApiResponse;
    if (file.encoding !== "base64") {
      throw new Error("gitlab_repository_file_encoding_unsupported");
    }
    return {
      content: Buffer.from(file.content, "base64").toString("utf8"),
    };
  }

  private async requestJson<T = unknown>(input: {
    readonly method: string;
    readonly path: string;
    readonly body?: unknown | undefined;
  }): Promise<T> {
    const response = await this.request(input);
    await ensureOk(response);
    return (await response.json()) as T;
  }

  private async request(input: {
    readonly method: string;
    readonly path: string;
    readonly body?: unknown | undefined;
    readonly allowNotFound?: boolean | undefined;
  }): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...this.authHeaders(),
    };
    const init: RequestInit = {
      method: input.method,
      headers,
    };
    if (input.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(input.body);
    }
    const response = await this.fetchImpl(
      `${this.apiBaseUrl}${input.path}`,
      init,
    );
    if (input.allowNotFound && response.status === 404) {
      return response;
    }
    return response;
  }

  private authHeaders(): Record<string, string> {
    if (this.tokenAuthMode === "bearer") {
      return { Authorization: `Bearer ${this.token}` };
    }
    return { "PRIVATE-TOKEN": this.token };
  }
}

function variableEndpoint(variable: GitLabCiVariableSpec): string {
  const encodedId = encodeURIComponent(variable.target.id);
  return variable.target.kind === "group"
    ? `/groups/${encodedId}/variables`
    : `/projects/${encodedId}/variables`;
}

function variableBody(variable: GitLabCiVariableSpec): Record<string, unknown> {
  return {
    value: variable.value,
    protected: variable.protected ?? false,
    masked: variable.masked ?? false,
    raw: variable.raw ?? true,
    variable_type: variable.variableType ?? "env_var",
  };
}

function mergeReviewRouterInclude(
  existingContent: string,
  includeContent: string,
): string {
  if (existingContent.includes(includeContent.trim())) {
    return existingContent;
  }
  const trimmedExisting = existingContent.endsWith("\n")
    ? existingContent
    : `${existingContent}\n`;
  return `${trimmedExisting}\n# ReviewRouter\n${includeContent}`;
}

async function ensureOk(response: Response): Promise<void> {
  if (!response.ok) {
    throw new Error(`gitlab_api_error_${response.status}`);
  }
}

function parsePositiveIntegerHeader(
  headers: Headers,
  name: string,
): number | null {
  const value = headers.get(name)?.trim();
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseNonNegativeIntegerHeader(
  headers: Headers,
  name: string,
): number | null {
  const value = headers.get(name)?.trim();
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}
