import type {
  ActionConflictReviewDispatchPayload,
  GitHubActionsOidcClaims,
} from "../../domain/action-control-plane.js";
export type { ActionConflictReviewDispatchPayload } from "../../domain/action-control-plane.js";

export type ActionConflictReviewExchange = {
  readonly reviewKind: "conflict-head";
  readonly dispatchId: string;
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly baseRef: string;
  readonly baseSha: string;
};

export interface ActionConflictReviewExchangeVerifierPort {
  verifyConflictReviewExchange(input: {
    readonly claims: GitHubActionsOidcClaims;
    readonly dispatchPayload: ActionConflictReviewDispatchPayload;
    readonly configSnapshotId: string;
    readonly exchangedAt: Date;
  }): Promise<ActionConflictReviewExchange>;
}
