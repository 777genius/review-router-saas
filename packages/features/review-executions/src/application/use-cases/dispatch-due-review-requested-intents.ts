import {
  ReviewRequestedClaimStatus,
  ReviewRequestedDispatchSubmissionStatus,
  ReviewRequestedTransitionStatus,
  type ReviewRequestedDispatchGatewayPort,
  type ReviewRequestedIntentCommandPort,
  type ReviewRequestedIntentQueryPort,
} from "../ports/review-requested-intent-ports";
import { ReviewRequestedIntentTerminalReason } from "../../domain/review-requested-intent";
import {
  buildReviewRequestedRetryCandidate,
  defaultReviewRequestedDispatchPolicy,
  validateReviewRequestedDispatchPolicy,
  type ReviewRequestedDispatchPolicy,
  type ReviewRequestedRetryDependencies,
} from "./review-requested-dispatch-policy";

export type DispatchDueReviewRequestedIntentsResult = Readonly<{
  scanned: number;
  claimed: number;
  dispatched: number;
  busy: number;
  failed: number;
}>;

export class DispatchDueReviewRequestedIntents {
  private readonly policy: ReviewRequestedDispatchPolicy;

  constructor(
    private readonly queries: ReviewRequestedIntentQueryPort,
    private readonly commands: ReviewRequestedIntentCommandPort,
    private readonly gateway: ReviewRequestedDispatchGatewayPort,
    private readonly clock: { now(): Date },
    private readonly ids: {
      nextClaimId(): string;
      nextRequestId(): string;
    },
    private readonly digest: ReviewRequestedRetryDependencies["digest"],
    policy: ReviewRequestedDispatchPolicy = defaultReviewRequestedDispatchPolicy,
  ) {
    validateReviewRequestedDispatchPolicy(policy);
    this.policy = policy;
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
        claimUntil: new Date(
          observedAt.getTime() + this.policy.claimDurationMs,
        ),
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

      let prepared;
      try {
        prepared = await this.gateway.prepare({ intent: claim.intent });
      } catch {
        // No effect-bearing call has happened. The expiring claim can be
        // retried safely after repository/credential preparation recovers.
        failed += 1;
        continue;
      }

      const submissionAt = this.clock.now();
      const begun = await this.commands.beginSubmission({
        requestId: claim.intent.requestId,
        claimId: claim.intent.claim.claimId,
        ownerIdHash: claim.intent.claim.ownerIdHash,
        fencingToken: claim.intent.claim.fencingToken,
        now: submissionAt,
        nextResolutionAt: new Date(
          submissionAt.getTime() + this.policy.dispatchResolutionDelayMs,
        ),
        resolutionDeadlineAt: new Date(
          submissionAt.getTime() + this.policy.dispatchResolutionTimeoutMs,
        ),
      });
      if (
        begun.status !== ReviewRequestedTransitionStatus.Applied ||
        !begun.intent?.claim
      ) {
        // A restored begin means the one allowed POST may already have happened.
        // Only the reconciliation path is allowed to make progress from there.
        failed += 1;
        continue;
      }

      try {
        const submission = await prepared.submit();
        if (
          submission.status ===
          ReviewRequestedDispatchSubmissionStatus.DefinitelyNoEffect
        ) {
          const now = this.clock.now();
          const successor = await buildReviewRequestedRetryCandidate({
            intent: begun.intent,
            now,
            identitySeed: `definitely-no-effect\0${begun.intent.dispatchAttempt}`,
            dependencies: {
              ids: this.ids,
              digest: this.digest,
            },
            policy: this.policy,
          });
          const recovered = await this.commands.recoverDispatch({
            requestId: begun.intent.requestId,
            expectedVersion: begun.intent.version,
            sourceRunId: null,
            sourceRunAttempt: null,
            now,
            terminalReason:
              successor === null
                ? ReviewRequestedIntentTerminalReason.DispatchAttemptsExhausted
                : ReviewRequestedIntentTerminalReason.DispatchFailedNoEffect,
            successorCandidate: successor,
          });
          if (
            recovered.status !== ReviewRequestedTransitionStatus.Applied &&
            recovered.status !== ReviewRequestedTransitionStatus.Restored
          ) {
            failed += 1;
          }
          continue;
        }

        const recordedAt = this.clock.now();
        const recorded = await this.commands.recordDispatch({
          requestId: begun.intent.requestId,
          claimId: begun.intent.claim.claimId,
          ownerIdHash: begun.intent.claim.ownerIdHash,
          fencingToken: begun.intent.claim.fencingToken,
          sourceRunId: submission.sourceRunId,
          sourceRunAttempt: submission.sourceRunAttempt,
          now: recordedAt,
          nextResolutionAt: new Date(
            recordedAt.getTime() + this.policy.authorizationResolutionDelayMs,
          ),
          resolutionDeadlineAt: new Date(
            recordedAt.getTime() + this.policy.authorizationResolutionTimeoutMs,
          ),
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
        // Unknown POST outcome remains ReconcilingDispatch. Recovery performs
        // lookup only and never submits this request identity again.
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
