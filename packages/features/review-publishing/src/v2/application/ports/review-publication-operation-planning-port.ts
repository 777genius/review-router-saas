import type {
  PublishedReviewProjectionPublicationEnvelope,
  ReviewPublicationPlanningLimits,
} from "../../domain/review-publication-operation-planning";
import type { ReviewPublicationOperationPlan } from "../../domain/review-publication-attempt";

export type ReviewPublicationReleaseLimitsIdentity = Pick<
  PublishedReviewProjectionPublicationEnvelope,
  "producerReleaseId" | "protocolLimitsProfileId" | "limitsDigest"
>;

/**
 * Anti-corruption port to immutable release/run-control facts. Implementations
 * must resolve the profile bound to the producer release, never caller overrides.
 */
export interface ReviewPublicationReleaseLimitsQueryPort {
  findReleaseBoundLimits(
    identity: ReviewPublicationReleaseLimitsIdentity,
  ): Promise<ReviewPublicationPlanningLimits | null>;
}

export interface ReviewPublicationOperationPlanningPort {
  plan(
    envelope: PublishedReviewProjectionPublicationEnvelope,
  ): Promise<readonly ReviewPublicationOperationPlan[]>;
}
