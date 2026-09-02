export type IssueGitHubAppCommentTokenInput = {
  readonly githubInstallationId: string;
  readonly githubRepositoryId: string;
  readonly repositoryFullName: string;
  readonly signal?: AbortSignal;
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
  /** A bearer is always returned to custody, even when provider evidence is unacceptable. */
  readonly custody: "acceptable" | "unacceptable";
  readonly custodyReason?: string;
};

export type PreparedGitHubAppCommentTokenRequest = Readonly<{
  send(input: {
    /** Remaining DB-authoritative budget at the confirmation query. */
    readonly remainingBudgetMs: number;
    /** Monotonic instant captured before that confirmation query started. */
    readonly budgetStartedAtMonotonicMs: number;
    readonly signal?: AbortSignal;
  }): Promise<IssuedGitHubAppCommentToken>;
}>;

export interface GitHubAppCommentTokenIssuerPort {
  prepareCommentToken?(
    input: Omit<IssueGitHubAppCommentTokenInput, "signal">,
  ): Promise<PreparedGitHubAppCommentTokenRequest>;
  issueCommentToken(
    input: IssueGitHubAppCommentTokenInput,
  ): Promise<IssuedGitHubAppCommentToken>;
  revokeCommentToken?(input: {
    readonly token: string;
    readonly signal?: AbortSignal;
  }): Promise<void | Readonly<{ proof: "revoked" | "already_invalid" }>>;
}
