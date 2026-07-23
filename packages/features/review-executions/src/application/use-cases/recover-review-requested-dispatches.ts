import {
  ReviewRequestedDispatchLookupStatus,
  ReviewRequestedDispatchRunStatus,
  ReviewRequestedTransitionStatus,
  type ReviewRequestedDispatchGatewayPort,
  type ReviewRequestedIntentCommandPort,
  type ReviewRequestedIntentQueryPort,
} from "../ports/review-requested-intent-ports";
import {
  ReviewRequestedIntentState,
  ReviewRequestedIntentTerminalReason,
  type ReviewRequestedIntent,
} from "../../domain/review-requested-intent";
import {
  buildReviewRequestedRetryCandidate,
  defaultReviewRequestedDispatchPolicy,
  validateReviewRequestedDispatchPolicy,
  type ReviewRequestedDispatchPolicy,
  type ReviewRequestedRetryDependencies,
} from "./review-requested-dispatch-policy";

export type RecoverReviewRequestedDispatchesResult = Readonly<{
  scanned: number;
  pending: number;
  recovered: number;
  failed: number;
}>;

type CandidateResolution = "pending" | "recovered" | "failed";

export class RecoverReviewRequestedDispatches {
  private readonly policy: ReviewRequestedDispatchPolicy;

  constructor(
    private readonly queries: ReviewRequestedIntentQueryPort,
    private readonly commands: ReviewRequestedIntentCommandPort,
    private readonly gateway: ReviewRequestedDispatchGatewayPort,
    private readonly clock: { now(): Date },
    private readonly retryDependencies: ReviewRequestedRetryDependencies,
    policy: ReviewRequestedDispatchPolicy = defaultReviewRequestedDispatchPolicy,
  ) {
    validateReviewRequestedDispatchPolicy(policy);
    this.policy = policy;
  }

  async execute(input: {
    readonly limit: number;
  }): Promise<RecoverReviewRequestedDispatchesResult> {
    assertLimit(input.limit);
    const candidates = await this.queries.listDueForResolution({
      now: this.clock.now(),
      limit: input.limit,
    });
    let pending = 0;
    let recovered = 0;
    let failed = 0;

    for (const intent of candidates) {
      let resolution: CandidateResolution;
      try {
        resolution =
          intent.state === ReviewRequestedIntentState.ReconcilingDispatch
            ? await this.reconcileUnknownDispatch(intent)
            : intent.state === ReviewRequestedIntentState.AwaitingAuthorization
              ? await this.resolveAwaitingAuthorization(intent)
              : "failed";
      } catch {
        failed += 1;
        continue;
      }
      if (resolution === "pending") pending += 1;
      else if (resolution === "recovered") recovered += 1;
      else failed += 1;
    }

    return { scanned: candidates.length, pending, recovered, failed };
  }

  private async reconcileUnknownDispatch(
    intent: ReviewRequestedIntent,
  ): Promise<CandidateResolution> {
    const deadline = requiredDate(
      intent.resolutionDeadlineAt,
      "review_requested_dispatch_resolution_deadline_missing",
    );
    let lookup:
      | Awaited<
          ReturnType<
            ReviewRequestedDispatchGatewayPort["findByRequestIdentity"]
          >
        >
      | undefined;
    try {
      lookup = await this.gateway.findByRequestIdentity({ intent });
    } catch {
      lookup = {
        status: ReviewRequestedDispatchLookupStatus.Inconclusive,
      };
    }
    const now = this.clock.now();
    if (lookup.status === ReviewRequestedDispatchLookupStatus.Found) {
      const claim = intent.claim;
      if (claim === null) return "failed";
      const linked = await this.commands.recordDispatch({
        requestId: intent.requestId,
        claimId: claim.claimId,
        ownerIdHash: claim.ownerIdHash,
        fencingToken: claim.fencingToken,
        sourceRunId: lookup.sourceRunId,
        sourceRunAttempt: lookup.sourceRunAttempt,
        now,
        nextResolutionAt: new Date(
          now.getTime() + this.policy.authorizationResolutionDelayMs,
        ),
        resolutionDeadlineAt: new Date(
          now.getTime() + this.policy.authorizationResolutionTimeoutMs,
        ),
      });
      return transitionApplied(linked.status) ? "recovered" : "failed";
    }
    if (now >= deadline) {
      const terminalized = await this.commands.recoverDispatch({
        requestId: intent.requestId,
        expectedVersion: intent.version,
        sourceRunId: null,
        sourceRunAttempt: null,
        now,
        terminalReason:
          ReviewRequestedIntentTerminalReason.DispatchOutcomeUnknown,
        successorCandidate: null,
      });
      return transitionApplied(terminalized.status) ? "recovered" : "failed";
    }
    return this.defer(intent, now, deadline);
  }

  private async resolveAwaitingAuthorization(
    intent: ReviewRequestedIntent,
  ): Promise<CandidateResolution> {
    const deadline = requiredDate(
      intent.resolutionDeadlineAt,
      "review_requested_authorization_deadline_missing",
    );
    const runStatus = await this.gateway
      .inspectKnownRun({ intent })
      .then((inspection) => inspection.status)
      .catch((): ReviewRequestedDispatchRunStatus | null => null);
    const now = this.clock.now();
    if (
      runStatus === ReviewRequestedDispatchRunStatus.TerminalCurrentRevision
    ) {
      const sourceRunId = requiredSourceIdentity(
        intent.sourceRunId,
        "review_requested_recovery_source_run_missing",
      );
      const sourceRunAttempt = requiredSourceIdentity(
        intent.sourceRunAttempt,
        "review_requested_recovery_source_attempt_missing",
      );
      const successor = await buildReviewRequestedRetryCandidate({
        intent,
        now,
        identitySeed: `${sourceRunId}\0${sourceRunAttempt}`,
        dependencies: this.retryDependencies,
        policy: this.policy,
      });
      const recovered = await this.commands.recoverDispatch({
        requestId: intent.requestId,
        expectedVersion: intent.version,
        sourceRunId,
        sourceRunAttempt,
        now,
        terminalReason:
          successor === null
            ? ReviewRequestedIntentTerminalReason.DispatchAttemptsExhausted
            : ReviewRequestedIntentTerminalReason.DispatchFailedNoEffect,
        successorCandidate: successor,
      });
      return transitionApplied(recovered.status) ? "recovered" : "failed";
    }
    if (runStatus === ReviewRequestedDispatchRunStatus.TerminalStaleRevision) {
      const recovered = await this.commands.recoverDispatch({
        requestId: intent.requestId,
        expectedVersion: intent.version,
        sourceRunId: requiredSourceIdentity(
          intent.sourceRunId,
          "review_requested_recovery_source_run_missing",
        ),
        sourceRunAttempt: requiredSourceIdentity(
          intent.sourceRunAttempt,
          "review_requested_recovery_source_attempt_missing",
        ),
        now,
        terminalReason: null,
        successorCandidate: null,
      });
      return transitionApplied(recovered.status) ? "recovered" : "failed";
    }
    if (now < deadline) {
      return this.defer(intent, now, deadline);
    }

    const terminalized = await this.commands.recoverDispatch({
      requestId: intent.requestId,
      expectedVersion: intent.version,
      sourceRunId: requiredSourceIdentity(
        intent.sourceRunId,
        "review_requested_recovery_source_run_missing",
      ),
      sourceRunAttempt: requiredSourceIdentity(
        intent.sourceRunAttempt,
        "review_requested_recovery_source_attempt_missing",
      ),
      now,
      terminalReason:
        ReviewRequestedIntentTerminalReason.AuthorizationDeadlineExceeded,
      successorCandidate: null,
    });
    if (!transitionApplied(terminalized.status)) return "failed";
    try {
      await this.gateway.cancelKnownRun({ intent });
    } catch {
      // Terminalization is authoritative. Cancellation is best effort because
      // the run may have completed concurrently or SCM may be unavailable.
    }
    return "recovered";
  }

  private async defer(
    intent: ReviewRequestedIntent,
    now: Date,
    deadline: Date,
  ): Promise<CandidateResolution> {
    const deferred = await this.commands.deferResolution({
      requestId: intent.requestId,
      expectedVersion: intent.version,
      expectedState: intent.state as
        | ReviewRequestedIntentState.ReconcilingDispatch
        | ReviewRequestedIntentState.AwaitingAuthorization,
      now,
      nextResolutionAt: new Date(
        Math.min(
          deadline.getTime(),
          now.getTime() +
            (intent.state === ReviewRequestedIntentState.ReconcilingDispatch
              ? this.policy.dispatchResolutionDelayMs
              : this.policy.authorizationResolutionDelayMs),
        ),
      ),
    });
    return transitionApplied(deferred.status) ? "pending" : "failed";
  }
}

function transitionApplied(status: ReviewRequestedTransitionStatus): boolean {
  return (
    status === ReviewRequestedTransitionStatus.Applied ||
    status === ReviewRequestedTransitionStatus.Restored
  );
}

function requiredSourceIdentity(value: string | null, error: string): string {
  if (!value) throw new Error(error);
  return value;
}

function requiredDate(value: Date | null, error: string): Date {
  if (value === null) throw new Error(error);
  return value;
}

function assertLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 1_000) {
    throw new Error("review_requested_recovery_limit_invalid");
  }
}
