import {
  GitHubReviewRequestIngressCommandKind,
  githubReviewRequestIngressEventType,
  githubReviewRequestIngressEventVersion,
  parseGitHubReviewRequestIngressPayload,
  type GitHubReviewRequestIngressPayload,
} from "@reviewrouter/features-github-installations";
import type {
  OutboxEventRepositoryPort,
  OutboxEventStatusQueryPort,
} from "@reviewrouter/features-outbox";
import { canonicalJson } from "@reviewrouter/features-review-run-control";
import type {
  EnqueueGitHubReviewRequestIngressCommand,
  GitHubReviewRequestIngressPort,
} from "./github/review-v2-pull-request-webhook-handler.js";
import { assertRestorableOutboxEvent } from "./review-v2-request-ingress-outbox.js";

export class ReviewV2GitHubRequestIngressOutbox implements GitHubReviewRequestIngressPort {
  constructor(
    private readonly outbox: OutboxEventRepositoryPort &
      OutboxEventStatusQueryPort,
    private readonly digest: { digestUtf8(value: string): Promise<string> },
  ) {}

  async enqueue(command: EnqueueGitHubReviewRequestIngressCommand) {
    const deliveryIdentityHash = await this.digest.digestUtf8(
      `rr.github-review-request-ingress-source.v1\0${command.sourceIdentity}`,
    );
    const requestId =
      command.commandKind === GitHubReviewRequestIngressCommandKind.Request
        ? `review-request-${deliveryIdentityHash}`
        : null;
    const base = {
      protocolVersion: 1 as const,
      commandKind: command.commandKind,
      triggerAction: command.triggerAction,
      deliveryIdentityHash,
      githubInstallationId: command.githubInstallationId,
      githubRepositoryId: command.githubRepositoryId,
      repositoryFullName: command.repositoryFullName,
      pullRequestNumber: command.pullRequestNumber,
    };
    const payload: GitHubReviewRequestIngressPayload =
      command.commandKind === GitHubReviewRequestIngressCommandKind.Request
        ? {
            ...base,
            commandKind: GitHubReviewRequestIngressCommandKind.Request,
            expectedBaseSha: required(command.expectedBaseSha),
            expectedHeadSha: required(command.expectedHeadSha),
            draftAtIngress: command.draftAtIngress === true,
          }
        : {
            ...base,
            commandKind: GitHubReviewRequestIngressCommandKind.Cancel,
          };
    parseGitHubReviewRequestIngressPayload(payload);
    const aggregateHash = await this.digest.digestUtf8(
      canonicalJson({
        githubRepositoryId: command.githubRepositoryId,
        pullRequestNumber: command.pullRequestNumber,
      }),
    );
    const idempotencyKey = `github-review-request-ingress:v1:${deliveryIdentityHash}`;
    const result = await this.outbox.enqueue({
      type: githubReviewRequestIngressEventType,
      version: githubReviewRequestIngressEventVersion,
      idempotencyKey,
      aggregateId: `github-review-request-scope:${aggregateHash}`,
      payload,
      maxAttempts: 20,
      occurredAt: command.occurredAt,
    });
    await assertRestorableOutboxEvent(this.outbox, idempotencyKey, result);
    return { ...result, requestId };
  }
}

function required(value: string | undefined): string {
  if (!value) throw new Error("github_review_request_revision_missing");
  return value;
}
