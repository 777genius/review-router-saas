import {
  assertRateLimit,
  type RateLimitStorePort,
} from "@reviewrouter/features-rate-limits";
import type { ActionRateLimitPolicyPort } from "@reviewrouter/features-action-control-plane";
import type { Clock } from "@reviewrouter/shared";

const oidcExchangeLimit = {
  limit: 20,
  windowMs: 10 * 60 * 1000,
};

const healthReportLimit = {
  limit: 120,
  windowMs: 60 * 60 * 1000,
};

export class ActionRateLimitPolicy implements ActionRateLimitPolicyPort {
  constructor(
    private readonly rateLimits: RateLimitStorePort,
    private readonly clock: Clock,
  ) {}

  async assertOidcExchangeAllowed(input: {
    readonly repositoryId: string;
    readonly githubRunId: string;
    readonly githubRunAttempt: string;
  }): Promise<void> {
    await assertRateLimit(
      {
        key: [
          "action",
          "oidc_exchange",
          input.repositoryId,
          input.githubRunId,
          input.githubRunAttempt,
        ].join(":"),
        ...oidcExchangeLimit,
      },
      { rateLimits: this.rateLimits, clock: this.clock },
    );
  }

  async assertHealthReportAllowed(input: {
    readonly repositoryId: string;
  }): Promise<void> {
    await assertRateLimit(
      {
        key: ["action", "health_report", input.repositoryId].join(":"),
        ...healthReportLimit,
      },
      { rateLimits: this.rateLimits, clock: this.clock },
    );
  }
}
