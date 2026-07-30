import { createHash } from "node:crypto";
import {
  assertRateLimit,
  RateLimitExceededError,
  type RateLimitStorePort,
} from "@reviewrouter/features-rate-limits";
import type { ReviewConfigurationOperatorRateLimitPort } from "@reviewrouter/features-review-config";
import type { Clock } from "@reviewrouter/shared";

export class ReviewConfigurationOperatorRateLimit implements ReviewConfigurationOperatorRateLimitPort {
  constructor(
    private readonly rateLimits: RateLimitStorePort,
    private readonly clock: Clock,
  ) {}

  async consume(
    input: Parameters<ReviewConfigurationOperatorRateLimitPort["consume"]>[0],
  ): Promise<boolean> {
    try {
      await assertRateLimit(
        {
          key: [
            "operator",
            "review_config",
            input.operation,
            hashKeyPart(input.operatorId),
            hashKeyPart(input.repositoryFullName),
          ].join(":"),
          limit: 60,
          windowMs: 10 * 60 * 1000,
        },
        { rateLimits: this.rateLimits, clock: this.clock },
      );
      return true;
    } catch (error) {
      if (error instanceof RateLimitExceededError) return false;
      throw error;
    }
  }
}

function hashKeyPart(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
