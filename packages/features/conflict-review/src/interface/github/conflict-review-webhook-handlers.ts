import type {
  GitHubPullRequestWebhookEnvelope,
  GitHubPullRequestWebhookHandlerPort,
  GitHubPushWebhookEnvelope,
  GitHubPushWebhookHandlerPort,
} from "@reviewrouter/features-github-installations";
import type { OutboxEventRepositoryPort } from "@reviewrouter/features-outbox";
import type { Clock } from "@reviewrouter/shared";
import type { ConflictReviewRolloutPolicyPort } from "../../application/ports/conflict-review-rollout-policy-port";
import {
  requestConflictReviewDetectionFromPullRequestWebhook,
  requestConflictReviewDetectionFromPushWebhook,
} from "../../application/use-cases/request-conflict-review-detection";

export class ConflictReviewPullRequestWebhookHandler implements GitHubPullRequestWebhookHandlerPort {
  constructor(
    private readonly dependencies: {
      readonly outbox: OutboxEventRepositoryPort;
      readonly rolloutPolicy?: ConflictReviewRolloutPolicyPort | undefined;
      readonly clock: Clock;
    },
  ) {}

  async handleGitHubPullRequestWebhook(
    envelope: GitHubPullRequestWebhookEnvelope,
  ): Promise<Record<string, unknown>> {
    return requestConflictReviewDetectionFromPullRequestWebhook(
      envelope,
      this.dependencies,
    );
  }
}

export class ConflictReviewPushWebhookHandler implements GitHubPushWebhookHandlerPort {
  constructor(
    private readonly dependencies: {
      readonly outbox: OutboxEventRepositoryPort;
      readonly rolloutPolicy?: ConflictReviewRolloutPolicyPort | undefined;
      readonly clock: Clock;
    },
  ) {}

  async handleGitHubPushWebhook(
    envelope: GitHubPushWebhookEnvelope,
  ): Promise<Record<string, unknown>> {
    return requestConflictReviewDetectionFromPushWebhook(
      envelope,
      this.dependencies,
    );
  }
}
