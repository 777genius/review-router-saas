import type {
  ConflictReviewDispatchPayload,
  ConflictReviewPullRequestSnapshot,
} from "../../domain/conflict-review";

export type ConflictReviewWorkflowCapability =
  | { readonly supported: true }
  | {
      readonly supported: false;
      readonly reason: "workflow_missing" | "workflow_unsupported";
    };

export interface ConflictReviewGitHubGatewayPort {
  getPullRequest(input: {
    readonly githubInstallationId: string;
    readonly owner: string;
    readonly repo: string;
    readonly pullRequestNumber: number;
  }): Promise<ConflictReviewPullRequestSnapshot>;

  listOpenPullRequestNumbersForBase(input: {
    readonly githubInstallationId: string;
    readonly owner: string;
    readonly repo: string;
    readonly baseRef: string;
  }): Promise<readonly number[]>;

  getReviewWorkflowCapability(input: {
    readonly githubInstallationId: string;
    readonly owner: string;
    readonly repo: string;
    readonly ref: string;
  }): Promise<ConflictReviewWorkflowCapability>;

  dispatchConflictReview(input: {
    readonly githubInstallationId: string;
    readonly owner: string;
    readonly repo: string;
    readonly payload: ConflictReviewDispatchPayload;
  }): Promise<void>;
}
