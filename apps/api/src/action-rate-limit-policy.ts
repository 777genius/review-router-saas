import {
  assertRateLimit,
  type RateLimitStorePort,
} from "@reviewrouter/features-rate-limits";
import type { ActionRateLimitPolicyPort } from "@reviewrouter/features-action-control-plane";
import type { Clock } from "@reviewrouter/shared";
import { createHash } from "node:crypto";

const oidcExchangeLimit = {
  limit: 20,
  windowMs: 10 * 60 * 1000,
};

const interactionActorOidcExchangeLimit = {
  limit: 30,
  windowMs: 10 * 60 * 1000,
};

const interactionRepositoryOidcExchangeLimit = {
  limit: 120,
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
    readonly eventName: string;
    readonly githubActorLogin: string | null;
    readonly githubRunId: string;
    readonly githubRunAttempt: string;
  }): Promise<void> {
    if (isInteractionEvent(input.eventName)) {
      await assertRateLimit(
        {
          key: [
            "action",
            "oidc_exchange",
            "interaction_actor",
            input.repositoryId,
            hashRateLimitKeyPart(input.githubActorLogin ?? "unknown"),
          ].join(":"),
          ...interactionActorOidcExchangeLimit,
        },
        { rateLimits: this.rateLimits, clock: this.clock },
      );
      await assertRateLimit(
        {
          key: [
            "action",
            "oidc_exchange",
            "interaction_repository",
            input.repositoryId,
          ].join(":"),
          ...interactionRepositoryOidcExchangeLimit,
        },
        { rateLimits: this.rateLimits, clock: this.clock },
      );
    }

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

function isInteractionEvent(eventName: string): boolean {
  return (
    eventName === "issue_comment" || eventName === "pull_request_review_comment"
  );
}

function hashRateLimitKeyPart(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
