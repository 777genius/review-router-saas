import {
  ReviewPublicationPlanningError,
  ReviewPublicationPlanningErrorCode,
  ReviewPublicationOperationIdentityVersion,
  assertPublishedReviewProjectionPublicationEnvelopeIdentity,
  planReviewPublicationOperations,
  type PublishedReviewProjectionPublicationEnvelope,
  type ReviewPublicationOperationIdentity,
} from "../../domain/review-publication-operation-planning";
import type { ReviewPublicationOperationPlan } from "../../domain/review-publication-attempt";
import type {
  ReviewPublicationOperationPlanningPort,
  ReviewPublicationReleaseLimitsQueryPort,
} from "../ports/review-publication-operation-planning-port";

// Reader-first rollout: switch this to AttemptScopedV2 only after every
// production API and worker can restore both identity versions.
export const currentReviewPublicationOperationIdentityWriteVersion =
  ReviewPublicationOperationIdentityVersion.LegacyProjectionV1;

export class ReviewPublicationOperationPlanningService implements ReviewPublicationOperationPlanningPort {
  constructor(
    private readonly releaseLimits: ReviewPublicationReleaseLimitsQueryPort,
  ) {}

  async plan(input: {
    readonly identity: ReviewPublicationOperationIdentity;
    readonly envelope: PublishedReviewProjectionPublicationEnvelope;
  }): Promise<readonly ReviewPublicationOperationPlan[]> {
    const { identity, envelope } = input;
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
    return planReviewPublicationOperations({ identity, envelope, limits });
  }
}
