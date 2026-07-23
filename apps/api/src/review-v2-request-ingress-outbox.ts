import type {
  OutboxEventRepositoryPort,
  OutboxEventStatusQueryPort,
} from "@reviewrouter/features-outbox";
import {
  ReviewRequestIngressCommandKind,
  parseReviewRequestIngressPayload,
  reviewRequestIngressEventType,
  reviewRequestIngressEventVersion,
  type EnqueueReviewRequestIngressCommand,
  type ReviewRequestIngressPayload,
  type ReviewRequestIngressPort,
} from "@reviewrouter/features-review-executions";
import { canonicalJson } from "@reviewrouter/features-review-run-control";

export class ReviewV2RequestIngressOutbox implements ReviewRequestIngressPort {
  constructor(
    private readonly outbox: OutboxEventRepositoryPort &
      OutboxEventStatusQueryPort,
    private readonly digest: { digestUtf8(value: string): Promise<string> },
  ) {}

  async enqueue(command: EnqueueReviewRequestIngressCommand) {
    const deliveryIdentityHash = await this.digest.digestUtf8(
      `rr.review-request-ingress-source.v1\0${command.sourceIdentity}`,
    );
    const requestId =
      command.commandKind === ReviewRequestIngressCommandKind.Request
        ? `review-request-${deliveryIdentityHash}`
        : null;
    const base = {
      protocolVersion: 1 as const,
      commandKind: command.commandKind,
      workspaceId: command.workspaceId,
      repositoryConnectionId: command.repositoryConnectionId,
      scmRepositoryIdentityId: command.scmRepositoryIdentityId,
      pullRequestNumber: command.pullRequestNumber,
      githubInstallationId: command.githubInstallationId,
      repositoryFullName: command.repositoryFullName,
      deliveryIdentityHash,
    };
    const payload: ReviewRequestIngressPayload =
      command.commandKind === ReviewRequestIngressCommandKind.Request
        ? {
            ...base,
            commandKind: ReviewRequestIngressCommandKind.Request,
            requestId: requestId!,
            triggerKind: command.triggerKind,
            expectedBaseSha: command.expectedBaseSha,
            expectedHeadSha: command.expectedHeadSha,
            quietPeriodMs: command.quietPeriodMs,
            retentionMs: command.retentionMs,
          }
        : {
            ...base,
            commandKind: ReviewRequestIngressCommandKind.Cancel,
          };
    parseReviewRequestIngressPayload(payload);
    const scopeHash = await this.digest.digestUtf8(
      canonicalJson({
        workspaceId: command.workspaceId,
        repositoryConnectionId: command.repositoryConnectionId,
        scmRepositoryIdentityId: command.scmRepositoryIdentityId,
        pullRequestNumber: command.pullRequestNumber,
      }),
    );
    const idempotencyKey = `review-request-ingress:v1:${deliveryIdentityHash}`;
    const result = await this.outbox.enqueue({
      type: reviewRequestIngressEventType,
      version: reviewRequestIngressEventVersion,
      idempotencyKey,
      workspaceId: command.workspaceId,
      repositoryId: command.repositoryConnectionId,
      aggregateId: `review-request-scope:${scopeHash}`,
      payload,
      maxAttempts: 20,
      occurredAt: command.occurredAt,
    });
    await assertRestorableOutboxEvent(this.outbox, idempotencyKey, result);
    return { ...result, deliveryIdentityHash, requestId };
  }
}

export async function assertRestorableOutboxEvent(
  outbox: OutboxEventStatusQueryPort,
  idempotencyKey: string,
  result: { readonly created: boolean },
): Promise<void> {
  if (result.created) return;
  const existing = await outbox.findStatusByIdempotencyKey(idempotencyKey);
  if (!existing) throw new Error("outbox_restored_event_missing");
  if (existing.status === "dead_letter") {
    throw new Error("outbox_restored_event_dead_lettered");
  }
}
