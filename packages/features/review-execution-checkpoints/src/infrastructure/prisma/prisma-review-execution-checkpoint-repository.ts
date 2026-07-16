import {
  Prisma,
  ReviewExecutionCheckpointState as PrismaCheckpointState,
  type ReviewExecutionBatchResult as BatchResultRecord,
  type ReviewExecutionCheckpoint as CheckpointRecord,
  type PrismaClient,
} from "@prisma/client";
import type {
  ClearReviewExecutionCheckpointResult,
  CommitReviewExecutionBatchResult,
  FinalizeReviewExecutionCheckpointResult,
  ReviewExecutionCheckpointConflict,
  ReviewExecutionCheckpointRepositoryPort,
  StartOrReplaceReviewExecutionCheckpointResult,
} from "../../application/ports/review-execution-checkpoint-repository-port";
import {
  ReviewExecutionBatchCommitStatus,
  ReviewExecutionCheckpointClearStatus,
  ReviewExecutionCheckpointFinalizeStatus,
  ReviewExecutionCheckpointStartStatus,
  ReviewExecutionCheckpointState,
  assertReviewExecutionBatchResult,
  assertReviewExecutionCheckpointAggregate,
  assertReviewExecutionCheckpointRoot,
  decodeReviewExecutionBatchPayload,
  hashReviewExecutionBatchPayload,
  isReviewExecutionCheckpointStartIdempotent,
  reviewExecutionBatchPayloadBytes,
  reviewExecutionCheckpointMaxAggregateBytes,
  reviewExecutionCheckpointMaxFindings,
  type ReviewExecutionBatchPayload,
  type ReviewExecutionBatchResult,
  type ReviewExecutionCheckpointAggregate,
  type ReviewExecutionCheckpointRoot,
  type ReviewExecutionCheckpointScope,
} from "../../domain/review-execution-checkpoint";

export class PrismaReviewExecutionCheckpointRepository implements ReviewExecutionCheckpointRepositoryPort {
  constructor(private readonly prisma: PrismaClient) {}

  async find(
    scope: ReviewExecutionCheckpointScope,
  ): Promise<ReviewExecutionCheckpointAggregate | null> {
    const record = await this.prisma.$transaction(
      (tx) =>
        tx.reviewExecutionCheckpoint.findUnique({
          where: scopedUnique(scope),
          include: { batchResults: { orderBy: { batchIndex: "asc" } } },
        }),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return record ? toAggregate(record) : null;
  }

  async startOrReplace(input: {
    readonly expectedVersion: number;
    readonly checkpoint: ReviewExecutionCheckpointRoot;
  }): Promise<StartOrReplaceReviewExecutionCheckpointResult> {
    assertReviewExecutionCheckpointAggregate({
      checkpoint: input.checkpoint,
      batchResults: [],
    });
    try {
      const transactionResult = await this.prisma.$transaction(
        async (tx) => {
          const currentRecord = await tx.reviewExecutionCheckpoint.findUnique({
            where: scopedUnique(input.checkpoint),
            include: { batchResults: { orderBy: { batchIndex: "asc" } } },
          });
          if (!currentRecord) {
            if (input.expectedVersion !== 0) {
              return result<StartOrReplaceReviewExecutionCheckpointResult>(
                startConflict(),
              );
            }
            const created = await tx.reviewExecutionCheckpoint.create({
              data: toRootCreateInput(input.checkpoint),
            });
            return result<StartOrReplaceReviewExecutionCheckpointResult>({
              status: ReviewExecutionCheckpointStartStatus.Started,
              checkpoint: mapRoot(created),
            });
          }
          const current = toAggregate(currentRecord);
          if (!current) {
            return result<StartOrReplaceReviewExecutionCheckpointResult>({
              status: ReviewExecutionCheckpointStartStatus.Conflict,
              ...rawCheckpointConflict(currentRecord),
            });
          }
          const currentExpired =
            current.checkpoint.expiresAt <= input.checkpoint.updatedAt;
          if (
            !currentExpired &&
            isReviewExecutionCheckpointStartIdempotent(
              current.checkpoint,
              input.checkpoint,
            )
          ) {
            return result<StartOrReplaceReviewExecutionCheckpointResult>({
              status: ReviewExecutionCheckpointStartStatus.Idempotent,
              checkpoint: current.checkpoint,
            });
          }
          if (current.checkpoint.version !== input.expectedVersion) {
            return result<StartOrReplaceReviewExecutionCheckpointResult>(
              startConflict(current.checkpoint),
            );
          }
          const updated = await tx.reviewExecutionCheckpoint.updateMany({
            where: {
              id: currentRecord.id,
              version: input.expectedVersion,
            },
            data: toRootUpdateInput(input.checkpoint),
          });
          if (updated.count !== 1) return race();
          await tx.reviewExecutionBatchResult.deleteMany({
            where: { checkpointId: currentRecord.id },
          });
          return result<StartOrReplaceReviewExecutionCheckpointResult>({
            status: ReviewExecutionCheckpointStartStatus.Replaced,
            checkpoint: input.checkpoint,
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      if (transactionResult.kind === "race") {
        return this.resolveStartRace(input.checkpoint);
      }
      return transactionResult.value;
    } catch (error) {
      if (!isRetryableTransactionRace(error)) throw error;
      return this.resolveStartRace(input.checkpoint);
    }
  }

  async commitBatchResult(input: {
    readonly scope: ReviewExecutionCheckpointScope;
    readonly expectedVersion: number;
    readonly headSha: string;
    readonly planHash: string;
    readonly batchResult: ReviewExecutionBatchResult;
    readonly updatedAt: Date;
    readonly expiresAt: Date;
  }): Promise<CommitReviewExecutionBatchResult> {
    assertReviewExecutionBatchResult(input.batchResult);
    try {
      const transactionResult = await this.prisma.$transaction(
        async (tx) => {
          const currentRecord = await tx.reviewExecutionCheckpoint.findUnique({
            where: scopedUnique(input.scope),
          });
          if (!currentRecord) {
            return result<CommitReviewExecutionBatchResult>({
              status: ReviewExecutionBatchCommitStatus.Missing,
              currentVersion: 0,
            });
          }
          const current = mapValidRoot(currentRecord);
          if (!current) {
            return result<CommitReviewExecutionBatchResult>({
              status: ReviewExecutionBatchCommitStatus.Corrupted,
              currentVersion: currentRecord.version,
            });
          }
          if (
            current.headSha !== input.headSha ||
            current.planHash !== input.planHash ||
            current.expiresAt <= input.updatedAt
          ) {
            return result<CommitReviewExecutionBatchResult>({
              status: ReviewExecutionBatchCommitStatus.Conflict,
              ...checkpointConflict(current),
            });
          }
          const existingRecord = await tx.reviewExecutionBatchResult.findUnique(
            {
              where: {
                checkpointId_workKey: {
                  checkpointId: currentRecord.id,
                  workKey: input.batchResult.workKey,
                },
              },
            },
          );
          if (existingRecord) {
            const existing = mapBatchResultOrNull(existingRecord);
            if (!existing) {
              return result<CommitReviewExecutionBatchResult>({
                status: ReviewExecutionBatchCommitStatus.Corrupted,
                currentVersion: current.version,
              });
            }
            return result(
              resolveExistingBatchResult(current, existing, input.batchResult),
            );
          }
          if (current.state === ReviewExecutionCheckpointState.Finalized) {
            return result<CommitReviewExecutionBatchResult>({
              status: ReviewExecutionBatchCommitStatus.Finalized,
              checkpoint: current,
            });
          }
          if (current.version !== input.expectedVersion) {
            return result<CommitReviewExecutionBatchResult>({
              status: ReviewExecutionBatchCommitStatus.Conflict,
              ...checkpointConflict(current),
            });
          }
          const plannedIndex = current.plannedWorkKeys.indexOf(
            input.batchResult.workKey,
          );
          if (
            plannedIndex < 0 ||
            plannedIndex !== input.batchResult.batchIndex
          ) {
            return result<CommitReviewExecutionBatchResult>({
              status: ReviewExecutionBatchCommitStatus.UnplannedWork,
              checkpoint: current,
            });
          }
          const acceptedFindings = current.acceptedFindings;
          const nextAcceptedBytes =
            current.acceptedBytes + input.batchResult.byteCount;
          const nextAcceptedFindings =
            acceptedFindings + input.batchResult.payload.findings.length;
          if (
            nextAcceptedBytes > reviewExecutionCheckpointMaxAggregateBytes ||
            nextAcceptedFindings > reviewExecutionCheckpointMaxFindings
          ) {
            return result<CommitReviewExecutionBatchResult>({
              status: ReviewExecutionBatchCommitStatus.BudgetExceeded,
              checkpoint: current,
              acceptedBytes: current.acceptedBytes,
              acceptedFindings,
            });
          }
          const updated = await tx.reviewExecutionCheckpoint.updateMany({
            where: {
              id: currentRecord.id,
              version: input.expectedVersion,
              state: PrismaCheckpointState.active,
              acceptedBytes: current.acceptedBytes,
              acceptedFindings: current.acceptedFindings,
              headSha: input.headSha,
              planHash: input.planHash,
              expiresAt: { gt: input.updatedAt },
            },
            data: {
              version: input.expectedVersion + 1,
              acceptedBytes: nextAcceptedBytes,
              acceptedFindings: nextAcceptedFindings,
              updatedAt: input.updatedAt,
              expiresAt: input.expiresAt,
            },
          });
          if (updated.count !== 1) return race();
          const created = await tx.reviewExecutionBatchResult.create({
            data: toBatchCreateInput(currentRecord.id, input.batchResult),
          });
          return result<CommitReviewExecutionBatchResult>({
            status: ReviewExecutionBatchCommitStatus.Committed,
            checkpoint: {
              ...current,
              version: input.expectedVersion + 1,
              acceptedBytes: nextAcceptedBytes,
              acceptedFindings: nextAcceptedFindings,
              updatedAt: input.updatedAt,
              expiresAt: input.expiresAt,
            },
            batchResult: mapBatchResultOrThrow(created),
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      if (transactionResult.kind === "race") {
        return this.resolveBatchRace(input);
      }
      return transactionResult.value;
    } catch (error) {
      if (!isRetryableTransactionRace(error)) throw error;
      return this.resolveBatchRace(input);
    }
  }

  async finalize(input: {
    readonly scope: ReviewExecutionCheckpointScope;
    readonly expectedVersion: number;
    readonly headSha: string;
    readonly planHash: string;
    readonly finalizedAt: Date;
    readonly expiresAt: Date;
  }): Promise<FinalizeReviewExecutionCheckpointResult> {
    try {
      const transactionResult = await this.prisma.$transaction(
        async (tx) => {
          const currentRecord = await tx.reviewExecutionCheckpoint.findUnique({
            where: scopedUnique(input.scope),
            include: { batchResults: { orderBy: { batchIndex: "asc" } } },
          });
          if (!currentRecord) {
            return result<FinalizeReviewExecutionCheckpointResult>({
              status: ReviewExecutionCheckpointFinalizeStatus.Missing,
              currentVersion: 0,
            });
          }
          const current = toAggregate(currentRecord);
          if (!current) {
            return result<FinalizeReviewExecutionCheckpointResult>({
              status: ReviewExecutionCheckpointFinalizeStatus.Corrupted,
              currentVersion: currentRecord.version,
            });
          }
          if (current.checkpoint.expiresAt <= input.finalizedAt) {
            return result<FinalizeReviewExecutionCheckpointResult>({
              status: ReviewExecutionCheckpointFinalizeStatus.Conflict,
              ...checkpointConflict(current.checkpoint),
            });
          }
          if (
            current.checkpoint.headSha !== input.headSha ||
            current.checkpoint.planHash !== input.planHash
          ) {
            return result<FinalizeReviewExecutionCheckpointResult>({
              status: ReviewExecutionCheckpointFinalizeStatus.Conflict,
              ...checkpointConflict(current.checkpoint),
            });
          }
          if (
            current.checkpoint.state ===
            ReviewExecutionCheckpointState.Finalized
          ) {
            return result<FinalizeReviewExecutionCheckpointResult>({
              status: ReviewExecutionCheckpointFinalizeStatus.Idempotent,
              checkpoint: current.checkpoint,
            });
          }
          if (current.checkpoint.version !== input.expectedVersion) {
            return result<FinalizeReviewExecutionCheckpointResult>({
              status: ReviewExecutionCheckpointFinalizeStatus.Conflict,
              ...checkpointConflict(current.checkpoint),
            });
          }
          const accepted = new Set(
            current.batchResults.map((batchResult) => batchResult.workKey),
          );
          const missingWorkKeys = current.checkpoint.plannedWorkKeys.filter(
            (workKey) => !accepted.has(workKey),
          );
          if (missingWorkKeys.length > 0) {
            return result<FinalizeReviewExecutionCheckpointResult>({
              status: ReviewExecutionCheckpointFinalizeStatus.Incomplete,
              checkpoint: current.checkpoint,
              missingWorkKeys,
            });
          }
          const updated = await tx.reviewExecutionCheckpoint.updateMany({
            where: {
              id: currentRecord.id,
              version: input.expectedVersion,
              state: PrismaCheckpointState.active,
              headSha: input.headSha,
              planHash: input.planHash,
              expiresAt: { gt: input.finalizedAt },
            },
            data: {
              version: input.expectedVersion + 1,
              state: PrismaCheckpointState.finalized,
              updatedAt: input.finalizedAt,
              expiresAt: input.expiresAt,
              finalizedAt: input.finalizedAt,
            },
          });
          if (updated.count !== 1) return race();
          return result<FinalizeReviewExecutionCheckpointResult>({
            status: ReviewExecutionCheckpointFinalizeStatus.Finalized,
            checkpoint: {
              ...current.checkpoint,
              version: input.expectedVersion + 1,
              state: ReviewExecutionCheckpointState.Finalized,
              updatedAt: input.finalizedAt,
              expiresAt: input.expiresAt,
              finalizedAt: input.finalizedAt,
            },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      if (transactionResult.kind === "race") {
        return this.resolveFinalizeRace(input);
      }
      return transactionResult.value;
    } catch (error) {
      if (!isRetryableTransactionRace(error)) throw error;
      return this.resolveFinalizeRace(input);
    }
  }

  async clear(input: {
    readonly scope: ReviewExecutionCheckpointScope;
    readonly expectedVersion: number;
    readonly headSha: string;
    readonly planHash: string;
  }): Promise<ClearReviewExecutionCheckpointResult> {
    const deleted = await this.prisma.reviewExecutionCheckpoint.deleteMany({
      where: {
        ...input.scope,
        version: input.expectedVersion,
        state: PrismaCheckpointState.finalized,
        headSha: input.headSha,
        planHash: input.planHash,
      },
    });
    if (deleted.count === 1) {
      return { status: ReviewExecutionCheckpointClearStatus.Cleared };
    }
    const current = await this.prisma.reviewExecutionCheckpoint.findUnique({
      where: scopedUnique(input.scope),
    });
    if (!current) {
      return { status: ReviewExecutionCheckpointClearStatus.Missing };
    }
    return {
      status: ReviewExecutionCheckpointClearStatus.Conflict,
      ...rawCheckpointConflict(current),
    };
  }

  async pruneExpired(input: {
    readonly expiredBefore: Date;
    readonly limit: number;
  }): Promise<number> {
    const expired = await this.prisma.reviewExecutionCheckpoint.findMany({
      where: { expiresAt: { lte: input.expiredBefore } },
      orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
      take: input.limit,
      select: { id: true },
    });
    if (expired.length === 0) return 0;
    const deleted = await this.prisma.reviewExecutionCheckpoint.deleteMany({
      where: {
        id: { in: expired.map((record) => record.id) },
        expiresAt: { lte: input.expiredBefore },
      },
    });
    return deleted.count;
  }

  private async resolveStartRace(
    candidate: ReviewExecutionCheckpointRoot,
  ): Promise<StartOrReplaceReviewExecutionCheckpointResult> {
    const current = await this.find(candidate);
    if (!current) return startConflict();
    const currentExpired = current.checkpoint.expiresAt <= candidate.updatedAt;
    if (
      !currentExpired &&
      isReviewExecutionCheckpointStartIdempotent(current.checkpoint, candidate)
    ) {
      return {
        status: ReviewExecutionCheckpointStartStatus.Idempotent,
        checkpoint: current.checkpoint,
      };
    }
    if (
      !currentExpired &&
      current.checkpoint.state === ReviewExecutionCheckpointState.Finalized
    ) {
      return {
        status: ReviewExecutionCheckpointStartStatus.Finalized,
        checkpoint: current.checkpoint,
      };
    }
    return startConflict(current.checkpoint);
  }

  private async resolveBatchRace(input: {
    readonly scope: ReviewExecutionCheckpointScope;
    readonly headSha: string;
    readonly planHash: string;
    readonly updatedAt: Date;
    readonly batchResult: ReviewExecutionBatchResult;
  }): Promise<CommitReviewExecutionBatchResult> {
    const current = await this.find(input.scope);
    if (!current) {
      return {
        status: ReviewExecutionBatchCommitStatus.Missing,
        currentVersion: 0,
      };
    }
    if (
      current.checkpoint.headSha !== input.headSha ||
      current.checkpoint.planHash !== input.planHash ||
      current.checkpoint.expiresAt <= input.updatedAt
    ) {
      return {
        status: ReviewExecutionBatchCommitStatus.Conflict,
        ...checkpointConflict(current.checkpoint),
      };
    }
    const existing = current.batchResults.find(
      (batchResult) => batchResult.workKey === input.batchResult.workKey,
    );
    if (existing) {
      return resolveExistingBatchResult(
        current.checkpoint,
        existing,
        input.batchResult,
      );
    }
    if (current.checkpoint.state === ReviewExecutionCheckpointState.Finalized) {
      return {
        status: ReviewExecutionBatchCommitStatus.Finalized,
        checkpoint: current.checkpoint,
      };
    }
    return {
      status: ReviewExecutionBatchCommitStatus.Conflict,
      ...checkpointConflict(current.checkpoint),
    };
  }

  private async resolveFinalizeRace(input: {
    readonly scope: ReviewExecutionCheckpointScope;
    readonly headSha: string;
    readonly planHash: string;
  }): Promise<FinalizeReviewExecutionCheckpointResult> {
    const current = await this.find(input.scope);
    if (!current) {
      return {
        status: ReviewExecutionCheckpointFinalizeStatus.Missing,
        currentVersion: 0,
      };
    }
    if (
      current.checkpoint.state === ReviewExecutionCheckpointState.Finalized &&
      current.checkpoint.headSha === input.headSha &&
      current.checkpoint.planHash === input.planHash
    ) {
      return {
        status: ReviewExecutionCheckpointFinalizeStatus.Idempotent,
        checkpoint: current.checkpoint,
      };
    }
    return {
      status: ReviewExecutionCheckpointFinalizeStatus.Conflict,
      ...checkpointConflict(current.checkpoint),
    };
  }
}

type CheckpointWithResults = Prisma.ReviewExecutionCheckpointGetPayload<{
  include: { batchResults: true };
}>;

function toAggregate(
  record: CheckpointWithResults,
): ReviewExecutionCheckpointAggregate | null {
  try {
    const aggregate: ReviewExecutionCheckpointAggregate = {
      checkpoint: mapRoot(record),
      batchResults: record.batchResults.map(mapBatchResultOrThrow),
    };
    assertReviewExecutionCheckpointAggregate(aggregate);
    return aggregate;
  } catch {
    return null;
  }
}

function mapRoot(record: CheckpointRecord): ReviewExecutionCheckpointRoot {
  const state =
    record.state === PrismaCheckpointState.active
      ? ReviewExecutionCheckpointState.Active
      : ReviewExecutionCheckpointState.Finalized;
  return {
    workspaceId: record.workspaceId,
    repositoryId: record.repositoryId,
    pullRequestNumber: record.pullRequestNumber,
    version: record.version,
    state,
    schemaVersion: record.schemaVersion,
    baseSha: record.baseSha,
    headSha: record.headSha,
    compatibilityKey: record.compatibilityKey,
    planHash: record.planHash,
    plannedWorkKeys: record.plannedWorkKeys,
    acceptedBytes: record.acceptedBytes,
    acceptedFindings: record.acceptedFindings,
    sourceRunId: record.sourceRunId,
    sourceRunAttempt: record.sourceRunAttempt,
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt,
    ...(record.finalizedAt ? { finalizedAt: record.finalizedAt } : {}),
  };
}

function mapBatchResultOrThrow(
  record: BatchResultRecord,
): ReviewExecutionBatchResult {
  const payload = requireBatchPayload(record.payload);
  if (canonicalJson(record.payload) !== canonicalJson(payload)) {
    throw new Error(
      "review_execution_checkpoint_persisted_batch_not_normalized",
    );
  }
  const byteCount = reviewExecutionBatchPayloadBytes(payload);
  if (
    byteCount !== record.byteCount ||
    hashReviewExecutionBatchPayload(payload) !== record.payloadHash
  ) {
    throw new Error("review_execution_checkpoint_persisted_batch_invalid");
  }
  return {
    workKey: record.workKey,
    batchId: record.batchId,
    batchIndex: record.batchIndex,
    payload,
    payloadHash: record.payloadHash,
    byteCount: record.byteCount,
    sourceRunId: record.sourceRunId,
    sourceRunAttempt: record.sourceRunAttempt,
    completedAt: record.completedAt,
  };
}

function mapBatchResultOrNull(
  record: BatchResultRecord,
): ReviewExecutionBatchResult | null {
  try {
    return mapBatchResultOrThrow(record);
  } catch {
    return null;
  }
}

function mapValidRoot(
  record: CheckpointRecord,
): ReviewExecutionCheckpointRoot | null {
  try {
    const checkpoint = mapRoot(record);
    assertReviewExecutionCheckpointRoot(checkpoint);
    return checkpoint;
  } catch {
    return null;
  }
}

function toRootCreateInput(
  checkpoint: ReviewExecutionCheckpointRoot,
): Prisma.ReviewExecutionCheckpointUncheckedCreateInput {
  return {
    workspaceId: checkpoint.workspaceId,
    repositoryId: checkpoint.repositoryId,
    pullRequestNumber: checkpoint.pullRequestNumber,
    ...toRootMutationInput(checkpoint),
  };
}

function toRootUpdateInput(
  checkpoint: ReviewExecutionCheckpointRoot,
): Prisma.ReviewExecutionCheckpointUpdateManyMutationInput {
  return toRootMutationInput(checkpoint);
}

function toRootMutationInput(checkpoint: ReviewExecutionCheckpointRoot) {
  return {
    version: checkpoint.version,
    state:
      checkpoint.state === ReviewExecutionCheckpointState.Active
        ? PrismaCheckpointState.active
        : PrismaCheckpointState.finalized,
    schemaVersion: checkpoint.schemaVersion,
    baseSha: checkpoint.baseSha,
    headSha: checkpoint.headSha,
    compatibilityKey: checkpoint.compatibilityKey,
    planHash: checkpoint.planHash,
    plannedWorkKeys: [...checkpoint.plannedWorkKeys],
    acceptedBytes: checkpoint.acceptedBytes,
    acceptedFindings: checkpoint.acceptedFindings,
    sourceRunId: checkpoint.sourceRunId,
    sourceRunAttempt: checkpoint.sourceRunAttempt,
    updatedAt: checkpoint.updatedAt,
    expiresAt: checkpoint.expiresAt,
    finalizedAt: checkpoint.finalizedAt ?? null,
  };
}

function toBatchCreateInput(
  checkpointId: string,
  batchResult: ReviewExecutionBatchResult,
): Prisma.ReviewExecutionBatchResultUncheckedCreateInput {
  const payload = requireBatchPayload(batchResult.payload);
  if (
    reviewExecutionBatchPayloadBytes(payload) !== batchResult.byteCount ||
    hashReviewExecutionBatchPayload(payload) !== batchResult.payloadHash
  ) {
    throw new Error("review_execution_checkpoint_batch_result_invalid");
  }
  return {
    checkpointId,
    workKey: batchResult.workKey,
    batchId: batchResult.batchId,
    batchIndex: batchResult.batchIndex,
    payload: payload as Prisma.InputJsonValue,
    payloadHash: batchResult.payloadHash,
    byteCount: batchResult.byteCount,
    sourceRunId: batchResult.sourceRunId,
    sourceRunAttempt: batchResult.sourceRunAttempt,
    completedAt: batchResult.completedAt,
  };
}

function requireBatchPayload(payload: unknown): ReviewExecutionBatchPayload {
  const decoded = decodeReviewExecutionBatchPayload(payload);
  if (!decoded) {
    throw new Error("review_execution_checkpoint_payload_invalid");
  }
  return decoded;
}

function resolveExistingBatchResult(
  checkpoint: ReviewExecutionCheckpointRoot,
  existing: ReviewExecutionBatchResult,
  candidate: ReviewExecutionBatchResult,
): CommitReviewExecutionBatchResult {
  if (existing.payloadHash === candidate.payloadHash) {
    return {
      status: ReviewExecutionBatchCommitStatus.Idempotent,
      checkpoint,
      batchResult: existing,
    };
  }
  return {
    status: ReviewExecutionBatchCommitStatus.Conflict,
    ...checkpointConflict(checkpoint),
    currentPayloadHash: existing.payloadHash,
  };
}

function startConflict(
  checkpoint?: ReviewExecutionCheckpointRoot,
): StartOrReplaceReviewExecutionCheckpointResult {
  return {
    status: ReviewExecutionCheckpointStartStatus.Conflict,
    ...checkpointConflict(checkpoint),
  };
}

function checkpointConflict(
  checkpoint?: ReviewExecutionCheckpointRoot,
): ReviewExecutionCheckpointConflict {
  return checkpoint
    ? {
        currentVersion: checkpoint.version,
        currentState: checkpoint.state,
        currentHeadSha: checkpoint.headSha,
        currentPlanHash: checkpoint.planHash,
      }
    : { currentVersion: 0 };
}

function rawCheckpointConflict(
  checkpoint: CheckpointRecord,
): ReviewExecutionCheckpointConflict {
  return {
    currentVersion: checkpoint.version,
    currentState:
      checkpoint.state === PrismaCheckpointState.active
        ? ReviewExecutionCheckpointState.Active
        : ReviewExecutionCheckpointState.Finalized,
    currentHeadSha: checkpoint.headSha,
    currentPlanHash: checkpoint.planHash,
  };
}

function scopedUnique(scope: ReviewExecutionCheckpointScope) {
  return {
    workspaceId_repositoryId_pullRequestNumber: {
      workspaceId: scope.workspaceId,
      repositoryId: scope.repositoryId,
      pullRequestNumber: scope.pullRequestNumber,
    },
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

function isRetryableTransactionRace(error: unknown): boolean {
  return (
    isUniqueConstraintError(error) ||
    (error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2034")
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function race(): { readonly kind: "race" } {
  return { kind: "race" };
}

function result<T>(value: T): { readonly kind: "result"; readonly value: T } {
  return { kind: "result", value };
}
