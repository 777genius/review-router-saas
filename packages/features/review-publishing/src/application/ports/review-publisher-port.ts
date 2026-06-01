import type {
  ReviewInlineSkipReason,
  ReviewPublicationPlan,
  ReviewPublicationTarget,
} from "../../domain/review-publication";

export type ReviewPublicationSkippedInlineFinding = {
  readonly fingerprint: string;
  readonly reason: ReviewInlineSkipReason;
};

export type ReviewPublicationResult = {
  readonly target: ReviewPublicationTarget;
  readonly inlineCommentCount: number;
  readonly summaryCommentCount: number;
  readonly skippedInlineFindings: readonly ReviewPublicationSkippedInlineFinding[];
  readonly externalIds: readonly string[];
};

export interface ReviewPublisherPort {
  publishReview(plan: ReviewPublicationPlan): Promise<ReviewPublicationResult>;
}
