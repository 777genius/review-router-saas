import {
  ReviewRequestedClaimStatus,
  ReviewRequestedTransitionStatus,
  type ReviewRequestedDispatchGatewayPort,
  type ReviewRequestedIntentCommandPort,
  type ReviewRequestedIntentQueryPort,
} from "../ports/review-requested-intent-ports";

export type DispatchDueReviewRequestedIntentsResult = Readonly<{
  scanned: number;
  claimed: number;
  dispatched: number;
  busy: number;
  failed: number;
}>;

export class DispatchDueReviewRequestedIntents {
  constructor(
    private readonly queries: ReviewRequestedIntentQueryPort,
    private readonly commands: ReviewRequestedIntentCommandPort,
    private readonly gateway: ReviewRequestedDispatchGatewayPort,
    private readonly clock: { now(): Date },
    private readonly ids: { nextClaimId(): string },
    private readonly claimDurationMs = 60_000,
  ) {
    if (!Number.isSafeInteger(claimDurationMs) || claimDurationMs <= 0) {
      throw new Error("review_requested_claim_duration_invalid");
    }
  }

  async execute(input: {
    readonly ownerIdHash: string;
    readonly limit: number;
  }): Promise<DispatchDueReviewRequestedIntentsResult> {
    assertOwnerHash(input.ownerIdHash);
    assertLimit(input.limit);
    const due = await this.queries.listDue({
      now: this.clock.now(),
      limit: input.limit,
    });
    const claimedScopes = new Set<string>();
    let claimed = 0;
    let dispatched = 0;
    let busy = 0;
    let failed = 0;

    for (const candidate of due) {
      const scope = intentScopeKey(candidate);
      if (claimedScopes.has(scope)) {
        busy += 1;
        continue;
      }
      const observedAt = this.clock.now();
      const claim = await this.commands.claimIntent({
        requestId: candidate.requestId,
        claimId: this.ids.nextClaimId(),
        ownerIdHash: input.ownerIdHash,
        now: observedAt,
        claimUntil: new Date(observedAt.getTime() + this.claimDurationMs),
      });
      if (
        claim.status !== ReviewRequestedClaimStatus.Claimed &&
        claim.status !== ReviewRequestedClaimStatus.Restored
      ) {
        busy += 1;
        continue;
      }
      if (!claim.intent?.claim) {
        throw new Error("review_requested_claim_term_missing");
      }
      claimed += 1;
      claimedScopes.add(scope);

      try {
        const source = await this.gateway.dispatch({ intent: claim.intent });
        const recorded = await this.commands.recordDispatch({
          requestId: claim.intent.requestId,
          claimId: claim.intent.claim.claimId,
          ownerIdHash: claim.intent.claim.ownerIdHash,
          fencingToken: claim.intent.claim.fencingToken,
          sourceRunId: source.sourceRunId,
          sourceRunAttempt: source.sourceRunAttempt,
          now: this.clock.now(),
        });
        if (
          recorded.status === ReviewRequestedTransitionStatus.Applied ||
          recorded.status === ReviewRequestedTransitionStatus.Restored
        ) {
          dispatched += 1;
        } else {
          failed += 1;
        }
      } catch {
        // The fenced claim is deliberately left for expiry/takeover. The gateway
        // must reconcile by requestId before creating another external run.
        failed += 1;
      }
    }

    return {
      scanned: due.length,
      claimed,
      dispatched,
      busy,
      failed,
    };
  }
}

function intentScopeKey(input: {
  readonly workspaceId: string;
  readonly repositoryConnectionId: string;
  readonly scmRepositoryIdentityId: string;
  readonly pullRequestNumber: number;
}): string {
  return JSON.stringify([
    input.workspaceId,
    input.repositoryConnectionId,
    input.scmRepositoryIdentityId,
    input.pullRequestNumber,
  ]);
}

function assertOwnerHash(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("review_requested_owner_hash_invalid");
  }
}

function assertLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 1_000) {
    throw new Error("review_requested_dispatch_limit_invalid");
  }
}
