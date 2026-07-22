import {
  ReviewCoverageState,
  ReviewExecutionState,
  ReviewInvocationLeasePurpose,
  ReviewInvocationLeaseState,
  ReviewObservationAttachmentKind,
  ReviewWorkSlotState,
  assertDate,
  assertFinalizationEnvelope,
  assertIdentifier,
  assertReviewExecutionLimits,
  assertReviewExecutionScope,
  assertReviewRevision,
  assertSha256,
  deriveCoverageState,
  prepareWorkSlots,
  reviewExecutionIsTerminal,
  reviewRevisionsEqual,
  scopeKey,
  type FinalizedReviewProjectionArtifact,
  type PublicationPermit,
  type ReviewExecution,
  type ReviewExecutionLimits,
  type ReviewExecutionObservationRef,
  type ReviewExecutionScope,
  type ReviewExecutionStream,
  type ReviewInvocationLease,
  type ReviewRevision,
  type ReviewWorkSlot,
  type ReviewWorkSlotPlan,
} from "./review-execution";

export enum ExecutionPreparationReplayDecisionStatus {
  Proceed = "proceed",
  Restored = "restored",
  IdempotencyConflict = "idempotency_conflict",
}

export type ExecutionPreparationReplayDecision =
  | {
      readonly status: ExecutionPreparationReplayDecisionStatus.Proceed;
    }
  | {
      readonly status: ExecutionPreparationReplayDecisionStatus.Restored;
      readonly execution: ReviewExecution;
    }
  | {
      readonly status: ExecutionPreparationReplayDecisionStatus.IdempotencyConflict;
    };

export function decideExecutionPreparationReplay(input: {
  readonly existingByStartIdentity: ReviewExecution | null;
  readonly canonicalStartHash: string;
}): ExecutionPreparationReplayDecision {
  assertSha256(input.canonicalStartHash, "canonical_start_hash");
  if (input.existingByStartIdentity === null) {
    return { status: ExecutionPreparationReplayDecisionStatus.Proceed };
  }
  return input.existingByStartIdentity.canonicalStartHash ===
    input.canonicalStartHash
    ? {
        status: ExecutionPreparationReplayDecisionStatus.Restored,
        execution: input.existingByStartIdentity,
      }
    : {
        status: ExecutionPreparationReplayDecisionStatus.IdempotencyConflict,
      };
}

export enum ExecutionPrepareDecisionStatus {
  Prepared = "prepared",
}

export type ExecutionPrepareDecision = {
  readonly status: ExecutionPrepareDecisionStatus.Prepared;
  readonly stream: ReviewExecutionStream;
  readonly execution: ReviewExecution;
  readonly supersededPrepared: ReviewExecution | null;
};

export type PrepareExecutionTransitionInput = {
  readonly stream: ReviewExecutionStream;
  readonly priorPrepared: ReviewExecution | null;
  readonly scope: ReviewExecutionScope;
  readonly executionId: string;
  readonly authorizationId: string;
  readonly producerReleaseId: string;
  readonly mutationEpoch: bigint;
  readonly revision: ReviewRevision;
  readonly startIdentityHash: string;
  readonly canonicalStartHash: string;
  readonly admissionSafetyDecisionHash: string;
  readonly compatibilityKey: string;
  readonly planHash: string;
  readonly workSlots: readonly ReviewWorkSlotPlan[];
  readonly limits: ReviewExecutionLimits;
  readonly sourceRunId: string;
  readonly sourceRunAttempt: string;
  readonly now: Date;
  readonly admissionDeadlineAt: Date;
  readonly executionDeadlineAt: Date;
  readonly retainUntil: Date;
};

export function decideExecutionPreparation(
  input: PrepareExecutionTransitionInput,
): ExecutionPrepareDecision {
  assertPrepareInput(input);
  const generation = input.stream.lastAllocatedGeneration + 1n;
  const execution: ReviewExecution = {
    ...input.scope,
    executionId: input.executionId,
    version: 1n,
    generation,
    revision: { ...input.revision },
    authorizationId: input.authorizationId,
    producerReleaseId: input.producerReleaseId,
    mutationEpoch: input.mutationEpoch,
    startIdentityHash: input.startIdentityHash,
    canonicalStartHash: input.canonicalStartHash,
    admissionSafetyDecisionHash: input.admissionSafetyDecisionHash,
    state: ReviewExecutionState.Planned,
    compatibilityKey: input.compatibilityKey,
    planHash: input.planHash,
    protocolLimitsProfileId: input.limits.profileId,
    sourceRunId: input.sourceRunId,
    sourceRunAttempt: input.sourceRunAttempt,
    workSlots: prepareWorkSlots(input.workSlots, input.limits),
    finalizedArtifactId: null,
    supersededByExecutionId: null,
    createdAt: new Date(input.now),
    updatedAt: new Date(input.now),
    admissionDeadlineAt: new Date(input.admissionDeadlineAt),
    admissionCheckedAt: null,
    executionDeadlineAt: new Date(input.executionDeadlineAt),
    retainUntil: new Date(input.retainUntil),
  };
  return {
    status: ExecutionPrepareDecisionStatus.Prepared,
    execution,
    supersededPrepared:
      input.priorPrepared?.state === ReviewExecutionState.Planned
        ? transitionExecutionToSuperseded(
            input.priorPrepared,
            execution.executionId,
            input.now,
          )
        : null,
    stream: {
      ...input.stream,
      version: input.stream.version + 1n,
      preparedExecutionId: execution.executionId,
      lastAllocatedGeneration: generation,
      updatedAt: new Date(input.now),
    },
  };
}

export enum ExecutionAdmissionDecisionStatus {
  Admitted = "admitted",
  Restored = "restored",
  Superseded = "superseded",
  Deferred = "deferred",
  NotPrepared = "not_prepared",
}

export enum ExecutionAdmissionVerdict {
  Current = "current",
  Stale = "stale",
  Unavailable = "unavailable",
}

export type ExecutionAdmissionDecision = {
  readonly status: ExecutionAdmissionDecisionStatus;
  readonly stream: ReviewExecutionStream;
  readonly execution: ReviewExecution;
  readonly supersededPriorActive: ReviewExecution | null;
  readonly revokedPriorLeases: readonly ReviewInvocationLease[];
};

export function decideExecutionAdmission(input: {
  readonly stream: ReviewExecutionStream;
  readonly execution: ReviewExecution;
  readonly priorActive: ReviewExecution | null;
  readonly priorActiveLeases: readonly ReviewInvocationLease[];
  readonly authorizationId: string;
  readonly mutationEpoch: bigint;
  readonly requestedRevision: ReviewRevision;
  readonly observedRevision: ReviewRevision | null;
  readonly verdict: ExecutionAdmissionVerdict;
  readonly checkedAt: Date;
}): ExecutionAdmissionDecision {
  assertSameScope(input.stream, input.execution, "admission_execution");
  if (input.priorActive !== null) {
    assertSameScope(input.execution, input.priorActive, "admission_prior");
  }
  assertDate(input.checkedAt, "admission_checked_at");
  assertIdentifier(input.authorizationId, "authorization_id");
  if (input.mutationEpoch <= 0n) {
    throw new Error("review_execution_invalid_mutation_epoch");
  }
  assertReviewRevision(input.requestedRevision);
  if (input.observedRevision !== null) {
    assertReviewRevision(input.observedRevision);
  }
  const identityMatches =
    input.execution.authorizationId === input.authorizationId &&
    input.execution.mutationEpoch === input.mutationEpoch &&
    reviewRevisionsEqual(input.execution.revision, input.requestedRevision);
  if (
    input.execution.state === ReviewExecutionState.Running &&
    input.stream.activeExecutionId === input.execution.executionId
  ) {
    return unchangedAdmission(
      identityMatches
        ? ExecutionAdmissionDecisionStatus.Restored
        : ExecutionAdmissionDecisionStatus.NotPrepared,
      input,
    );
  }
  if (
    input.execution.state === ReviewExecutionState.Superseded &&
    input.verdict === ExecutionAdmissionVerdict.Stale &&
    identityMatches
  ) {
    return unchangedAdmission(
      ExecutionAdmissionDecisionStatus.Superseded,
      input,
    );
  }
  if (
    input.execution.state !== ReviewExecutionState.Planned ||
    input.stream.preparedExecutionId !== input.execution.executionId ||
    !identityMatches
  ) {
    return unchangedAdmission(
      ExecutionAdmissionDecisionStatus.NotPrepared,
      input,
    );
  }
  if (input.verdict === ExecutionAdmissionVerdict.Unavailable) {
    return unchangedAdmission(ExecutionAdmissionDecisionStatus.Deferred, input);
  }
  if (
    input.verdict === ExecutionAdmissionVerdict.Stale ||
    input.observedRevision === null ||
    !reviewRevisionsEqual(input.observedRevision, input.execution.revision)
  ) {
    return {
      status: ExecutionAdmissionDecisionStatus.Superseded,
      execution: transitionExecutionToSuperseded(
        input.execution,
        null,
        input.checkedAt,
      ),
      stream: {
        ...input.stream,
        version: input.stream.version + 1n,
        preparedExecutionId: null,
        updatedAt: new Date(input.checkedAt),
      },
      supersededPriorActive: null,
      revokedPriorLeases: [],
    };
  }
  const prior = input.priorActive;
  const supersededPriorActive =
    prior !== null &&
    prior.executionId !== input.execution.executionId &&
    !reviewExecutionIsTerminal(prior.state)
      ? transitionExecutionToSuperseded(
          prior,
          input.execution.executionId,
          input.checkedAt,
        )
      : null;
  const revokedPriorLeases =
    supersededPriorActive === null
      ? []
      : revokeActiveLeases(
          input.priorActiveLeases,
          supersededPriorActive.executionId,
        );
  return {
    status: ExecutionAdmissionDecisionStatus.Admitted,
    execution: {
      ...input.execution,
      version: input.execution.version + 1n,
      state: ReviewExecutionState.Running,
      admissionCheckedAt: new Date(input.checkedAt),
      updatedAt: new Date(input.checkedAt),
    },
    stream: {
      ...input.stream,
      version: input.stream.version + 1n,
      activeExecutionId: input.execution.executionId,
      preparedExecutionId: null,
      currentRevision: { ...input.execution.revision },
      updatedAt: new Date(input.checkedAt),
    },
    supersededPriorActive,
    revokedPriorLeases,
  };
}

export enum LeaseAcquireReplayDecisionStatus {
  Proceed = "proceed",
  Restored = "restored",
  IdempotencyConflict = "idempotency_conflict",
}

export type LeaseAcquireReplayDecision =
  | {
      readonly status: LeaseAcquireReplayDecisionStatus.Proceed;
    }
  | {
      readonly status: LeaseAcquireReplayDecisionStatus.Restored;
      readonly lease: ReviewInvocationLease;
    }
  | {
      readonly status: LeaseAcquireReplayDecisionStatus.IdempotencyConflict;
    };

export function decideLeaseAcquireReplay(input: {
  readonly existingByAcquireIdentity: ReviewInvocationLease | null;
  readonly scope: ReviewExecutionScope;
  readonly executionId: string;
  readonly acquireRequestIdHash: string;
  readonly acquireRequestHash: string;
  readonly ownerIdHash: string;
  readonly providerInvocationKey: string;
  readonly preparedManifestCanonicalJson: string | null;
  readonly preparedManifestKey: string | null;
  readonly providerVoteIdentityHash: string;
  readonly workSlotId: string;
  readonly purpose: ReviewInvocationLeasePurpose;
}): LeaseAcquireReplayDecision {
  assertReviewExecutionScope(input.scope);
  assertIdentifier(input.executionId, "execution_id");
  assertSha256(input.acquireRequestIdHash, "acquire_request_id_hash");
  assertSha256(input.acquireRequestHash, "acquire_request_hash");
  assertIdentifier(input.ownerIdHash, "owner_id_hash");
  assertSha256(input.providerInvocationKey, "provider_invocation_key");
  assertIdentifier(input.workSlotId, "work_slot_id");
  const lease = input.existingByAcquireIdentity;
  if (lease === null) {
    return { status: LeaseAcquireReplayDecisionStatus.Proceed };
  }
  return scopeKey(lease) === scopeKey(input.scope) &&
    lease.executionId === input.executionId &&
    lease.acquireRequestIdHash === input.acquireRequestIdHash &&
    lease.acquireRequestHash === input.acquireRequestHash &&
    lease.ownerIdHash === input.ownerIdHash &&
    lease.providerInvocationKey === input.providerInvocationKey &&
    lease.preparedManifestCanonicalJson ===
      input.preparedManifestCanonicalJson &&
    lease.preparedManifestKey === input.preparedManifestKey &&
    lease.providerVoteIdentityHash === input.providerVoteIdentityHash &&
    lease.workSlotId === input.workSlotId &&
    lease.purpose === input.purpose
    ? { status: LeaseAcquireReplayDecisionStatus.Restored, lease }
    : { status: LeaseAcquireReplayDecisionStatus.IdempotencyConflict };
}

export enum LeaseAcquireDecisionStatus {
  Acquired = "acquired",
  Busy = "busy",
  AttemptBudgetExhausted = "attempt_budget_exhausted",
  NotRunnable = "not_runnable",
  MissingSlot = "missing_slot",
}

export type LeaseAcquireDecision =
  | {
      readonly status: LeaseAcquireDecisionStatus.Acquired;
      readonly execution: ReviewExecution;
      readonly lease: ReviewInvocationLease;
      readonly expiredLease: ReviewInvocationLease | null;
    }
  | {
      readonly status: LeaseAcquireDecisionStatus.AttemptBudgetExhausted;
      readonly execution: ReviewExecution;
      readonly expiredLease: ReviewInvocationLease | null;
    }
  | {
      readonly status: LeaseAcquireDecisionStatus.Busy;
    }
  | {
      readonly status: LeaseAcquireDecisionStatus.NotRunnable;
    }
  | {
      readonly status: LeaseAcquireDecisionStatus.MissingSlot;
    };

export type LeaseAcquireTransitionInput = {
  readonly stream: ReviewExecutionStream;
  readonly execution: ReviewExecution;
  readonly activeLease: ReviewInvocationLease | null;
  readonly fencingToken: bigint;
  readonly scope: ReviewExecutionScope;
  readonly workSlotId: string;
  readonly purpose: ReviewInvocationLeasePurpose;
  readonly providerInvocationKey: string;
  readonly preparedManifestCanonicalJson: string | null;
  readonly preparedManifestKey: string | null;
  readonly providerVoteIdentityHash: string;
  readonly leaseId: string;
  readonly attemptId: string | null;
  readonly sourceObservationId: string | null;
  readonly acquireRequestIdHash: string;
  readonly acquireRequestHash: string;
  readonly ownerIdHash: string;
  readonly leaseCapabilityId: string;
  readonly capabilitySigningKeyId: string;
  readonly leaseSafetyDecisionHash: string;
  readonly now: Date;
  readonly expiresAt: Date;
  readonly resultReportUntil: Date;
  readonly retainUntil: Date;
  readonly limits: ReviewExecutionLimits;
};

export function decideLeaseAcquire(
  input: LeaseAcquireTransitionInput,
): LeaseAcquireDecision {
  assertLeaseAcquireInput(input);
  assertSameScope(input.stream, input.execution, "lease_execution");
  assertSameScope(input.execution, input.scope, "lease_command");
  if (
    input.stream.activeExecutionId !== input.execution.executionId ||
    input.execution.state !== ReviewExecutionState.Running
  ) {
    return { status: LeaseAcquireDecisionStatus.NotRunnable };
  }
  const slot = input.execution.workSlots.find(
    (candidate) => candidate.workSlotId === input.workSlotId,
  );
  if (!slot) {
    return { status: LeaseAcquireDecisionStatus.MissingSlot };
  }
  if (
    slot.state === ReviewWorkSlotState.Satisfied ||
    slot.state === ReviewWorkSlotState.Cancelled ||
    slot.state === ReviewWorkSlotState.Exhausted
  ) {
    return { status: LeaseAcquireDecisionStatus.NotRunnable };
  }
  let currentSlot = slot;
  let expiredLease: ReviewInvocationLease | null = null;
  if (slot.activeLeaseId !== null) {
    const active = input.activeLease;
    if (!active || active.leaseId !== slot.activeLeaseId) {
      throw new Error("review_execution_active_lease_reference_corrupted");
    }
    if (
      active.executionId !== input.execution.executionId ||
      active.workSlotId !== slot.workSlotId ||
      scopeKey(active) !== scopeKey(input.execution)
    ) {
      throw new Error("review_execution_active_lease_aggregate_mismatch");
    }
    if (
      active.state === ReviewInvocationLeaseState.Active &&
      active.expiresAt > input.now
    ) {
      return { status: LeaseAcquireDecisionStatus.Busy };
    }
    expiredLease =
      active.state === ReviewInvocationLeaseState.Active
        ? { ...active, state: ReviewInvocationLeaseState.Expired }
        : null;
    currentSlot = { ...slot, activeLeaseId: null };
  }
  if (
    input.purpose === ReviewInvocationLeasePurpose.ProviderExecution &&
    currentSlot.nextAttemptOrdinal > currentSlot.attemptBudget
  ) {
    return {
      status: LeaseAcquireDecisionStatus.AttemptBudgetExhausted,
      execution: replaceExecutionSlot(
        input.execution,
        { ...currentSlot, state: ReviewWorkSlotState.Exhausted },
        input.now,
      ),
      expiredLease,
    };
  }
  const attemptOrdinal =
    input.purpose === ReviewInvocationLeasePurpose.ProviderExecution
      ? currentSlot.nextAttemptOrdinal
      : Math.max(0, currentSlot.nextAttemptOrdinal - 1);
  const lease: ReviewInvocationLease = {
    ...input.scope,
    providerInvocationKey: input.providerInvocationKey,
    preparedManifestCanonicalJson: input.preparedManifestCanonicalJson,
    preparedManifestKey: input.preparedManifestKey,
    providerVoteIdentityHash: input.providerVoteIdentityHash,
    workSlotId: input.workSlotId,
    leaseId: input.leaseId,
    purpose: input.purpose,
    authorizationId: input.execution.authorizationId,
    producerReleaseId: input.execution.producerReleaseId,
    reviewRevisionHash: input.execution.revision.reviewRevisionHash,
    mutationEpoch: input.execution.mutationEpoch,
    leaseSafetyDecisionHash: input.leaseSafetyDecisionHash,
    attemptId: input.attemptId,
    sourceObservationId: input.sourceObservationId,
    attemptOrdinal,
    acquireRequestIdHash: input.acquireRequestIdHash,
    acquireRequestHash: input.acquireRequestHash,
    ownerIdHash: input.ownerIdHash,
    leaseCapabilityId: input.leaseCapabilityId,
    capabilitySigningKeyId: input.capabilitySigningKeyId,
    fencingToken: input.fencingToken,
    executionId: input.execution.executionId,
    executionGeneration: input.execution.generation,
    state: ReviewInvocationLeaseState.Active,
    acquiredAt: new Date(input.now),
    renewedAt: new Date(input.now),
    expiresAt: new Date(input.expiresAt),
    resultReportUntil: new Date(input.resultReportUntil),
    retainUntil: new Date(input.retainUntil),
  };
  return {
    status: LeaseAcquireDecisionStatus.Acquired,
    lease,
    expiredLease,
    execution: replaceExecutionSlot(
      input.execution,
      {
        ...currentSlot,
        state: ReviewWorkSlotState.Leased,
        activeLeaseId: lease.leaseId,
        nextAttemptOrdinal:
          input.purpose === ReviewInvocationLeasePurpose.ProviderExecution
            ? currentSlot.nextAttemptOrdinal + 1
            : currentSlot.nextAttemptOrdinal,
      },
      input.now,
    ),
  };
}

export enum LeaseTransitionDecisionStatus {
  Applied = "applied",
  Restored = "restored",
  StaleTerm = "stale_term",
  Expired = "expired",
  InvalidDeadline = "invalid_deadline",
}

export type LeaseTransitionDecision = {
  readonly status: LeaseTransitionDecisionStatus;
  readonly lease: ReviewInvocationLease;
  readonly execution: ReviewExecution | null;
};

export function decideLeaseRenewal(input: {
  readonly lease: ReviewInvocationLease;
  readonly execution: ReviewExecution | null;
  readonly ownerIdHash: string;
  readonly leaseCapabilityId: string;
  readonly fencingToken: bigint;
  readonly now: Date;
  readonly expiresAt: Date;
  readonly resultReportUntil: Date;
  readonly limits: ReviewExecutionLimits;
}): LeaseTransitionDecision {
  assertDate(input.now, "now");
  assertDate(input.expiresAt, "lease_expires_at");
  assertDate(input.resultReportUntil, "result_report_until");
  assertReviewExecutionLimits(input.limits);
  assertLeaseExecutionRelation(input.lease, input.execution);
  if (!leaseTermMatches(input.lease, input)) {
    return unchangedLease(LeaseTransitionDecisionStatus.StaleTerm, input);
  }
  if (
    input.lease.state !== ReviewInvocationLeaseState.Active ||
    input.lease.expiresAt <= input.now
  ) {
    return expireLeaseDecision(input);
  }
  if (
    input.lease.expiresAt.getTime() === input.expiresAt.getTime() &&
    input.lease.resultReportUntil.getTime() ===
      input.resultReportUntil.getTime()
  ) {
    return unchangedLease(LeaseTransitionDecisionStatus.Restored, input);
  }
  if (!validLeaseDeadlines(input, input.limits)) {
    return unchangedLease(LeaseTransitionDecisionStatus.InvalidDeadline, input);
  }
  return {
    status: LeaseTransitionDecisionStatus.Applied,
    lease: {
      ...input.lease,
      renewedAt: new Date(input.now),
      expiresAt: new Date(input.expiresAt),
      resultReportUntil: new Date(input.resultReportUntil),
    },
    execution: input.execution,
  };
}

export function decideLeaseRelease(input: {
  readonly lease: ReviewInvocationLease;
  readonly execution: ReviewExecution | null;
  readonly ownerIdHash: string;
  readonly leaseCapabilityId: string;
  readonly fencingToken: bigint;
  readonly now: Date;
}): LeaseTransitionDecision {
  assertDate(input.now, "now");
  assertLeaseExecutionRelation(input.lease, input.execution);
  if (!leaseTermMatches(input.lease, input)) {
    return unchangedLease(LeaseTransitionDecisionStatus.StaleTerm, input);
  }
  if (input.lease.state === ReviewInvocationLeaseState.Released) {
    return unchangedLease(LeaseTransitionDecisionStatus.Restored, input);
  }
  if (
    input.lease.state === ReviewInvocationLeaseState.Active &&
    input.lease.expiresAt <= input.now
  ) {
    return expireLeaseDecision(input);
  }
  if (input.lease.state !== ReviewInvocationLeaseState.Active) {
    return unchangedLease(LeaseTransitionDecisionStatus.StaleTerm, input);
  }
  return {
    status: LeaseTransitionDecisionStatus.Applied,
    lease: { ...input.lease, state: ReviewInvocationLeaseState.Released },
    execution: clearLeaseFromExecution(input.execution, input.lease, input.now),
  };
}

export enum ObservationAttachmentDecisionStatus {
  Attached = "attached",
  Restored = "restored",
  Conflict = "conflict",
  NotRunnable = "not_runnable",
  StaleLease = "stale_lease",
  Ineligible = "ineligible",
}

export type ObservationAttachmentDecision =
  | {
      readonly status: ObservationAttachmentDecisionStatus.Attached;
      readonly execution: ReviewExecution;
      readonly observationRef: ReviewExecutionObservationRef;
      readonly lease: ReviewInvocationLease | null;
    }
  | {
      readonly status: ObservationAttachmentDecisionStatus.Restored;
      readonly observationRef: ReviewExecutionObservationRef;
    }
  | {
      readonly status:
        | ObservationAttachmentDecisionStatus.Conflict
        | ObservationAttachmentDecisionStatus.NotRunnable
        | ObservationAttachmentDecisionStatus.StaleLease
        | ObservationAttachmentDecisionStatus.Ineligible;
    };

export type ObservationFacts = {
  readonly observationRefId: string;
  readonly observationId: string;
  readonly executionId: string;
  readonly workSlotId: string;
  readonly providerInvocationKey: string;
  readonly providerVoteIdentityHash: string;
  readonly payloadHash: string;
  readonly byteCount: number;
  readonly findingCount: number;
  readonly eligibilityPolicyVersion: string;
  readonly now: Date;
};

type ObservationAttachmentIdentity = {
  readonly sourceExecutionId: string;
  readonly attachmentKind: ReviewObservationAttachmentKind;
  readonly reuseSafetyDecisionHash: string | null;
  readonly sourceLeaseId: string | null;
  readonly sourceFencingToken: bigint | null;
};

export function decideFreshObservationAttachment(input: {
  readonly stream: ReviewExecutionStream;
  readonly execution: ReviewExecution;
  readonly slot: ReviewWorkSlot;
  readonly existingRefForSlot: ReviewExecutionObservationRef | null;
  readonly existingRefByIdentity: ReviewExecutionObservationRef | null;
  readonly lease: ReviewInvocationLease | null;
  readonly term: {
    readonly leaseId: string;
    readonly ownerIdHash: string;
    readonly leaseCapabilityId: string;
    readonly fencingToken: bigint;
  };
  readonly facts: ObservationFacts;
}): ObservationAttachmentDecision {
  assertObservationFacts(input.facts);
  assertObservationTarget(input.stream, input.execution, input.slot);
  const restored = decideExistingObservation(
    input.existingRefForSlot,
    input.existingRefByIdentity,
    input.facts,
    {
      sourceExecutionId: input.facts.executionId,
      attachmentKind: ReviewObservationAttachmentKind.FreshLease,
      reuseSafetyDecisionHash: null,
      sourceLeaseId: input.term.leaseId,
      sourceFencingToken: input.term.fencingToken,
    },
  );
  if (restored !== null) return restored;
  if (!isCurrentRunning(input.stream, input.execution)) {
    return { status: ObservationAttachmentDecisionStatus.NotRunnable };
  }
  const lease = input.lease;
  if (
    lease === null ||
    lease.leaseId !== input.term.leaseId ||
    !leaseTermMatches(lease, input.term) ||
    lease.state !== ReviewInvocationLeaseState.Active ||
    lease.expiresAt <= input.facts.now ||
    lease.executionId !== input.facts.executionId ||
    scopeKey(lease) !== scopeKey(input.execution) ||
    lease.workSlotId !== input.facts.workSlotId ||
    lease.providerInvocationKey !== input.facts.providerInvocationKey ||
    input.slot.activeLeaseId !== lease.leaseId
  ) {
    return { status: ObservationAttachmentDecisionStatus.StaleLease };
  }
  const ref = buildObservationRef({
    facts: input.facts,
    sourceExecutionId: input.facts.executionId,
    attachmentKind: ReviewObservationAttachmentKind.FreshLease,
    reuseSafetyDecisionHash: null,
    sourceLeaseId: lease.leaseId,
    sourceFencingToken: lease.fencingToken,
  });
  return attachedObservationDecision(
    input.execution,
    input.slot,
    ref,
    { ...lease, state: ReviewInvocationLeaseState.Released },
    input.facts.now,
  );
}

export function decideReusableObservationAttachment(input: {
  readonly stream: ReviewExecutionStream;
  readonly execution: ReviewExecution;
  readonly slot: ReviewWorkSlot;
  readonly existingRefForSlot: ReviewExecutionObservationRef | null;
  readonly existingRefByIdentity: ReviewExecutionObservationRef | null;
  readonly sourceExecutionId: string;
  readonly attachmentKind:
    | ReviewObservationAttachmentKind.ExactRevisionReuse
    | ReviewObservationAttachmentKind.PromptOnlyCrossRevisionReuse
    | ReviewObservationAttachmentKind.ContextGatewayCrossRevisionReuse;
  readonly reuseSafetyDecisionHash: string;
  readonly facts: ObservationFacts;
}): ObservationAttachmentDecision {
  assertObservationFacts(input.facts);
  assertObservationTarget(input.stream, input.execution, input.slot);
  assertSha256(input.reuseSafetyDecisionHash, "reuse_safety_decision_hash");
  const restored = decideExistingObservation(
    input.existingRefForSlot,
    input.existingRefByIdentity,
    input.facts,
    {
      sourceExecutionId: input.sourceExecutionId,
      attachmentKind: input.attachmentKind,
      reuseSafetyDecisionHash: input.reuseSafetyDecisionHash,
      sourceLeaseId: null,
      sourceFencingToken: null,
    },
  );
  if (restored !== null) return restored;
  if (
    input.sourceExecutionId === input.execution.executionId ||
    !isCurrentRunning(input.stream, input.execution) ||
    input.slot.activeLeaseId !== null ||
    input.slot.providerVoteIdentityHash !== input.facts.providerVoteIdentityHash
  ) {
    return { status: ObservationAttachmentDecisionStatus.Ineligible };
  }
  const ref = buildObservationRef({
    facts: input.facts,
    sourceExecutionId: input.sourceExecutionId,
    attachmentKind: input.attachmentKind,
    reuseSafetyDecisionHash: input.reuseSafetyDecisionHash,
    sourceLeaseId: null,
    sourceFencingToken: null,
  });
  return attachedObservationDecision(
    input.execution,
    input.slot,
    ref,
    null,
    input.facts.now,
  );
}

export function decideObservationAdoption(input: {
  readonly stream: ReviewExecutionStream;
  readonly execution: ReviewExecution;
  readonly slot: ReviewWorkSlot;
  readonly existingRefForSlot: ReviewExecutionObservationRef | null;
  readonly existingRefByIdentity: ReviewExecutionObservationRef | null;
  readonly existingAdoptionLease: ReviewInvocationLease | null;
  readonly sourceLease: ReviewInvocationLease | null;
  readonly sourceLeaseId: string;
  readonly sourceFencingToken: bigint;
  readonly adoptionLeaseId: string;
  readonly adoptionAcquireRequestIdHash: string;
  readonly adoptionAcquireRequestHash: string;
  readonly ownerIdHash: string;
  readonly leaseCapabilityId: string;
  readonly capabilitySigningKeyId: string;
  readonly leaseSafetyDecisionHash: string;
  readonly fencingToken: bigint;
  readonly retainUntil: Date;
  readonly facts: ObservationFacts;
}): ObservationAttachmentDecision {
  assertObservationFacts(input.facts);
  assertObservationTarget(input.stream, input.execution, input.slot);
  if (input.existingAdoptionLease !== null) {
    return { status: ObservationAttachmentDecisionStatus.Conflict };
  }
  const restored = decideExistingObservation(
    input.existingRefForSlot,
    input.existingRefByIdentity,
    input.facts,
    {
      sourceExecutionId: input.facts.executionId,
      attachmentKind: ReviewObservationAttachmentKind.ObservationAdoption,
      reuseSafetyDecisionHash: null,
      sourceLeaseId: input.sourceLeaseId,
      sourceFencingToken: input.sourceFencingToken,
    },
  );
  if (restored !== null) return restored;
  const source = input.sourceLease;
  if (
    !isCurrentRunning(input.stream, input.execution) ||
    source === null ||
    source.leaseId !== input.sourceLeaseId ||
    source.fencingToken !== input.sourceFencingToken ||
    scopeKey(source) !== scopeKey(input.execution) ||
    source.executionId !== input.execution.executionId ||
    source.workSlotId !== input.slot.workSlotId ||
    source.providerInvocationKey !== input.facts.providerInvocationKey ||
    source.purpose !== ReviewInvocationLeasePurpose.ProviderExecution ||
    input.slot.activeLeaseId !== null ||
    input.slot.acceptedObservationRefId !== null
  ) {
    return { status: ObservationAttachmentDecisionStatus.Ineligible };
  }
  const adoptionLease: ReviewInvocationLease = {
    workspaceId: input.execution.workspaceId,
    repositoryConnectionId: input.execution.repositoryConnectionId,
    scmRepositoryIdentityId: input.execution.scmRepositoryIdentityId,
    pullRequestNumber: input.execution.pullRequestNumber,
    providerInvocationKey: input.facts.providerInvocationKey,
    preparedManifestCanonicalJson: null,
    preparedManifestKey: null,
    providerVoteIdentityHash: input.facts.providerVoteIdentityHash,
    workSlotId: input.slot.workSlotId,
    leaseId: input.adoptionLeaseId,
    purpose: ReviewInvocationLeasePurpose.ObservationAdoption,
    authorizationId: input.execution.authorizationId,
    producerReleaseId: input.execution.producerReleaseId,
    reviewRevisionHash: input.execution.revision.reviewRevisionHash,
    mutationEpoch: input.execution.mutationEpoch,
    leaseSafetyDecisionHash: input.leaseSafetyDecisionHash,
    attemptId: null,
    sourceObservationId: input.facts.observationId,
    attemptOrdinal: Math.max(0, input.slot.nextAttemptOrdinal - 1),
    acquireRequestIdHash: input.adoptionAcquireRequestIdHash,
    acquireRequestHash: input.adoptionAcquireRequestHash,
    ownerIdHash: input.ownerIdHash,
    leaseCapabilityId: input.leaseCapabilityId,
    capabilitySigningKeyId: input.capabilitySigningKeyId,
    fencingToken: input.fencingToken,
    executionId: input.execution.executionId,
    executionGeneration: input.execution.generation,
    state: ReviewInvocationLeaseState.Released,
    acquiredAt: new Date(input.facts.now),
    renewedAt: new Date(input.facts.now),
    expiresAt: new Date(input.facts.now),
    resultReportUntil: new Date(input.facts.now),
    retainUntil: new Date(input.retainUntil),
  };
  const ref = buildObservationRef({
    facts: input.facts,
    sourceExecutionId: input.execution.executionId,
    attachmentKind: ReviewObservationAttachmentKind.ObservationAdoption,
    reuseSafetyDecisionHash: null,
    sourceLeaseId: source.leaseId,
    sourceFencingToken: source.fencingToken,
  });
  return attachedObservationDecision(
    input.execution,
    input.slot,
    ref,
    adoptionLease,
    input.facts.now,
  );
}

export enum ExecutionFinalizationDecisionStatus {
  Finalized = "finalized",
  NotRunnable = "not_runnable",
  RequiredCoverageIncomplete = "required_coverage_incomplete",
}

export enum ExecutionFinalizationReplayDecisionStatus {
  Proceed = "proceed",
  Restored = "restored",
  Conflict = "conflict",
}

export type ExecutionFinalizationReplayDecision =
  | {
      readonly status: ExecutionFinalizationReplayDecisionStatus.Proceed;
    }
  | {
      readonly status: ExecutionFinalizationReplayDecisionStatus.Restored;
      readonly artifact: FinalizedReviewProjectionArtifact;
    }
  | {
      readonly status: ExecutionFinalizationReplayDecisionStatus.Conflict;
    };

export function decideExecutionFinalizationReplay(input: {
  readonly executionId: string;
  readonly existingArtifact: FinalizedReviewProjectionArtifact | null;
  readonly existingArtifactHash: string | null;
  readonly artifactHash: string;
}): ExecutionFinalizationReplayDecision {
  assertIdentifier(input.executionId, "execution_id");
  assertSha256(input.artifactHash, "artifact_hash");
  if (input.existingArtifact === null) {
    if (input.existingArtifactHash !== null) {
      throw new Error("review_execution_artifact_index_corrupted");
    }
    return { status: ExecutionFinalizationReplayDecisionStatus.Proceed };
  }
  if (input.existingArtifactHash === null) {
    throw new Error("review_execution_artifact_index_corrupted");
  }
  if (input.existingArtifact.executionId !== input.executionId) {
    throw new Error("review_execution_artifact_index_corrupted");
  }
  return input.existingArtifactHash === input.artifactHash
    ? {
        status: ExecutionFinalizationReplayDecisionStatus.Restored,
        artifact: input.existingArtifact,
      }
    : { status: ExecutionFinalizationReplayDecisionStatus.Conflict };
}

export type ExecutionFinalizationDecision =
  | {
      readonly status: ExecutionFinalizationDecisionStatus.Finalized;
      readonly stream: ReviewExecutionStream;
      readonly execution: ReviewExecution;
      readonly artifact: FinalizedReviewProjectionArtifact;
      readonly revokedLeases: readonly ReviewInvocationLease[];
    }
  | {
      readonly status: ExecutionFinalizationDecisionStatus.NotRunnable;
    }
  | {
      readonly status: ExecutionFinalizationDecisionStatus.RequiredCoverageIncomplete;
    };

export type FinalizeExecutionTransitionInput = {
  readonly stream: ReviewExecutionStream;
  readonly execution: ReviewExecution;
  readonly activeLeases: readonly ReviewInvocationLease[];
  readonly scope: ReviewExecutionScope;
  readonly artifactId: string;
  readonly projectionEnvelopeVersion: number;
  readonly projectionEnvelopeJson: string;
  readonly projectionHash: string;
  readonly byteCount: number;
  readonly findingCount: number;
  readonly lifecycleStateHash: string;
  readonly commandLedgerWatermark: bigint;
  readonly projectionPolicyVersion: string;
  readonly publicationSafetyDecisionHash: string;
  readonly publicationNotAfter: Date;
  readonly permitEpoch: bigint;
  readonly allowPartial: boolean;
  readonly limits: ReviewExecutionLimits;
  readonly now: Date;
  readonly retainUntil: Date;
};

export function decideExecutionFinalization(
  input: FinalizeExecutionTransitionInput,
): ExecutionFinalizationDecision {
  assertFinalizeInput(input);
  assertSameScope(input.stream, input.execution, "finalization_execution");
  assertSameScope(input.execution, input.scope, "finalization_command");
  if (
    !isCurrentRunning(input.stream, input.execution) ||
    input.stream.currentRevision === null ||
    !reviewRevisionsEqual(
      input.stream.currentRevision,
      input.execution.revision,
    )
  ) {
    return { status: ExecutionFinalizationDecisionStatus.NotRunnable };
  }
  const coverageState = deriveCoverageState(input.execution.workSlots);
  if (coverageState === ReviewCoverageState.Partial && !input.allowPartial) {
    return {
      status: ExecutionFinalizationDecisionStatus.RequiredCoverageIncomplete,
    };
  }
  const permit: PublicationPermit = {
    ...input.scope,
    executionId: input.execution.executionId,
    generation: input.execution.generation,
    authorizationId: input.execution.authorizationId,
    producerReleaseId: input.execution.producerReleaseId,
    reviewedHeadSha: input.execution.revision.headSha,
    reviewRevisionHash: input.execution.revision.reviewRevisionHash,
    projectionHash: input.projectionHash,
    lifecycleStateHash: input.lifecycleStateHash,
    commandLedgerWatermark: input.commandLedgerWatermark,
    permitEpoch: input.permitEpoch,
    publicationSafetyDecisionHash: input.publicationSafetyDecisionHash,
    publicationNotAfter: new Date(input.publicationNotAfter),
  };
  const artifact: FinalizedReviewProjectionArtifact = {
    artifactId: input.artifactId,
    executionId: input.execution.executionId,
    generation: input.execution.generation,
    reviewedHeadSha: input.execution.revision.headSha,
    reviewRevisionHash: input.execution.revision.reviewRevisionHash,
    coverageState,
    projectionEnvelopeVersion: input.projectionEnvelopeVersion,
    projectionEnvelopeJson: input.projectionEnvelopeJson,
    projectionHash: input.projectionHash,
    byteCount: input.byteCount,
    findingCount: input.findingCount,
    lifecycleStateHash: input.lifecycleStateHash,
    commandLedgerWatermark: input.commandLedgerWatermark,
    projectionPolicyVersion: input.projectionPolicyVersion,
    publicationPermit: permit,
    createdAt: new Date(input.now),
    retainUntil: new Date(input.retainUntil),
  };
  const terminalSlots = input.execution.workSlots.map((slot) =>
    slot.state === ReviewWorkSlotState.Satisfied
      ? slot
      : { ...slot, state: ReviewWorkSlotState.Cancelled, activeLeaseId: null },
  );
  return {
    status: ExecutionFinalizationDecisionStatus.Finalized,
    artifact,
    revokedLeases: revokeActiveLeases(
      input.activeLeases,
      input.execution.executionId,
    ),
    execution: {
      ...input.execution,
      version: input.execution.version + 1n,
      state:
        coverageState === ReviewCoverageState.Completed
          ? ReviewExecutionState.Completed
          : ReviewExecutionState.Partial,
      workSlots: terminalSlots,
      finalizedArtifactId: artifact.artifactId,
      updatedAt: new Date(input.now),
    },
    stream: {
      ...input.stream,
      version: input.stream.version + 1n,
      updatedAt: new Date(input.now),
    },
  };
}

export enum ExecutionLifecycleDecisionStatus {
  Applied = "applied",
  Restored = "restored",
  NotEligible = "not_eligible",
}

export type ExecutionLifecycleDecision = {
  readonly status: ExecutionLifecycleDecisionStatus;
  readonly stream: ReviewExecutionStream;
  readonly execution: ReviewExecution;
  readonly revokedLeases: readonly ReviewInvocationLease[];
};

export function decideExecutionSupersession(input: {
  readonly stream: ReviewExecutionStream;
  readonly execution: ReviewExecution;
  readonly activeLeases: readonly ReviewInvocationLease[];
  readonly observedCurrentRevision: ReviewRevision;
  readonly now: Date;
}): ExecutionLifecycleDecision {
  assertReviewRevision(input.observedCurrentRevision);
  assertDate(input.now, "superseded_at");
  assertSameScope(input.stream, input.execution, "supersession_execution");
  if (input.execution.state === ReviewExecutionState.Superseded) {
    return unchangedLifecycle(ExecutionLifecycleDecisionStatus.Restored, input);
  }
  if (reviewExecutionIsTerminal(input.execution.state)) {
    return unchangedLifecycle(
      ExecutionLifecycleDecisionStatus.NotEligible,
      input,
    );
  }
  const ownsActive =
    input.stream.activeExecutionId === input.execution.executionId;
  const ownsPrepared =
    input.stream.preparedExecutionId === input.execution.executionId;
  if (!ownsActive && !ownsPrepared) {
    return unchangedLifecycle(
      ExecutionLifecycleDecisionStatus.NotEligible,
      input,
    );
  }
  return {
    status: ExecutionLifecycleDecisionStatus.Applied,
    execution: transitionExecutionToSuperseded(
      input.execution,
      null,
      input.now,
    ),
    stream: {
      ...input.stream,
      version: input.stream.version + 1n,
      activeExecutionId: ownsActive ? null : input.stream.activeExecutionId,
      preparedExecutionId: ownsPrepared
        ? null
        : input.stream.preparedExecutionId,
      currentRevision: { ...input.observedCurrentRevision },
      updatedAt: new Date(input.now),
    },
    revokedLeases: revokeActiveLeases(
      input.activeLeases,
      input.execution.executionId,
    ),
  };
}

export function decideAbandonedPreparationFailure(input: {
  readonly stream: ReviewExecutionStream;
  readonly execution: ReviewExecution;
  readonly now: Date;
}): ExecutionLifecycleDecision {
  assertDate(input.now, "abandoned_at");
  assertSameScope(input.stream, input.execution, "abandoned_execution");
  if (input.execution.state === ReviewExecutionState.Failed) {
    return unchangedLifecycle(ExecutionLifecycleDecisionStatus.Restored, {
      ...input,
      activeLeases: [],
    });
  }
  if (
    input.execution.state !== ReviewExecutionState.Planned ||
    input.stream.preparedExecutionId !== input.execution.executionId ||
    input.execution.admissionDeadlineAt > input.now
  ) {
    return unchangedLifecycle(ExecutionLifecycleDecisionStatus.NotEligible, {
      ...input,
      activeLeases: [],
    });
  }
  return {
    status: ExecutionLifecycleDecisionStatus.Applied,
    execution: {
      ...input.execution,
      version: input.execution.version + 1n,
      state: ReviewExecutionState.Failed,
      workSlots: input.execution.workSlots.map((slot) => ({
        ...slot,
        state: ReviewWorkSlotState.Cancelled,
        activeLeaseId: null,
      })),
      updatedAt: new Date(input.now),
    },
    stream: {
      ...input.stream,
      version: input.stream.version + 1n,
      preparedExecutionId: null,
      updatedAt: new Date(input.now),
    },
    revokedLeases: [],
  };
}

export function transitionExecutionToSuperseded(
  execution: ReviewExecution,
  supersededByExecutionId: string | null,
  now: Date,
): ReviewExecution {
  return {
    ...execution,
    version: execution.version + 1n,
    state: ReviewExecutionState.Superseded,
    supersededByExecutionId,
    workSlots: execution.workSlots.map((slot) => ({
      ...slot,
      state:
        slot.state === ReviewWorkSlotState.Satisfied
          ? ReviewWorkSlotState.Satisfied
          : ReviewWorkSlotState.Cancelled,
      activeLeaseId: null,
    })),
    updatedAt: new Date(now),
  };
}

function unchangedAdmission(
  status: ExecutionAdmissionDecisionStatus,
  input: {
    readonly stream: ReviewExecutionStream;
    readonly execution: ReviewExecution;
  },
): ExecutionAdmissionDecision {
  return {
    status,
    stream: input.stream,
    execution: input.execution,
    supersededPriorActive: null,
    revokedPriorLeases: [],
  };
}

function expireLeaseDecision(input: {
  readonly lease: ReviewInvocationLease;
  readonly execution: ReviewExecution | null;
  readonly now: Date;
}): LeaseTransitionDecision {
  return {
    status: LeaseTransitionDecisionStatus.Expired,
    lease:
      input.lease.state === ReviewInvocationLeaseState.Active
        ? { ...input.lease, state: ReviewInvocationLeaseState.Expired }
        : input.lease,
    execution: clearLeaseFromExecution(input.execution, input.lease, input.now),
  };
}

function unchangedLease(
  status: LeaseTransitionDecisionStatus,
  input: {
    readonly lease: ReviewInvocationLease;
    readonly execution: ReviewExecution | null;
  },
): LeaseTransitionDecision {
  return { status, lease: input.lease, execution: input.execution };
}

function clearLeaseFromExecution(
  execution: ReviewExecution | null,
  lease: ReviewInvocationLease,
  now: Date,
): ReviewExecution | null {
  if (execution === null) return null;
  const slot = execution.workSlots.find(
    (candidate) => candidate.workSlotId === lease.workSlotId,
  );
  if (!slot || slot.activeLeaseId !== lease.leaseId) return execution;
  return replaceExecutionSlot(
    execution,
    {
      ...slot,
      activeLeaseId: null,
      state:
        slot.nextAttemptOrdinal > slot.attemptBudget
          ? ReviewWorkSlotState.Exhausted
          : ReviewWorkSlotState.Pending,
    },
    now,
  );
}

function attachedObservationDecision(
  execution: ReviewExecution,
  slot: ReviewWorkSlot,
  ref: ReviewExecutionObservationRef,
  lease: ReviewInvocationLease | null,
  now: Date,
): ObservationAttachmentDecision {
  return {
    status: ObservationAttachmentDecisionStatus.Attached,
    observationRef: ref,
    lease,
    execution: replaceExecutionSlot(
      execution,
      {
        ...slot,
        state: ReviewWorkSlotState.Satisfied,
        activeLeaseId: null,
        acceptedObservationRefId: ref.observationRefId,
      },
      now,
    ),
  };
}

function decideExistingObservation(
  existingForSlot: ReviewExecutionObservationRef | null,
  existingByIdentity: ReviewExecutionObservationRef | null,
  facts: ObservationFacts,
  identity: ObservationAttachmentIdentity,
): ObservationAttachmentDecision | null {
  if (existingForSlot === null) {
    return existingByIdentity === null
      ? null
      : { status: ObservationAttachmentDecisionStatus.Conflict };
  }
  return existingForSlot.observationRefId === facts.observationRefId &&
    existingForSlot.observationId === facts.observationId &&
    existingForSlot.executionId === facts.executionId &&
    existingForSlot.workSlotId === facts.workSlotId &&
    existingForSlot.providerInvocationKey === facts.providerInvocationKey &&
    existingForSlot.providerVoteIdentityHash ===
      facts.providerVoteIdentityHash &&
    existingForSlot.payloadHash === facts.payloadHash &&
    existingForSlot.byteCount === facts.byteCount &&
    existingForSlot.findingCount === facts.findingCount &&
    existingForSlot.eligibilityPolicyVersion ===
      facts.eligibilityPolicyVersion &&
    existingForSlot.sourceExecutionId === identity.sourceExecutionId &&
    existingForSlot.attachmentKind === identity.attachmentKind &&
    existingForSlot.reuseSafetyDecisionHash ===
      identity.reuseSafetyDecisionHash &&
    existingForSlot.sourceLeaseId === identity.sourceLeaseId &&
    existingForSlot.sourceFencingToken === identity.sourceFencingToken
    ? {
        status: ObservationAttachmentDecisionStatus.Restored,
        observationRef: existingForSlot,
      }
    : { status: ObservationAttachmentDecisionStatus.Conflict };
}

function buildObservationRef(input: {
  readonly facts: ObservationFacts;
  readonly sourceExecutionId: string;
  readonly attachmentKind: ReviewObservationAttachmentKind;
  readonly reuseSafetyDecisionHash: string | null;
  readonly sourceLeaseId: string | null;
  readonly sourceFencingToken: bigint | null;
}): ReviewExecutionObservationRef {
  return {
    observationRefId: input.facts.observationRefId,
    executionId: input.facts.executionId,
    workSlotId: input.facts.workSlotId,
    providerInvocationKey: input.facts.providerInvocationKey,
    observationId: input.facts.observationId,
    providerVoteIdentityHash: input.facts.providerVoteIdentityHash,
    attachmentKind: input.attachmentKind,
    eligibilityPolicyVersion: input.facts.eligibilityPolicyVersion,
    reuseSafetyDecisionHash: input.reuseSafetyDecisionHash,
    sourceExecutionId: input.sourceExecutionId,
    sourceLeaseId: input.sourceLeaseId,
    sourceFencingToken: input.sourceFencingToken,
    payloadHash: input.facts.payloadHash,
    byteCount: input.facts.byteCount,
    findingCount: input.facts.findingCount,
    attachedAt: new Date(input.facts.now),
  };
}

function replaceExecutionSlot(
  execution: ReviewExecution,
  slot: ReviewWorkSlot,
  now: Date,
): ReviewExecution {
  return {
    ...execution,
    version: execution.version + 1n,
    workSlots: execution.workSlots.map((candidate) =>
      candidate.workSlotId === slot.workSlotId ? slot : candidate,
    ),
    updatedAt: new Date(now),
  };
}

function unchangedLifecycle(
  status: ExecutionLifecycleDecisionStatus,
  input: {
    readonly stream: ReviewExecutionStream;
    readonly execution: ReviewExecution;
    readonly activeLeases: readonly ReviewInvocationLease[];
  },
): ExecutionLifecycleDecision {
  return {
    status,
    stream: input.stream,
    execution: input.execution,
    revokedLeases: [],
  };
}

function revokeActiveLeases(
  leases: readonly ReviewInvocationLease[],
  executionId: string,
): readonly ReviewInvocationLease[] {
  for (const lease of leases) {
    if (
      lease.executionId !== executionId ||
      lease.state !== ReviewInvocationLeaseState.Active
    ) {
      throw new Error("review_execution_invalid_active_lease_set");
    }
  }
  return leases.map((lease) => ({
    ...lease,
    state: ReviewInvocationLeaseState.Revoked,
  }));
}

function isCurrentRunning(
  stream: ReviewExecutionStream,
  execution: ReviewExecution,
): boolean {
  return (
    stream.activeExecutionId === execution.executionId &&
    execution.state === ReviewExecutionState.Running
  );
}

function assertSameScope(
  left: ReviewExecutionScope,
  right: ReviewExecutionScope,
  relation: string,
): void {
  if (scopeKey(left) !== scopeKey(right)) {
    throw new Error(`review_execution_scope_mismatch_${relation}`);
  }
}

function assertObservationTarget(
  stream: ReviewExecutionStream,
  execution: ReviewExecution,
  slot: ReviewWorkSlot,
): void {
  assertSameScope(stream, execution, "observation_execution");
  const aggregateSlot = execution.workSlots.find(
    (candidate) => candidate.workSlotId === slot.workSlotId,
  );
  if (aggregateSlot === undefined || !workSlotsEqual(aggregateSlot, slot)) {
    throw new Error("review_execution_observation_slot_not_in_aggregate");
  }
}

function workSlotsEqual(left: ReviewWorkSlot, right: ReviewWorkSlot): boolean {
  return (
    left.workSlotId === right.workSlotId &&
    left.taskKind === right.taskKind &&
    left.providerKind === right.providerKind &&
    left.providerVoteIdentityHash === right.providerVoteIdentityHash &&
    left.shardKey === right.shardKey &&
    left.required === right.required &&
    left.attemptBudget === right.attemptBudget &&
    left.retryPolicyVersion === right.retryPolicyVersion &&
    left.state === right.state &&
    left.activeLeaseId === right.activeLeaseId &&
    left.acceptedObservationRefId === right.acceptedObservationRefId &&
    left.nextAttemptOrdinal === right.nextAttemptOrdinal
  );
}

function leaseTermMatches(
  lease: ReviewInvocationLease,
  term: {
    readonly ownerIdHash: string;
    readonly leaseCapabilityId: string;
    readonly fencingToken: bigint;
  },
): boolean {
  return (
    lease.ownerIdHash === term.ownerIdHash &&
    lease.leaseCapabilityId === term.leaseCapabilityId &&
    lease.fencingToken === term.fencingToken
  );
}

function assertLeaseExecutionRelation(
  lease: ReviewInvocationLease,
  execution: ReviewExecution | null,
): void {
  if (
    execution !== null &&
    (lease.executionId !== execution.executionId ||
      scopeKey(lease) !== scopeKey(execution))
  ) {
    throw new Error("review_execution_lease_aggregate_mismatch");
  }
}

function assertPrepareInput(input: PrepareExecutionTransitionInput): void {
  assertReviewExecutionScope(input.scope);
  assertSameScope(input.scope, input.stream, "preparation_stream");
  if (input.priorPrepared !== null) {
    assertSameScope(input.scope, input.priorPrepared, "preparation_prior");
  }
  if (
    (input.stream.preparedExecutionId === null) !==
      (input.priorPrepared === null) ||
    (input.priorPrepared !== null &&
      input.stream.preparedExecutionId !== input.priorPrepared.executionId)
  ) {
    throw new Error("review_execution_prepared_reference_corrupted");
  }
  assertIdentifier(input.executionId, "execution_id");
  assertIdentifier(input.authorizationId, "authorization_id");
  assertIdentifier(input.producerReleaseId, "producer_release_id");
  if (input.mutationEpoch <= 0n) {
    throw new Error("review_execution_invalid_mutation_epoch");
  }
  assertReviewRevision(input.revision);
  assertSha256(input.startIdentityHash, "start_identity_hash");
  assertSha256(input.canonicalStartHash, "canonical_start_hash");
  assertSha256(
    input.admissionSafetyDecisionHash,
    "admission_safety_decision_hash",
  );
  assertSha256(input.planHash, "plan_hash");
  assertIdentifier(input.compatibilityKey, "compatibility_key");
  assertIdentifier(input.sourceRunId, "source_run_id");
  assertIdentifier(input.sourceRunAttempt, "source_run_attempt");
  assertReviewExecutionLimits(input.limits);
  for (const date of [
    input.now,
    input.admissionDeadlineAt,
    input.executionDeadlineAt,
    input.retainUntil,
  ]) {
    assertDate(date, "execution_deadline");
  }
  if (
    input.admissionDeadlineAt <= input.now ||
    input.executionDeadlineAt <= input.admissionDeadlineAt ||
    input.retainUntil <= input.executionDeadlineAt
  ) {
    throw new Error("review_execution_invalid_deadline_order");
  }
}

function assertLeaseAcquireInput(input: LeaseAcquireTransitionInput): void {
  assertReviewExecutionScope(input.scope);
  for (const [value, field] of [
    [input.workSlotId, "work_slot_id"],
    [input.leaseId, "lease_id"],
    [input.ownerIdHash, "owner_id_hash"],
    [input.leaseCapabilityId, "lease_capability_id"],
    [input.capabilitySigningKeyId, "capability_signing_key_id"],
  ] as const) {
    assertIdentifier(value, field);
  }
  for (const [value, field] of [
    [input.providerInvocationKey, "provider_invocation_key"],
    [input.providerVoteIdentityHash, "provider_vote_identity_hash"],
    [input.acquireRequestIdHash, "acquire_request_id_hash"],
    [input.acquireRequestHash, "acquire_request_hash"],
    [input.leaseSafetyDecisionHash, "lease_safety_decision_hash"],
  ] as const) {
    assertSha256(value, field);
  }
  if (
    input.purpose === ReviewInvocationLeasePurpose.ProviderExecution
      ? input.attemptId === null ||
        input.sourceObservationId !== null ||
        input.preparedManifestCanonicalJson === null ||
        input.preparedManifestKey === null
      : input.sourceObservationId === null ||
        input.attemptId !== null ||
        input.preparedManifestCanonicalJson !== null ||
        input.preparedManifestKey !== null
  ) {
    throw new Error("review_execution_invalid_lease_purpose_fields");
  }
  if (input.attemptId) assertIdentifier(input.attemptId, "attempt_id");
  if (input.preparedManifestKey) {
    assertSha256(input.preparedManifestKey, "prepared_manifest_key");
  }
  if (
    input.preparedManifestCanonicalJson !== null &&
    (input.preparedManifestCanonicalJson.length === 0 ||
      new TextEncoder().encode(input.preparedManifestCanonicalJson).byteLength >
        262_144)
  ) {
    throw new Error("review_execution_prepared_manifest_invalid");
  }
  if (input.sourceObservationId)
    assertIdentifier(input.sourceObservationId, "source_observation_id");
  assertReviewExecutionLimits(input.limits);
  if (!validLeaseDeadlines(input, input.limits)) {
    throw new Error("review_execution_invalid_lease_deadlines");
  }
  if (
    input.retainUntil <= input.resultReportUntil ||
    input.fencingToken <= 0n
  ) {
    throw new Error("review_execution_invalid_lease_retention");
  }
}

function validLeaseDeadlines(
  input: {
    readonly now: Date;
    readonly expiresAt: Date;
    readonly resultReportUntil: Date;
  },
  limits: Pick<
    ReviewExecutionLimits,
    "maxLeaseDurationMs" | "maxResultReportDurationMs"
  >,
): boolean {
  return (
    input.expiresAt > input.now &&
    input.resultReportUntil >= input.expiresAt &&
    input.expiresAt.getTime() - input.now.getTime() <=
      limits.maxLeaseDurationMs &&
    input.resultReportUntil.getTime() - input.now.getTime() <=
      limits.maxResultReportDurationMs
  );
}

function assertObservationFacts(facts: ObservationFacts): void {
  assertIdentifier(facts.observationRefId, "observation_ref_id");
  assertIdentifier(facts.observationId, "observation_id");
  assertSha256(facts.providerInvocationKey, "provider_invocation_key");
  assertSha256(facts.providerVoteIdentityHash, "provider_vote_identity_hash");
  assertSha256(facts.payloadHash, "payload_hash");
  assertIdentifier(
    facts.eligibilityPolicyVersion,
    "eligibility_policy_version",
  );
  if (!Number.isSafeInteger(facts.byteCount) || facts.byteCount < 0) {
    throw new Error("review_execution_invalid_observation_byte_count");
  }
  if (!Number.isSafeInteger(facts.findingCount) || facts.findingCount < 0) {
    throw new Error("review_execution_invalid_observation_finding_count");
  }
  assertDate(facts.now, "observation_attached_at");
}

function assertFinalizeInput(input: FinalizeExecutionTransitionInput): void {
  assertReviewExecutionScope(input.scope);
  assertIdentifier(input.artifactId, "artifact_id");
  assertSha256(input.lifecycleStateHash, "lifecycle_state_hash");
  assertSha256(
    input.publicationSafetyDecisionHash,
    "publication_safety_decision_hash",
  );
  assertIdentifier(input.projectionPolicyVersion, "projection_policy_version");
  assertDate(input.now, "finalized_at");
  assertDate(input.publicationNotAfter, "publication_not_after");
  assertDate(input.retainUntil, "artifact_retain_until");
  if (
    input.publicationNotAfter <= input.now ||
    input.retainUntil <= input.publicationNotAfter ||
    input.commandLedgerWatermark < 0n ||
    input.permitEpoch <= 0n
  ) {
    throw new Error("review_execution_invalid_finalization_window");
  }
  assertReviewExecutionLimits(input.limits);
  assertFinalizationEnvelope(input);
}
