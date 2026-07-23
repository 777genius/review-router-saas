import {
  ReviewRequestedDispatchRunStatus,
  ReviewRequestedTransitionStatus,
  type ReviewRequestedDispatchGatewayPort,
  type ReviewRequestedIntentCommandPort,
  type ReviewRequestedIntentQueryPort,
} from "../ports/review-requested-intent-ports";

export type RecoverReviewRequestedDispatchesResult = Readonly<{
  scanned: number;
  pending: number;
  recovered: number;
  failed: number;
}>;

export class RecoverReviewRequestedDispatches {
  constructor(
    private readonly queries: ReviewRequestedIntentQueryPort,
    private readonly commands: ReviewRequestedIntentCommandPort,
    private readonly gateway: ReviewRequestedDispatchGatewayPort,
    private readonly clock: { now(): Date },
    private readonly ids: { nextRequestId(): string },
    private readonly digest: { digestUtf8(value: string): Promise<string> },
    private readonly minimumAgeMs = 300_000,
    private readonly retryDelayMs = 30_000,
    private readonly retentionMs = 2_592_000_000,
    private readonly maxDispatchAttempts = 3,
  ) {
    assertDuration(minimumAgeMs, "review_requested_recovery_age_invalid");
    assertDuration(retryDelayMs, "review_requested_recovery_delay_invalid");
    assertRetention(retentionMs);
    if (
      !Number.isSafeInteger(maxDispatchAttempts) ||
      maxDispatchAttempts <= 0 ||
      maxDispatchAttempts > 10
    ) {
      throw new Error("review_requested_recovery_attempt_budget_invalid");
    }
  }

  async execute(input: {
    readonly limit: number;
  }): Promise<RecoverReviewRequestedDispatchesResult> {
    assertLimit(input.limit);
    const candidates = await this.queries.listAwaitingAuthorization({
      now: this.clock.now(),
      minimumAgeMs: this.minimumAgeMs,
      limit: input.limit,
    });
    let pending = 0;
    let recovered = 0;
    let failed = 0;

    for (const intent of candidates) {
      try {
        const run = await this.gateway.inspect({ intent });
        if (run.status === ReviewRequestedDispatchRunStatus.Pending) {
          pending += 1;
          continue;
        }
        const now = this.clock.now();
        const sourceRunId = requiredSourceIdentity(
          intent.sourceRunId,
          "review_requested_recovery_source_run_missing",
        );
        const sourceRunAttempt = requiredSourceIdentity(
          intent.sourceRunAttempt,
          "review_requested_recovery_source_attempt_missing",
        );
        const retryAllowed =
          run.status ===
            ReviewRequestedDispatchRunStatus.TerminalCurrentRevision &&
          intent.dispatchAttempt < this.maxDispatchAttempts;
        const deliveryIdentityHash = retryAllowed
          ? await this.digest.digestUtf8(
              `rr.review-request-recovery-delivery.v1\0${intent.requestId}\0${sourceRunId}\0${sourceRunAttempt}`,
            )
          : null;
        const canonicalRequestHash = deliveryIdentityHash
          ? await this.digest.digestUtf8(
              `rr.review-request-recovery-canonical.v1\0${intent.canonicalRequestHash}\0${deliveryIdentityHash}`,
            )
          : null;
        const result = await this.commands.recoverDispatch({
          requestId: intent.requestId,
          sourceRunId,
          sourceRunAttempt,
          now,
          successorCandidate:
            deliveryIdentityHash && canonicalRequestHash
              ? {
                  workspaceId: intent.workspaceId,
                  repositoryConnectionId: intent.repositoryConnectionId,
                  scmRepositoryIdentityId: intent.scmRepositoryIdentityId,
                  pullRequestNumber: intent.pullRequestNumber,
                  requestId: this.ids.nextRequestId(),
                  dispatchAttempt: intent.dispatchAttempt + 1,
                  revision: intent.revision,
                  triggerKind: intent.triggerKind,
                  deliveryIdentityHash,
                  canonicalRequestHash,
                  notBefore: new Date(now.getTime() + this.retryDelayMs),
                  createdAt: now,
                  retainUntil: new Date(now.getTime() + this.retentionMs),
                }
              : null,
        });
        if (
          result.status === ReviewRequestedTransitionStatus.Applied ||
          result.status === ReviewRequestedTransitionStatus.Restored
        ) {
          recovered += 1;
        } else {
          failed += 1;
        }
      } catch {
        failed += 1;
      }
    }

    return { scanned: candidates.length, pending, recovered, failed };
  }
}

function requiredSourceIdentity(value: string | null, error: string): string {
  if (!value) throw new Error(error);
  return value;
}

function assertDuration(value: number, error: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 86_400_000) {
    throw new Error(error);
  }
}

function assertRetention(value: number): void {
  if (!Number.isSafeInteger(value) || value < 86_400_000) {
    throw new Error("review_requested_recovery_retention_invalid");
  }
}

function assertLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 1_000) {
    throw new Error("review_requested_recovery_limit_invalid");
  }
}
