import type { ActionConflictReviewPostingSessionClaims } from "../../domain/action-control-plane.js";

export interface ActionConflictReviewPostingSessionTokenServicePort {
  sign(input: {
    readonly claims: ActionConflictReviewPostingSessionClaims;
    readonly expiresInSeconds: number;
    readonly issuedAt: Date;
  }): Promise<{ readonly token: string; readonly expiresAt: Date }>;

  verify(input: {
    readonly token: string;
    readonly now: Date;
  }): Promise<ActionConflictReviewPostingSessionClaims>;
}
