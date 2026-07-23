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
import { ReviewRequestedIntentState } from "../../domain/review-requested-intent";
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
import {
  ReviewRequestedTransitionStatus,
  type ReviewRequestedIntentCommandPort,
  type ReviewRequestedIntentQueryPort,
} from "../ports/review-requested-intent-ports";

export enum StartReviewExecutionStatus {
  Admitted = "admitted",
  Restored = "restored",
  AdmissionDeferred = "admission_deferred",
  StaleRevision = "stale_revision",
  AuthorizationRejected = "authorization_rejected",
  IdempotencyConflict = "idempotency_conflict",
  ConcurrencyConflict = "concurrency_conflict",
  RequestIntentMissing = "request_intent_missing",
  RequestIntentConflict = "request_intent_conflict",
}

enum RequestedIntentResolutionStatus {
  NotRequired = "not_required",
  Resolved = "resolved",
  Missing = "missing",
  Conflict = "conflict",
}

type RequestedIntentResolution =
  | { readonly status: RequestedIntentResolutionStatus.NotRequired }
  | {
      readonly status: RequestedIntentResolutionStatus.Resolved;
      readonly requestId: string;
    }
  | {
      readonly status:
        | RequestedIntentResolutionStatus.Missing
        | RequestedIntentResolutionStatus.Conflict;
    };

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
    private readonly requestedIntentAdmission?: Readonly<{
      queries: ReviewRequestedIntentQueryPort;
      commands: ReviewRequestedIntentCommandPort;
      required: boolean;
    }>,
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

    const requestedIntentResolution = await this.resolveRequestedIntent(
      input,
      authorization,
    );
    if (
      requestedIntentResolution.status ===
      RequestedIntentResolutionStatus.Missing
    ) {
      return { status: StartReviewExecutionStatus.RequestIntentMissing };
    }
    if (
      requestedIntentResolution.status ===
      RequestedIntentResolutionStatus.Conflict
    ) {
      return { status: StartReviewExecutionStatus.RequestIntentConflict };
    }
    const requestedIntent =
      requestedIntentResolution.status ===
      RequestedIntentResolutionStatus.Resolved
        ? requestedIntentResolution.requestId
        : null;

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
      if (
        requestedIntent !== null &&
        (await this.linkRequestedIntent(
          requestedIntent,
          input,
          authorization,
        )) === "conflict"
      ) {
        await this.compensateIntentConflict(prepared, authorization.revision);
        return {
          status: StartReviewExecutionStatus.RequestIntentConflict,
          snapshot: prepared,
        };
      }
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
          if (
            requestedIntent !== null &&
            (await this.linkRequestedIntent(
              requestedIntent,
              input,
              authorization,
            )) === "conflict"
          ) {
            await this.compensateIntentConflict(
              admission.snapshot ?? admissionSnapshot,
              postcheck.status === CurrentReviewRevisionStatus.Found
                ? postcheck.revision
                : authorization.revision,
            );
            return {
              status: StartReviewExecutionStatus.RequestIntentConflict,
              snapshot: admission.snapshot,
            };
          }
          return {
            status: StartReviewExecutionStatus.Admitted,
            snapshot: admission.snapshot,
          };
        case ReviewExecutionAdmissionStatus.Restored:
          if (
            requestedIntent !== null &&
            (await this.linkRequestedIntent(
              requestedIntent,
              input,
              authorization,
            )) === "conflict"
          ) {
            await this.compensateIntentConflict(
              admission.snapshot ?? admissionSnapshot,
              postcheck.status === CurrentReviewRevisionStatus.Found
                ? postcheck.revision
                : authorization.revision,
            );
            return {
              status: StartReviewExecutionStatus.RequestIntentConflict,
              snapshot: admission.snapshot,
            };
          }
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

  private async resolveRequestedIntent(
    input: StartReviewExecutionInput,
    authorization: ReviewExecutionAuthorizationFacts,
  ): Promise<RequestedIntentResolution> {
    const admission = this.requestedIntentAdmission;
    if (!admission) {
      return { status: RequestedIntentResolutionStatus.NotRequired };
    }
    const intent = await admission.queries.findBySourceRunIdentity({
      ...input.scope,
      sourceRunId: input.sourceRunId,
      sourceRunAttempt: input.sourceRunAttempt,
    });
    if (!intent) {
      return {
        status: admission.required
          ? RequestedIntentResolutionStatus.Missing
          : RequestedIntentResolutionStatus.NotRequired,
      };
    }
    return intent.state === ReviewRequestedIntentState.AwaitingAuthorization &&
      reviewRevisionsEqual(intent.revision, authorization.revision)
      ? {
          status: RequestedIntentResolutionStatus.Resolved,
          requestId: intent.requestId,
        }
      : { status: RequestedIntentResolutionStatus.Conflict };
  }

  private async linkRequestedIntent(
    requestId: string,
    input: StartReviewExecutionInput,
    authorization: ReviewExecutionAuthorizationFacts,
  ): Promise<"linked" | "conflict"> {
    const admission = this.requestedIntentAdmission;
    if (!admission) return "linked";
    const linked = await admission.commands.linkAdmission({
      requestId,
      sourceRunId: input.sourceRunId,
      sourceRunAttempt: input.sourceRunAttempt,
      authorizationId: input.authorizationId,
      executionId: input.executionId,
      revision: authorization.revision,
      now: this.clock.now(),
    });
    return linked.status === ReviewRequestedTransitionStatus.Applied ||
      linked.status === ReviewRequestedTransitionStatus.Restored
      ? "linked"
      : "conflict";
  }

  private async compensateIntentConflict(
    snapshot: ReviewExecutionSnapshot,
    observedCurrentRevision: ReviewExecutionAuthorizationFacts["revision"],
  ): Promise<void> {
    await this.commands.supersedeExecution({
      scope: snapshot.execution,
      executionId: snapshot.execution.executionId,
      expectedStreamVersion: snapshot.stream.version,
      observedCurrentRevision,
      now: this.clock.now(),
    });
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
