export interface ConflictReviewRolloutPolicyPort {
  isConflictReviewFallbackAllowed(input: {
    readonly workspaceId?: string | undefined;
    readonly repositoryId?: string | undefined;
    readonly repositoryFullName: string;
  }): Promise<boolean> | boolean;
}
