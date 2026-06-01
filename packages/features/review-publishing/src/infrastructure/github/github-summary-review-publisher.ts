import type {
  ReviewPublicationSkippedInlineFinding,
  ReviewPublisherPort,
} from "../../application/ports/review-publisher-port";
import {
  renderReviewSummaryMarkdown,
  reviewSummaryMarker,
} from "../../domain/review-publication-markdown";
import {
  reviewFindingInlineSkipReason,
  type ReviewPublicationPlan,
} from "../../domain/review-publication";

type FetchLike = typeof fetch;

export type GitHubSummaryReviewPublisherOptions = {
  readonly token: string;
  readonly apiBaseUrl?: string | undefined;
  readonly fetchImpl?: FetchLike | undefined;
  readonly tokenRefresh?: GitHubCommentTokenRefresh | undefined;
};

type GitHubIssueComment = {
  readonly id: number;
  readonly body?: string | null | undefined;
};

export type GitHubCommentTokenRefresh = {
  refreshToken(): Promise<string>;
};

const defaultGitHubApiBaseUrl = "https://api.github.com";

export class GitHubSummaryReviewPublisher implements ReviewPublisherPort {
  private token: string;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly tokenRefresh: GitHubCommentTokenRefresh | null;
  private tokenRefreshAttempted = false;

  constructor(options: GitHubSummaryReviewPublisherOptions) {
    const token = options.token.trim();
    if (!token) {
      throw new Error("github_review_publisher_token_required");
    }
    this.token = token;
    this.apiBaseUrl = (options.apiBaseUrl ?? defaultGitHubApiBaseUrl).replace(
      /\/+$/,
      "",
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.tokenRefresh = options.tokenRefresh ?? null;
  }

  async publishReview(plan: ReviewPublicationPlan) {
    if (plan.target.provider !== "github") {
      throw new Error("github_review_publisher_target_invalid");
    }
    const [owner, repo] = splitRepositoryFullName(
      plan.target.repositoryFullName,
    );
    const issueNumber = Number(plan.target.changeRequestExternalId);
    const marker = reviewSummaryMarker(plan.marker);
    const existing = await this.findExistingComment({
      owner,
      repo,
      issueNumber,
      marker,
    });
    const externalId = await this.upsertComment({
      owner,
      repo,
      issueNumber,
      existingCommentId: existing?.id,
      body: renderReviewSummaryMarkdown({ plan }),
    });

    const skippedInlineFindings: ReviewPublicationSkippedInlineFinding[] = [];
    let inlineIndex = 0;
    for (const finding of plan.findings) {
      const skipReason = reviewFindingInlineSkipReason({
        finding,
        plan,
        inlineIndex,
      });
      skippedInlineFindings.push({
        fingerprint: finding.fingerprint,
        reason: skipReason ?? "provider_position_unavailable",
      });
      if (!skipReason) {
        inlineIndex += 1;
      }
    }

    return {
      target: plan.target,
      inlineCommentCount: 0,
      summaryCommentCount: 1,
      skippedInlineFindings,
      externalIds: [`github:summary:${externalId}`],
    };
  }

  private async findExistingComment(input: {
    readonly owner: string;
    readonly repo: string;
    readonly issueNumber: number;
    readonly marker: string;
  }): Promise<GitHubIssueComment | null> {
    const comments = await this.requestJson<GitHubIssueComment[]>({
      method: "GET",
      path: `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/issues/${input.issueNumber}/comments?per_page=100`,
      label: "github_review_comment_lookup",
    });
    if (!Array.isArray(comments)) {
      throw new Error("github_review_comment_lookup_invalid");
    }
    return (
      comments.find(
        (comment) =>
          typeof comment.id === "number" &&
          typeof comment.body === "string" &&
          comment.body.startsWith(input.marker),
      ) ?? null
    );
  }

  private async upsertComment(input: {
    readonly owner: string;
    readonly repo: string;
    readonly issueNumber: number;
    readonly existingCommentId?: number | undefined;
    readonly body: string;
  }): Promise<number> {
    if (input.existingCommentId !== undefined) {
      const updated = await this.requestJson<GitHubIssueComment>({
        method: "PATCH",
        path: `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/issues/comments/${input.existingCommentId}`,
        label: "github_review_comment_update",
        body: JSON.stringify({ body: input.body }),
      });
      return updated.id;
    }
    const created = await this.requestJson<GitHubIssueComment>({
      method: "POST",
      path: `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/issues/${input.issueNumber}/comments`,
      label: "github_review_comment_create",
      body: JSON.stringify({ body: input.body }),
    });
    return created.id;
  }

  private async requestJson<T>(input: {
    readonly method: string;
    readonly path: string;
    readonly label: string;
    readonly body?: string | undefined;
  }): Promise<T> {
    const response = await this.fetchJson(input);
    if (
      response.status === 401 &&
      this.tokenRefresh &&
      !this.tokenRefreshAttempted
    ) {
      this.tokenRefreshAttempted = true;
      this.token = await this.refreshToken();
      const retryResponse = await this.fetchJson(input);
      if (!retryResponse.ok) {
        throw new Error(`${input.label}_failed:${retryResponse.status}`);
      }
      return (await retryResponse.json()) as T;
    }

    if (!response.ok) {
      throw new Error(`${input.label}_failed:${response.status}`);
    }
    return (await response.json()) as T;
  }

  private async fetchJson(input: {
    readonly method: string;
    readonly path: string;
    readonly body?: string | undefined;
  }): Promise<Response> {
    const response = await this.fetchImpl(`${this.apiBaseUrl}${input.path}`, {
      method: input.method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        ...(input.body ? { "content-type": "application/json" } : {}),
        "x-github-api-version": "2022-11-28",
      },
      ...(input.body ? { body: input.body } : {}),
    });
    return response;
  }

  private async refreshToken(): Promise<string> {
    const token = (await this.tokenRefresh?.refreshToken())?.trim() ?? "";
    if (!token) {
      throw new Error("github_review_publisher_token_refresh_invalid");
    }
    return token;
  }
}

function splitRepositoryFullName(fullName: string): readonly [string, string] {
  const [owner, repo, ...rest] = fullName.split("/");
  if (!owner || !repo || rest.length > 0) {
    throw new Error("github_repository_full_name_invalid");
  }
  return [owner, repo];
}
