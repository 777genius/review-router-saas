export interface ActionConflictReviewPostingGatewayPort {
  upsertConflictReviewSummary(input: {
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
  }>;

  postConflictReviewAdvisoryStatus(input: {
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
  }>;
}
