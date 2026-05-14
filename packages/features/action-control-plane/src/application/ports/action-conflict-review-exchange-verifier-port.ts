import type { GitHubActionsOidcClaims } from "../../domain/action-control-plane.js";

export type ActionConflictReviewDispatchPayload = {
  readonly protocolVersion: 1;
  readonly dispatchId: string;
  readonly nonce: string;
  readonly repositoryId: string;
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly fallbackVersion: 1;
};

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
