import {
  canonicalReviewExecutionPlanPreimage,
  canonicalReviewExecutionStartPreimage,
  ReviewExecutionState,
  reviewExecutionIsTerminal,
  reviewRevisionsEqual,
  scopeKey,
  type ReviewExecutionSnapshot,
  type ReviewExecutionScope,
  type ReviewWorkSlotPlan,
} from "../../domain/review-execution";
import {
  CurrentReviewRevisionStatus,
  ReviewExecutionAdmissionStatus,
  ReviewExecutionAdmissionVerdict,
  ReviewExecutionPrepareStatus,
  type ClockPort,
  type CurrentReviewRevisionPort,
  type ReviewExecutionAuthorizationFactsPort,
  type ReviewExecutionAuthorizationFacts,
  type ReviewExecutionCommandPort,
  type ReviewExecutionQueryPort,
  type Sha256DigestPort,
} from "../ports/review-execution-ports";

export enum StartReviewExecutionStatus {
  Admitted = "admitted",
  Restored = "restored",
  AdmissionDeferred = "admission_deferred",
  StaleRevision = "stale_revision",
  AuthorizationRejected = "authorization_rejected",
  IdempotencyConflict = "idempotency_conflict",
  ConcurrencyConflict = "concurrency_conflict",
}

export type StartReviewExecutionInput = {
  readonly scope: ReviewExecutionScope;
  readonly executionId: string;
  readonly authorizationId: string;
  readonly compatibilityKey: string;
  readonly planHash: string;
  readonly workSlots: readonly ReviewWorkSlotPlan[];
  readonly sourceRunId: string;
  readonly sourceRunAttempt: string;
  readonly admissionDeadlineAt: Date;
  readonly executionDeadlineAt: Date;
  readonly retainUntil: Date;
};

export type StartReviewExecutionResult = {
  readonly status: StartReviewExecutionStatus;
  readonly snapshot?: ReviewExecutionSnapshot | undefined;
};

export class StartReviewExecution {
  constructor(
    private readonly authorizationFacts: ReviewExecutionAuthorizationFactsPort,
    private readonly currentRevision: CurrentReviewRevisionPort,
    private readonly queries: ReviewExecutionQueryPort,
    private readonly commands: ReviewExecutionCommandPort,
    private readonly digest: Sha256DigestPort,
    private readonly clock: ClockPort,
  ) {}

  async execute(
    input: StartReviewExecutionInput,
  ): Promise<StartReviewExecutionResult> {
    const authorization = await this.resolveInitialAuthorization(
      input.authorizationId,
      input.scope,
    );
    if (authorization === null) {
      return { status: StartReviewExecutionStatus.AuthorizationRejected };
    }

    const precheck = await this.currentRevision.resolve(input.scope);
    if (precheck.status === CurrentReviewRevisionStatus.Unavailable) {
      return { status: StartReviewExecutionStatus.AdmissionDeferred };
    }
    if (!reviewRevisionsEqual(precheck.revision, authorization.revision)) {
      return { status: StartReviewExecutionStatus.StaleRevision };
    }

    const canonicalPlan = canonicalReviewExecutionPlanPreimage(input.workSlots);
    const startPreimage = canonicalReviewExecutionStartPreimage({
      authorizationId: input.authorizationId,
      revision: authorization.revision,
      planHash: input.planHash,
      canonicalPlan,
    });
    const [startIdentityHash, canonicalStartHash] = await Promise.all([
      this.digest.digestUtf8(startPreimage),
      this.digest.digestUtf8(
        `rr.review-execution-start-body.v1\0${startPreimage}`,
      ),
    ]);

    let prepared: ReviewExecutionSnapshot | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.queries.findStream(input.scope);
      const prepareAuthorization = await this.resolveCurrentAuthorization(
        authorization,
        input.scope,
      );
      if (prepareAuthorization === null) {
        return { status: StartReviewExecutionStatus.AuthorizationRejected };
      }
      const result = await this.commands.prepareExecution({
        scope: input.scope,
        expectedStreamVersion: current?.version ?? 0n,
        executionId: input.executionId,
        authorizationId: input.authorizationId,
        producerReleaseId: authorization.producerReleaseId,
        mutationEpoch: authorization.mutationEpoch,
        revision: authorization.revision,
        startIdentityHash,
        canonicalStartHash,
        admissionSafetyDecisionHash: authorization.admissionSafetyDecisionHash,
        compatibilityKey: input.compatibilityKey,
        planHash: input.planHash,
        workSlots: input.workSlots,
        limits: authorization.limits,
        sourceRunId: input.sourceRunId,
        sourceRunAttempt: input.sourceRunAttempt,
        now: prepareAuthorization.observedAt,
        admissionDeadlineAt: input.admissionDeadlineAt,
        executionDeadlineAt: input.executionDeadlineAt,
        retainUntil: input.retainUntil,
      });
      if (result.status === ReviewExecutionPrepareStatus.IdempotencyConflict) {
        return { status: StartReviewExecutionStatus.IdempotencyConflict };
      }
      if (result.status === ReviewExecutionPrepareStatus.ConcurrencyConflict) {
        continue;
      }
      prepared = result.snapshot;
      break;
    }
    if (prepared === undefined) {
      return { status: StartReviewExecutionStatus.ConcurrencyConflict };
    }

    if (
      (await this.resolveCurrentAuthorization(authorization, input.scope)) ===
      null
    ) {
      return {
        status: StartReviewExecutionStatus.AuthorizationRejected,
        snapshot: prepared,
      };
    }

    if (
      prepared.execution.state !== ReviewExecutionState.Planned ||
      reviewExecutionIsTerminal(prepared.execution.state)
    ) {
      return {
        status: StartReviewExecutionStatus.Restored,
        snapshot: prepared,
      };
    }

    let admissionSnapshot = prepared;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) {
        const reloaded = await this.queries.findExecution(
          prepared.execution.executionId,
        );
        if (reloaded === null) {
          return { status: StartReviewExecutionStatus.ConcurrencyConflict };
        }
        admissionSnapshot = reloaded;
      }
      const postcheck = await this.currentRevision.resolve(input.scope);
      const admissionAuthorization = await this.resolveCurrentAuthorization(
        authorization,
        input.scope,
      );
      if (admissionAuthorization === null) {
        return {
          status: StartReviewExecutionStatus.AuthorizationRejected,
          snapshot: admissionSnapshot,
        };
      }
      const verdict =
        postcheck.status === CurrentReviewRevisionStatus.Unavailable
          ? ReviewExecutionAdmissionVerdict.Unavailable
          : reviewRevisionsEqual(postcheck.revision, authorization.revision)
            ? ReviewExecutionAdmissionVerdict.Current
            : ReviewExecutionAdmissionVerdict.Stale;
      const admission = await this.commands.confirmAdmission({
        scope: input.scope,
        expectedStreamVersion: admissionSnapshot.stream.version,
        executionId: prepared.execution.executionId,
        authorizationId: authorization.authorizationId,
        mutationEpoch: authorization.mutationEpoch,
        requestedRevision: authorization.revision,
        observedRevision:
          postcheck.status === CurrentReviewRevisionStatus.Found
            ? postcheck.revision
            : null,
        verdict,
        checkedAt: admissionAuthorization.observedAt,
      });

      switch (admission.status) {
        case ReviewExecutionAdmissionStatus.Admitted:
          return {
            status: StartReviewExecutionStatus.Admitted,
            snapshot: admission.snapshot,
          };
        case ReviewExecutionAdmissionStatus.Restored:
          return {
            status: StartReviewExecutionStatus.Restored,
            snapshot: admission.snapshot,
          };
        case ReviewExecutionAdmissionStatus.Deferred:
          return {
            status: StartReviewExecutionStatus.AdmissionDeferred,
            snapshot: admission.snapshot,
          };
        case ReviewExecutionAdmissionStatus.Superseded:
          return {
            status: StartReviewExecutionStatus.StaleRevision,
            snapshot: admission.snapshot,
          };
        case ReviewExecutionAdmissionStatus.ConcurrencyConflict:
          continue;
        case ReviewExecutionAdmissionStatus.Missing:
        case ReviewExecutionAdmissionStatus.NotPrepared:
          return { status: StartReviewExecutionStatus.ConcurrencyConflict };
      }
    }
    return { status: StartReviewExecutionStatus.ConcurrencyConflict };
  }

  private async resolveInitialAuthorization(
    authorizationId: string,
    scope: ReviewExecutionScope,
  ): Promise<ReviewExecutionAuthorizationFacts | null> {
    const current = await this.authorizationFacts.find(authorizationId);
    const observedAt = this.clock.now();
    return current !== null &&
      current.active &&
      current.expiresAt > observedAt &&
      scopeKey(current.scope) === scopeKey(scope)
      ? snapshotAuthorizationFacts(current)
      : null;
  }

  private async resolveCurrentAuthorization(
    expected: ReviewExecutionAuthorizationFacts,
    scope: ReviewExecutionScope,
  ): Promise<{
    readonly facts: ReviewExecutionAuthorizationFacts;
    readonly observedAt: Date;
  } | null> {
    const current = await this.authorizationFacts.find(
      expected.authorizationId,
    );
    const observedAt = this.clock.now();
    return current !== null &&
      current.active &&
      current.expiresAt > observedAt &&
      scopeKey(current.scope) === scopeKey(scope) &&
      authorizationFactsEqual(current, expected)
      ? {
          facts: snapshotAuthorizationFacts(current),
          observedAt: new Date(observedAt),
        }
      : null;
  }
}

function snapshotAuthorizationFacts(
  facts: ReviewExecutionAuthorizationFacts,
): ReviewExecutionAuthorizationFacts {
  return {
    ...facts,
    scope: { ...facts.scope },
    revision: { ...facts.revision },
    limits: { ...facts.limits },
    expiresAt: new Date(facts.expiresAt),
  };
}

function authorizationFactsEqual(
  left: ReviewExecutionAuthorizationFacts,
  right: ReviewExecutionAuthorizationFacts,
): boolean {
  return (
    left.authorizationId === right.authorizationId &&
    scopeKey(left.scope) === scopeKey(right.scope) &&
    reviewRevisionsEqual(left.revision, right.revision) &&
    left.producerReleaseId === right.producerReleaseId &&
    left.mutationEpoch === right.mutationEpoch &&
    left.admissionSafetyDecisionHash === right.admissionSafetyDecisionHash &&
    left.expiresAt.getTime() === right.expiresAt.getTime() &&
    limitsEqual(left.limits, right.limits)
  );
}

function limitsEqual(
  left: ReviewExecutionAuthorizationFacts["limits"],
  right: ReviewExecutionAuthorizationFacts["limits"],
): boolean {
  return (
    left.profileId === right.profileId &&
    left.maxWorkSlots === right.maxWorkSlots &&
    left.maxAttemptBudget === right.maxAttemptBudget &&
    left.maxProjectionBytes === right.maxProjectionBytes &&
    left.maxFindingCount === right.maxFindingCount &&
    left.maxLeaseDurationMs === right.maxLeaseDurationMs &&
    left.maxResultReportDurationMs === right.maxResultReportDurationMs
  );
}
