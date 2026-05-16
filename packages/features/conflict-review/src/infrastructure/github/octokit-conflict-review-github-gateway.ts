import { Buffer } from "node:buffer";
import { App } from "@octokit/app";
import { analyzeConflictReviewWorkflowCapability } from "@reviewrouter/features-workflow-provisioning";
import {
  assertSafeConflictReviewDispatchPayload,
  conflictReviewDispatchEventType,
  type ConflictReviewDispatchPayload,
  type ConflictReviewPullRequestSnapshot,
} from "../../domain/conflict-review";
import type {
  ConflictReviewGitHubGatewayPort,
  ConflictReviewWorkflowCapability,
} from "../../application/ports/conflict-review-github-gateway-port";

type OctokitRequester = {
  request: (
    route: string,
    parameters?: Record<string, unknown>,
  ) => Promise<{ data: unknown }>;
};

export class OctokitConflictReviewGitHubGateway implements ConflictReviewGitHubGatewayPort {
  private readonly app: App;

  constructor(options: {
    readonly appId: string;
    readonly privateKey: string;
  }) {
    this.app = new App({
      appId: options.appId,
      privateKey: options.privateKey,
    });
  }

  async getPullRequest(input: {
    readonly githubInstallationId: string;
    readonly owner: string;
    readonly repo: string;
    readonly pullRequestNumber: number;
  }): Promise<ConflictReviewPullRequestSnapshot> {
    const octokit = await this.installationOctokit(input.githubInstallationId);
    const { data } = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      {
        owner: input.owner,
        repo: input.repo,
        pull_number: input.pullRequestNumber,
      },
    );
    return parsePullRequest(data);
  }

  async listOpenPullRequestNumbersForBase(input: {
    readonly githubInstallationId: string;
    readonly owner: string;
    readonly repo: string;
    readonly baseRef: string;
  }): Promise<readonly number[]> {
    const octokit = await this.installationOctokit(input.githubInstallationId);
    const pullRequestNumbers: number[] = [];
    for (let page = 1; ; page += 1) {
      const { data } = await octokit.request(
        "GET /repos/{owner}/{repo}/pulls",
        {
          owner: input.owner,
          repo: input.repo,
          state: "open",
          base: input.baseRef,
          per_page: 100,
          page,
        },
      );
      if (!Array.isArray(data)) {
        throw new Error("github_pull_requests_response_invalid");
      }
      pullRequestNumbers.push(
        ...data.map((item) => parsePullRequestNumber(item)),
      );
      if (data.length < 100) break;
    }
    return pullRequestNumbers;
  }

  async getReviewWorkflowCapability(input: {
    readonly githubInstallationId: string;
    readonly owner: string;
    readonly repo: string;
    readonly ref: string;
  }): Promise<ConflictReviewWorkflowCapability> {
    const octokit = await this.installationOctokit(input.githubInstallationId);
    try {
      const { data } = await octokit.request(
        "GET /repos/{owner}/{repo}/contents/{path}",
        {
          owner: input.owner,
          repo: input.repo,
          path: ".github/workflows/reviewrouter.yml",
          ref: input.ref,
        },
      );
      const workflowYaml = parseWorkflowFileContent(data);
      const capability = analyzeConflictReviewWorkflowCapability({
        workflowYaml,
      });
      return capability.supported
        ? { supported: true }
        : { supported: false, reason: "workflow_unsupported" };
    } catch (error) {
      if (getErrorStatus(error) === 404) {
        return { supported: false, reason: "workflow_missing" };
      }
      throw error;
    }
  }

  async dispatchConflictReview(input: {
    readonly githubInstallationId: string;
    readonly owner: string;
    readonly repo: string;
    readonly payload: ConflictReviewDispatchPayload;
  }): Promise<void> {
    const payload = assertSafeConflictReviewDispatchPayload(input.payload);
    const octokit = await this.installationOctokit(input.githubInstallationId);
    await octokit.request("POST /repos/{owner}/{repo}/dispatches", {
      owner: input.owner,
      repo: input.repo,
      event_type: conflictReviewDispatchEventType,
      client_payload: payload,
    });
  }

  private async installationOctokit(
    githubInstallationId: string,
  ): Promise<OctokitRequester> {
    return this.app.getInstallationOctokit(Number(githubInstallationId));
  }
}

function parsePullRequest(data: unknown): ConflictReviewPullRequestSnapshot {
  if (typeof data !== "object" || data === null) {
    throw new Error("github_pull_request_response_invalid");
  }
  const pullRequest = data as {
    readonly number?: unknown;
    readonly state?: unknown;
    readonly draft?: unknown;
    readonly merged?: unknown;
    readonly mergeable?: unknown;
    readonly mergeable_state?: unknown;
    readonly head?: unknown;
    readonly base?: unknown;
  };
  const head = parsePullRequestRef(pullRequest.head, "head");
  const base = parsePullRequestRef(pullRequest.base, "base");
  if (
    typeof pullRequest.number !== "number" ||
    typeof pullRequest.state !== "string"
  ) {
    throw new Error("github_pull_request_response_invalid");
  }
  return {
    repositoryFullName: base.repositoryFullName,
    number: pullRequest.number,
    state: pullRequest.state,
    draft: pullRequest.draft === true,
    merged: pullRequest.merged === true,
    headSha: head.sha,
    headRef: head.ref,
    headRepositoryFullName: head.repositoryFullName,
    baseSha: base.sha,
    baseRef: base.ref,
    baseRepositoryFullName: base.repositoryFullName,
    mergeable:
      typeof pullRequest.mergeable === "boolean" ? pullRequest.mergeable : null,
    mergeableState:
      typeof pullRequest.mergeable_state === "string"
        ? pullRequest.mergeable_state
        : null,
  };
}

function parsePullRequestRef(
  value: unknown,
  name: "head" | "base",
): {
  readonly sha: string;
  readonly ref: string;
  readonly repositoryFullName: string;
} {
  if (typeof value !== "object" || value === null) {
    throw new Error(`github_pull_request_${name}_invalid`);
  }
  const ref = value as {
    readonly sha?: unknown;
    readonly ref?: unknown;
    readonly repo?: unknown;
  };
  if (typeof ref.sha !== "string" || typeof ref.ref !== "string") {
    throw new Error(`github_pull_request_${name}_invalid`);
  }
  const repo = ref.repo as { readonly full_name?: unknown } | null;
  if (!repo || typeof repo.full_name !== "string") {
    throw new Error(`github_pull_request_${name}_repo_invalid`);
  }
  return { sha: ref.sha, ref: ref.ref, repositoryFullName: repo.full_name };
}

function parsePullRequestNumber(value: unknown): number {
  if (typeof value !== "object" || value === null) {
    throw new Error("github_pull_request_response_invalid");
  }
  const pullRequest = value as { readonly number?: unknown };
  if (typeof pullRequest.number !== "number") {
    throw new Error("github_pull_request_response_invalid");
  }
  return pullRequest.number;
}

function parseWorkflowFileContent(data: unknown): string {
  if (Array.isArray(data) || typeof data !== "object" || data === null) {
    throw new Error("github_workflow_file_response_invalid");
  }
  const file = data as {
    readonly type?: unknown;
    readonly content?: unknown;
  };
  if (file.type !== "file" || typeof file.content !== "string") {
    throw new Error("github_workflow_file_response_invalid");
  }
  return Buffer.from(file.content.replaceAll("\n", ""), "base64").toString(
    "utf8",
  );
}

function getErrorStatus(error: unknown): number {
  return typeof error === "object" && error !== null && "status" in error
    ? Number(error.status)
    : 0;
}
