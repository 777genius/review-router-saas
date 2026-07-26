import {
  assertDate,
  assertIdentifier,
  assertSha256,
  reviewRevisionsEqual,
  scopeKey,
  type ReviewExecutionScope,
  type ReviewRevision,
} from "./review-execution";
import {
  assertReviewRequestedIntentCandidate,
  createReviewRequestedIntent,
  ReviewRequestAdmissionState,
  reviewRequestedAdmissionHandoffMinimumMs,
  ReviewRequestedIntentState,
  ReviewRequestedIntentTerminalReason,
  type ReviewRequestedIntent,
  type ReviewRequestedTriggerKind,
} from "./review-requested-intent";

export type ReviewRequestedRerunIntentCandidate = ReviewExecutionScope & {
  readonly predecessorRequestId: string;
  readonly requestId: string;
  readonly revision: ReviewRevision;
  readonly triggerKind: ReviewRequestedTriggerKind;
  readonly deliveryIdentityHash: string;
  readonly canonicalRequestHash: string;
  readonly sourceRunId: string;
  readonly sourceRunAttempt: string;
  readonly changedLines: number;
  readonly maxChangedLines: number;
  readonly policySnapshotId: string;
  readonly admissionDecisionHash: string;
  readonly verdict:
    | ReviewRequestAdmissionState.Admitted
    | ReviewRequestAdmissionState.Rejected;
  readonly createdAt: Date;
  readonly nextResolutionAt: Date;
  readonly resolutionDeadlineAt: Date;
  readonly retainUntil: Date;
};

export enum ReviewRequestedRerunRegistrationDecisionStatus {
  Create = "create",
  Restore = "restore",
  MissingPredecessor = "missing_predecessor",
  Conflict = "conflict",
}

export type ReviewRequestedRerunRegistrationDecision =
  | {
      readonly status: ReviewRequestedRerunRegistrationDecisionStatus.Create;
      readonly intent: ReviewRequestedIntent;
    }
  | {
      readonly status: ReviewRequestedRerunRegistrationDecisionStatus.Restore;
      readonly intent: ReviewRequestedIntent;
    }
  | {
      readonly status: ReviewRequestedRerunRegistrationDecisionStatus.MissingPredecessor;
    }
  | {
      readonly status: ReviewRequestedRerunRegistrationDecisionStatus.Conflict;
    };

export function decideReviewRequestedRerunRegistration(input: {
  readonly candidate: ReviewRequestedRerunIntentCandidate;
  readonly intentsForSourceRun: readonly ReviewRequestedIntent[];
}): ReviewRequestedRerunRegistrationDecision {
  assertReviewRequestedRerunIntentCandidate(input.candidate);
  const currentAttempt = parseReviewRequestedSourceRunAttempt(
    input.candidate.sourceRunAttempt,
  );
  if (currentAttempt <= 1) {
    return {
      status: ReviewRequestedRerunRegistrationDecisionStatus.Conflict,
    };
  }

  const seenAttempts = new Set<number>();
  let exact: ReviewRequestedIntent | null = null;
  let predecessor: ReviewRequestedIntent | null = null;
  let predecessorAttempt = 0;
  for (const intent of input.intentsForSourceRun) {
    if (
      intent.repositoryConnectionId !==
        input.candidate.repositoryConnectionId ||
      intent.sourceRunId !== input.candidate.sourceRunId ||
      intent.sourceRunAttempt === null
    ) {
      throw new Error("review_requested_rerun_source_index_corrupted");
    }
    const attempt = parseReviewRequestedSourceRunAttempt(
      intent.sourceRunAttempt,
    );
    if (seenAttempts.has(attempt)) {
      throw new Error("review_requested_rerun_source_identity_corrupted");
    }
    seenAttempts.add(attempt);
    if (attempt > currentAttempt) {
      return {
        status: ReviewRequestedRerunRegistrationDecisionStatus.Conflict,
      };
    }
    if (attempt === currentAttempt) {
      exact = intent;
    } else if (attempt > predecessorAttempt) {
      predecessor = intent;
      predecessorAttempt = attempt;
    }
  }

  if (exact !== null) {
    return rerunIntentMatchesCandidate(exact, input.candidate)
      ? {
          status: ReviewRequestedRerunRegistrationDecisionStatus.Restore,
          intent: exact,
        }
      : {
          status: ReviewRequestedRerunRegistrationDecisionStatus.Conflict,
        };
  }
  if (predecessor === null) {
    return {
      status: ReviewRequestedRerunRegistrationDecisionStatus.MissingPredecessor,
    };
  }
  if (
    predecessor.requestId !== input.candidate.predecessorRequestId ||
    scopeKey(predecessor) !== scopeKey(input.candidate) ||
    !reviewRevisionsEqual(predecessor.revision, input.candidate.revision) ||
    !reviewRequestedIntentCanSeedRerun(predecessor)
  ) {
    return {
      status: ReviewRequestedRerunRegistrationDecisionStatus.Conflict,
    };
  }
  return {
    status: ReviewRequestedRerunRegistrationDecisionStatus.Create,
    intent: createReviewRequestedRerunIntent(input.candidate),
  };
}

function createReviewRequestedRerunIntent(
  candidate: ReviewRequestedRerunIntentCandidate,
): ReviewRequestedIntent {
  const intent = createReviewRequestedIntent({
    workspaceId: candidate.workspaceId,
    repositoryConnectionId: candidate.repositoryConnectionId,
    scmRepositoryIdentityId: candidate.scmRepositoryIdentityId,
    pullRequestNumber: candidate.pullRequestNumber,
    requestId: candidate.requestId,
    revision: candidate.revision,
    triggerKind: candidate.triggerKind,
    deliveryIdentityHash: candidate.deliveryIdentityHash,
    canonicalRequestHash: candidate.canonicalRequestHash,
    notBefore: candidate.createdAt,
    createdAt: candidate.createdAt,
    retainUntil: candidate.retainUntil,
  });
  const admitted = candidate.verdict === ReviewRequestAdmissionState.Admitted;
  return {
    ...intent,
    state: admitted
      ? ReviewRequestedIntentState.AwaitingAuthorization
      : ReviewRequestedIntentState.Terminal,
    submissionStartedAt: new Date(candidate.createdAt),
    nextResolutionAt: admitted ? new Date(candidate.nextResolutionAt) : null,
    resolutionDeadlineAt: admitted
      ? new Date(candidate.resolutionDeadlineAt)
      : null,
    sourceRunId: candidate.sourceRunId,
    sourceRunAttempt: candidate.sourceRunAttempt,
    terminalReason: admitted
      ? null
      : ReviewRequestedIntentTerminalReason.MaxChangedLinesExceeded,
    admission: {
      state: candidate.verdict,
      changedLines: candidate.changedLines,
      maxChangedLines: candidate.maxChangedLines,
      policySnapshotId: candidate.policySnapshotId,
      decisionHash: candidate.admissionDecisionHash,
      checkedAt: new Date(candidate.createdAt),
    },
    rerunPredecessorRequestId: candidate.predecessorRequestId,
  };
}

function assertReviewRequestedRerunIntentCandidate(
  candidate: ReviewRequestedRerunIntentCandidate,
): void {
  assertReviewRequestedIntentCandidate({
    ...candidate,
    notBefore: candidate.createdAt,
  });
  assertIdentifier(candidate.predecessorRequestId, "rerun_predecessor_id");
  assertIdentifier(candidate.sourceRunId, "source_run_id");
  parseReviewRequestedSourceRunAttempt(candidate.sourceRunAttempt);
  assertNonNegativeSafeInteger(
    candidate.changedLines,
    "review_request_admission_changed_lines",
  );
  if (
    !Number.isSafeInteger(candidate.maxChangedLines) ||
    candidate.maxChangedLines < 1
  ) {
    throw new Error("review_request_admission_max_changed_lines_invalid");
  }
  assertIdentifier(
    candidate.policySnapshotId,
    "review_request_admission_policy_snapshot_id",
  );
  assertSha256(
    candidate.admissionDecisionHash,
    "review_request_admission_decision_hash",
  );
  const expectedVerdict =
    candidate.changedLines > candidate.maxChangedLines
      ? ReviewRequestAdmissionState.Rejected
      : ReviewRequestAdmissionState.Admitted;
  if (candidate.verdict !== expectedVerdict) {
    throw new Error("review_request_admission_verdict_invalid");
  }
  assertDate(candidate.nextResolutionAt, "rerun_next_resolution_at");
  assertDate(candidate.resolutionDeadlineAt, "rerun_resolution_deadline_at");
  if (
    candidate.verdict === ReviewRequestAdmissionState.Admitted &&
    (candidate.nextResolutionAt < candidate.createdAt ||
      candidate.resolutionDeadlineAt.getTime() - candidate.createdAt.getTime() <
        reviewRequestedAdmissionHandoffMinimumMs ||
      candidate.nextResolutionAt > candidate.resolutionDeadlineAt)
  ) {
    throw new Error("review_requested_rerun_resolution_window_invalid");
  }
}

function reviewRequestedIntentCanSeedRerun(
  intent: ReviewRequestedIntent,
): boolean {
  if (intent.state === ReviewRequestedIntentState.Superseded) return false;
  if (intent.sourceRunId === null || intent.sourceRunAttempt === null) {
    return false;
  }
  if (intent.state === ReviewRequestedIntentState.Dispatched) {
    return (
      intent.admission.state === ReviewRequestAdmissionState.Admitted &&
      intent.authorizationId !== null &&
      intent.executionId !== null
    );
  }
  if (intent.state === ReviewRequestedIntentState.AwaitingAuthorization) {
    return (
      intent.admission.state === ReviewRequestAdmissionState.Admitted &&
      intent.authorizationId === null &&
      intent.executionId === null
    );
  }
  return intent.state === ReviewRequestedIntentState.Terminal;
}

function rerunIntentMatchesCandidate(
  intent: ReviewRequestedIntent,
  candidate: ReviewRequestedRerunIntentCandidate,
): boolean {
  return (
    intent.requestId === candidate.requestId &&
    intent.deliveryIdentityHash === candidate.deliveryIdentityHash &&
    intent.canonicalRequestHash === candidate.canonicalRequestHash &&
    intent.rerunPredecessorRequestId === candidate.predecessorRequestId &&
    intent.sourceRunId === candidate.sourceRunId &&
    intent.sourceRunAttempt === candidate.sourceRunAttempt &&
    scopeKey(intent) === scopeKey(candidate) &&
    reviewRevisionsEqual(intent.revision, candidate.revision) &&
    intent.admission.state === candidate.verdict &&
    intent.admission.changedLines === candidate.changedLines &&
    intent.admission.maxChangedLines === candidate.maxChangedLines &&
    intent.admission.policySnapshotId === candidate.policySnapshotId &&
    intent.admission.decisionHash === candidate.admissionDecisionHash
  );
}

export function parseReviewRequestedSourceRunAttempt(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error("review_requested_source_run_attempt_invalid");
  }
  const attempt = Number(value);
  if (!Number.isSafeInteger(attempt)) {
    throw new Error("review_requested_source_run_attempt_invalid");
  }
  return attempt;
}

function assertNonNegativeSafeInteger(value: number, error: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(error);
}
