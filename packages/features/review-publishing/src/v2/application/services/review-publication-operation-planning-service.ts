import {
  ReviewPublicationPlanningError,
  ReviewPublicationPlanningErrorCode,
  assertPublishedReviewProjectionPublicationEnvelopeIdentity,
  planReviewPublicationOperations,
  type PublishedReviewProjectionPublicationEnvelope,
} from "../../domain/review-publication-operation-planning";
import type { ReviewPublicationOperationPlan } from "../../domain/review-publication-attempt";
import type {
  ReviewPublicationOperationPlanningPort,
  ReviewPublicationReleaseLimitsQueryPort,
} from "../ports/review-publication-operation-planning-port";

export class ReviewPublicationOperationPlanningService implements ReviewPublicationOperationPlanningPort {
  constructor(
    private readonly releaseLimits: ReviewPublicationReleaseLimitsQueryPort,
  ) {}

  async plan(
    envelope: PublishedReviewProjectionPublicationEnvelope,
  ): Promise<readonly ReviewPublicationOperationPlan[]> {
    assertPublishedReviewProjectionPublicationEnvelopeIdentity(envelope);
    const limits = await this.releaseLimits.findReleaseBoundLimits({
      producerReleaseId: envelope.producerReleaseId,
      protocolLimitsProfileId: envelope.protocolLimitsProfileId,
      limitsDigest: envelope.limitsDigest,
    });
    if (limits === null) {
      throw new ReviewPublicationPlanningError(
        ReviewPublicationPlanningErrorCode.ReleaseLimitsUnavailable,
      );
    }
    return planReviewPublicationOperations({ envelope, limits });
  }
}
