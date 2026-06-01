import type { ScmProvider } from "@reviewrouter/shared";
import type {
  ReviewPublicationResult,
  ReviewPublisherPort,
} from "../ports/review-publisher-port";
import type { ReviewPublicationPlan } from "../../domain/review-publication";

export class ProviderReviewPublisher implements ReviewPublisherPort {
  private readonly publishers: ReadonlyMap<ScmProvider, ReviewPublisherPort>;

  constructor(publishers: ReadonlyMap<ScmProvider, ReviewPublisherPort>) {
    this.publishers = publishers;
  }

  async publishReview(
    plan: ReviewPublicationPlan,
  ): Promise<ReviewPublicationResult> {
    const publisher = this.publishers.get(plan.target.provider);
    if (!publisher) {
      throw new Error(`review_publisher_missing:${plan.target.provider}`);
    }
    return publisher.publishReview(plan);
  }
}
