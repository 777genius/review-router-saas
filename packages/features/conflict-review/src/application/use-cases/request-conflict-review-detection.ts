import { isSafeGitHubBranchName, type Clock } from "@reviewrouter/shared";
import {
  enqueueOutboxEvent,
  type OutboxEventRepositoryPort,
} from "@reviewrouter/features-outbox";
import type {
  GitHubPullRequestWebhookEnvelope,
  GitHubPushWebhookEnvelope,
} from "@reviewrouter/features-github-installations";
import { conflictReviewOutboxEventType } from "../../domain/conflict-review";

export type ConflictReviewDetectionRequestPayload =
  | {
      readonly source: "pull_request";
      readonly deliveryId: string;
      readonly githubInstallationId: string;
      readonly githubRepositoryId: string;
      readonly repositoryFullName: string;
      readonly pullRequestNumber: number;
      readonly action: string;
    }
  | {
      readonly source: "base_push";
      readonly deliveryId: string;
      readonly githubInstallationId: string;
      readonly githubRepositoryId: string;
      readonly repositoryFullName: string;
      readonly baseRef: string;
    };

const pullRequestActionsThatMayAffectConflictReview = new Set([
  "opened",
  "reopened",
  "synchronize",
  "ready_for_review",
  "edited",
]);

export async function requestConflictReviewDetectionFromPullRequestWebhook(
  envelope: GitHubPullRequestWebhookEnvelope,
  dependencies: {
    readonly outbox: OutboxEventRepositoryPort;
    readonly clock: Clock;
  },
): Promise<{
  readonly processed: boolean;
  readonly queued: boolean;
  readonly reason?: string;
}> {
  const payload = envelope.payload;
  if (!pullRequestActionsThatMayAffectConflictReview.has(payload.action)) {
    return {
      processed: false,
      queued: false,
      reason: "pull_request_action_ignored",
    };
  }

  const eventPayload: ConflictReviewDetectionRequestPayload = {
    source: "pull_request",
    deliveryId: envelope.deliveryId,
    githubInstallationId: String(payload.installation.id),
    githubRepositoryId: String(payload.repository.id),
    repositoryFullName: payload.repository.full_name,
    pullRequestNumber: payload.pull_request.number,
    action: payload.action,
  };

  const result = await enqueueOutboxEvent(
    {
      type: conflictReviewOutboxEventType,
      version: 1,
      idempotencyKey: `conflict-review:detect:delivery:${envelope.deliveryId}`,
      aggregateId: `github-repository:${payload.repository.id}`,
      payload: eventPayload,
      occurredAt: dependencies.clock.now(),
      maxAttempts: 5,
    },
    { outbox: dependencies.outbox },
  );

  return { processed: true, queued: result.created };
}

export async function requestConflictReviewDetectionFromPushWebhook(
  envelope: GitHubPushWebhookEnvelope,
  dependencies: {
    readonly outbox: OutboxEventRepositoryPort;
    readonly clock: Clock;
  },
): Promise<{
  readonly processed: boolean;
  readonly queued: boolean;
  readonly reason?: string;
}> {
  const payload = envelope.payload;
  if (payload.deleted) {
    return { processed: false, queued: false, reason: "push_deleted_ref" };
  }
  const branchRef = parseBranchRef(payload.ref);
  if (!branchRef) {
    return { processed: false, queued: false, reason: "push_not_branch" };
  }

  const eventPayload: ConflictReviewDetectionRequestPayload = {
    source: "base_push",
    deliveryId: envelope.deliveryId,
    githubInstallationId: String(payload.installation.id),
    githubRepositoryId: String(payload.repository.id),
    repositoryFullName: payload.repository.full_name,
    baseRef: branchRef,
  };

  const result = await enqueueOutboxEvent(
    {
      type: conflictReviewOutboxEventType,
      version: 1,
      idempotencyKey: `conflict-review:detect:delivery:${envelope.deliveryId}`,
      aggregateId: `github-repository:${payload.repository.id}`,
      payload: eventPayload,
      occurredAt: dependencies.clock.now(),
      maxAttempts: 5,
    },
    { outbox: dependencies.outbox },
  );

  return { processed: true, queued: result.created };
}

function parseBranchRef(ref: string): string | null {
  const prefix = "refs/heads/";
  if (!ref.startsWith(prefix)) return null;
  const branchRef = ref.slice(prefix.length);
  return isSafeGitHubBranchName(branchRef) ? branchRef : null;
}
