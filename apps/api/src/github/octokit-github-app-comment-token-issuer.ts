import { App } from "@octokit/app";
import type {
  GitHubAppCommentTokenIssuerPort,
  IssueGitHubAppCommentTokenInput,
  IssuedGitHubAppCommentToken,
} from "@reviewrouter/features-action-control-plane";

type InstallationTokenResponse = {
  readonly token?: unknown;
  readonly expiresAt?: unknown;
  readonly permissions?: {
    readonly contents?: unknown;
    readonly pull_requests?: unknown;
    readonly issues?: unknown;
    readonly statuses?: unknown;
  };
};

export class OctokitGitHubAppCommentTokenIssuer implements GitHubAppCommentTokenIssuerPort {
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

  async issueCommentToken(
    input: IssueGitHubAppCommentTokenInput,
  ): Promise<IssuedGitHubAppCommentToken> {
    const data = (await this.app.octokit.auth({
      type: "installation",
      installationId: parsePositiveSafeInteger(
        input.githubInstallationId,
        "comment_token_installation_id_invalid",
      ),
      repositoryIds: [
        parsePositiveSafeInteger(
          input.githubRepositoryId,
          "comment_token_repository_id_invalid",
        ),
      ],
      permissions: {
        contents: "read",
        pull_requests: "write",
        issues: "write",
        statuses: "write",
      },
    })) as InstallationTokenResponse;
    if (typeof data.token !== "string" || data.token.length === 0) {
      throw new Error("comment_token_invalid_response");
    }
    if (typeof data.expiresAt !== "string") {
      throw new Error("comment_token_invalid_response");
    }
    const expiresAt = new Date(data.expiresAt);
    if (!Number.isFinite(expiresAt.getTime())) {
      throw new Error("comment_token_invalid_response");
    }
    if (
      data.permissions?.contents !== "read" ||
      data.permissions?.pull_requests !== "write" ||
      data.permissions?.issues !== "write" ||
      data.permissions?.statuses !== "write"
    ) {
      throw new Error("comment_token_permissions_mismatch");
    }

    return {
      token: data.token,
      expiresAt,
      repository: input.repositoryFullName,
      permissions: {
        contents: "read",
        pullRequests: "write",
        issues: "write",
        statuses: "write",
      },
    };
  }
}

function parsePositiveSafeInteger(value: string, errorCode: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(errorCode);
  }
  return parsed;
}
