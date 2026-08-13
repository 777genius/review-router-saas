import type {
  AcquireReviewInvocationLeaseCommand,
  AdoptAcceptedReviewObservationCommand,
  AttachReusableReviewObservationCommand,
  AttachReviewObservationCommand,
  ConfirmReviewExecutionAdmissionCommand,
  FinalizeReviewExecutionCommand,
  FailAbandonedPreparedExecutionCommand,
  FailExpiredRunningExecutionCommand,
  PrepareReviewExecutionCommand,
  ReleaseReviewInvocationLeaseCommand,
  RenewReviewInvocationLeaseCommand,
  ReviewExecutionCommandPort,
  ReviewExecutionFencingTokenSourcePort,
  ReviewExecutionPrunerPort,
  ReviewExecutionQueryPort,
  ReviewInvocationLeaseAcquireResult,
  ReviewInvocationLeaseTransitionResult,
  ReviewObservationAttachmentResult,
  SupersedeReviewExecutionCommand,
  TerminalizeReviewWorkSlotCommand,
} from "../../application/ports/review-execution-ports";
import type { InvocationFlightQueryPort } from "../../application/ports/invocation-flight-ports";
import {
  ReviewExecutionAdmissionStatus,
  ReviewExecutionAdmissionVerdict,
  ReviewExecutionFinalizeStatus,
  ReviewExecutionLifecycleTransitionStatus,
  ReviewExecutionPrepareStatus,
  ReviewInvocationLeaseAcquireStatus,
  ReviewInvocationLeaseTransitionStatus,
  ReviewObservationAttachmentStatus,
} from "../../application/ports/review-execution-ports";
import {
  ReviewInvocationLeasePurpose,
  ReviewInvocationLeaseState,
  ReviewExecutionState,
  createEmptyReviewExecutionStream,
  reviewExecutionIsTerminal,
  scopeKey,
  type FinalizedReviewProjectionArtifact,
  type ReviewExecution,
  type ReviewExecutionObservationRef,
  type ReviewExecutionScope,
  type ReviewExecutionSnapshot,
  type ReviewExecutionStream,
  type ReviewInvocationLease,
  type ReviewWorkSlot,
} from "../../domain/review-execution";
import {
  ExecutionAdmissionDecisionStatus,
  ExecutionAdmissionVerdict,
  ExecutionFinalizationDecisionStatus,
  ExecutionFinalizationReplayDecisionStatus,
  ExecutionLifecycleDecisionStatus,
  ExecutionPreparationReplayDecisionStatus,
  LeaseAcquireDecisionStatus,
  LeaseAcquireReplayDecisionStatus,
  LeaseTransitionDecisionStatus,
  ObservationAttachmentDecisionStatus,
  decideAbandonedPreparationFailure,
  decideExpiredRunningExecutionFailure,
  decideExecutionAdmission,
  decideExecutionFinalization,
  decideExecutionFinalizationReplay,
  decideExecutionPreparation,
  decideExecutionPreparationReplay,
  decideExecutionSupersession,
  decideWorkSlotTerminalization,
  WorkSlotTerminalizationDecisionStatus,
  decideFreshObservationAttachment,
  decideLeaseAcquire,
  decideLeaseAcquireReplay,
  decideLeaseExpiry,
  decideLeaseRelease,
  decideLeaseRenewal,
  decideObservationAdoption,
  decideReusableObservationAttachment,
  type ObservationFacts,
} from "../../domain/review-execution-transitions";
import {
  restoreInvocationFlight,
  type InvocationFlight,
} from "../../domain/invocation-flight";
import { MonotonicBigIntFencingTokenSource } from "./monotonic-bigint-fencing-token-source";

type StreamRecord = {
  stream: ReviewExecutionStream;
  readonly executions: Map<string, ReviewExecution>;
  readonly startIdentityIndex: Map<string, string>;
};

export class InMemoryReviewExecutionStore
  implements
    ReviewExecutionQueryPort,
    ReviewExecutionCommandPort,
    ReviewExecutionPrunerPort,
    InvocationFlightQueryPort
{
  async listExpiredRunning(input: {
    readonly now: Date;
    readonly limit: number;
  }) {
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 256
    ) {
      throw new Error("review_execution_recovery_limit_invalid");
    }
    return [...this.executionScope.keys()]
      .map((executionId) => {
        const record = this.recordForExecution(executionId);
        const execution = record?.executions.get(executionId);
        return record && execution ? { record, execution } : null;
      })
      .filter(
        (
          entry,
        ): entry is { record: StreamRecord; execution: ReviewExecution } =>
          entry !== null &&
          entry.execution.state === ReviewExecutionState.Running &&
          entry.record.stream.activeExecutionId ===
            entry.execution.executionId &&
          entry.execution.executionDeadlineAt <= input.now,
      )
      .sort(
        (left, right) =>
          left.execution.executionDeadlineAt.getTime() -
            right.execution.executionDeadlineAt.getTime() ||
          left.execution.executionId.localeCompare(right.execution.executionId),
      )
      .slice(0, input.limit)
      .map(({ record, execution }) =>
        this.snapshot(record, execution.executionId),
      );
  }
  private readonly streams = new Map<string, StreamRecord>();
  private readonly executionScope = new Map<string, string>();
  private readonly leases = new Map<string, ReviewInvocationLease>();
  private readonly leaseAcquireIndex = new Map<string, string>();
  private readonly observationRefs = new Map<
    string,
    ReviewExecutionObservationRef
  >();
  private readonly observationRefBySlot = new Map<string, string>();
  private readonly artifacts = new Map<
    string,
    FinalizedReviewProjectionArtifact
  >();
  private readonly artifactHashes = new Map<string, string>();
  private readonly leaseTombstones = new Set<string>();
  private transactionTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly fencingTokens: ReviewExecutionFencingTokenSourcePort = new MonotonicBigIntFencingTokenSource(),
  ) {}

  async findStream(
    scope: ReviewExecutionScope,
  ): Promise<ReviewExecutionStream | null> {
    await this.transactionTail;
    const record = this.streams.get(scopeKey(scope));
    return record ? cloneStream(record.stream) : null;
  }

  async findExecution(
    executionId: string,
  ): Promise<ReviewExecutionSnapshot | null> {
    await this.transactionTail;
    const record = this.recordForExecution(executionId);
    return record ? this.snapshot(record, executionId) : null;
  }

  async findByStartIdentity(input: {
    readonly scope: ReviewExecutionScope;
    readonly authorizationId: string;
    readonly startIdentityHash: string;
  }): Promise<ReviewExecutionSnapshot | null> {
    await this.transactionTail;
    const record = this.streams.get(scopeKey(input.scope));
    const executionId = record?.startIdentityIndex.get(
      startIdentityKey(input.authorizationId, input.startIdentityHash),
    );
    return record && executionId ? this.snapshot(record, executionId) : null;
  }

  async findLease(leaseId: string): Promise<ReviewInvocationLease | null> {
    await this.transactionTail;
    const lease = this.leases.get(leaseId);
    return lease ? cloneLease(lease) : null;
  }

  async findProviderExecutionLeaseByAttemptId(
    attemptId: string,
  ): Promise<ReviewInvocationLease | null> {
    const lease = [...this.leases.values()].find(
      (candidate) => candidate.attemptId === attemptId,
    );
    return lease ? cloneLease(lease) : null;
  }

  async observeActiveInvocationFlightByLane(input: {
    readonly providerVoteIdentityHash: string;
    readonly requestedAt: Date;
  }): Promise<Readonly<{ flight: InvocationFlight | null; observedAt: Date }>> {
    await this.transactionTail;
    const incumbents = [...this.leases.values()]
      .filter(
        (candidate) =>
          candidate.providerVoteIdentityHash ===
            input.providerVoteIdentityHash &&
          candidate.purpose ===
            ReviewInvocationLeasePurpose.ProviderExecution &&
          candidate.state === ReviewInvocationLeaseState.Active,
      )
      .sort((left, right) => left.leaseId.localeCompare(right.leaseId));
    if (incumbents.length > 1) {
      throw new Error("review_provider_lane_invariant_violated");
    }
    const lease = incumbents[0];
    if (lease === undefined) {
      return { flight: null, observedAt: new Date(input.requestedAt) };
    }
    const record = this.recordForExecution(lease.executionId);
    const execution = record?.executions.get(lease.executionId);
    const slot = execution?.workSlots.find(
      (candidate) => candidate.workSlotId === lease.workSlotId,
    );
    if (execution === undefined || slot === undefined) {
      throw new Error("invocation_flight_owner_aggregate_missing");
    }
    return {
      flight: restoreInvocationFlight({ execution, slot, lease }),
      observedAt: new Date(input.requestedAt),
    };
  }

  async prepareExecution(command: PrepareReviewExecutionCommand) {
    return this.atomic(() => {
      const key = scopeKey(command.scope);
      const record =
        this.streams.get(key) ?? newStreamRecord(command.scope, command.now);
      const identityKey = startIdentityKey(
        command.authorizationId,
        command.startIdentityHash,
      );
      const existingId = record.startIdentityIndex.get(identityKey);
      const replay = decideExecutionPreparationReplay({
        existingByStartIdentity: existingId
          ? requiredExecution(record, existingId)
          : null,
        canonicalStartHash: command.canonicalStartHash,
      });
      if (replay.status === ExecutionPreparationReplayDecisionStatus.Restored) {
        return {
          status: ReviewExecutionPrepareStatus.Restored,
          snapshot: this.snapshot(record, replay.execution.executionId),
        };
      }
      if (
        replay.status ===
        ExecutionPreparationReplayDecisionStatus.IdempotencyConflict
      ) {
        return { status: ReviewExecutionPrepareStatus.IdempotencyConflict };
      }
      if (record.stream.version !== command.expectedStreamVersion) {
        return { status: ReviewExecutionPrepareStatus.ConcurrencyConflict };
      }
      if (this.executionScope.has(command.executionId)) {
        return { status: ReviewExecutionPrepareStatus.IdempotencyConflict };
      }

      const oldPreparedId = record.stream.preparedExecutionId;
      const decision = decideExecutionPreparation({
        stream: record.stream,
        priorPrepared: oldPreparedId
          ? requiredExecution(record, oldPreparedId)
          : null,
        ...command,
      });
      const execution = decision.execution;
      if (decision.supersededPrepared !== null) {
        record.executions.set(
          decision.supersededPrepared.executionId,
          decision.supersededPrepared,
        );
      }
      record.executions.set(execution.executionId, execution);
      record.startIdentityIndex.set(identityKey, execution.executionId);
      record.stream = decision.stream;
      this.streams.set(key, record);
      this.executionScope.set(execution.executionId, key);
      return {
        status: ReviewExecutionPrepareStatus.Prepared,
        snapshot: this.snapshot(record, execution.executionId),
      };
    });
  }

  async confirmAdmission(command: ConfirmReviewExecutionAdmissionCommand) {
    return this.atomic(() => {
      const record = this.streams.get(scopeKey(command.scope));
      if (!record) {
        return { status: ReviewExecutionAdmissionStatus.Missing };
      }
      const execution = record.executions.get(command.executionId);
      if (!execution) {
        return { status: ReviewExecutionAdmissionStatus.Missing };
      }
      const priorActiveId = record.stream.activeExecutionId;
      const priorActive =
        priorActiveId && priorActiveId !== execution.executionId
          ? requiredExecution(record, priorActiveId)
          : null;
      const decision = decideExecutionAdmission({
        stream: record.stream,
        execution,
        priorActive,
        priorActiveLeases:
          priorActive === null
            ? []
            : this.activeLeases(priorActive.executionId),
        authorizationId: command.authorizationId,
        mutationEpoch: command.mutationEpoch,
        requestedRevision: command.requestedRevision,
        observedRevision: command.observedRevision,
        verdict:
          command.verdict === ReviewExecutionAdmissionVerdict.Current
            ? ExecutionAdmissionVerdict.Current
            : command.verdict === ReviewExecutionAdmissionVerdict.Stale
              ? ExecutionAdmissionVerdict.Stale
              : ExecutionAdmissionVerdict.Unavailable,
        checkedAt: command.checkedAt,
      });
      if (decision.status === ExecutionAdmissionDecisionStatus.Restored) {
        return {
          status: ReviewExecutionAdmissionStatus.Restored,
          snapshot: this.snapshot(record, execution.executionId),
        };
      }
      if (
        decision.status === ExecutionAdmissionDecisionStatus.Superseded &&
        decision.stream.version === record.stream.version
      ) {
        return {
          status: ReviewExecutionAdmissionStatus.Superseded,
          snapshot: this.snapshot(record, execution.executionId),
        };
      }
      if (record.stream.version !== command.expectedStreamVersion) {
        return { status: ReviewExecutionAdmissionStatus.ConcurrencyConflict };
      }
      if (decision.status === ExecutionAdmissionDecisionStatus.NotPrepared) {
        return { status: ReviewExecutionAdmissionStatus.NotPrepared };
      }
      if (decision.status === ExecutionAdmissionDecisionStatus.Deferred) {
        return {
          status: ReviewExecutionAdmissionStatus.Deferred,
          snapshot: this.snapshot(record, execution.executionId),
        };
      }
      record.executions.set(execution.executionId, decision.execution);
      record.stream = decision.stream;
      if (decision.supersededPriorActive !== null) {
        record.executions.set(
          decision.supersededPriorActive.executionId,
          decision.supersededPriorActive,
        );
      }
      this.persistRevokedLeases(decision.revokedPriorLeases);
      if (decision.status === ExecutionAdmissionDecisionStatus.Superseded) {
        return {
          status: ReviewExecutionAdmissionStatus.Superseded,
          snapshot: this.snapshot(record, execution.executionId),
        };
      }
      return {
        status: ReviewExecutionAdmissionStatus.Admitted,
        snapshot: this.snapshot(record, execution.executionId),
      };
    });
  }

  async acquireLease(
    command: AcquireReviewInvocationLeaseCommand,
  ): Promise<ReviewInvocationLeaseAcquireResult> {
    return this.atomic(() => {
      const acquireKey = leaseAcquireKey(command);
      const restoredId = this.leaseAcquireIndex.get(acquireKey);
      const replay = decideLeaseAcquireReplay({
        existingByAcquireIdentity: restoredId
          ? requiredLease(this.leases, restoredId)
          : null,
        scope: command.scope,
        executionId: command.executionId,
        acquireRequestIdHash: command.acquireRequestIdHash,
        acquireRequestHash: command.acquireRequestHash,
        ownerIdHash: command.ownerIdHash,
        providerInvocationKey: command.providerInvocationKey,
        preparedManifestCanonicalJson: command.preparedManifestCanonicalJson,
        preparedManifestKey: command.preparedManifestKey,
        providerVoteIdentityHash: command.providerVoteIdentityHash,
        workSlotId: command.workSlotId,
        purpose: command.purpose,
      });
      if (replay.status === LeaseAcquireReplayDecisionStatus.Restored) {
        return {
          status: ReviewInvocationLeaseAcquireStatus.Restored,
          lease: cloneLease(replay.lease),
        };
      }
      if (
        replay.status === LeaseAcquireReplayDecisionStatus.IdempotencyConflict
      ) {
        return {
          status: ReviewInvocationLeaseAcquireStatus.IdempotencyConflict,
        };
      }
      const record = this.streams.get(scopeKey(command.scope));
      const execution = record?.executions.get(command.executionId);
      if (!record || !execution) {
        return { status: ReviewInvocationLeaseAcquireStatus.Missing };
      }
      const slot = execution.workSlots.find(
        (candidate) => candidate.workSlotId === command.workSlotId,
      );
      const activeLease =
        slot?.activeLeaseId !== null && slot?.activeLeaseId !== undefined
          ? requiredLease(this.leases, slot.activeLeaseId)
          : null;
      const decision = decideLeaseAcquire({
        stream: record.stream,
        execution,
        activeLease,
        fencingToken: this.fencingTokens.next(),
        ...command,
      });
      if (decision.status === LeaseAcquireDecisionStatus.MissingSlot) {
        return { status: ReviewInvocationLeaseAcquireStatus.Missing };
      }
      if (decision.status === LeaseAcquireDecisionStatus.NotRunnable) {
        return { status: ReviewInvocationLeaseAcquireStatus.NotRunnable };
      }
      if (decision.status === LeaseAcquireDecisionStatus.Busy) {
        return { status: ReviewInvocationLeaseAcquireStatus.Busy };
      }
      if (
        decision.status === LeaseAcquireDecisionStatus.Acquired &&
        command.purpose === ReviewInvocationLeasePurpose.ProviderExecution
      ) {
        const incumbents = [...this.leases.values()].filter(
          (candidate) =>
            candidate.purpose ===
              ReviewInvocationLeasePurpose.ProviderExecution &&
            candidate.providerVoteIdentityHash ===
              command.providerVoteIdentityHash &&
            candidate.state === ReviewInvocationLeaseState.Active,
        );
        if (incumbents.length > 1) {
          throw new Error("review_provider_lane_invariant_violated");
        }
        const incumbent = incumbents[0];
        const locallyExpiring =
          incumbent !== undefined &&
          decision.expiredLease?.leaseId === incumbent.leaseId;
        if (incumbent && !locallyExpiring) {
          if (incumbent.expiresAt > command.now) {
            return { status: ReviewInvocationLeaseAcquireStatus.Busy };
          }
          const incumbentRecord = this.recordForExecution(
            incumbent.executionId,
          );
          const incumbentExecution =
            incumbentRecord?.executions.get(incumbent.executionId) ?? null;
          const expiry = decideLeaseExpiry({
            lease: incumbent,
            execution: incumbentExecution,
            now: command.now,
          });
          this.leases.set(incumbent.leaseId, expiry.lease);
          if (incumbentRecord && expiry.execution) {
            incumbentRecord.executions.set(
              expiry.execution.executionId,
              expiry.execution,
            );
          }
        }
      }
      if (decision.expiredLease !== null) {
        this.leases.set(decision.expiredLease.leaseId, decision.expiredLease);
      }
      record.executions.set(execution.executionId, decision.execution);
      if (
        decision.status === LeaseAcquireDecisionStatus.AttemptBudgetExhausted
      ) {
        return {
          status: ReviewInvocationLeaseAcquireStatus.AttemptBudgetExhausted,
          snapshot: this.snapshot(record, execution.executionId),
        };
      }
      const lease = decision.lease;
      if (
        this.leases.has(lease.leaseId) ||
        this.leaseTombstones.has(lease.leaseId) ||
        [...this.leases.values()].some(
          (candidate) =>
            candidate.fencingToken === lease.fencingToken ||
            candidate.leaseCapabilityId === lease.leaseCapabilityId ||
            (lease.attemptId !== null &&
              candidate.attemptId === lease.attemptId),
        )
      ) {
        throw new Error("review_execution_lease_identity_conflict");
      }
      this.leases.set(lease.leaseId, lease);
      this.leaseAcquireIndex.set(acquireKey, lease.leaseId);
      return {
        status: ReviewInvocationLeaseAcquireStatus.Acquired,
        lease: cloneLease(lease),
        snapshot: this.snapshot(record, execution.executionId),
      };
    });
  }

  async renewLease(
    command: RenewReviewInvocationLeaseCommand,
  ): Promise<ReviewInvocationLeaseTransitionResult> {
    return this.atomic(() => {
      const lease = this.leases.get(command.leaseId);
      if (!lease) {
        return { status: ReviewInvocationLeaseTransitionStatus.Missing };
      }
      const record = this.recordForExecution(lease.executionId);
      const execution = record?.executions.get(lease.executionId) ?? null;
      const decision = decideLeaseRenewal({ lease, execution, ...command });
      if (decision.status === LeaseTransitionDecisionStatus.StaleTerm) {
        return { status: ReviewInvocationLeaseTransitionStatus.StaleTerm };
      }
      if (decision.status === LeaseTransitionDecisionStatus.InvalidDeadline) {
        return {
          status: ReviewInvocationLeaseTransitionStatus.InvalidDeadline,
        };
      }
      if (
        decision.status === LeaseTransitionDecisionStatus.IdempotencyConflict
      ) {
        return {
          status: ReviewInvocationLeaseTransitionStatus.IdempotencyConflict,
        };
      }
      this.persistLeaseTransition(record, decision.lease, decision.execution);
      if (decision.status === LeaseTransitionDecisionStatus.Expired) {
        return { status: ReviewInvocationLeaseTransitionStatus.Expired };
      }
      if (decision.status === LeaseTransitionDecisionStatus.Restored) {
        return {
          status: ReviewInvocationLeaseTransitionStatus.Restored,
          lease: cloneLease(decision.lease),
        };
      }
      return {
        status: ReviewInvocationLeaseTransitionStatus.Applied,
        lease: cloneLease(decision.lease),
      };
    });
  }

  async releaseLease(
    command: ReleaseReviewInvocationLeaseCommand,
  ): Promise<ReviewInvocationLeaseTransitionResult> {
    return this.atomic(() => {
      const lease = this.leases.get(command.leaseId);
      if (!lease) {
        return { status: ReviewInvocationLeaseTransitionStatus.Missing };
      }
      const record = this.recordForExecution(lease.executionId);
      const execution = record?.executions.get(lease.executionId) ?? null;
      const decision = decideLeaseRelease({ lease, execution, ...command });
      if (decision.status === LeaseTransitionDecisionStatus.StaleTerm) {
        return { status: ReviewInvocationLeaseTransitionStatus.StaleTerm };
      }
      this.persistLeaseTransition(record, decision.lease, decision.execution);
      if (decision.status === LeaseTransitionDecisionStatus.Expired) {
        return { status: ReviewInvocationLeaseTransitionStatus.Expired };
      }
      if (decision.status === LeaseTransitionDecisionStatus.Restored) {
        return {
          status: ReviewInvocationLeaseTransitionStatus.Restored,
          lease: cloneLease(decision.lease),
        };
      }
      return {
        status: ReviewInvocationLeaseTransitionStatus.Applied,
        lease: cloneLease(decision.lease),
      };
    });
  }

  async attachObservation(
    command: AttachReviewObservationCommand,
  ): Promise<ReviewObservationAttachmentResult> {
    return this.atomic(() => {
      const target = this.targetSlot(
        command.scope,
        command.executionId,
        command.workSlotId,
      );
      if (!target) {
        return { status: ReviewObservationAttachmentStatus.Missing };
      }
      const lease = this.leases.get(command.leaseId);
      const decision = decideFreshObservationAttachment({
        stream: target.record.stream,
        execution: target.execution,
        slot: target.slot,
        existingRefForSlot: this.observationRefForSlot(
          target.execution.executionId,
          target.slot.workSlotId,
        ),
        existingRefByIdentity:
          this.observationRefs.get(command.observationRefId) ?? null,
        lease: lease ?? null,
        term: command,
        facts: observationFacts(command, command.observationId),
      });
      return this.persistObservationDecision(target.record, decision);
    });
  }

  async attachReusableObservation(
    command: AttachReusableReviewObservationCommand,
  ): Promise<ReviewObservationAttachmentResult> {
    return this.atomic(() => {
      const target = this.targetSlot(
        command.scope,
        command.executionId,
        command.workSlotId,
      );
      if (!target) {
        return { status: ReviewObservationAttachmentStatus.Missing };
      }
      const decision = decideReusableObservationAttachment({
        stream: target.record.stream,
        execution: target.execution,
        slot: target.slot,
        existingRefForSlot: this.observationRefForSlot(
          target.execution.executionId,
          target.slot.workSlotId,
        ),
        existingRefByIdentity:
          this.observationRefs.get(command.observationRefId) ?? null,
        sourceExecutionId: command.sourceExecutionId,
        attachmentKind: command.attachmentKind,
        reuseSafetyDecisionHash: command.reuseSafetyDecisionHash,
        facts: observationFacts(command, command.observationId),
      });
      return this.persistObservationDecision(target.record, decision);
    });
  }

  async adoptObservation(
    command: AdoptAcceptedReviewObservationCommand,
  ): Promise<ReviewObservationAttachmentResult> {
    return this.atomic(() => {
      const target = this.targetSlot(
        command.scope,
        command.executionId,
        command.workSlotId,
      );
      if (!target) {
        return { status: ReviewObservationAttachmentStatus.Missing };
      }
      const sourceLease = this.leases.get(command.sourceLeaseId);
      const decision = decideObservationAdoption({
        stream: target.record.stream,
        execution: target.execution,
        slot: target.slot,
        existingRefForSlot: this.observationRefForSlot(
          target.execution.executionId,
          target.slot.workSlotId,
        ),
        existingRefByIdentity:
          this.observationRefs.get(command.observationRefId) ?? null,
        existingAdoptionLease: this.leases.get(command.adoptionLeaseId) ?? null,
        sourceLease: sourceLease ?? null,
        expectedStreamVersion: command.expectedStreamVersion,
        expectedExecutionVersion: command.expectedExecutionVersion,
        sourceLeaseId: command.sourceLeaseId,
        sourceFencingToken: command.sourceFencingToken,
        adoptionLeaseId: command.adoptionLeaseId,
        adoptionAcquireRequestIdHash: command.adoptionAcquireRequestIdHash,
        adoptionAcquireRequestHash: command.adoptionAcquireRequestHash,
        ownerIdHash: command.ownerIdHash,
        leaseCapabilityId: command.leaseCapabilityId,
        capabilitySigningKeyId: command.capabilitySigningKeyId,
        leaseSafetyDecisionHash: command.leaseSafetyDecisionHash,
        fencingToken: this.fencingTokens.next(),
        retainUntil: command.retainUntil,
        facts: observationFacts(command, command.sourceObservationId),
      });
      return this.persistObservationDecision(target.record, decision);
    });
  }

  async finalizeExecution(command: FinalizeReviewExecutionCommand) {
    return this.atomic(() => {
      const existing = this.artifacts.get(command.executionId);
      const replay = decideExecutionFinalizationReplay({
        executionId: command.executionId,
        existingArtifact: existing ?? null,
        existingArtifactHash:
          this.artifactHashes.get(command.executionId) ?? null,
        artifactHash: command.artifactHash,
      });
      if (
        replay.status === ExecutionFinalizationReplayDecisionStatus.Restored
      ) {
        const record = this.recordForExecution(command.executionId);
        if (record === null) {
          throw new Error("review_execution_artifact_scope_corrupted");
        }
        return {
          status: ReviewExecutionFinalizeStatus.Restored,
          artifact: cloneArtifact(replay.artifact),
          snapshot: this.snapshot(record, command.executionId),
        };
      }
      if (
        replay.status === ExecutionFinalizationReplayDecisionStatus.Conflict
      ) {
        return { status: ReviewExecutionFinalizeStatus.Conflict };
      }
      const record = this.streams.get(scopeKey(command.scope));
      const execution = record?.executions.get(command.executionId);
      if (!record || !execution) {
        return { status: ReviewExecutionFinalizeStatus.Missing };
      }
      if (
        record.stream.version !== command.expectedStreamVersion ||
        execution.version !== command.expectedExecutionVersion
      ) {
        return { status: ReviewExecutionFinalizeStatus.Conflict };
      }
      const activeLeases = this.activeLeases(execution.executionId);
      const decision = decideExecutionFinalization({
        stream: record.stream,
        execution,
        activeLeases,
        ...command,
      });
      if (decision.status === ExecutionFinalizationDecisionStatus.NotRunnable) {
        return { status: ReviewExecutionFinalizeStatus.NotRunnable };
      }
      if (
        decision.status ===
        ExecutionFinalizationDecisionStatus.RequiredCoverageIncomplete
      ) {
        return {
          status: ReviewExecutionFinalizeStatus.RequiredCoverageIncomplete,
        };
      }
      this.persistRevokedLeases(decision.revokedLeases);
      record.executions.set(execution.executionId, decision.execution);
      record.stream = decision.stream;
      this.artifacts.set(execution.executionId, decision.artifact);
      this.artifactHashes.set(execution.executionId, command.artifactHash);
      return {
        status: ReviewExecutionFinalizeStatus.Finalized,
        artifact: cloneArtifact(decision.artifact),
        snapshot: this.snapshot(record, execution.executionId),
      };
    });
  }

  async supersedeExecution(command: SupersedeReviewExecutionCommand) {
    return this.atomic(() => {
      const record = this.streams.get(scopeKey(command.scope));
      const execution = record?.executions.get(command.executionId);
      if (!record || !execution) {
        return { status: ReviewExecutionLifecycleTransitionStatus.Missing };
      }
      const activeLeases = this.activeLeases(execution.executionId);
      const decision = decideExecutionSupersession({
        stream: record.stream,
        execution,
        activeLeases,
        observedCurrentRevision: command.observedCurrentRevision,
        now: command.now,
      });
      if (decision.status === ExecutionLifecycleDecisionStatus.Restored) {
        return {
          status: ReviewExecutionLifecycleTransitionStatus.Restored,
          snapshot: this.snapshot(record, execution.executionId),
        };
      }
      if (record.stream.version !== command.expectedStreamVersion) {
        return {
          status: ReviewExecutionLifecycleTransitionStatus.ConcurrencyConflict,
        };
      }
      if (decision.status === ExecutionLifecycleDecisionStatus.NotEligible) {
        return { status: ReviewExecutionLifecycleTransitionStatus.NotEligible };
      }
      record.executions.set(execution.executionId, decision.execution);
      record.stream = decision.stream;
      this.persistRevokedLeases(decision.revokedLeases);
      return {
        status: ReviewExecutionLifecycleTransitionStatus.Applied,
        snapshot: this.snapshot(record, execution.executionId),
      };
    });
  }

  async failAbandonedPreparedExecution(
    command: FailAbandonedPreparedExecutionCommand,
  ) {
    return this.atomic(() => {
      const record = this.streams.get(scopeKey(command.scope));
      const execution = record?.executions.get(command.executionId);
      if (!record || !execution) {
        return { status: ReviewExecutionLifecycleTransitionStatus.Missing };
      }
      const decision = decideAbandonedPreparationFailure({
        stream: record.stream,
        execution,
        now: command.now,
      });
      if (decision.status === ExecutionLifecycleDecisionStatus.Restored) {
        return {
          status: ReviewExecutionLifecycleTransitionStatus.Restored,
          snapshot: this.snapshot(record, execution.executionId),
        };
      }
      if (record.stream.version !== command.expectedStreamVersion) {
        return {
          status: ReviewExecutionLifecycleTransitionStatus.ConcurrencyConflict,
        };
      }
      if (decision.status === ExecutionLifecycleDecisionStatus.NotEligible) {
        return { status: ReviewExecutionLifecycleTransitionStatus.NotEligible };
      }
      record.executions.set(execution.executionId, decision.execution);
      record.stream = decision.stream;
      return {
        status: ReviewExecutionLifecycleTransitionStatus.Applied,
        snapshot: this.snapshot(record, execution.executionId),
      };
    });
  }

  async terminalizeWorkSlot(command: TerminalizeReviewWorkSlotCommand) {
    return this.atomic(() => {
      const record = this.streams.get(scopeKey(command.scope));
      const execution = record?.executions.get(command.executionId);
      if (!record || !execution) {
        return { status: ReviewExecutionLifecycleTransitionStatus.Missing };
      }
      const decision = decideWorkSlotTerminalization({
        stream: record.stream,
        execution,
        ...command,
      });
      if (decision.status === WorkSlotTerminalizationDecisionStatus.Restored) {
        return {
          status: ReviewExecutionLifecycleTransitionStatus.Restored,
          snapshot: this.snapshot(record, execution.executionId),
        };
      }
      if (
        decision.status === WorkSlotTerminalizationDecisionStatus.NotEligible
      ) {
        return { status: ReviewExecutionLifecycleTransitionStatus.NotEligible };
      }
      if (decision.status === WorkSlotTerminalizationDecisionStatus.Conflict) {
        return {
          status: ReviewExecutionLifecycleTransitionStatus.ConcurrencyConflict,
        };
      }
      record.executions.set(execution.executionId, decision.execution);
      return {
        status: ReviewExecutionLifecycleTransitionStatus.Applied,
        snapshot: this.snapshot(record, execution.executionId),
      };
    });
  }

  async failExpiredRunningExecution(
    command: FailExpiredRunningExecutionCommand,
  ) {
    return this.atomic(() => {
      const record = this.streams.get(scopeKey(command.scope));
      const execution = record?.executions.get(command.executionId);
      if (!record || !execution) {
        return { status: ReviewExecutionLifecycleTransitionStatus.Missing };
      }
      const decision = decideExpiredRunningExecutionFailure({
        stream: record.stream,
        execution,
        activeLeases: this.activeLeases(execution.executionId),
        now: command.now,
      });
      if (decision.status === ExecutionLifecycleDecisionStatus.Restored) {
        return {
          status: ReviewExecutionLifecycleTransitionStatus.Restored,
          snapshot: this.snapshot(record, execution.executionId),
        };
      }
      if (record.stream.version !== command.expectedStreamVersion) {
        return {
          status: ReviewExecutionLifecycleTransitionStatus.ConcurrencyConflict,
        };
      }
      if (decision.status === ExecutionLifecycleDecisionStatus.NotEligible) {
        return { status: ReviewExecutionLifecycleTransitionStatus.NotEligible };
      }
      record.executions.set(execution.executionId, decision.execution);
      record.stream = decision.stream;
      this.persistRevokedLeases(decision.revokedLeases);
      return {
        status: ReviewExecutionLifecycleTransitionStatus.Applied,
        snapshot: this.snapshot(record, execution.executionId),
      };
    });
  }

  async pruneRetainedHistory(input: { readonly limit: number }) {
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit <= 0 ||
      input.limit > 1_000
    ) {
      throw new Error("review_execution_prune_limit_invalid");
    }
    return this.atomic(() => {
      const now = new Date();
      const compacted = [...this.leases.values()]
        .filter(
          (lease) =>
            lease.state !== ReviewInvocationLeaseState.Active &&
            lease.retainUntil < now,
        )
        .sort(
          (left, right) =>
            left.retainUntil.getTime() - right.retainUntil.getTime() ||
            left.leaseId.localeCompare(right.leaseId),
        )
        .slice(0, input.limit);
      for (const lease of compacted) {
        this.leases.delete(lease.leaseId);
        this.leaseTombstones.add(lease.leaseId);
      }

      const candidates = [...this.executionScope.entries()]
        .map(([executionId, key]) => ({
          executionId,
          record: this.streams.get(key),
        }))
        .filter(
          (entry): entry is { executionId: string; record: StreamRecord } =>
            entry.record !== undefined,
        )
        .map((entry) => ({
          ...entry,
          execution: entry.record.executions.get(entry.executionId),
        }))
        .filter(
          (
            entry,
          ): entry is {
            executionId: string;
            record: StreamRecord;
            execution: ReviewExecution;
          } => entry.execution !== undefined,
        )
        .filter(
          ({ execution, record }) =>
            reviewExecutionIsTerminal(execution.state) &&
            execution.retainUntil < now &&
            record.stream.activeExecutionId !== execution.executionId &&
            record.stream.preparedExecutionId !== execution.executionId &&
            ![...this.leases.values()].some(
              (lease) => lease.executionId === execution.executionId,
            ),
        )
        .sort(
          (left, right) =>
            left.execution.retainUntil.getTime() -
              right.execution.retainUntil.getTime() ||
            left.executionId.localeCompare(right.executionId),
        )
        .slice(0, input.limit);
      let deletedObservationRefs = 0;
      let deletedArtifacts = 0;
      let deletedWorkSlots = 0;
      for (const { executionId, record, execution } of candidates) {
        for (const [refId, ref] of this.observationRefs) {
          if (ref.executionId !== executionId) continue;
          this.observationRefs.delete(refId);
          this.observationRefBySlot.delete(
            slotRefKey(ref.executionId, ref.workSlotId),
          );
          deletedObservationRefs += 1;
        }
        if (this.artifacts.delete(executionId)) deletedArtifacts += 1;
        this.artifactHashes.delete(executionId);
        deletedWorkSlots += execution.workSlots.length;
        record.executions.delete(executionId);
        for (const [
          identity,
          indexedExecutionId,
        ] of record.startIdentityIndex) {
          if (indexedExecutionId === executionId) {
            record.startIdentityIndex.delete(identity);
          }
        }
        this.executionScope.delete(executionId);
      }
      return {
        compactedLeases: compacted.length,
        deletedObservationRefs,
        deletedArtifacts,
        deletedWorkSlots,
        deletedExecutions: candidates.length,
      };
    });
  }

  private async atomic<T>(operation: () => T): Promise<T> {
    const previous = this.transactionTail;
    let release!: () => void;
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return operation();
    } finally {
      release();
    }
  }

  private recordForExecution(executionId: string): StreamRecord | null {
    const key = this.executionScope.get(executionId);
    return key ? (this.streams.get(key) ?? null) : null;
  }

  private snapshot(
    record: StreamRecord,
    executionId: string,
  ): ReviewExecutionSnapshot {
    const execution = requiredExecution(record, executionId);
    return {
      stream: cloneStream(record.stream),
      execution: cloneExecution(execution),
      observationRefs: [...this.observationRefs.values()]
        .filter((ref) => ref.executionId === executionId)
        .map(cloneObservationRef),
      activeLeases: [...this.leases.values()]
        .filter(
          (lease) =>
            lease.executionId === executionId &&
            lease.state === ReviewInvocationLeaseState.Active,
        )
        .map(cloneLease),
      artifact: this.artifacts.has(executionId)
        ? cloneArtifact(this.artifacts.get(executionId)!)
        : null,
    };
  }

  private activeLeases(executionId: string): readonly ReviewInvocationLease[] {
    return [...this.leases.values()].filter(
      (lease) =>
        lease.executionId === executionId &&
        lease.state === ReviewInvocationLeaseState.Active,
    );
  }

  private persistRevokedLeases(
    revokedLeases: readonly ReviewInvocationLease[],
  ): void {
    for (const lease of revokedLeases) {
      if (lease.state !== ReviewInvocationLeaseState.Revoked) {
        throw new Error("review_execution_invalid_revoked_lease_write");
      }
      this.leases.set(lease.leaseId, lease);
    }
  }

  private persistLeaseTransition(
    record: StreamRecord | null,
    lease: ReviewInvocationLease,
    execution: ReviewExecution | null,
  ): void {
    this.leases.set(lease.leaseId, lease);
    if (record !== null && execution !== null) {
      record.executions.set(execution.executionId, execution);
    }
  }

  private observationRefForSlot(
    executionId: string,
    workSlotId: string,
  ): ReviewExecutionObservationRef | null {
    const refId = this.observationRefBySlot.get(
      slotRefKey(executionId, workSlotId),
    );
    return refId ? (this.observationRefs.get(refId) ?? null) : null;
  }

  private persistObservationDecision(
    record: StreamRecord,
    decision: ReturnType<
      | typeof decideFreshObservationAttachment
      | typeof decideReusableObservationAttachment
      | typeof decideObservationAdoption
    >,
  ): ReviewObservationAttachmentResult {
    switch (decision.status) {
      case ObservationAttachmentDecisionStatus.Restored:
        return {
          status: ReviewObservationAttachmentStatus.Restored,
          snapshot: this.snapshot(record, decision.observationRef.executionId),
        };
      case ObservationAttachmentDecisionStatus.Conflict:
        return { status: ReviewObservationAttachmentStatus.Conflict };
      case ObservationAttachmentDecisionStatus.NotRunnable:
        return { status: ReviewObservationAttachmentStatus.NotRunnable };
      case ObservationAttachmentDecisionStatus.StaleLease:
        return { status: ReviewObservationAttachmentStatus.StaleLease };
      case ObservationAttachmentDecisionStatus.Ineligible:
        return { status: ReviewObservationAttachmentStatus.Ineligible };
      case ObservationAttachmentDecisionStatus.Attached: {
        const ref = decision.observationRef;
        if (this.observationRefs.has(ref.observationRefId)) {
          throw new Error("review_execution_observation_ref_identity_conflict");
        }
        this.observationRefs.set(ref.observationRefId, ref);
        this.observationRefBySlot.set(
          slotRefKey(ref.executionId, ref.workSlotId),
          ref.observationRefId,
        );
        record.executions.set(
          decision.execution.executionId,
          decision.execution,
        );
        for (const lease of decision.leases) {
          this.leases.set(lease.leaseId, lease);
        }
        return {
          status: ReviewObservationAttachmentStatus.Attached,
          snapshot: this.snapshot(record, decision.execution.executionId),
        };
      }
    }
  }

  private targetSlot(
    scope: ReviewExecutionScope,
    executionId: string,
    workSlotId: string,
  ): {
    readonly record: StreamRecord;
    readonly execution: ReviewExecution;
    readonly slot: ReviewWorkSlot;
  } | null {
    const record = this.streams.get(scopeKey(scope));
    const execution = record?.executions.get(executionId);
    const slot = execution?.workSlots.find(
      (candidate) => candidate.workSlotId === workSlotId,
    );
    return record && execution && slot ? { record, execution, slot } : null;
  }
}

function newStreamRecord(scope: ReviewExecutionScope, now: Date): StreamRecord {
  return {
    stream: createEmptyReviewExecutionStream(scope, now),
    executions: new Map(),
    startIdentityIndex: new Map(),
  };
}

function observationFacts(
  command: {
    readonly observationRefId: string;
    readonly executionId: string;
    readonly workSlotId: string;
    readonly providerInvocationKey: string;
    readonly providerVoteIdentityHash: string;
    readonly payloadHash: string;
    readonly byteCount: number;
    readonly findingCount: number;
    readonly eligibilityPolicyVersion: string;
    readonly now: Date;
  },
  observationId: string,
): ObservationFacts {
  return {
    observationRefId: command.observationRefId,
    observationId,
    executionId: command.executionId,
    workSlotId: command.workSlotId,
    providerInvocationKey: command.providerInvocationKey,
    providerVoteIdentityHash: command.providerVoteIdentityHash,
    payloadHash: command.payloadHash,
    byteCount: command.byteCount,
    findingCount: command.findingCount,
    eligibilityPolicyVersion: command.eligibilityPolicyVersion,
    now: command.now,
  };
}

function requiredExecution(record: StreamRecord, id: string): ReviewExecution {
  const execution = record.executions.get(id);
  if (!execution) {
    throw new Error("review_execution_store_corrupted");
  }
  return execution;
}

function requiredLease(
  leases: Map<string, ReviewInvocationLease>,
  id: string,
): ReviewInvocationLease {
  const lease = leases.get(id);
  if (!lease) {
    throw new Error("review_execution_lease_store_corrupted");
  }
  return lease;
}

function startIdentityKey(authorizationId: string, hash: string): string {
  return `${authorizationId}\0${hash}`;
}

function leaseAcquireKey(command: AcquireReviewInvocationLeaseCommand): string {
  return [
    command.executionId,
    command.providerInvocationKey,
    command.acquireRequestIdHash,
  ].join("\0");
}

function slotRefKey(executionId: string, workSlotId: string): string {
  return `${executionId}\0${workSlotId}`;
}

function cloneStream(stream: ReviewExecutionStream): ReviewExecutionStream {
  return {
    ...stream,
    currentRevision: stream.currentRevision
      ? { ...stream.currentRevision }
      : null,
    updatedAt: new Date(stream.updatedAt),
  };
}

function cloneExecution(execution: ReviewExecution): ReviewExecution {
  return {
    ...execution,
    revision: { ...execution.revision },
    workSlots: execution.workSlots.map((slot) => ({ ...slot })),
    createdAt: new Date(execution.createdAt),
    updatedAt: new Date(execution.updatedAt),
    admissionDeadlineAt: new Date(execution.admissionDeadlineAt),
    admissionCheckedAt: execution.admissionCheckedAt
      ? new Date(execution.admissionCheckedAt)
      : null,
    executionDeadlineAt: new Date(execution.executionDeadlineAt),
    retainUntil: new Date(execution.retainUntil),
  };
}

function cloneLease(lease: ReviewInvocationLease): ReviewInvocationLease {
  return {
    ...lease,
    acquiredAt: new Date(lease.acquiredAt),
    renewedAt: new Date(lease.renewedAt),
    expiresAt: new Date(lease.expiresAt),
    resultReportUntil: new Date(lease.resultReportUntil),
    retainUntil: new Date(lease.retainUntil),
  };
}

function cloneObservationRef(
  ref: ReviewExecutionObservationRef,
): ReviewExecutionObservationRef {
  return { ...ref, attachedAt: new Date(ref.attachedAt) };
}

function cloneArtifact(
  artifact: FinalizedReviewProjectionArtifact,
): FinalizedReviewProjectionArtifact {
  return {
    ...artifact,
    publicationPermit: {
      ...artifact.publicationPermit,
      publicationNotAfter: new Date(
        artifact.publicationPermit.publicationNotAfter,
      ),
    },
    createdAt: new Date(artifact.createdAt),
    retainUntil: new Date(artifact.retainUntil),
  };
}
