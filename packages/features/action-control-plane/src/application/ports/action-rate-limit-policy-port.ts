export interface ActionRateLimitPolicyPort {
  assertOidcExchangeAllowed(input: {
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly repositoryFullName: string;
    readonly githubRunId: string;
    readonly githubRunAttempt: string;
  }): Promise<void>;

  assertHealthReportAllowed(input: {
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly repositoryFullName: string;
    readonly githubRunId: string;
    readonly githubRunAttempt: string;
  }): Promise<void>;
}
