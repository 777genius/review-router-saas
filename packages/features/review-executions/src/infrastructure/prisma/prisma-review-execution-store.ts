import { createHash } from "node:crypto";
import {
  Prisma,
  ReviewInvocationLeaseStateV2 as PrismaLeaseState,
  type PrismaClient,
  type ReviewExecutionV2 as ExecutionRecord,
  type ReviewInvocationLeaseV2 as LeaseRecord,
} from "@prisma/client";
import {
  ReviewExecutionAdmissionStatus,
  ReviewExecutionAdmissionVerdict,
  ReviewExecutionFinalizeStatus,
  ReviewExecutionLifecycleTransitionStatus,
  ReviewExecutionPrepareStatus,
  ReviewInvocationLeaseAcquireStatus,
  ReviewInvocationLeaseTransitionStatus,
  ReviewObservationAttachmentStatus,
  type AcquireReviewInvocationLeaseCommand,
  type AdoptAcceptedReviewObservationCommand,
  type AttachReusableReviewObservationCommand,
  type AttachReviewObservationCommand,
  type ConfirmReviewExecutionAdmissionCommand,
  type FailAbandonedPreparedExecutionCommand,
  type FailExpiredRunningExecutionCommand,
  type FinalizeReviewExecutionCommand,
  type PrepareReviewExecutionCommand,
  type ReleaseReviewInvocationLeaseCommand,
  type RenewReviewInvocationLeaseCommand,
  type ReviewExecutionCommandPort,
  type ReviewExecutionPrunerPort,
  type ReviewExecutionQueryPort,
  type ReviewInvocationLeaseAcquireResult,
  type ReviewInvocationLeaseTransitionResult,
  type ReviewObservationAttachmentResult,
  type SupersedeReviewExecutionCommand,
  type TerminalizeReviewWorkSlotCommand,
} from "../../application/ports/review-execution-ports";
import type { InvocationFlightQueryPort } from "../../application/ports/invocation-flight-ports";
import {
  createEmptyReviewExecutionStream,
  reviewRevisionsEqual,
  reviewExecutionAbsoluteMaxWorkSlots,
  type FinalizedReviewProjectionArtifact,
  type ReviewExecution,
  type ReviewExecutionObservationRef,
  type ReviewExecutionScope,
  type ReviewExecutionSnapshot,
  type ReviewExecutionStream,
  type ReviewInvocationLease,
  ReviewInvocationLeasePurpose,
  ReviewExecutionState,
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
  type ObservationAttachmentDecision,
  type ObservationFacts,
} from "../../domain/review-execution-transitions";
import {
  restoreInvocationFlight,
  type InvocationFlight,
} from "../../domain/invocation-flight";
import {
  artifactFromRecord,
  attachmentKindToPrisma,
  coverageStateToPrisma,
  executionStateToPrisma,
  executionToDomain,
  leasePurposeToPrisma,
  leaseStateToPrisma,
  leaseToDomain,
  observationRefToDomain,
  providerKindToPrisma,
  streamToDomain,
  taskKindToPrisma,
  workSlotStateToPrisma,
} from "./prisma-review-execution-mappers";
import {
  databaseRelativeDate,
  isTransactionConflictError,
} from "./prisma-review-execution-utils";
type Transaction = Prisma.TransactionClient;

export type ReviewExecutionProgressCapturePort = (
  transaction: Transaction,
  execution: ReviewExecution,
) => Promise<void>;

export class PrismaReviewExecutionStore
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
    assertLimit(input.limit);
    const records = await this.prisma.reviewExecutionV2.findMany({
      where: {
        state: "running",
        executionDeadlineAt: { lte: input.now },
      },
      orderBy: [{ executionDeadlineAt: "asc" }, { executionId: "asc" }],
      take: input.limit,
    });
    const snapshots = await Promise.all(
      records.map((record) => this.findExecution(record.executionId)),
    );
    return snapshots.filter(
      (snapshot): snapshot is ReviewExecutionSnapshot =>
        snapshot !== null &&
        snapshot.stream.activeExecutionId === snapshot.execution.executionId,
    );
  }
  constructor(
    private readonly prisma: PrismaClient,
    private readonly options: Readonly<{
      progressCapture?: ReviewExecutionProgressCapturePort;
    }> = {},
  ) {}

  private async captureProgress(
    transaction: Transaction,
    execution: ReviewExecution,
  ): Promise<void> {
    await this.options.progressCapture?.(transaction, execution);
  }

  async findStream(
    scope: ReviewExecutionScope,
  ): Promise<ReviewExecutionStream | null> {
    const record = await this.prisma.reviewExecutionStreamV2.findFirst({
      where: scopeWhere(scope),
    });
    return record === null ? null : streamToDomain(record);
  }

  async findExecution(
    executionId: string,
  ): Promise<ReviewExecutionSnapshot | null> {
    return this.prisma.$transaction((transaction) =>
      loadSnapshot(transaction, executionId),
    );
  }

  async findByStartIdentity(input: {
    readonly scope: ReviewExecutionScope;
    readonly authorizationId: string;
    readonly startIdentityHash: string;
  }): Promise<ReviewExecutionSnapshot | null> {
    return this.prisma.$transaction(async (transaction) => {
      const record = await transaction.reviewExecutionV2.findFirst({
        where: {
          ...scopeWhere(input.scope),
          authorizationId: input.authorizationId,
          startIdentityHash: input.startIdentityHash,
        },
      });
      return record === null
        ? null
        : loadSnapshot(transaction, record.executionId);
    });
  }

  async findLease(leaseId: string): Promise<ReviewInvocationLease | null> {
    const record = await this.prisma.reviewInvocationLeaseV2.findUnique({
      where: { leaseId },
    });
    return record === null ? null : leaseToDomain(record);
  }

  async findProviderExecutionLeaseByAttemptId(
    attemptId: string,
  ): Promise<ReviewInvocationLease | null> {
    const record = await this.prisma.reviewInvocationLeaseV2.findUnique({
      where: { attemptId },
    });
    return record === null ? null : leaseToDomain(record);
  }

  /**
   * Legacy repository-owned flight observation remains available to its exact
   * callers during the mixed fleet. It is an observation/join path only; new
   * admission and lease capacity are fenced by the scope-local path below.
   */
  async observeActiveInvocationFlightByLane(input: {
    readonly providerVoteIdentityHash: string;
    readonly requestedAt: Date;
  }): Promise<Readonly<{ flight: InvocationFlight | null; observedAt: Date }>> {
    return this.prisma.$transaction(async (transaction) => {
      const observedAt = await databaseNow(transaction);
      const incumbents = await transaction.reviewInvocationLeaseV2.findMany({
        where: {
          providerVoteIdentityHash: input.providerVoteIdentityHash,
          purpose: leasePurposeToPrisma(
            ReviewInvocationLeasePurpose.ProviderExecution,
          ),
          state: PrismaLeaseState.active,
        },
        orderBy: { leaseId: "asc" },
        take: 2,
      });
      if (incumbents.length > 1) {
        throw new Error("review_provider_lane_invariant_violated");
      }
      const record = incumbents[0];
      if (record === undefined) return { flight: null, observedAt };
      const executionRecord = await transaction.reviewExecutionV2.findUnique({
        where: { executionId: record.executionId },
      });
      if (executionRecord === null) {
        throw new Error("invocation_flight_owner_execution_missing");
      }
      const execution = await loadExecution(transaction, executionRecord);
      const slot = execution.workSlots.find(
        (candidate) => candidate.workSlotId === record.workSlotId,
      );
      if (slot === undefined) {
        throw new Error("invocation_flight_owner_slot_missing");
      }
      return {
        flight: restoreInvocationFlight({
          execution,
          slot,
          lease: leaseToDomain(record),
        }),
        observedAt,
      };
    });
  }

  async observeActiveInvocationFlight(input: {
    readonly scope: ReviewExecutionScope;
    readonly providerInvocationKey: string;
    readonly providerVoteIdentityHash: string;
    readonly requestedAt: Date;
  }): Promise<Readonly<{ flight: InvocationFlight | null; observedAt: Date }>> {
    return this.prisma.$transaction(async (transaction) => {
      const observedAt = await databaseNow(transaction);
      // Shared only: this fences the fleet cutover transaction while the
      // observer chooses its read shape. It is not invocation capacity or an
      // account-wide provider lock.
      await transaction.$queryRaw`
        SELECT pg_advisory_xact_lock_shared(1381126735, 1381192279) IS NULL AS "locked"
      `;
      const controls = await transaction.$queryRaw<
        Array<{ activated: boolean }>
      >`
        SELECT "activated"
        FROM "ReviewProviderScopeConcurrencyControl"
        WHERE "singleton" = true
      `;
      if (controls.length !== 1) {
        throw new Error("review_provider_scope_concurrency_control_missing");
      }
      const activated = controls[0]!.activated;
      const incumbents = await transaction.reviewInvocationLeaseV2.findMany({
        where: {
          ...(activated
            ? {
                ...scopeWhere(input.scope),
                providerInvocationKey: input.providerInvocationKey,
              }
            : {
                providerVoteIdentityHash: input.providerVoteIdentityHash,
              }),
          purpose: leasePurposeToPrisma(
            ReviewInvocationLeasePurpose.ProviderExecution,
          ),
          state: PrismaLeaseState.active,
        },
        orderBy: { leaseId: "asc" },
        take: 2,
      });
      if (incumbents.length > 1) {
        throw new Error(
          activated
            ? "review_provider_invocation_invariant_violated"
            : "review_provider_lane_invariant_violated",
        );
      }
      const record = incumbents[0];
      if (record === undefined) return { flight: null, observedAt };
      const executionRecord = await transaction.reviewExecutionV2.findUnique({
        where: { executionId: record.executionId },
      });
      if (executionRecord === null) {
        throw new Error("invocation_flight_owner_execution_missing");
      }
      const execution = await loadExecution(transaction, executionRecord);
      const slot = execution.workSlots.find(
        (candidate) => candidate.workSlotId === record.workSlotId,
      );
      if (slot === undefined) {
        throw new Error("invocation_flight_owner_slot_missing");
      }
      return {
        flight: restoreInvocationFlight({
          execution,
          slot,
          lease: leaseToDomain(record),
        }),
        observedAt,
      };
    });
  }

  async prepareExecution(command: PrepareReviewExecutionCommand) {
    for (let attempt = 1; attempt <= transactionRetryLimit; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          async (transaction) => {
            await lockScope(transaction, command.scope);
            const existing = await transaction.reviewExecutionV2.findFirst({
              where: {
                ...scopeWhere(command.scope),
                authorizationId: command.authorizationId,
                startIdentityHash: command.startIdentityHash,
              },
            });
            if (existing !== null) {
              const execution = await loadExecution(transaction, existing);
              const replay = decideExecutionPreparationReplay({
                existingByStartIdentity: execution,
                canonicalStartHash: command.canonicalStartHash,
              });
              if (
                replay.status ===
                ExecutionPreparationReplayDecisionStatus.Restored
              ) {
                return {
                  status: ReviewExecutionPrepareStatus.Restored,
                  snapshot: requiredSnapshot(
                    await loadSnapshot(transaction, existing.executionId),
                  ),
                };
              }
              return {
                status: ReviewExecutionPrepareStatus.IdempotencyConflict,
              };
            }

            const now = await databaseNow(transaction);
            await ensureStream(transaction, command.scope, now);
            await lockStream(transaction, command.scope);
            const streamRecord = await requiredStreamRecord(
              transaction,
              command.scope,
            );
            const stream = streamToDomain(streamRecord);
            if (stream.version !== command.expectedStreamVersion) {
              return {
                status: ReviewExecutionPrepareStatus.ConcurrencyConflict,
              };
            }
            if (
              await transaction.reviewExecutionV2.findUnique({
                where: { executionId: command.executionId },
              })
            ) {
              return {
                status: ReviewExecutionPrepareStatus.IdempotencyConflict,
              };
            }
            const priorPreparedRecord =
              stream.preparedExecutionId === null
                ? null
                : await transaction.reviewExecutionV2.findUnique({
                    where: { executionId: stream.preparedExecutionId },
                  });
            const priorPrepared =
              priorPreparedRecord === null
                ? null
                : await loadExecution(transaction, priorPreparedRecord);
            const decision = decideExecutionPreparation({
              stream,
              priorPrepared,
              ...command,
              now,
              admissionDeadlineAt: databaseRelativeDate(
                now,
                command.now,
                command.admissionDeadlineAt,
                "admission_deadline",
              ),
              executionDeadlineAt: databaseRelativeDate(
                now,
                command.now,
                command.executionDeadlineAt,
                "execution_deadline",
              ),
              retainUntil: databaseRelativeDate(
                now,
                command.now,
                command.retainUntil,
                "retention_deadline",
              ),
            });
            if (decision.supersededPrepared !== null) {
              if (priorPrepared === null) {
                throw new Error("review_execution_prepared_row_missing");
              }
              await persistExecutionUpdate(
                transaction,
                priorPrepared,
                decision.supersededPrepared,
              );
              await this.captureProgress(
                transaction,
                decision.supersededPrepared,
              );
            }
            await createExecution(transaction, decision.execution);
            await this.captureProgress(transaction, decision.execution);
            await persistStreamUpdate(transaction, stream, decision.stream);
            return {
              status: ReviewExecutionPrepareStatus.Prepared,
              snapshot: requiredSnapshot(
                await loadSnapshot(transaction, decision.execution.executionId),
              ),
            };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
        );
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          return this.resolvePrepareRace(command);
        }
        if (isSerializationError(error)) {
          if (attempt < transactionRetryLimit) {
            await pauseBeforeTransactionRetry(command.scope, attempt);
            continue;
          }
          return this.resolvePrepareRace(command);
        }
        throw error;
      }
    }
    throw new Error("review_execution_prepare_retry_unreachable");
  }

  async confirmAdmission(command: ConfirmReviewExecutionAdmissionCommand) {
    for (let attempt = 1; attempt <= transactionRetryLimit; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          async (transaction) => {
            await lockScope(transaction, command.scope);
            await lockStream(transaction, command.scope);
            const streamRecord =
              await transaction.reviewExecutionStreamV2.findFirst({
                where: scopeWhere(command.scope),
              });
            const executionRecord =
              await transaction.reviewExecutionV2.findUnique({
                where: { executionId: command.executionId },
              });
            if (streamRecord === null || executionRecord === null) {
              return { status: ReviewExecutionAdmissionStatus.Missing };
            }
            const stream = streamToDomain(streamRecord);
            const execution = await loadExecution(transaction, executionRecord);
            const priorActiveRecord =
              stream.activeExecutionId !== null &&
              stream.activeExecutionId !== execution.executionId
                ? await transaction.reviewExecutionV2.findUnique({
                    where: { executionId: stream.activeExecutionId },
                  })
                : null;
            if (
              stream.activeExecutionId !== null &&
              stream.activeExecutionId !== execution.executionId &&
              priorActiveRecord === null
            ) {
              throw new Error("review_execution_active_pointer_corrupted");
            }
            const priorActive =
              priorActiveRecord === null
                ? null
                : await loadExecution(transaction, priorActiveRecord);
            if (
              priorActive !== null &&
              !sameScope(priorActive, command.scope)
            ) {
              throw new Error("review_execution_active_scope_corrupted");
            }
            const priorActiveLeases =
              priorActive === null
                ? []
                : await loadActiveLeases(transaction, priorActive.executionId);
            const decision = decideExecutionAdmission({
              stream,
              execution,
              priorActive,
              priorActiveLeases,
              authorizationId: command.authorizationId,
              mutationEpoch: command.mutationEpoch,
              requestedRevision: command.requestedRevision,
              observedRevision: command.observedRevision,
              verdict: admissionVerdict(command.verdict),
              checkedAt: await databaseNow(transaction),
            });
            if (decision.status === ExecutionAdmissionDecisionStatus.Restored) {
              return {
                status: ReviewExecutionAdmissionStatus.Restored,
                snapshot: requiredSnapshot(
                  await loadSnapshot(transaction, execution.executionId),
                ),
              };
            }
            if (
              decision.status === ExecutionAdmissionDecisionStatus.Superseded &&
              decision.stream.version === stream.version
            ) {
              return {
                status: ReviewExecutionAdmissionStatus.Superseded,
                snapshot: requiredSnapshot(
                  await loadSnapshot(transaction, execution.executionId),
                ),
              };
            }
            if (stream.version !== command.expectedStreamVersion) {
              return {
                status: ReviewExecutionAdmissionStatus.ConcurrencyConflict,
              };
            }
            if (
              decision.status === ExecutionAdmissionDecisionStatus.NotPrepared
            ) {
              return { status: ReviewExecutionAdmissionStatus.NotPrepared };
            }
            if (decision.status === ExecutionAdmissionDecisionStatus.Deferred) {
              return {
                status: ReviewExecutionAdmissionStatus.Deferred,
                snapshot: requiredSnapshot(
                  await loadSnapshot(transaction, execution.executionId),
                ),
              };
            }
            await persistExecutionUpdate(
              transaction,
              execution,
              decision.execution,
            );
            await this.captureProgress(transaction, decision.execution);
            if (decision.supersededPriorActive !== null) {
              if (priorActive === null) {
                throw new Error("review_execution_prior_active_missing");
              }
              await persistExecutionUpdate(
                transaction,
                priorActive,
                decision.supersededPriorActive,
              );
              await this.captureProgress(
                transaction,
                decision.supersededPriorActive,
              );
            }
            await persistLeaseStates(transaction, decision.revokedPriorLeases);
            await persistStreamUpdate(transaction, stream, decision.stream);
            return {
              status:
                decision.status === ExecutionAdmissionDecisionStatus.Admitted
                  ? ReviewExecutionAdmissionStatus.Admitted
                  : ReviewExecutionAdmissionStatus.Superseded,
              snapshot: requiredSnapshot(
                await loadSnapshot(transaction, execution.executionId),
              ),
            };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
        );
      } catch (error) {
        if (isSerializationError(error)) {
          if (attempt < transactionRetryLimit) {
            await pauseBeforeTransactionRetry(command.scope, attempt);
            continue;
          }
          return this.resolveAdmissionSerializationExhaustion(command);
        }
        throw error;
      }
    }
    throw new Error("review_execution_admission_retry_unreachable");
  }

  async acquireLease(
    command: AcquireReviewInvocationLeaseCommand,
  ): Promise<ReviewInvocationLeaseAcquireResult> {
    for (
      let attempt = 1;
      attempt <= acquireTransactionRetryLimit;
      attempt += 1
    ) {
      try {
        return await this.prisma.$transaction(
          async (transaction) => {
            await lockScopes(transaction, [command.scope]);
            const executionIdentity =
              await transaction.reviewExecutionV2.findUnique({
                where: { executionId: command.executionId },
                select: { generation: true },
              });
            const existing =
              executionIdentity === null
                ? null
                : await transaction.reviewInvocationLeaseV2.findFirst({
                    where: {
                      ...scopeWhere(command.scope),
                      executionGeneration: executionIdentity.generation,
                      providerInvocationKey: command.providerInvocationKey,
                      acquireRequestIdHash: command.acquireRequestIdHash,
                    },
                  });
            const replay = decideLeaseAcquireReplay({
              existingByAcquireIdentity:
                existing === null ? null : leaseToDomain(existing),
              scope: command.scope,
              executionId: command.executionId,
              acquireRequestIdHash: command.acquireRequestIdHash,
              acquireRequestHash: command.acquireRequestHash,
              ownerIdHash: command.ownerIdHash,
              providerInvocationKey: command.providerInvocationKey,
              preparedManifestCanonicalJson:
                command.preparedManifestCanonicalJson,
              preparedManifestKey: command.preparedManifestKey,
              providerVoteIdentityHash: command.providerVoteIdentityHash,
              workSlotId: command.workSlotId,
              purpose: command.purpose,
            });
            if (replay.status === LeaseAcquireReplayDecisionStatus.Restored) {
              return {
                status: ReviewInvocationLeaseAcquireStatus.Restored,
                lease: replay.lease,
              };
            }
            if (
              replay.status ===
              LeaseAcquireReplayDecisionStatus.IdempotencyConflict
            ) {
              return {
                status: ReviewInvocationLeaseAcquireStatus.IdempotencyConflict,
              };
            }
            await lockStream(transaction, command.scope);
            await lockExecution(transaction, command.executionId);
            await lockWorkSlot(
              transaction,
              command.executionId,
              command.workSlotId,
            );
            let snapshot = await loadSnapshot(transaction, command.executionId);
            if (snapshot === null) {
              return { status: ReviewInvocationLeaseAcquireStatus.Missing };
            }
            const now = await databaseNow(transaction);
            let decision = await decideLeaseAcquireForSnapshot(
              transaction,
              snapshot,
              command,
              now,
            );
            const early = await persistEarlyLeaseAcquireResult(
              transaction,
              decision,
              snapshot,
              command.executionId,
            );
            if (early !== null) {
              if (early.snapshot) {
                await this.captureProgress(
                  transaction,
                  early.snapshot.execution,
                );
              }
              return early;
            }
            if (decision.status !== LeaseAcquireDecisionStatus.Acquired) {
              throw new Error("review_lease_acquire_decision_unhandled");
            }
            if (
              command.purpose === ReviewInvocationLeasePurpose.ProviderExecution
            ) {
              const incumbentRecords =
                await transaction.reviewInvocationLeaseV2.findMany({
                  where: {
                    ...scopeWhere(command.scope),
                    providerInvocationKey: command.providerInvocationKey,
                    purpose: leasePurposeToPrisma(
                      ReviewInvocationLeasePurpose.ProviderExecution,
                    ),
                    state: PrismaLeaseState.active,
                  },
                  orderBy: { leaseId: "asc" },
                  take: 2,
                });
              if (incumbentRecords.length > 1) {
                throw new Error(
                  "review_provider_invocation_invariant_violated",
                );
              }
              const incumbentRecord = incumbentRecords[0] ?? null;
              if (incumbentRecord !== null) {
                const incumbent = leaseToDomain(incumbentRecord);
                const locallyExpiring =
                  decision.expiredLease?.leaseId === incumbent.leaseId;
                if (!locallyExpiring && incumbent.expiresAt > now) {
                  return { status: ReviewInvocationLeaseAcquireStatus.Busy };
                }
                if (!locallyExpiring) {
                  const incumbentExecutionRecord =
                    await transaction.reviewExecutionV2.findUnique({
                      where: { executionId: incumbent.executionId },
                    });
                  const incumbentExecution = incumbentExecutionRecord
                    ? await loadExecution(transaction, incumbentExecutionRecord)
                    : null;
                  const expiry = decideLeaseExpiry({
                    lease: incumbent,
                    execution: incumbentExecution,
                    now,
                  });
                  await persistLeaseTransition(
                    transaction,
                    incumbent,
                    expiry.lease,
                    incumbentExecution,
                    expiry.execution,
                    this.options.progressCapture,
                  );
                  snapshot = await loadSnapshot(
                    transaction,
                    command.executionId,
                  );
                  if (snapshot === null) {
                    return {
                      status: ReviewInvocationLeaseAcquireStatus.Missing,
                    };
                  }
                  decision = await decideLeaseAcquireForSnapshot(
                    transaction,
                    snapshot,
                    command,
                    now,
                  );
                  const recomputedEarly = await persistEarlyLeaseAcquireResult(
                    transaction,
                    decision,
                    snapshot,
                    command.executionId,
                  );
                  if (recomputedEarly !== null) {
                    if (recomputedEarly.snapshot) {
                      await this.captureProgress(
                        transaction,
                        recomputedEarly.snapshot.execution,
                      );
                    }
                    return recomputedEarly;
                  }
                  if (decision.status !== LeaseAcquireDecisionStatus.Acquired) {
                    throw new Error("review_lease_acquire_decision_unhandled");
                  }
                }
              }
            }
            if (decision.expiredLease !== null) {
              await persistSingleLeaseState(transaction, decision.expiredLease);
            }
            await persistExecutionUpdate(
              transaction,
              snapshot.execution,
              decision.execution,
            );
            await assertLeaseIdentityNotTombstoned(transaction, decision.lease);
            await transaction.reviewInvocationLeaseV2.create({
              data: leaseCreateData(decision.lease),
            });
            await this.captureProgress(transaction, decision.execution);
            return {
              status: ReviewInvocationLeaseAcquireStatus.Acquired,
              lease: decision.lease,
              snapshot: requiredSnapshot(
                await loadSnapshot(transaction, command.executionId),
              ),
            };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (
          command.purpose === ReviewInvocationLeasePurpose.ProviderExecution &&
          isLegacyProviderVoteLaneUniqueConstraintError(error)
        ) {
          return { status: ReviewInvocationLeaseAcquireStatus.Busy };
        }
        if (isUniqueConstraintError(error)) {
          return this.resolveLeaseAcquireRace(command);
        }
        if (isSerializationError(error)) {
          if (attempt < acquireTransactionRetryLimit) {
            await pauseBeforeTransactionRetry(command.scope, attempt);
            continue;
          }
          return this.resolveLeaseAcquireSerializationExhaustion(command);
        }
        throw error;
      }
    }
    throw new Error("review_execution_lease_acquire_retry_unreachable");
  }

  async renewLease(
    command: RenewReviewInvocationLeaseCommand,
  ): Promise<ReviewInvocationLeaseTransitionResult> {
    return this.transitionLease(command, (input) =>
      decideLeaseRenewal({
        ...input,
        renewRequestIdHash: command.renewRequestIdHash,
        renewRequestHash: command.renewRequestHash,
        expiresAt: command.expiresAt,
        resultReportUntil: command.resultReportUntil,
        limits: command.limits,
      }),
    );
  }

  async releaseLease(
    command: ReleaseReviewInvocationLeaseCommand,
  ): Promise<ReviewInvocationLeaseTransitionResult> {
    return this.transitionLease(command, decideLeaseRelease);
  }

  async attachObservation(
    command: AttachReviewObservationCommand,
  ): Promise<ReviewObservationAttachmentResult> {
    return this.attach(command, async (transaction, target, now) => {
      const lease = await loadLease(transaction, command.leaseId);
      return decideFreshObservationAttachment({
        stream: target.stream,
        execution: target.execution,
        slot: target.slot,
        existingRefForSlot: target.existingRefForSlot,
        existingRefByIdentity: target.existingRefByIdentity,
        lease,
        term: command,
        facts: observationFacts(command, command.observationId, now),
      });
    });
  }

  async attachReusableObservation(
    command: AttachReusableReviewObservationCommand,
  ): Promise<ReviewObservationAttachmentResult> {
    return this.attach(command, async (_transaction, target, now) =>
      decideReusableObservationAttachment({
        stream: target.stream,
        execution: target.execution,
        slot: target.slot,
        existingRefForSlot: target.existingRefForSlot,
        existingRefByIdentity: target.existingRefByIdentity,
        sourceExecutionId: command.sourceExecutionId,
        attachmentKind: command.attachmentKind,
        reuseSafetyDecisionHash: command.reuseSafetyDecisionHash,
        facts: observationFacts(command, command.observationId, now),
      }),
    );
  }

  async adoptObservation(
    command: AdoptAcceptedReviewObservationCommand,
  ): Promise<ReviewObservationAttachmentResult> {
    return this.attach(command, async (transaction, target, now) => {
      const sourceLease = await loadLease(transaction, command.sourceLeaseId);
      const existingAdoptionLease = await loadLease(
        transaction,
        command.adoptionLeaseId,
      );
      const fencingToken = await nextLeaseFencingToken(transaction);
      return decideObservationAdoption({
        stream: target.stream,
        execution: target.execution,
        slot: target.slot,
        existingRefForSlot: target.existingRefForSlot,
        existingRefByIdentity: target.existingRefByIdentity,
        existingAdoptionLease,
        sourceLease,
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
        fencingToken,
        retainUntil: databaseRelativeDate(
          now,
          command.now,
          command.retainUntil,
          "adoption_retention_deadline",
        ),
        facts: observationFacts(command, command.sourceObservationId, now),
      });
    });
  }

  async finalizeExecution(command: FinalizeReviewExecutionCommand) {
    try {
      return await this.prisma.$transaction(
        async (transaction) => {
          await lockScope(transaction, command.scope);
          await lockStream(transaction, command.scope);
          await lockExecution(transaction, command.executionId);
          const existingRecord =
            await transaction.finalizedReviewProjectionArtifactV2.findUnique({
              where: { executionId: command.executionId },
            });
          if (existingRecord !== null) {
            await assertFinalizedOutbox(
              transaction,
              command.executionId,
              existingRecord.artifactId,
              existingRecord.artifactHash,
            );
            const executionRecord =
              await transaction.reviewExecutionV2.findUnique({
                where: { executionId: command.executionId },
              });
            if (executionRecord === null) {
              throw new Error("review_execution_artifact_scope_corrupted");
            }
            const artifact = artifactFromRecord(
              existingRecord,
              executionRecord,
            );
            const replay = decideExecutionFinalizationReplay({
              executionId: command.executionId,
              existingArtifact: artifact,
              existingArtifactHash: existingRecord.artifactHash,
              artifactHash: command.artifactHash,
            });
            if (
              replay.status ===
              ExecutionFinalizationReplayDecisionStatus.Restored
            ) {
              return {
                status: ReviewExecutionFinalizeStatus.Restored,
                artifact: replay.artifact,
                snapshot: requiredSnapshot(
                  await loadSnapshot(transaction, command.executionId),
                ),
              };
            }
            return { status: ReviewExecutionFinalizeStatus.Conflict };
          }
          const snapshot = await loadSnapshot(transaction, command.executionId);
          if (snapshot === null) {
            return { status: ReviewExecutionFinalizeStatus.Missing };
          }
          if (
            snapshot.stream.version !== command.expectedStreamVersion ||
            snapshot.execution.version !== command.expectedExecutionVersion
          ) {
            return { status: ReviewExecutionFinalizeStatus.Conflict };
          }
          const now = await databaseNow(transaction);
          const decision = decideExecutionFinalization({
            stream: snapshot.stream,
            execution: snapshot.execution,
            activeLeases: snapshot.activeLeases,
            ...command,
            now,
            publicationNotAfter: databaseRelativeDate(
              now,
              command.now,
              command.publicationNotAfter,
              "publication_deadline",
            ),
            retainUntil: databaseRelativeDate(
              now,
              command.now,
              command.retainUntil,
              "artifact_retention_deadline",
            ),
          });
          if (
            decision.status === ExecutionFinalizationDecisionStatus.NotRunnable
          ) {
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
          await persistLeaseStates(transaction, decision.revokedLeases);
          await persistExecutionUpdate(
            transaction,
            snapshot.execution,
            decision.execution,
          );
          await this.captureProgress(transaction, decision.execution);
          await persistStreamUpdate(
            transaction,
            snapshot.stream,
            decision.stream,
          );
          await transaction.finalizedReviewProjectionArtifactV2.create({
            data: artifactCreateData(decision.artifact, command.artifactHash),
          });
          await transaction.outboxEvent.create({
            data: finalizedOutboxData(decision.artifact, command.artifactHash),
          });
          return {
            status: ReviewExecutionFinalizeStatus.Finalized,
            artifact: decision.artifact,
            snapshot: requiredSnapshot(
              await loadSnapshot(transaction, command.executionId),
            ),
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return this.resolveFinalizationRace(command);
      }
      if (isSerializationError(error)) {
        return { status: ReviewExecutionFinalizeStatus.Conflict };
      }
      throw error;
    }
  }

  async supersedeExecution(command: SupersedeReviewExecutionCommand) {
    return this.transitionExecutionLifecycle(command, (snapshot, now) =>
      decideExecutionSupersession({
        stream: snapshot.stream,
        execution: snapshot.execution,
        activeLeases: snapshot.activeLeases,
        observedCurrentRevision: command.observedCurrentRevision,
        now,
      }),
    );
  }

  async failAbandonedPreparedExecution(
    command: FailAbandonedPreparedExecutionCommand,
  ) {
    return this.transitionExecutionLifecycle(command, (snapshot, now) =>
      decideAbandonedPreparationFailure({
        stream: snapshot.stream,
        execution: snapshot.execution,
        now,
      }),
    );
  }

  async terminalizeWorkSlot(command: TerminalizeReviewWorkSlotCommand) {
    try {
      return await this.prisma.$transaction(
        async (transaction) => {
          await lockScope(transaction, command.scope);
          await lockStream(transaction, command.scope);
          await lockExecution(transaction, command.executionId);
          await lockWorkSlot(
            transaction,
            command.executionId,
            command.workSlotId,
          );
          const snapshot = await loadSnapshot(transaction, command.executionId);
          if (snapshot === null) {
            return { status: ReviewExecutionLifecycleTransitionStatus.Missing };
          }
          const decision = decideWorkSlotTerminalization({
            stream: snapshot.stream,
            execution: snapshot.execution,
            ...command,
            now: await databaseNow(transaction),
          });
          if (
            decision.status === WorkSlotTerminalizationDecisionStatus.Restored
          ) {
            return {
              status: ReviewExecutionLifecycleTransitionStatus.Restored,
              snapshot,
            };
          }
          if (
            decision.status ===
            WorkSlotTerminalizationDecisionStatus.NotEligible
          ) {
            return {
              status: ReviewExecutionLifecycleTransitionStatus.NotEligible,
            };
          }
          if (
            decision.status === WorkSlotTerminalizationDecisionStatus.Conflict
          ) {
            return {
              status:
                ReviewExecutionLifecycleTransitionStatus.ConcurrencyConflict,
            };
          }
          await persistExecutionUpdate(
            transaction,
            snapshot.execution,
            decision.execution,
          );
          await this.captureProgress(transaction, decision.execution);
          return {
            status: ReviewExecutionLifecycleTransitionStatus.Applied,
            snapshot: requiredSnapshot(
              await loadSnapshot(transaction, command.executionId),
            ),
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (isSerializationError(error)) {
        return {
          status: ReviewExecutionLifecycleTransitionStatus.ConcurrencyConflict,
        };
      }
      throw error;
    }
  }

  async failExpiredRunningExecution(
    command: FailExpiredRunningExecutionCommand,
  ) {
    return this.transitionExecutionLifecycle(command, (snapshot, now) =>
      decideExpiredRunningExecutionFailure({
        stream: snapshot.stream,
        execution: snapshot.execution,
        activeLeases: snapshot.activeLeases,
        now,
      }),
    );
  }

  async pruneRetainedHistory(input: { readonly limit: number }) {
    assertLimit(input.limit);
    return this.prisma.$transaction(
      async (transaction) => {
        const compactedLeases = await compactRetainedLeases(
          transaction,
          input.limit,
        );
        const candidateIds = await terminalPruneCandidates(
          transaction,
          input.limit,
        );
        if (candidateIds.length === 0) {
          return {
            compactedLeases,
            deletedObservationRefs: 0,
            deletedArtifacts: 0,
            deletedWorkSlots: 0,
            deletedExecutions: 0,
          };
        }
        const removableExecutionIds = await executionIdsWithoutDependents(
          transaction,
          candidateIds,
        );
        await transaction.reviewExecutionProgressV1.deleteMany({
          where: { executionId: { in: removableExecutionIds } },
        });
        const deletedObservationRefs = (
          await transaction.reviewExecutionObservationRefV2.deleteMany({
            where: { executionId: { in: removableExecutionIds } },
          })
        ).count;
        const deletedArtifacts = (
          await transaction.finalizedReviewProjectionArtifactV2.deleteMany({
            where: { executionId: { in: removableExecutionIds } },
          })
        ).count;
        const deletedWorkSlots = (
          await transaction.reviewExecutionWorkSlotV2.deleteMany({
            where: { executionId: { in: removableExecutionIds } },
          })
        ).count;
        const deletedExecutions = (
          await transaction.reviewExecutionV2.deleteMany({
            where: { executionId: { in: removableExecutionIds } },
          })
        ).count;
        return {
          compactedLeases,
          deletedObservationRefs,
          deletedArtifacts,
          deletedWorkSlots,
          deletedExecutions,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  private async transitionLease(
    command:
      | RenewReviewInvocationLeaseCommand
      | ReleaseReviewInvocationLeaseCommand,
    decide: (input: {
      readonly lease: ReviewInvocationLease;
      readonly execution: ReviewExecution | null;
      readonly ownerIdHash: string;
      readonly leaseCapabilityId: string;
      readonly fencingToken: bigint;
      readonly now: Date;
    }) => ReturnType<typeof decideLeaseRelease>,
  ): Promise<ReviewInvocationLeaseTransitionResult> {
    try {
      return await this.prisma.$transaction(
        async (transaction) => {
          const observedLease = await loadLease(transaction, command.leaseId);
          if (observedLease === null) {
            return { status: ReviewInvocationLeaseTransitionStatus.Missing };
          }
          await lockScope(transaction, observedLease);
          await lockStream(transaction, observedLease);
          await lockExecution(transaction, observedLease.executionId);
          await lockWorkSlot(
            transaction,
            observedLease.executionId,
            observedLease.workSlotId,
          );
          await lockLease(transaction, command.leaseId);
          const lease = await loadLease(transaction, command.leaseId);
          if (lease === null) {
            return { status: ReviewInvocationLeaseTransitionStatus.Missing };
          }
          const executionRecord =
            await transaction.reviewExecutionV2.findUnique({
              where: { executionId: lease.executionId },
            });
          const execution =
            executionRecord === null
              ? null
              : await loadExecution(transaction, executionRecord);
          const decision = decide({
            lease,
            execution,
            ownerIdHash: command.ownerIdHash,
            leaseCapabilityId: command.leaseCapabilityId,
            fencingToken: command.fencingToken,
            now: await databaseNow(transaction),
          });
          if (decision.status === LeaseTransitionDecisionStatus.StaleTerm) {
            return { status: ReviewInvocationLeaseTransitionStatus.StaleTerm };
          }
          if (
            decision.status === LeaseTransitionDecisionStatus.InvalidDeadline
          ) {
            return {
              status: ReviewInvocationLeaseTransitionStatus.InvalidDeadline,
            };
          }
          if (
            decision.status ===
            LeaseTransitionDecisionStatus.IdempotencyConflict
          ) {
            return {
              status: ReviewInvocationLeaseTransitionStatus.IdempotencyConflict,
            };
          }
          await persistLeaseTransition(
            transaction,
            lease,
            decision.lease,
            execution,
            decision.execution,
            this.options.progressCapture,
          );
          if (decision.status === LeaseTransitionDecisionStatus.Expired) {
            return { status: ReviewInvocationLeaseTransitionStatus.Expired };
          }
          return {
            status:
              decision.status === LeaseTransitionDecisionStatus.Restored
                ? ReviewInvocationLeaseTransitionStatus.Restored
                : ReviewInvocationLeaseTransitionStatus.Applied,
            lease: decision.lease,
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (isSerializationError(error)) {
        return { status: ReviewInvocationLeaseTransitionStatus.StaleTerm };
      }
      throw error;
    }
  }

  private async attach(
    command:
      | AttachReviewObservationCommand
      | AttachReusableReviewObservationCommand
      | AdoptAcceptedReviewObservationCommand,
    decide: (
      transaction: Transaction,
      target: AttachmentTarget,
      now: Date,
    ) => Promise<ObservationAttachmentDecision>,
  ): Promise<ReviewObservationAttachmentResult> {
    // This transaction only mutates local execution state. A complete retry
    // reloads all fences and cannot repeat a provider or SCM side effect.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          async (transaction) => {
            await lockScope(transaction, command.scope);
            await lockStream(transaction, command.scope);
            await lockExecution(transaction, command.executionId);
            await lockWorkSlot(
              transaction,
              command.executionId,
              command.workSlotId,
            );
            const target = await loadAttachmentTarget(transaction, command);
            if (target === null) {
              return { status: ReviewObservationAttachmentStatus.Missing };
            }
            const decision = await decide(
              transaction,
              target,
              await databaseNow(transaction),
            );
            const result = await persistObservationDecision(
              transaction,
              target,
              decision,
            );
            if (
              result.status === ReviewObservationAttachmentStatus.Attached &&
              result.snapshot
            ) {
              await this.captureProgress(
                transaction,
                result.snapshot.execution,
              );
            }
            return result;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          const restored = await this.findExecution(command.executionId);
          const ref = restored?.observationRefs.find(
            (entry) => entry.workSlotId === command.workSlotId,
          );
          return ref?.observationRefId === command.observationRefId
            ? {
                status: ReviewObservationAttachmentStatus.Restored,
                snapshot: restored ?? undefined,
              }
            : { status: ReviewObservationAttachmentStatus.Conflict };
        }
        if (isSerializationError(error) && attempt < 3) continue;
        throw error;
      }
    }
    throw new Error("review_execution_attachment_retry_exhausted");
  }

  private async transitionExecutionLifecycle(
    command:
      | SupersedeReviewExecutionCommand
      | FailAbandonedPreparedExecutionCommand
      | FailExpiredRunningExecutionCommand,
    decide: (
      snapshot: ReviewExecutionSnapshot,
      now: Date,
    ) => ReturnType<typeof decideAbandonedPreparationFailure>,
  ) {
    try {
      return await this.prisma.$transaction(
        async (transaction) => {
          await lockScope(transaction, command.scope);
          await lockStream(transaction, command.scope);
          await lockExecution(transaction, command.executionId);
          const snapshot = await loadSnapshot(transaction, command.executionId);
          if (snapshot === null) {
            return {
              status: ReviewExecutionLifecycleTransitionStatus.Missing,
            };
          }
          const decision = decide(snapshot, await databaseNow(transaction));
          if (decision.status === ExecutionLifecycleDecisionStatus.Restored) {
            return {
              status: ReviewExecutionLifecycleTransitionStatus.Restored,
              snapshot,
            };
          }
          if (snapshot.stream.version !== command.expectedStreamVersion) {
            return {
              status:
                ReviewExecutionLifecycleTransitionStatus.ConcurrencyConflict,
            };
          }
          if (
            decision.status === ExecutionLifecycleDecisionStatus.NotEligible
          ) {
            return {
              status: ReviewExecutionLifecycleTransitionStatus.NotEligible,
            };
          }
          await persistLeaseStates(transaction, decision.revokedLeases);
          await persistExecutionUpdate(
            transaction,
            snapshot.execution,
            decision.execution,
          );
          await this.captureProgress(transaction, decision.execution);
          await persistStreamUpdate(
            transaction,
            snapshot.stream,
            decision.stream,
          );
          return {
            status: ReviewExecutionLifecycleTransitionStatus.Applied,
            snapshot: requiredSnapshot(
              await loadSnapshot(transaction, command.executionId),
            ),
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (isSerializationError(error)) {
        return {
          status: ReviewExecutionLifecycleTransitionStatus.ConcurrencyConflict,
        };
      }
      throw error;
    }
  }

  private async resolvePrepareRace(command: PrepareReviewExecutionCommand) {
    const existing = await this.findByStartIdentity({
      scope: command.scope,
      authorizationId: command.authorizationId,
      startIdentityHash: command.startIdentityHash,
    });
    if (existing === null) {
      return { status: ReviewExecutionPrepareStatus.ConcurrencyConflict };
    }
    return existing.execution.canonicalStartHash === command.canonicalStartHash
      ? {
          status: ReviewExecutionPrepareStatus.Restored,
          snapshot: existing,
        }
      : { status: ReviewExecutionPrepareStatus.IdempotencyConflict };
  }

  private async resolveAdmissionSerializationExhaustion(
    command: ConfirmReviewExecutionAdmissionCommand,
  ) {
    const snapshot = await this.findExecution(command.executionId);
    if (snapshot === null || !sameScope(snapshot.execution, command.scope)) {
      return { status: ReviewExecutionAdmissionStatus.ConcurrencyConflict };
    }
    const identityMatches =
      snapshot.execution.authorizationId === command.authorizationId &&
      snapshot.execution.mutationEpoch === command.mutationEpoch &&
      reviewRevisionsEqual(
        snapshot.execution.revision,
        command.requestedRevision,
      );
    if (
      identityMatches &&
      snapshot.execution.state === ReviewExecutionState.Running &&
      snapshot.stream.activeExecutionId === command.executionId
    ) {
      return {
        status: ReviewExecutionAdmissionStatus.Restored,
        snapshot,
      };
    }
    if (
      identityMatches &&
      command.verdict === ReviewExecutionAdmissionVerdict.Stale &&
      snapshot.execution.state === ReviewExecutionState.Superseded
    ) {
      return {
        status: ReviewExecutionAdmissionStatus.Superseded,
        snapshot,
      };
    }
    if (
      identityMatches &&
      command.verdict === ReviewExecutionAdmissionVerdict.Unavailable &&
      snapshot.execution.state === ReviewExecutionState.Planned &&
      snapshot.stream.preparedExecutionId === command.executionId &&
      snapshot.stream.version === command.expectedStreamVersion
    ) {
      return {
        status: ReviewExecutionAdmissionStatus.Deferred,
        snapshot,
      };
    }
    return { status: ReviewExecutionAdmissionStatus.ConcurrencyConflict };
  }

  private async resolveLeaseAcquireRace(
    command: AcquireReviewInvocationLeaseCommand,
  ): Promise<ReviewInvocationLeaseAcquireResult> {
    const execution = await this.findExecution(command.executionId);
    if (execution === null) {
      return { status: ReviewInvocationLeaseAcquireStatus.Missing };
    }
    const record = await this.prisma.reviewInvocationLeaseV2.findFirst({
      where: {
        ...scopeWhere(command.scope),
        executionGeneration: execution.execution.generation,
        providerInvocationKey: command.providerInvocationKey,
        acquireRequestIdHash: command.acquireRequestIdHash,
      },
    });
    if (record === null) {
      if (command.purpose === ReviewInvocationLeasePurpose.ProviderExecution) {
        // During the rolling migration, the retired vote-hash-only partial
        // index can still reject an otherwise unrelated scope with P2002.
        // Report contention; never reinterpret that incumbent as joinable.
        const incumbent = await this.prisma.reviewInvocationLeaseV2.findFirst({
          where: {
            providerVoteIdentityHash: command.providerVoteIdentityHash,
            purpose: leasePurposeToPrisma(
              ReviewInvocationLeasePurpose.ProviderExecution,
            ),
            state: PrismaLeaseState.active,
          },
          select: { leaseId: true },
        });
        if (incumbent !== null) {
          return { status: ReviewInvocationLeaseAcquireStatus.Busy };
        }
      }
      throw new Error("review_execution_lease_unique_invariant_violated");
    }
    const lease = leaseToDomain(record);
    const replay = decideLeaseAcquireReplay({
      existingByAcquireIdentity: lease,
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
    return replay.status === LeaseAcquireReplayDecisionStatus.Restored
      ? {
          status: ReviewInvocationLeaseAcquireStatus.Restored,
          lease,
        }
      : {
          status: ReviewInvocationLeaseAcquireStatus.IdempotencyConflict,
        };
  }

  private async resolveLeaseAcquireSerializationExhaustion(
    command: AcquireReviewInvocationLeaseCommand,
  ): Promise<ReviewInvocationLeaseAcquireResult> {
    const execution = await this.findExecution(command.executionId);
    if (execution === null) {
      return { status: ReviewInvocationLeaseAcquireStatus.Missing };
    }
    const record = await this.prisma.reviewInvocationLeaseV2.findFirst({
      where: {
        ...scopeWhere(command.scope),
        executionGeneration: execution.execution.generation,
        providerInvocationKey: command.providerInvocationKey,
        acquireRequestIdHash: command.acquireRequestIdHash,
      },
    });
    if (record === null) {
      // The API deliberately has no generic transaction-conflict result. Once
      // bounded retries are exhausted, fail closed as contention; never claim
      // that provider work was acquired when commit is unknown.
      return { status: ReviewInvocationLeaseAcquireStatus.Busy };
    }
    const lease = leaseToDomain(record);
    const replay = decideLeaseAcquireReplay({
      existingByAcquireIdentity: lease,
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
    return replay.status === LeaseAcquireReplayDecisionStatus.Restored
      ? { status: ReviewInvocationLeaseAcquireStatus.Restored, lease }
      : { status: ReviewInvocationLeaseAcquireStatus.IdempotencyConflict };
  }

  private async resolveFinalizationRace(
    command: FinalizeReviewExecutionCommand,
  ) {
    const snapshot = await this.findExecution(command.executionId);
    if (snapshot?.artifact === null || snapshot === null) {
      return { status: ReviewExecutionFinalizeStatus.Conflict };
    }
    const record =
      await this.prisma.finalizedReviewProjectionArtifactV2.findUnique({
        where: { executionId: command.executionId },
      });
    return record?.artifactHash === command.artifactHash
      ? {
          status: ReviewExecutionFinalizeStatus.Restored,
          artifact: snapshot.artifact,
          snapshot,
        }
      : { status: ReviewExecutionFinalizeStatus.Conflict };
  }
}

type AttachmentTarget = {
  readonly stream: ReviewExecutionStream;
  readonly execution: ReviewExecution;
  readonly slot: ReviewWorkSlot;
  readonly existingRefForSlot: ReviewExecutionObservationRef | null;
  readonly existingRefByIdentity: ReviewExecutionObservationRef | null;
};

async function loadSnapshot(
  transaction: Transaction,
  executionId: string,
): Promise<ReviewExecutionSnapshot | null> {
  const record = await transaction.reviewExecutionV2.findUnique({
    where: { executionId },
  });
  if (record === null) return null;
  const execution = await loadExecution(transaction, record);
  const streamRecord = await transaction.reviewExecutionStreamV2.findFirst({
    where: scopeWhere(record),
  });
  const refs = await transaction.reviewExecutionObservationRefV2.findMany({
    where: { executionId },
    orderBy: { workSlotId: "asc" },
    take: reviewExecutionAbsoluteMaxWorkSlots + 1,
  });
  const leases = await transaction.reviewInvocationLeaseV2.findMany({
    where: {
      executionId,
      state: PrismaLeaseState.active,
    },
    orderBy: { leaseId: "asc" },
    take: reviewExecutionAbsoluteMaxWorkSlots + 1,
  });
  const artifactRecord =
    await transaction.finalizedReviewProjectionArtifactV2.findUnique({
      where: { executionId },
    });
  if (streamRecord === null) {
    throw new Error("review_execution_stream_missing");
  }
  assertBoundedAggregateCollection(refs, "observation_refs");
  assertBoundedAggregateCollection(leases, "active_leases");
  return {
    stream: streamToDomain(streamRecord),
    execution,
    observationRefs: Object.freeze(refs.map(observationRefToDomain)),
    activeLeases: Object.freeze(leases.map(leaseToDomain)),
    artifact:
      artifactRecord === null
        ? null
        : artifactFromRecord(artifactRecord, execution),
  };
}

async function loadExecution(
  transaction: Transaction,
  record: ExecutionRecord,
): Promise<ReviewExecution> {
  const workSlots = await transaction.reviewExecutionWorkSlotV2.findMany({
    where: { executionId: record.executionId },
    orderBy: { planOrdinal: "asc" },
    take: reviewExecutionAbsoluteMaxWorkSlots + 1,
  });
  assertBoundedAggregateCollection(workSlots, "work_slots");
  return executionToDomain(record, workSlots);
}

async function loadActiveLeases(
  transaction: Transaction,
  executionId: string,
): Promise<readonly ReviewInvocationLease[]> {
  const records = await transaction.reviewInvocationLeaseV2.findMany({
    where: { executionId, state: PrismaLeaseState.active },
    orderBy: { leaseId: "asc" },
    take: reviewExecutionAbsoluteMaxWorkSlots + 1,
  });
  assertBoundedAggregateCollection(records, "active_leases");
  return records.map(leaseToDomain);
}

async function loadLease(
  transaction: Transaction,
  leaseId: string,
): Promise<ReviewInvocationLease | null> {
  const record = await transaction.reviewInvocationLeaseV2.findUnique({
    where: { leaseId },
  });
  return record === null ? null : leaseToDomain(record);
}

async function loadAttachmentTarget(
  transaction: Transaction,
  command: {
    readonly scope: ReviewExecutionScope;
    readonly executionId: string;
    readonly workSlotId: string;
    readonly observationRefId: string;
  },
): Promise<AttachmentTarget | null> {
  const snapshot = await loadSnapshot(transaction, command.executionId);
  if (snapshot === null || !sameScope(snapshot.execution, command.scope)) {
    return null;
  }
  const slot = snapshot.execution.workSlots.find(
    (entry) => entry.workSlotId === command.workSlotId,
  );
  if (slot === undefined) return null;
  const existingRefForSlot =
    await transaction.reviewExecutionObservationRefV2.findFirst({
      where: {
        executionId: command.executionId,
        workSlotId: command.workSlotId,
      },
    });
  const existingRefByIdentity =
    await transaction.reviewExecutionObservationRefV2.findUnique({
      where: { observationRefId: command.observationRefId },
    });
  return {
    stream: snapshot.stream,
    execution: snapshot.execution,
    slot,
    existingRefForSlot:
      existingRefForSlot === null
        ? null
        : observationRefToDomain(existingRefForSlot),
    existingRefByIdentity:
      existingRefByIdentity === null
        ? null
        : observationRefToDomain(existingRefByIdentity),
  };
}

async function persistObservationDecision(
  transaction: Transaction,
  target: AttachmentTarget,
  decision: ObservationAttachmentDecision,
): Promise<ReviewObservationAttachmentResult> {
  switch (decision.status) {
    case ObservationAttachmentDecisionStatus.Restored:
      return {
        status: ReviewObservationAttachmentStatus.Restored,
        snapshot: requiredSnapshot(
          await loadSnapshot(transaction, target.execution.executionId),
        ),
      };
    case ObservationAttachmentDecisionStatus.Conflict:
      return { status: ReviewObservationAttachmentStatus.Conflict };
    case ObservationAttachmentDecisionStatus.NotRunnable:
      return { status: ReviewObservationAttachmentStatus.NotRunnable };
    case ObservationAttachmentDecisionStatus.StaleLease:
      return { status: ReviewObservationAttachmentStatus.StaleLease };
    case ObservationAttachmentDecisionStatus.Ineligible:
      return { status: ReviewObservationAttachmentStatus.Ineligible };
    case ObservationAttachmentDecisionStatus.Attached:
      await transaction.reviewExecutionObservationRefV2.create({
        data: observationRefCreateData(decision.observationRef),
      });
      await persistExecutionUpdate(
        transaction,
        target.execution,
        decision.execution,
      );
      for (const lease of decision.leases) {
        const existing = await transaction.reviewInvocationLeaseV2.findUnique({
          where: { leaseId: lease.leaseId },
        });
        if (existing === null) {
          await assertLeaseIdentityNotTombstoned(transaction, lease);
          await transaction.reviewInvocationLeaseV2.create({
            data: leaseCreateData(lease),
          });
        } else {
          await persistSingleLeaseState(transaction, lease);
        }
      }
      return {
        status: ReviewObservationAttachmentStatus.Attached,
        snapshot: requiredSnapshot(
          await loadSnapshot(transaction, target.execution.executionId),
        ),
      };
  }
}

async function persistStreamUpdate(
  transaction: Transaction,
  current: ReviewExecutionStream,
  next: ReviewExecutionStream,
): Promise<void> {
  const result = await transaction.reviewExecutionStreamV2.updateMany({
    where: { ...scopeWhere(current), version: current.version },
    data: {
      version: next.version,
      activeExecutionId: next.activeExecutionId,
      preparedExecutionId: next.preparedExecutionId,
      lastAllocatedGeneration: next.lastAllocatedGeneration,
      currentBaseSha: next.currentRevision?.baseSha ?? null,
      currentMergeBaseSha: next.currentRevision?.mergeBaseSha ?? null,
      currentHeadSha: next.currentRevision?.headSha ?? null,
      currentReviewRevisionHash:
        next.currentRevision?.reviewRevisionHash ?? null,
      updatedAt: next.updatedAt,
    },
  });
  if (result.count !== 1) throw new ConcurrentExecutionMutationError();
}

async function persistExecutionUpdate(
  transaction: Transaction,
  current: ReviewExecution,
  next: ReviewExecution,
): Promise<void> {
  const result = await transaction.reviewExecutionV2.updateMany({
    where: { executionId: current.executionId, version: current.version },
    data: executionMutableData(next),
  });
  if (result.count !== 1) throw new ConcurrentExecutionMutationError();
  for (const slot of next.workSlots) {
    const updated = await transaction.reviewExecutionWorkSlotV2.updateMany({
      where: { executionId: next.executionId, workSlotId: slot.workSlotId },
      data: workSlotMutableData(slot),
    });
    if (updated.count !== 1) {
      throw new Error("review_execution_work_slot_missing");
    }
  }
}

async function createExecution(
  transaction: Transaction,
  execution: ReviewExecution,
): Promise<void> {
  await transaction.reviewExecutionV2.create({
    data: executionCreateData(execution),
  });
  await transaction.reviewExecutionWorkSlotV2.createMany({
    data: execution.workSlots.map((slot, planOrdinal) => ({
      executionId: execution.executionId,
      planOrdinal,
      workSlotId: slot.workSlotId,
      taskKind: taskKindToPrisma(slot.taskKind),
      providerKind: providerKindToPrisma(slot.providerKind),
      providerVoteIdentityHash: slot.providerVoteIdentityHash,
      shardKey: slot.shardKey,
      required: slot.required,
      attemptBudget: slot.attemptBudget,
      retryPolicyVersion: slot.retryPolicyVersion,
      ...workSlotMutableData(slot),
    })),
  });
}

async function persistLeaseTransition(
  transaction: Transaction,
  currentLease: ReviewInvocationLease,
  nextLease: ReviewInvocationLease,
  currentExecution: ReviewExecution | null,
  nextExecution: ReviewExecution | null,
  progressCapture: ReviewExecutionProgressCapturePort | undefined,
): Promise<void> {
  const updated = await transaction.reviewInvocationLeaseV2.updateMany({
    where: {
      leaseId: currentLease.leaseId,
      ownerIdHash: currentLease.ownerIdHash,
      leaseCapabilityId: currentLease.leaseCapabilityId,
      fencingToken: currentLease.fencingToken,
    },
    data: {
      state: leaseStateToPrisma(nextLease.state),
      renewedAt: nextLease.renewedAt,
      expiresAt: nextLease.expiresAt,
      resultReportUntil: nextLease.resultReportUntil,
      lastRenewRequestIdHash: nextLease.lastRenewRequestIdHash,
      lastRenewRequestHash: nextLease.lastRenewRequestHash,
    },
  });
  if (updated.count !== 1) throw new ConcurrentExecutionMutationError();
  if (
    currentExecution !== null &&
    nextExecution !== null &&
    nextExecution.version !== currentExecution.version
  ) {
    await persistExecutionUpdate(transaction, currentExecution, nextExecution);
    await progressCapture?.(transaction, nextExecution);
  }
}

async function persistLeaseStates(
  transaction: Transaction,
  leases: readonly ReviewInvocationLease[],
): Promise<void> {
  for (const lease of leases) await persistSingleLeaseState(transaction, lease);
}

async function persistSingleLeaseState(
  transaction: Transaction,
  lease: ReviewInvocationLease,
): Promise<void> {
  const updated = await transaction.reviewInvocationLeaseV2.updateMany({
    where: { leaseId: lease.leaseId, fencingToken: lease.fencingToken },
    data: {
      state: leaseStateToPrisma(lease.state),
      renewedAt: lease.renewedAt,
      expiresAt: lease.expiresAt,
      resultReportUntil: lease.resultReportUntil,
    },
  });
  if (updated.count !== 1) throw new ConcurrentExecutionMutationError();
}

async function assertLeaseIdentityNotTombstoned(
  transaction: Transaction,
  lease: ReviewInvocationLease,
): Promise<void> {
  const tombstone =
    await transaction.reviewInvocationLeaseTombstoneV2.findFirst({
      where: {
        OR: [
          { leaseId: lease.leaseId },
          { leaseCapabilityId: lease.leaseCapabilityId },
          { fencingToken: lease.fencingToken },
        ],
      },
      select: { leaseId: true },
    });
  if (tombstone !== null) {
    throw new Error("review_execution_lease_identity_reused");
  }
}

async function ensureStream(
  transaction: Transaction,
  scope: ReviewExecutionScope,
  now: Date,
): Promise<void> {
  const empty = createEmptyReviewExecutionStream(scope, now);
  await transaction.$executeRaw(
    Prisma.sql`
      INSERT INTO "ReviewExecutionStreamV2" (
        "workspaceId", "repositoryConnectionId", "scmRepositoryIdentityId",
        "pullRequestNumber", version, "lastAllocatedGeneration", "updatedAt"
      ) VALUES (
        ${empty.workspaceId}, ${empty.repositoryConnectionId},
        ${empty.scmRepositoryIdentityId}, ${empty.pullRequestNumber},
        ${empty.version}, ${empty.lastAllocatedGeneration}, ${empty.updatedAt}
      )
      ON CONFLICT DO NOTHING
    `,
  );
}

async function requiredStreamRecord(
  transaction: Transaction,
  scope: ReviewExecutionScope,
) {
  const record = await transaction.reviewExecutionStreamV2.findFirst({
    where: scopeWhere(scope),
  });
  if (record === null) throw new Error("review_execution_stream_missing");
  return record;
}

function executionCreateData(execution: ReviewExecution) {
  return {
    executionId: execution.executionId,
    ...scopeWhere(execution),
    generation: execution.generation,
    version: execution.version,
    baseSha: execution.revision.baseSha,
    mergeBaseSha: execution.revision.mergeBaseSha,
    headSha: execution.revision.headSha,
    reviewRevisionHash: execution.revision.reviewRevisionHash,
    compatibilityKey: execution.compatibilityKey,
    planHash: execution.planHash,
    assignmentManifestVersion: execution.assignmentManifestVersion ?? null,
    assignmentManifestHash: execution.assignmentManifestHash ?? null,
    assignmentManifestJson:
      execution.assignmentManifestCanonicalJson === null ||
      execution.assignmentManifestCanonicalJson === undefined
        ? Prisma.DbNull
        : parseAssignmentManifestJson(
            execution.assignmentManifestCanonicalJson,
          ),
    startIdentityHash: execution.startIdentityHash,
    canonicalStartHash: execution.canonicalStartHash,
    state: executionStateToPrisma(execution.state),
    authorizationId: execution.authorizationId,
    producerReleaseId: execution.producerReleaseId,
    mutationEpoch: execution.mutationEpoch,
    admissionSafetyDecisionHash: execution.admissionSafetyDecisionHash,
    protocolLimitsProfileId: execution.protocolLimitsProfileId,
    sourceRunId: execution.sourceRunId,
    sourceRunAttempt: execution.sourceRunAttempt,
    supersededByExecutionId: execution.supersededByExecutionId,
    finalizedArtifactId: execution.finalizedArtifactId,
    createdAt: execution.createdAt,
    updatedAt: execution.updatedAt,
    admissionDeadlineAt: execution.admissionDeadlineAt,
    admissionCheckedAt: execution.admissionCheckedAt,
    executionDeadlineAt: execution.executionDeadlineAt,
    retainUntil: execution.retainUntil,
  };
}

function parseAssignmentManifestJson(value: string): Prisma.InputJsonObject {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("review_assignment_manifest_not_object");
  }
  return parsed as Prisma.InputJsonObject;
}

function executionMutableData(execution: ReviewExecution) {
  return {
    version: execution.version,
    state: executionStateToPrisma(execution.state),
    supersededByExecutionId: execution.supersededByExecutionId,
    finalizedArtifactId: execution.finalizedArtifactId,
    updatedAt: execution.updatedAt,
    admissionCheckedAt: execution.admissionCheckedAt,
  };
}

function workSlotMutableData(slot: ReviewWorkSlot) {
  return {
    state: workSlotStateToPrisma(slot.state),
    nextAttemptOrdinal: slot.nextAttemptOrdinal,
    activeLeaseId: slot.activeLeaseId,
    acceptedObservationRefId: slot.acceptedObservationRefId,
  };
}

function leaseCreateData(lease: ReviewInvocationLease) {
  return {
    leaseId: lease.leaseId,
    ...scopeWhere(lease),
    executionId: lease.executionId,
    executionGeneration: lease.executionGeneration,
    providerInvocationKey: lease.providerInvocationKey,
    preparedManifestCanonicalJson: lease.preparedManifestCanonicalJson,
    preparedManifestKey: lease.preparedManifestKey,
    providerVoteIdentityHash: lease.providerVoteIdentityHash,
    workSlotId: lease.workSlotId,
    purpose: leasePurposeToPrisma(lease.purpose),
    authorizationId: lease.authorizationId,
    producerReleaseId: lease.producerReleaseId,
    reviewRevisionHash: lease.reviewRevisionHash,
    mutationEpoch: lease.mutationEpoch,
    leaseSafetyDecisionHash: lease.leaseSafetyDecisionHash,
    attemptId: lease.attemptId,
    sourceObservationId: lease.sourceObservationId,
    attemptOrdinal: lease.attemptOrdinal,
    acquireRequestIdHash: lease.acquireRequestIdHash,
    acquireRequestHash: lease.acquireRequestHash,
    lastRenewRequestIdHash: lease.lastRenewRequestIdHash,
    lastRenewRequestHash: lease.lastRenewRequestHash,
    ownerIdHash: lease.ownerIdHash,
    leaseCapabilityId: lease.leaseCapabilityId,
    capabilitySigningKeyId: lease.capabilitySigningKeyId,
    fencingToken: lease.fencingToken,
    state: leaseStateToPrisma(lease.state),
    acquiredAt: lease.acquiredAt,
    renewedAt: lease.renewedAt,
    expiresAt: lease.expiresAt,
    resultReportUntil: lease.resultReportUntil,
    retainUntil: lease.retainUntil,
  };
}

function observationRefCreateData(ref: ReviewExecutionObservationRef) {
  return {
    observationRefId: ref.observationRefId,
    executionId: ref.executionId,
    workSlotId: ref.workSlotId,
    providerInvocationKey: ref.providerInvocationKey,
    observationId: ref.observationId,
    providerVoteIdentityHash: ref.providerVoteIdentityHash,
    attachmentKind: attachmentKindToPrisma(ref.attachmentKind),
    eligibilityPolicyVersion: ref.eligibilityPolicyVersion,
    reuseSafetyDecisionHash: ref.reuseSafetyDecisionHash,
    sourceExecutionId: ref.sourceExecutionId,
    sourceLeaseId: ref.sourceLeaseId,
    sourceFencingToken: ref.sourceFencingToken,
    payloadHash: ref.payloadHash,
    byteCount: ref.byteCount,
    findingCount: ref.findingCount,
    attachedAt: ref.attachedAt,
  };
}

function artifactCreateData(
  artifact: FinalizedReviewProjectionArtifact,
  artifactHash: string,
) {
  const projectionEnvelope = parseProjectionEnvelope(
    artifact.projectionEnvelopeJson,
  );
  return {
    artifactId: artifact.artifactId,
    executionId: artifact.executionId,
    artifactHash,
    generation: artifact.generation,
    reviewedHeadSha: artifact.reviewedHeadSha,
    reviewRevisionHash: artifact.reviewRevisionHash,
    coverageState: coverageStateToPrisma(artifact.coverageState),
    projectionEnvelopeVersion: artifact.projectionEnvelopeVersion,
    projectionEnvelope,
    projectionEnvelopeCanonicalJson: artifact.projectionEnvelopeJson,
    projectionHash: artifact.projectionHash,
    byteCount: artifact.byteCount,
    findingCount: artifact.findingCount,
    lifecycleStateHash: artifact.lifecycleStateHash,
    commandLedgerWatermark: artifact.commandLedgerWatermark,
    projectionPolicyVersion: artifact.projectionPolicyVersion,
    authorizationId: artifact.publicationPermit.authorizationId,
    producerReleaseId: artifact.publicationPermit.producerReleaseId,
    permitEpoch: artifact.publicationPermit.permitEpoch,
    publicationSafetyDecisionHash:
      artifact.publicationPermit.publicationSafetyDecisionHash,
    publicationNotAfter: artifact.publicationPermit.publicationNotAfter,
    createdAt: artifact.createdAt,
    retainUntil: artifact.retainUntil,
  };
}

function finalizedOutboxData(
  artifact: FinalizedReviewProjectionArtifact,
  artifactHash: string,
): Prisma.OutboxEventUncheckedCreateInput {
  return {
    type: "review.execution.finalized",
    version: 2,
    idempotencyKey: finalizedOutboxIdentity(artifact.executionId),
    workspaceId: artifact.publicationPermit.workspaceId,
    repositoryId: artifact.publicationPermit.repositoryConnectionId,
    aggregateId: artifact.executionId,
    payload: {
      executionId: artifact.executionId,
      artifactId: artifact.artifactId,
      artifactHash,
      generation: artifact.generation.toString(),
      reviewRevisionHash: artifact.reviewRevisionHash,
      projectionHash: artifact.projectionHash,
    },
    occurredAt: artifact.createdAt,
  };
}

async function assertFinalizedOutbox(
  transaction: Transaction,
  executionId: string,
  artifactId: string,
  artifactHash: string,
): Promise<void> {
  const event = await transaction.outboxEvent.findUnique({
    where: { idempotencyKey: finalizedOutboxIdentity(executionId) },
  });
  if (
    event === null ||
    event.type !== "review.execution.finalized" ||
    event.version !== 2 ||
    event.aggregateId !== executionId ||
    !sameFinalizedOutboxPayload(
      event.payload,
      executionId,
      artifactId,
      artifactHash,
    )
  ) {
    throw new Error("review_execution_finalized_outbox_corrupted");
  }
}

function sameFinalizedOutboxPayload(
  value: Prisma.JsonValue,
  executionId: string,
  artifactId: string,
  artifactHash: string,
): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    value.executionId === executionId &&
    value.artifactId === artifactId &&
    value.artifactHash === artifactHash
  );
}

function finalizedOutboxIdentity(executionId: string): string {
  return `review-execution-finalized:v2:${executionId}`;
}

function parseProjectionEnvelope(value: string): Prisma.InputJsonObject {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("review_execution_projection_envelope_not_object");
  }
  return parsed as Prisma.InputJsonObject;
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
  },
  observationId: string,
  now: Date,
): ObservationFacts {
  return { ...command, observationId, now };
}

async function decideLeaseAcquireForSnapshot(
  transaction: Transaction,
  snapshot: ReviewExecutionSnapshot,
  command: AcquireReviewInvocationLeaseCommand,
  now: Date,
): Promise<ReturnType<typeof decideLeaseAcquire>> {
  const slot = snapshot.execution.workSlots.find(
    (candidate) => candidate.workSlotId === command.workSlotId,
  );
  const activeLease =
    slot?.activeLeaseId === null || slot === undefined
      ? null
      : await loadLease(transaction, slot.activeLeaseId);
  return decideLeaseAcquire({
    stream: snapshot.stream,
    execution: snapshot.execution,
    activeLease,
    fencingToken: await nextLeaseFencingToken(transaction),
    ...command,
    now,
    expiresAt: databaseRelativeDate(
      now,
      command.now,
      command.expiresAt,
      "lease_deadline",
    ),
    resultReportUntil: databaseRelativeDate(
      now,
      command.now,
      command.resultReportUntil,
      "result_report_deadline",
    ),
    retainUntil: databaseRelativeDate(
      now,
      command.now,
      command.retainUntil,
      "lease_retention_deadline",
    ),
  });
}

async function persistEarlyLeaseAcquireResult(
  transaction: Transaction,
  decision: ReturnType<typeof decideLeaseAcquire>,
  snapshot: ReviewExecutionSnapshot,
  executionId: string,
): Promise<ReviewInvocationLeaseAcquireResult | null> {
  switch (decision.status) {
    case LeaseAcquireDecisionStatus.MissingSlot:
      return { status: ReviewInvocationLeaseAcquireStatus.Missing };
    case LeaseAcquireDecisionStatus.NotRunnable:
      return { status: ReviewInvocationLeaseAcquireStatus.NotRunnable };
    case LeaseAcquireDecisionStatus.Busy:
      return { status: ReviewInvocationLeaseAcquireStatus.Busy };
    case LeaseAcquireDecisionStatus.AttemptBudgetExhausted:
      if (decision.expiredLease !== null) {
        await persistSingleLeaseState(transaction, decision.expiredLease);
      }
      await persistExecutionUpdate(
        transaction,
        snapshot.execution,
        decision.execution,
      );
      return {
        status: ReviewInvocationLeaseAcquireStatus.AttemptBudgetExhausted,
        snapshot: requiredSnapshot(
          await loadSnapshot(transaction, executionId),
        ),
      };
    case LeaseAcquireDecisionStatus.Acquired:
      return null;
  }
}

function admissionVerdict(
  value: ReviewExecutionAdmissionVerdict,
): ExecutionAdmissionVerdict {
  switch (value) {
    case ReviewExecutionAdmissionVerdict.Current:
      return ExecutionAdmissionVerdict.Current;
    case ReviewExecutionAdmissionVerdict.Stale:
      return ExecutionAdmissionVerdict.Stale;
    case ReviewExecutionAdmissionVerdict.Unavailable:
      return ExecutionAdmissionVerdict.Unavailable;
  }
}

function scopeWhere(scope: ReviewExecutionScope) {
  return {
    workspaceId: scope.workspaceId,
    repositoryConnectionId: scope.repositoryConnectionId,
    scmRepositoryIdentityId: scope.scmRepositoryIdentityId,
    pullRequestNumber: scope.pullRequestNumber,
  };
}

function sameScope(
  left: ReviewExecutionScope,
  right: ReviewExecutionScope,
): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.repositoryConnectionId === right.repositoryConnectionId &&
    left.scmRepositoryIdentityId === right.scmRepositoryIdentityId &&
    left.pullRequestNumber === right.pullRequestNumber
  );
}

async function lockScope(
  transaction: Transaction,
  scope: ReviewExecutionScope,
): Promise<void> {
  const key = JSON.stringify([
    scope.workspaceId,
    scope.repositoryConnectionId,
    scope.scmRepositoryIdentityId,
    scope.pullRequestNumber,
  ]);
  await transaction.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
  );
}

async function lockScopes(
  transaction: Transaction,
  scopes: readonly ReviewExecutionScope[],
): Promise<void> {
  const unique = new Map<string, ReviewExecutionScope>();
  for (const scope of scopes) {
    unique.set(
      JSON.stringify([
        scope.workspaceId,
        scope.repositoryConnectionId,
        scope.scmRepositoryIdentityId,
        scope.pullRequestNumber,
      ]),
      scope,
    );
  }
  for (const key of [...unique.keys()].sort()) {
    await lockScope(transaction, unique.get(key)!);
  }
}

async function lockStream(
  transaction: Transaction,
  scope: ReviewExecutionScope,
): Promise<void> {
  await transaction.$queryRaw(
    Prisma.sql`
      SELECT 1 FROM "ReviewExecutionStreamV2"
      WHERE "workspaceId" = ${scope.workspaceId}
        AND "repositoryConnectionId" = ${scope.repositoryConnectionId}
        AND "scmRepositoryIdentityId" = ${scope.scmRepositoryIdentityId}
        AND "pullRequestNumber" = ${scope.pullRequestNumber}
      FOR UPDATE
    `,
  );
}

async function lockExecution(
  transaction: Transaction,
  executionId: string,
): Promise<void> {
  await transaction.$queryRaw(
    Prisma.sql`SELECT 1 FROM "ReviewExecutionV2" WHERE "executionId" = ${executionId} FOR UPDATE`,
  );
}

async function lockWorkSlot(
  transaction: Transaction,
  executionId: string,
  workSlotId: string,
): Promise<void> {
  await transaction.$queryRaw(
    Prisma.sql`SELECT 1 FROM "ReviewExecutionWorkSlotV2" WHERE "executionId" = ${executionId} AND "workSlotId" = ${workSlotId} FOR UPDATE`,
  );
}

async function lockLease(
  transaction: Transaction,
  leaseId: string,
): Promise<void> {
  await transaction.$queryRaw(
    Prisma.sql`SELECT 1 FROM "ReviewInvocationLeaseV2" WHERE "leaseId" = ${leaseId} FOR UPDATE`,
  );
}

async function databaseNow(transaction: Transaction): Promise<Date> {
  const [row] = await transaction.$queryRaw<Array<{ epochMs: bigint }>>(
    Prisma.sql`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS "epochMs"`,
  );
  if (row === undefined)
    throw new Error("review_execution_database_time_missing");
  const epochMs = Number(row.epochMs);
  if (!Number.isSafeInteger(epochMs))
    throw new Error("review_execution_database_time_invalid");
  return new Date(epochMs);
}

async function nextLeaseFencingToken(
  transaction: Transaction,
): Promise<bigint> {
  const [row] = await transaction.$queryRaw<Array<{ value: bigint }>>(
    Prisma.sql`SELECT nextval('"ReviewInvocationLeaseV2_fencingToken_seq"') AS value`,
  );
  if (row === undefined) throw new Error("review_execution_fence_unavailable");
  return row.value;
}

async function compactRetainedLeases(
  transaction: Transaction,
  limit: number,
): Promise<number> {
  const candidates = await transaction.$queryRaw<LeaseRecord[]>(
    Prisma.sql`
      SELECT lease.*
      FROM "ReviewInvocationLeaseV2" AS lease
      WHERE lease.state <> 'active'
        AND lease."retainUntil" < (clock_timestamp() AT TIME ZONE 'UTC')
        AND NOT EXISTS (
          SELECT 1 FROM "ReviewExecutionWorkSlotV2" AS slot
          WHERE slot."activeLeaseId" = lease."leaseId"
        )
        AND NOT EXISTS (
          SELECT 1 FROM "ReviewEvidenceObservation" AS observation
          WHERE observation."sourceLeaseId" = lease."leaseId"
        )
      ORDER BY lease."retainUntil", lease."leaseId"
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `,
  );
  const compactedAt = await databaseNow(transaction);
  let compacted = 0;
  for (const candidate of candidates) {
    await transaction.reviewInvocationLeaseTombstoneV2.create({
      data: {
        leaseId: candidate.leaseId,
        leaseCapabilityId: candidate.leaseCapabilityId,
        authorizationId: candidate.authorizationId,
        producerReleaseId: candidate.producerReleaseId,
        providerInvocationKeyHash: providerInvocationKeyTombstoneHash(
          candidate.providerInvocationKey,
        ),
        fencingToken: candidate.fencingToken,
        terminalState: candidate.state,
        expiresAt: candidate.expiresAt,
        resultReportUntil: candidate.resultReportUntil,
        compactedAt,
      },
    });
    const removed = await transaction.reviewInvocationLeaseV2.deleteMany({
      where: {
        leaseId: candidate.leaseId,
        fencingToken: candidate.fencingToken,
        state: candidate.state,
      },
    });
    if (removed.count !== 1) throw new ConcurrentExecutionMutationError();
    compacted += 1;
  }
  return compacted;
}

async function terminalPruneCandidates(
  transaction: Transaction,
  limit: number,
): Promise<string[]> {
  const rows = await transaction.$queryRaw<Array<{ executionId: string }>>(
    Prisma.sql`
      SELECT execution."executionId"
      FROM "ReviewExecutionV2" AS execution
      WHERE execution.state IN ('superseded', 'completed', 'partial', 'failed')
        AND execution."retainUntil" < (clock_timestamp() AT TIME ZONE 'UTC')
        AND NOT EXISTS (
          SELECT 1 FROM "ReviewExecutionStreamV2" AS stream
          WHERE stream."activeExecutionId" = execution."executionId"
             OR stream."preparedExecutionId" = execution."executionId"
        )
        AND NOT EXISTS (
          SELECT 1 FROM "ReviewInvocationLeaseV2" AS lease
          WHERE lease."executionId" = execution."executionId"
        )
      ORDER BY execution."retainUntil", execution."executionId"
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `,
  );
  return rows.map((row) => row.executionId);
}

async function executionIdsWithoutDependents(
  transaction: Transaction,
  candidateIds: readonly string[],
): Promise<string[]> {
  if (candidateIds.length === 0) return [];
  const rows = await transaction.$queryRaw<Array<{ executionId: string }>>(
    Prisma.sql`
      SELECT execution."executionId"
      FROM "ReviewExecutionV2" AS execution
      WHERE execution."executionId" IN (${Prisma.join(candidateIds)})
        AND NOT EXISTS (SELECT 1 FROM "FinalizedReviewProjectionArtifactV2" artifact WHERE artifact."executionId" = execution."executionId" AND artifact."retainUntil" >= (clock_timestamp() AT TIME ZONE 'UTC'))
        AND NOT EXISTS (SELECT 1 FROM "ReviewRequestedIntent" intent WHERE intent."executionId" = execution."executionId")
        AND NOT EXISTS (SELECT 1 FROM "ReviewSnapshot" snapshot WHERE snapshot."sourceExecutionId" = execution."executionId")
        AND NOT EXISTS (SELECT 1 FROM "ReviewSnapshotCommitReceiptV2" receipt WHERE receipt."sourceExecutionId" = execution."executionId")
        AND NOT EXISTS (SELECT 1 FROM "ReviewPublicationAttemptV2" publication WHERE publication."executionId" = execution."executionId")
        AND NOT EXISTS (SELECT 1 FROM "ReviewCompletionProcess" process WHERE process."executionId" = execution."executionId")
        AND NOT EXISTS (SELECT 1 FROM "ReviewInvestigation" investigation WHERE investigation."executionId" = execution."executionId")
        AND EXISTS (SELECT 1 FROM "ReviewRunAuthorization" auth_row WHERE auth_row."authorizationId" = execution."authorizationId" AND auth_row."expiresAt" < (clock_timestamp() AT TIME ZONE 'UTC'))
      ORDER BY execution."executionId"
    `,
  );
  return rows.map((row) => row.executionId);
}

function providerInvocationKeyTombstoneHash(value: string): string {
  return createHash("sha256")
    .update("rr.review-invocation-lease-tombstone.v1\0", "utf8")
    .update(value, "utf8")
    .digest("hex");
}

function requiredSnapshot(
  snapshot: ReviewExecutionSnapshot | null,
): ReviewExecutionSnapshot {
  if (snapshot === null) throw new Error("review_execution_snapshot_missing");
  return snapshot;
}

function assertBoundedAggregateCollection(
  records: readonly unknown[],
  kind: string,
): void {
  if (records.length > reviewExecutionAbsoluteMaxWorkSlots) {
    throw new Error(`review_execution_unbounded_${kind}`);
  }
}

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000) {
    throw new Error("review_execution_prune_limit_invalid");
  }
}

function isUniqueConstraintError(
  error: unknown,
): error is Prisma.PrismaClientKnownRequestError {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

function isLegacyProviderVoteLaneUniqueConstraintError(
  error: unknown,
): boolean {
  if (!isUniqueConstraintError(error)) return false;
  const legacyConstraint =
    "ReviewInvocationLeaseV2_one_active_provider_vote_lane";
  let metadata = "";
  try {
    metadata = JSON.stringify(error.meta) ?? "";
  } catch {
    // Unserializable metadata cannot verify the retired constraint identity.
  }
  return (
    metadata.includes(legacyConstraint) ||
    error.message.includes(legacyConstraint)
  );
}

function isSerializationError(error: unknown): boolean {
  return (
    error instanceof ConcurrentExecutionMutationError ||
    isTransactionConflictError(error)
  );
}

class ConcurrentExecutionMutationError extends Error {}

async function pauseBeforeTransactionRetry(
  scope: ReviewExecutionScope,
  failedAttempt: number,
): Promise<void> {
  const windowMs = transactionRetryBaseDelayMs * 2 ** (failedAttempt - 1);
  const scopeDigest = createHash("sha256")
    .update(
      JSON.stringify([
        scope.workspaceId,
        scope.repositoryConnectionId,
        scope.scmRepositoryIdentityId,
        scope.pullRequestNumber,
        failedAttempt,
      ]),
    )
    .digest();
  const spreadMs = scopeDigest.readUInt32BE(0) % windowMs;
  const delayMs = Math.min(windowMs + spreadMs, transactionRetryMaxDelayMs);
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

// Concurrent first writes to distinct scope keys can still form PostgreSQL SSI
// dependencies on shared B-tree pages. Preparation and admission retain five
// total attempts (under 480 ms added wait). Serializable lease acquisition gets
// ten total attempts because it also fences concurrent inserts. Scope spreading
// breaks up a burst's lockstep retries, while the 512 ms per-pause cap bounds the
// nine acquire pauses to at most 3,035 ms in total. Genuine exhaustion still
// reaches the exact reconciliation paths above (or is rethrown by mutations
// without a safe reconciliation).
const transactionRetryLimit = 5;
const acquireTransactionRetryLimit = 10;
const transactionRetryBaseDelayMs = 16;
const transactionRetryMaxDelayMs = 512;
