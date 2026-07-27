import type { GitHubActionsOidcClaims } from "../../domain/action-control-plane.js";

export enum LegacyReviewMutationOperation {
  SessionExchange = "session_exchange",
  CommentToken = "comment_token",
  CodexRotatingCommentToken = "codex_rotating_comment_token",
  ConflictPostingSession = "conflict_posting_session",
}

export type LegacyReviewMutationAdmissionInput =
  | {
      readonly operation: LegacyReviewMutationOperation.SessionExchange;
      readonly githubRepositoryId: string;
      readonly githubInstallationId: string;
      readonly repositoryFullName: string;
      readonly repositoryOwner: string;
      readonly eventName: GitHubActionsOidcClaims["event_name"];
      readonly workflowPath: string;
      readonly workflowSha: string | null;
    }
  | {
      readonly operation: Exclude<
        LegacyReviewMutationOperation,
        LegacyReviewMutationOperation.SessionExchange
      >;
      readonly githubRepositoryId: string;
      readonly repositoryFullName: string;
      readonly eventName?: GitHubActionsOidcClaims["event_name"];
      readonly workflowPath?: string;
    };

export interface LegacyReviewMutationAdmissionPort {
  assertLegacyReviewMutationAllowed(
    input: LegacyReviewMutationAdmissionInput,
  ): Promise<void>;
}
