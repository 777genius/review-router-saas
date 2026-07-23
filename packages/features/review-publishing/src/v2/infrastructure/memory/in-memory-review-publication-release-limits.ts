import type {
  ReviewPublicationReleaseLimitsIdentity,
  ReviewPublicationReleaseLimitsQueryPort,
} from "../../application/ports/review-publication-operation-planning-port";
import type { ReviewPublicationPlanningLimits } from "../../domain/review-publication-operation-planning";

export class InMemoryReviewPublicationReleaseLimitsQuery implements ReviewPublicationReleaseLimitsQueryPort {
  readonly #profiles = new Map<string, ReviewPublicationPlanningLimits>();

  constructor(profiles: readonly ReviewPublicationPlanningLimits[] = []) {
    for (const profile of profiles) {
      this.seed(profile);
    }
  }

  seed(profile: ReviewPublicationPlanningLimits): void {
    this.#profiles.set(keyOf(profile), { ...profile });
  }

  async findReleaseBoundLimits(
    identity: ReviewPublicationReleaseLimitsIdentity,
  ): Promise<ReviewPublicationPlanningLimits | null> {
    const profile = this.#profiles.get(keyOf(identity));
    return profile === undefined ? null : { ...profile };
  }
}

function keyOf(identity: ReviewPublicationReleaseLimitsIdentity): string {
  return JSON.stringify([
    identity.producerReleaseId,
    identity.protocolLimitsProfileId,
    identity.limitsDigest,
  ]);
}
