export interface ActionConflictReviewPrePostValidatorPort {
  assertConflictReviewPrePostState(input: {
    readonly githubInstallationId: string;
    readonly githubRepositoryId: string;
    readonly repositoryFullName: string;
    readonly pullRequestNumber: number;
    readonly headSha: string;
    readonly baseRef: string;
    readonly baseSha: string;
  }): Promise<void>;
}
