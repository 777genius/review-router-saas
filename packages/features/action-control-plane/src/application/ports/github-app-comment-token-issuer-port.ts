export type IssueGitHubAppCommentTokenInput = {
  readonly githubInstallationId: string;
  readonly githubRepositoryId: string;
  readonly repositoryFullName: string;
};

export type IssuedGitHubAppCommentToken = {
  readonly token: string;
  readonly expiresAt: Date;
  readonly repository: string;
  readonly permissions: {
    readonly contents: "read";
    readonly pullRequests: "write";
    readonly issues: "write";
    readonly statuses: "write";
  };
};

export interface GitHubAppCommentTokenIssuerPort {
  issueCommentToken(
    input: IssueGitHubAppCommentTokenInput,
  ): Promise<IssuedGitHubAppCommentToken>;
}
