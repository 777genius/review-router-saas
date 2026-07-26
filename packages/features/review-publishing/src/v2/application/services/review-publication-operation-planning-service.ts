import {
  ReviewPublicationPlanningError,
  ReviewPublicationPlanningErrorCode,
  ReviewPublicationOperationIdentityVersion,
  assertPublishedReviewProjectionPublicationEnvelopeIdentity,
  planReviewPublicationOperations,
  resolveReviewPublicationOperationIdentityVersion,
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

export function reviewPublicationAttemptId(input: {
  readonly executionId: string;
  readonly artifactId: string;
  readonly projectionHash: string;
  readonly digestUtf8: (value: string) => string;
}): string {
  const preimage = [
    input.executionId,
    input.artifactId,
    input.projectionHash,
  ].join("\0");
  const digest = input.digestUtf8(`rr.publication.v2\0${preimage}`);
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    throw new ReviewPublicationPlanningError(
      ReviewPublicationPlanningErrorCode.OperationIdentityInvalid,
    );
  }
  return `publication-${digest.slice(0, 40)}`;
}

export function resolveCurrentReviewPublicationOperationIdentity(input: {
  readonly publicationAttemptId: string;
  readonly projectionHash: string;
  readonly existingOperationIds: readonly string[] | null;
}): ReviewPublicationOperationIdentity {
  return {
    publicationAttemptId: input.publicationAttemptId,
    version: resolveReviewPublicationOperationIdentityVersion({
      ...input,
      newAttemptVersion: currentReviewPublicationOperationIdentityWriteVersion,
    }),
  };
}

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
