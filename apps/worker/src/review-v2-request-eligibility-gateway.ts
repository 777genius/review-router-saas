import { App } from "@octokit/app";
import {
  ReviewRequestEligibilityStatus,
  type ReviewRequestEligibilityPort,
} from "./review-v2-request-ingress-handler";

export class GitHubReviewRequestEligibilityGateway implements ReviewRequestEligibilityPort {
  private readonly app: App;

  constructor(options: {
    readonly appId: string;
    readonly privateKey: string;
  }) {
    this.app = new App(options);
  }

  async load(input: Parameters<ReviewRequestEligibilityPort["load"]>[0]) {
    const [owner, repo] = splitRepository(input.repositoryFullName);
    try {
      const octokit = await this.app.getInstallationOctokit(
        Number(input.githubInstallationId),
      );
      const response = await octokit.request(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}",
        {
          owner,
          repo,
          pull_number: input.pullRequestNumber,
        },
      );
      const data = response.data as unknown;
      if (!isRecord(data)) {
        return { status: ReviewRequestEligibilityStatus.Unavailable } as const;
      }
      const baseSha = nestedString(data.base, "sha");
      const headSha = nestedString(data.head, "sha");
      const headRepositoryFullName = nestedNestedString(
        data.head,
        "repo",
        "full_name",
      );
      const authorType = nestedString(data.user, "type");
      if (
        !isCommitSha(baseSha) ||
        !isCommitSha(headSha) ||
        !headRepositoryFullName ||
        !authorType ||
        typeof data.draft !== "boolean" ||
        (data.state !== "open" && data.state !== "closed")
      ) {
        return { status: ReviewRequestEligibilityStatus.Unavailable } as const;
      }
      return {
        status: ReviewRequestEligibilityStatus.Current,
        state: data.state,
        draft: data.draft,
        baseSha: baseSha.toLowerCase(),
        headSha: headSha.toLowerCase(),
        headRepositoryFullName,
        authorType,
      } as const;
    } catch (error) {
      return providerStatus(error) === 404
        ? ({ status: ReviewRequestEligibilityStatus.Missing } as const)
        : ({ status: ReviewRequestEligibilityStatus.Unavailable } as const);
    }
  }
}

function splitRepository(fullName: string): readonly [string, string] {
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) throw new Error("review_request_repository_invalid");
  return [owner, repo];
}

function nestedString(value: unknown, key: string): string | null {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : null;
}

function nestedNestedString(
  value: unknown,
  parent: string,
  child: string,
): string | null {
  return isRecord(value) ? nestedString(value[parent], child) : null;
}

function isCommitSha(value: string | null): value is string {
  return value !== null && /^[a-f0-9]{40}$/i.test(value);
}

function providerStatus(error: unknown): number | null {
  return isRecord(error) && typeof error.status === "number"
    ? error.status
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
