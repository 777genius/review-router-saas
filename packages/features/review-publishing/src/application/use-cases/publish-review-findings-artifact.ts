import type { ReviewPublisherPort } from "../ports/review-publisher-port";
import {
  createReviewPublicationPlanFromArtifact,
  parseReviewFindingsArtifactJson,
} from "../../domain/review-findings-artifact";
import type {
  ReviewPublicationMode,
  ReviewPublicationTarget,
} from "../../domain/review-publication";

export async function publishReviewFindingsArtifact(
  input: {
    readonly artifactJson: string;
    readonly target: ReviewPublicationTarget;
    readonly marker: string;
    readonly mode?: ReviewPublicationMode | undefined;
    readonly maxInlineComments?: number | undefined;
  },
  dependencies: {
    readonly publisher: ReviewPublisherPort;
  },
) {
  const artifact = parseReviewFindingsArtifactJson(input.artifactJson);
  const plan = createReviewPublicationPlanFromArtifact({
    target: input.target,
    artifact,
    marker: input.marker,
    mode: input.mode,
    maxInlineComments: input.maxInlineComments,
  });
  return dependencies.publisher.publishReview(plan);
}
