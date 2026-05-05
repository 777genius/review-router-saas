import { App } from "@octokit/app";
import type {
  GitHubAppCommentTokenIssuerPort,
  IssueGitHubAppCommentTokenInput,
  IssuedGitHubAppCommentToken,
} from "@reviewrouter/features-action-control-plane";

type InstallationTokenResponse = {
  readonly token?: unknown;
  readonly expires_at?: unknown;
  readonly permissions?: {
    readonly pull_requests?: unknown;
    readonly issues?: unknown;
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
    const response = await this.app.octokit.request(
      "POST /app/installations/{installation_id}/access_tokens",
      {
        installation_id: Number(input.githubInstallationId),
        repository_ids: [Number(input.githubRepositoryId)],
        permissions: {
          pull_requests: "write",
          issues: "write",
        },
      },
    );

    const data = response.data as InstallationTokenResponse;
    if (typeof data.token !== "string" || data.token.length === 0) {
      throw new Error("comment_token_invalid_response");
    }
    if (typeof data.expires_at !== "string") {
      throw new Error("comment_token_invalid_response");
    }
    const expiresAt = new Date(data.expires_at);
    if (!Number.isFinite(expiresAt.getTime())) {
      throw new Error("comment_token_invalid_response");
    }
    if (
      data.permissions?.pull_requests !== "write" ||
      data.permissions?.issues !== "write"
    ) {
      throw new Error("comment_token_permissions_mismatch");
    }

    return {
      token: data.token,
      expiresAt,
      repository: input.repositoryFullName,
      permissions: {
        pullRequests: "write",
        issues: "write",
      },
    };
  }
}
