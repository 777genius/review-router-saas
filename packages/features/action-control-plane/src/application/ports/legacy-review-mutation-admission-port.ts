export enum LegacyReviewMutationOperation {
  SessionExchange = "session_exchange",
  CommentToken = "comment_token",
  CodexRotatingCommentToken = "codex_rotating_comment_token",
  ConflictPostingSession = "conflict_posting_session",
}

export interface LegacyReviewMutationAdmissionPort {
  assertLegacyReviewMutationAllowed(input: {
    readonly operation: LegacyReviewMutationOperation;
    readonly githubRepositoryId: string;
    readonly repositoryFullName: string;
  }): Promise<void>;
}
