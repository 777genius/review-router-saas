import { App } from "@octokit/app";
import type {
  ActionConflictReviewPostingGatewayPort,
  ActionConflictReviewPrePostValidatorPort,
} from "@reviewrouter/features-action-control-plane";

type OctokitRequester = {
  request: (
    route: string,
    parameters?: Record<string, unknown>,
  ) => Promise<{ data: unknown }>;
};

type OctokitInstallationApp = {
  getInstallationOctokit(
    installationId: number,
  ): Promise<OctokitRequester> | OctokitRequester;
};

export type OctokitConflictReviewPostingGatewayOptions = {
  readonly appId?: string | undefined;
  readonly privateKey?: string | undefined;
  readonly appSlug?: string | undefined;
  readonly botLogin?: string | undefined;
  readonly app?: OctokitInstallationApp | undefined;
};

export class OctokitConflictReviewPostingGateway
  implements
    ActionConflictReviewPostingGatewayPort,
    ActionConflictReviewPrePostValidatorPort
{
  private readonly app: OctokitInstallationApp;
  private readonly botLogin: string;

  constructor(options: OctokitConflictReviewPostingGatewayOptions) {
    this.app =
      options.app ??
      createGitHubApp({
        appId: options.appId,
        privateKey: options.privateKey,
      });
    this.botLogin = normalizeBotLogin(
      options.botLogin ?? botLoginFromAppSlug(options.appSlug),
    );
  }

  async upsertConflictReviewSummary(input: {
    readonly githubInstallationId: string;
    readonly githubRepositoryId: string;
    readonly repositoryFullName: string;
    readonly pullRequestNumber: number;
    readonly headSha: string;
    readonly baseRef: string;
    readonly baseSha: string;
    readonly marker: string;
    readonly body: string;
  }): Promise<{
    readonly githubExternalId: string;
    readonly githubUrl?: string | undefined;
  }> {
    const { octokit, owner, repo } = await this.validatedInstallation(input);
    const existing = await findOwnedSummaryComment({
      octokit,
      owner,
      repo,
      pullRequestNumber: input.pullRequestNumber,
      marker: input.marker,
      botLogin: this.botLogin,
    });
    const response = existing
      ? await octokit.request(
          "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
          {
            owner,
            repo,
            comment_id: existing.id,
            body: input.body,
          },
        )
      : await octokit.request(
          "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
          {
            owner,
            repo,
            issue_number: input.pullRequestNumber,
            body: input.body,
          },
        );
    const comment = parseCommentResponse(response.data);
    return {
      githubExternalId: String(comment.id),
      githubUrl: comment.htmlUrl,
    };
  }

  async postConflictReviewAdvisoryStatus(input: {
    readonly githubInstallationId: string;
    readonly githubRepositoryId: string;
    readonly repositoryFullName: string;
    readonly pullRequestNumber: number;
    readonly headSha: string;
    readonly baseRef: string;
    readonly baseSha: string;
    readonly context: string;
    readonly state: "success" | "failure" | "error";
    readonly description: string;
  }): Promise<{
    readonly githubExternalId: string;
    readonly githubUrl?: string | undefined;
  }> {
    const { octokit, owner, repo } = await this.validatedInstallation(input);
    const existing = await findOwnedAdvisoryStatus({
      octokit,
      owner,
      repo,
      headSha: input.headSha,
      context: input.context,
      state: input.state,
      description: input.description,
      botLogin: this.botLogin,
    });
    if (existing) {
      return {
        githubExternalId: String(existing.id),
        githubUrl: existing.url,
      };
    }

    const response = await octokit.request(
      "POST /repos/{owner}/{repo}/statuses/{sha}",
      {
        owner,
        repo,
        sha: input.headSha,
        state: input.state,
        context: input.context,
        description: input.description,
      },
    );
    const status = parseStatusResponse(response.data);
    return {
      githubExternalId: String(status.id),
      githubUrl: status.url,
    };
  }

  async assertConflictReviewPrePostState(input: {
    readonly githubInstallationId: string;
    readonly githubRepositoryId: string;
    readonly repositoryFullName: string;
    readonly pullRequestNumber: number;
    readonly headSha: string;
    readonly baseRef: string;
    readonly baseSha: string;
  }): Promise<void> {
    await this.validatedInstallation(input);
  }

  private async validatedInstallation(input: {
    readonly githubInstallationId: string;
    readonly githubRepositoryId: string;
    readonly repositoryFullName: string;
    readonly pullRequestNumber: number;
    readonly headSha: string;
    readonly baseRef: string;
    readonly baseSha: string;
  }): Promise<{
    readonly octokit: OctokitRequester;
    readonly owner: string;
    readonly repo: string;
  }> {
    const { owner, repo } = splitRepositoryFullName(input.repositoryFullName);
    const octokit = await this.installationOctokit(input.githubInstallationId);
    await assertPullRequestStillMatches({
      octokit,
      owner,
      repo,
      githubRepositoryId: input.githubRepositoryId,
      pullRequestNumber: input.pullRequestNumber,
      headSha: input.headSha,
      baseRef: input.baseRef,
      baseSha: input.baseSha,
    });
    return { octokit, owner, repo };
  }

  private async installationOctokit(
    githubInstallationId: string,
  ): Promise<OctokitRequester> {
    const installationId = Number(githubInstallationId);
    if (!Number.isSafeInteger(installationId) || installationId <= 0) {
      throw new Error("conflict_posting_installation_id_invalid");
    }
    return this.app.getInstallationOctokit(installationId);
  }
}

function createGitHubApp(input: {
  readonly appId?: string | undefined;
  readonly privateKey?: string | undefined;
}): OctokitInstallationApp {
  if (!input.appId || !input.privateKey) {
    throw new Error("conflict_posting_github_app_unavailable");
  }
  return new App({
    appId: input.appId,
    privateKey: input.privateKey,
  });
}

async function assertPullRequestStillMatches(input: {
  readonly octokit: OctokitRequester;
  readonly owner: string;
  readonly repo: string;
  readonly githubRepositoryId: string;
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly baseRef: string;
  readonly baseSha: string;
}): Promise<void> {
  const response = await input.octokit.request(
    "GET /repos/{owner}/{repo}/pulls/{pull_number}",
    {
      owner: input.owner,
      repo: input.repo,
      pull_number: input.pullRequestNumber,
    },
  );
  const pullRequest = parsePullRequestForPreWriteValidation(response.data);
  if (pullRequest.repositoryId !== input.githubRepositoryId) {
    throw new Error("conflict_posting_pr_repository_mismatch");
  }
  if (pullRequest.headRepositoryId !== input.githubRepositoryId) {
    throw new Error("conflict_posting_pr_fork_unsupported");
  }
  if (pullRequest.state !== "open" || pullRequest.draft || pullRequest.merged) {
    throw new Error("conflict_posting_pr_not_reviewable");
  }
  if (pullRequest.headSha.toLowerCase() !== input.headSha.toLowerCase()) {
    throw new Error("conflict_posting_pr_head_mismatch");
  }
  if (pullRequest.baseRef !== input.baseRef) {
    throw new Error("conflict_posting_pr_base_ref_mismatch");
  }
  if (pullRequest.baseSha.toLowerCase() !== input.baseSha.toLowerCase()) {
    throw new Error("conflict_posting_pr_base_sha_mismatch");
  }
}

async function findOwnedSummaryComment(input: {
  readonly octokit: OctokitRequester;
  readonly owner: string;
  readonly repo: string;
  readonly pullRequestNumber: number;
  readonly marker: string;
  readonly botLogin: string;
}): Promise<{ readonly id: number } | null> {
  const matches: number[] = [];
  let searchBudgetExhausted = false;
  for (let page = 1; page <= 3; page += 1) {
    const response = await input.octokit.request(
      "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
      {
        owner: input.owner,
        repo: input.repo,
        issue_number: input.pullRequestNumber,
        per_page: 100,
        page,
      },
    );
    if (!Array.isArray(response.data)) {
      throw new Error("conflict_summary_comments_response_invalid");
    }
    for (const comment of response.data) {
      const parsed = parseCommentResponse(comment);
      if (
        parsed.body.includes(input.marker) &&
        parsed.authorLogin.toLowerCase() === input.botLogin
      ) {
        matches.push(parsed.id);
      }
    }
    if (response.data.length < 100) {
      break;
    }
    if (page === 3) {
      searchBudgetExhausted = true;
    }
  }
  if (matches.length > 1) {
    throw new Error("conflict_summary_marker_ambiguous");
  }
  if (searchBudgetExhausted) {
    throw new Error("conflict_summary_comment_search_budget_exceeded");
  }
  if (matches.length === 1) {
    return { id: matches[0]! };
  }
  return null;
}

async function findOwnedAdvisoryStatus(input: {
  readonly octokit: OctokitRequester;
  readonly owner: string;
  readonly repo: string;
  readonly headSha: string;
  readonly context: string;
  readonly state: "success" | "failure" | "error";
  readonly description: string;
  readonly botLogin: string;
}): Promise<{ readonly id: number; readonly url: string } | null> {
  for (let page = 1; page <= 3; page += 1) {
    const response = await input.octokit.request(
      "GET /repos/{owner}/{repo}/commits/{ref}/statuses",
      {
        owner: input.owner,
        repo: input.repo,
        ref: input.headSha,
        per_page: 100,
        page,
      },
    );
    if (!Array.isArray(response.data)) {
      throw new Error("conflict_statuses_response_invalid");
    }
    for (const status of response.data) {
      const parsed = parseStatusListItem(status);
      if (
        parsed.context === input.context &&
        parsed.state === input.state &&
        parsed.description === input.description &&
        parsed.creatorLogin.toLowerCase() === input.botLogin
      ) {
        return { id: parsed.id, url: parsed.url };
      }
    }
    if (response.data.length < 100) {
      return null;
    }
  }
  throw new Error("conflict_status_search_budget_exceeded");
}

function botLoginFromAppSlug(appSlug: string | undefined): string | undefined {
  const slug = appSlug?.trim();
  if (!slug) {
    return undefined;
  }
  if (!/^[a-zA-Z0-9-]+$/.test(slug)) {
    throw new Error("conflict_posting_app_slug_invalid");
  }
  return `${slug}[bot]`;
}

function normalizeBotLogin(botLogin: string | undefined): string {
  const normalized = botLogin?.trim().toLowerCase();
  if (!normalized || !/^[a-z0-9-]+\[bot\]$/.test(normalized)) {
    throw new Error("conflict_posting_bot_identity_unavailable");
  }
  return normalized;
}

function splitRepositoryFullName(fullName: string): {
  readonly owner: string;
  readonly repo: string;
} {
  const [owner, repo, extra] = fullName.split("/");
  if (!owner || !repo || extra) {
    throw new Error("conflict_posting_repository_full_name_invalid");
  }
  return { owner, repo };
}

function parseCommentResponse(data: unknown): {
  readonly id: number;
  readonly htmlUrl: string;
  readonly body: string;
  readonly authorLogin: string;
} {
  if (typeof data !== "object" || data === null) {
    throw new Error("conflict_summary_comment_response_invalid");
  }
  const comment = data as {
    readonly id?: unknown;
    readonly html_url?: unknown;
    readonly body?: unknown;
    readonly user?: unknown;
  };
  const user = comment.user as {
    readonly login?: unknown;
    readonly type?: unknown;
  } | null;
  if (
    typeof comment.id !== "number" ||
    typeof comment.html_url !== "string" ||
    typeof comment.body !== "string" ||
    !user ||
    typeof user.login !== "string" ||
    typeof user.type !== "string"
  ) {
    throw new Error("conflict_summary_comment_response_invalid");
  }
  return {
    id: comment.id,
    htmlUrl: comment.html_url,
    body: comment.body,
    authorLogin: user.type === "Bot" ? user.login : "",
  };
}

function parsePullRequestForPreWriteValidation(data: unknown): {
  readonly repositoryId: string;
  readonly state: string;
  readonly draft: boolean;
  readonly merged: boolean;
  readonly headRepositoryId: string;
  readonly headSha: string;
  readonly baseRef: string;
  readonly baseSha: string;
} {
  if (typeof data !== "object" || data === null) {
    throw new Error("conflict_posting_pr_response_invalid");
  }
  const pullRequest = data as {
    readonly state?: unknown;
    readonly draft?: unknown;
    readonly merged?: unknown;
    readonly head?: unknown;
    readonly base?: unknown;
  };
  const head = pullRequest.head as {
    readonly sha?: unknown;
    readonly repo?: unknown;
  } | null;
  const headRepository = head?.repo as { readonly id?: unknown } | null;
  const base = pullRequest.base as {
    readonly ref?: unknown;
    readonly sha?: unknown;
    readonly repo?: unknown;
  } | null;
  const baseRepository = base?.repo as { readonly id?: unknown } | null;
  if (
    typeof pullRequest.state !== "string" ||
    !head ||
    typeof head.sha !== "string" ||
    !headRepository ||
    !isSafeGitHubNumericId(headRepository.id) ||
    !base ||
    typeof base.ref !== "string" ||
    typeof base.sha !== "string" ||
    !baseRepository ||
    !isSafeGitHubNumericId(baseRepository.id)
  ) {
    throw new Error("conflict_posting_pr_response_invalid");
  }
  return {
    repositoryId: String(baseRepository.id),
    state: pullRequest.state,
    draft: pullRequest.draft === true,
    merged: pullRequest.merged === true,
    headRepositoryId: String(headRepository.id),
    headSha: head.sha,
    baseRef: base.ref,
    baseSha: base.sha,
  };
}

function isSafeGitHubNumericId(value: unknown): value is number | string {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0;
  }
  return typeof value === "string" && /^[0-9]+$/.test(value);
}

function parseStatusListItem(data: unknown): {
  readonly id: number;
  readonly url: string;
  readonly context: string;
  readonly state: "success" | "failure" | "error" | "pending";
  readonly description: string;
  readonly creatorLogin: string;
} {
  if (typeof data !== "object" || data === null) {
    throw new Error("conflict_status_response_invalid");
  }
  const status = data as {
    readonly id?: unknown;
    readonly url?: unknown;
    readonly context?: unknown;
    readonly state?: unknown;
    readonly description?: unknown;
    readonly creator?: unknown;
  };
  const creator = status.creator as { readonly login?: unknown } | null;
  if (
    typeof status.id !== "number" ||
    typeof status.url !== "string" ||
    typeof status.context !== "string" ||
    !isCommitStatusState(status.state) ||
    typeof status.description !== "string" ||
    !creator ||
    typeof creator.login !== "string"
  ) {
    throw new Error("conflict_status_response_invalid");
  }
  return {
    id: status.id,
    url: status.url,
    context: status.context,
    state: status.state,
    description: status.description,
    creatorLogin: creator.login,
  };
}

function isCommitStatusState(
  state: unknown,
): state is "success" | "failure" | "error" | "pending" {
  return (
    state === "success" ||
    state === "failure" ||
    state === "error" ||
    state === "pending"
  );
}

function parseStatusResponse(data: unknown): {
  readonly id: number;
  readonly url: string;
} {
  if (typeof data !== "object" || data === null) {
    throw new Error("conflict_status_response_invalid");
  }
  const status = data as {
    readonly id?: unknown;
    readonly url?: unknown;
  };
  if (typeof status.id !== "number" || typeof status.url !== "string") {
    throw new Error("conflict_status_response_invalid");
  }
  return {
    id: status.id,
    url: status.url,
  };
}
