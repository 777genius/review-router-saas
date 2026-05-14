import type {
  ActionConflictReviewPostingSessionClaims,
  ActionSessionClaims,
} from "../../domain/action-control-plane.js";

export type ActionConflictReviewPostingOperationKind =
  | "summary_comment"
  | "advisory_status";

export type ActionConflictReviewPostingSessionScope =
  ActionConflictReviewPostingSessionClaims;

export interface ActionConflictReviewPostingSessionRepositoryPort {
  issueConflictReviewPostingSession(input: {
    readonly session: ActionSessionClaims;
    readonly manifestHash: string;
    readonly issuedAt: Date;
  }): Promise<ActionConflictReviewPostingSessionScope>;

  reserveConflictReviewPostingIntent(input: {
    readonly scope: ActionConflictReviewPostingSessionScope;
    readonly operationKind: ActionConflictReviewPostingOperationKind;
    readonly operationFingerprint: string;
    readonly bodyHash: string;
    readonly requestedAt: Date;
  }): Promise<
    | {
        readonly status: "reserved";
        readonly intentId: string;
      }
    | {
        readonly status: "completed";
        readonly intentId: string;
        readonly githubExternalId: string;
        readonly githubUrl: string | null;
      }
    | {
        readonly status: "pending";
        readonly intentId: string;
      }
  >;

  commitConflictReviewPostingIntent(input: {
    readonly scope: ActionConflictReviewPostingSessionScope;
    readonly intentId: string;
    readonly operationKind: ActionConflictReviewPostingOperationKind;
    readonly githubExternalId: string;
    readonly githubUrl?: string | undefined;
    readonly bodyHash: string;
    readonly completedAt: Date;
  }): Promise<void>;

  markConflictReviewPostingIntentAmbiguous(input: {
    readonly scope: ActionConflictReviewPostingSessionScope;
    readonly intentId: string;
    readonly operationKind: ActionConflictReviewPostingOperationKind;
    readonly safeErrorCode: string;
    readonly safeErrorSummary: string;
    readonly failedAt: Date;
  }): Promise<void>;
}
