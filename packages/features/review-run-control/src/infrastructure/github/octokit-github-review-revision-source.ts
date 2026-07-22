import { App } from "@octokit/app";
import {
  ReviewScmMergeBaseStatus,
  type GitHubReviewRevisionSourcePort,
  type ReviewScmMergeBaseResult,
  type ReviewScmPullRequestPointer,
} from "../../application/ports/review-scm-revision-ports";

type OctokitRequester = {
  request(
    route: string,
    parameters?: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly data: unknown }>;
};

export class OctokitGitHubReviewRevisionSource implements GitHubReviewRevisionSourcePort {
  private readonly app: App;

  constructor(options: {
    readonly appId: string;
    readonly privateKey: string;
  }) {
    this.app = new App(options);
  }

  async findPullRequestNumbersForRun(
    input: Parameters<
      GitHubReviewRevisionSourcePort["findPullRequestNumbersForRun"]
    >[0],
  ): Promise<readonly number[]> {
    const octokit = await this.installationOctokit(input.githubInstallationId);
    try {
      const response = await octokit.request(
        "GET /repos/{owner}/{repo}/actions/runs/{run_id}",
        {
          owner: input.owner,
          repo: input.repo,
          run_id: input.sourceRunId,
        },
      );
      return parseWorkflowRunPullRequestNumbers(response.data);
    } catch (error) {
      if (providerStatus(error) === 404) return [];
      throw error;
    }
  }

  async loadPullRequestPointer(
    input: Parameters<
      GitHubReviewRevisionSourcePort["loadPullRequestPointer"]
    >[0],
  ): Promise<ReviewScmPullRequestPointer | null> {
    const octokit = await this.installationOctokit(input.githubInstallationId);
    try {
      const response = await octokit.request(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}",
        {
          owner: input.owner,
          repo: input.repo,
          pull_number: input.pullRequestNumber,
        },
      );
      return parsePullRequestPointer(response.data);
    } catch (error) {
      if (providerStatus(error) === 404) return null;
      throw error;
    }
  }

  async resolveOfficialMergeBase(
    input: Parameters<
      GitHubReviewRevisionSourcePort["resolveOfficialMergeBase"]
    >[0],
  ): Promise<ReviewScmMergeBaseResult> {
    const octokit = await this.installationOctokit(input.githubInstallationId);
    try {
      const response = await octokit.request(
        "GET /repos/{owner}/{repo}/compare/{basehead}",
        {
          owner: input.owner,
          repo: input.repo,
          basehead: `${input.baseSha}...${input.headSha}`,
        },
      );
      const mergeBaseSha = parseMergeBaseSha(response.data);
      return mergeBaseSha
        ? { status: ReviewScmMergeBaseStatus.Resolved, mergeBaseSha }
        : { status: ReviewScmMergeBaseStatus.Unavailable };
    } catch (error) {
      const status = providerStatus(error);
      if (status === 409) {
        return { status: ReviewScmMergeBaseStatus.Conflict };
      }
      if (status === 404 || status === 422) {
        return { status: ReviewScmMergeBaseStatus.Unavailable };
      }
      throw error;
    }
  }

  private async installationOctokit(
    githubInstallationId: string,
  ): Promise<OctokitRequester> {
    if (!/^[1-9][0-9]*$/.test(githubInstallationId)) {
      throw new Error("github_installation_id_invalid");
    }
    return this.app.getInstallationOctokit(Number(githubInstallationId));
  }
}

function parseWorkflowRunPullRequestNumbers(data: unknown): number[] {
  if (!isRecord(data) || !Array.isArray(data.pull_requests)) {
    throw new Error("github_workflow_run_response_invalid");
  }
  return data.pull_requests.map((value) => {
    if (!isRecord(value) || !isPullRequestNumber(value.number)) {
      throw new Error("github_workflow_run_pull_request_invalid");
    }
    return value.number;
  });
}

function parsePullRequestPointer(data: unknown): ReviewScmPullRequestPointer {
  if (!isRecord(data) || !isPullRequestNumber(data.number)) {
    throw new Error("github_pull_request_response_invalid");
  }
  const baseSha = nestedSha(data.base);
  const headSha = nestedSha(data.head);
  if (!baseSha || !headSha) {
    throw new Error("github_pull_request_revision_invalid");
  }
  return { pullRequestNumber: data.number, baseSha, headSha };
}

function parseMergeBaseSha(data: unknown): string | null {
  if (!isRecord(data) || !isRecord(data.merge_base_commit)) return null;
  const sha = data.merge_base_commit.sha;
  return typeof sha === "string" && /^[a-f0-9]{40}$/i.test(sha) ? sha : null;
}

function nestedSha(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const sha = value.sha;
  return typeof sha === "string" && /^[a-f0-9]{40}$/i.test(sha) ? sha : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPullRequestNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function providerStatus(error: unknown): number | null {
  if (!isRecord(error)) return null;
  return typeof error.status === "number" ? error.status : null;
}
