import { Prisma, type PrismaClient } from "@prisma/client";
import {
  ReviewRequestedClaimStatus,
  ReviewRequestedRegisterStatus,
  ReviewRequestedTransitionStatus,
  type ClaimReviewRequestedIntentCommand,
  type CancelReviewRequestedPreAdmissionCommand,
  type LinkReviewRequestedAdmissionCommand,
  type RecordReviewRequestedDispatchCommand,
  type RecoverReviewRequestedDispatchCommand,
  type RegisterReviewRequestedIntentCommand,
  type ReviewRequestedIntentCommandPort,
  type ReviewRequestedIntentPrunerPort,
  type ReviewRequestedIntentQueryPort,
} from "../../application/ports/review-requested-intent-ports";
import {
  cancelReviewRequestedPreAdmissionIntent,
  ReviewRequestedClaimDecisionStatus,
  ReviewRequestedDispatchRecoveryDecisionStatus,
  ReviewRequestedRegistrationDecisionStatus,
  ReviewRequestedTransitionDecisionStatus,
  ReviewRequestedIntentState,
  assessReviewRequestedClaim,
  claimReviewRequestedIntent,
  decideReviewRequestedAdmissionLink,
  decideReviewRequestedDispatch,
  decideReviewRequestedDispatchRecovery,
  decideReviewRequestedRegistration,
  type ReviewRequestedIntent,
} from "../../domain/review-requested-intent";
import type { ReviewExecutionScope } from "../../domain/review-execution";
import {
  databaseRelativeDate,
  isTransactionConflictError,
} from "./prisma-review-execution-utils";
import {
  intentStateToPrisma,
  intentToDomain,
  triggerKindToPrisma,
} from "./prisma-review-execution-mappers";

type Transaction = Prisma.TransactionClient;

export class PrismaReviewRequestedIntentStore
  implements
    ReviewRequestedIntentQueryPort,
    ReviewRequestedIntentCommandPort,
    ReviewRequestedIntentPrunerPort
{
  constructor(private readonly prisma: PrismaClient) {}

  async findByRequestId(
    requestId: string,
  ): Promise<ReviewRequestedIntent | null> {
    const record = await this.prisma.reviewRequestedIntent.findUnique({
      where: { requestId },
    });
    return record === null ? null : intentToDomain(record);
  }

  async findByDeliveryIdentity(
    deliveryIdentityHash: string,
  ): Promise<ReviewRequestedIntent | null> {
    const record = await this.prisma.reviewRequestedIntent.findUnique({
      where: { deliveryIdentityHash },
    });
    return record === null ? null : intentToDomain(record);
  }

  async findPendingByScope(
    scope: ReviewExecutionScope,
  ): Promise<ReviewRequestedIntent | null> {
    const record = await this.prisma.reviewRequestedIntent.findFirst({
      where: {
        ...scopeWhere(scope),
        state: intentStateToPrisma(ReviewRequestedIntentState.PendingDispatch),
      },
      orderBy: [{ createdAt: "asc" }, { requestId: "asc" }],
    });
    return record === null ? null : intentToDomain(record);
  }

  async findBySourceRunIdentity(input: {
    readonly workspaceId: string;
    readonly repositoryConnectionId: string;
    readonly scmRepositoryIdentityId: string;
    readonly pullRequestNumber: number;
    readonly sourceRunId: string;
    readonly sourceRunAttempt: string;
  }): Promise<ReviewRequestedIntent | null> {
    const records = await this.prisma.reviewRequestedIntent.findMany({
      where: {
        ...scopeWhere(input),
        sourceRunId: input.sourceRunId,
        sourceRunAttempt: input.sourceRunAttempt,
      },
      orderBy: { requestId: "asc" },
      take: 2,
    });
    if (records.length > 1) {
      throw new Error("review_requested_source_run_identity_corrupted");
    }
    return records[0] ? intentToDomain(records[0]) : null;
  }

  async findByRepositorySourceRunIdentity(input: {
    readonly repositoryConnectionId: string;
    readonly sourceRunId: string;
    readonly sourceRunAttempt: string;
  }): Promise<ReviewRequestedIntent | null> {
    const records = await this.prisma.reviewRequestedIntent.findMany({
      where: input,
      orderBy: { requestId: "asc" },
      take: 2,
    });
    if (records.length > 1) {
      throw new Error("review_requested_source_run_identity_corrupted");
    }
    return records[0] ? intentToDomain(records[0]) : null;
  }

  async listDue(input: {
    readonly now: Date;
    readonly limit: number;
  }): Promise<readonly ReviewRequestedIntent[]> {
    assertLimit(input.limit);
    void input.now;
    const records = await this.prisma.$queryRaw<
      Awaited<ReturnType<PrismaClient["reviewRequestedIntent"]["findMany"]>>
    >(Prisma.sql`
      SELECT intent.*
      FROM "ReviewRequestedIntent" AS intent
      WHERE (
        intent."state" = 'pending_dispatch'::"ReviewRequestedIntentStateV2"
        AND intent."notBefore" <= (statement_timestamp() AT TIME ZONE 'UTC')
      ) OR (
        intent."state" = 'dispatching'::"ReviewRequestedIntentStateV2"
        AND intent."claimUntil" <= (statement_timestamp() AT TIME ZONE 'UTC')
      )
      ORDER BY intent."notBefore", intent."createdAt", intent."requestId"
      LIMIT ${input.limit}
    `);
    return Object.freeze(records.map(intentToDomain));
  }

  async listAwaitingAuthorization(input: {
    readonly now: Date;
    readonly minimumAgeMs: number;
    readonly limit: number;
  }): Promise<readonly ReviewRequestedIntent[]> {
    assertAwaitingQuery(input.minimumAgeMs, input.limit);
    void input.now;
    const records = await this.prisma.$queryRaw<
      Awaited<ReturnType<PrismaClient["reviewRequestedIntent"]["findMany"]>>
    >(Prisma.sql`
      SELECT intent.*
      FROM "ReviewRequestedIntent" AS intent
      WHERE intent."state" = 'awaiting_authorization'::"ReviewRequestedIntentStateV2"
        AND intent."updatedAt" <= (
          (statement_timestamp() AT TIME ZONE 'UTC')
          - (${input.minimumAgeMs} * INTERVAL '1 millisecond')
        )
      ORDER BY intent."updatedAt", intent."requestId"
      LIMIT ${input.limit}
    `);
    return Object.freeze(records.map(intentToDomain));
  }

  async registerIntent(command: RegisterReviewRequestedIntentCommand) {
    try {
      return await this.prisma.$transaction(
        async (transaction) => {
          await lockScope(transaction, command.candidate);
          const existingByDelivery =
            await transaction.reviewRequestedIntent.findUnique({
              where: {
                deliveryIdentityHash: command.candidate.deliveryIdentityHash,
              },
            });
          const existingByRequestId =
            await transaction.reviewRequestedIntent.findUnique({
              where: { requestId: command.candidate.requestId },
            });
          const pendingInScope =
            await transaction.reviewRequestedIntent.findFirst({
              where: {
                ...scopeWhere(command.candidate),
                state: intentStateToPrisma(
                  ReviewRequestedIntentState.PendingDispatch,
                ),
              },
              orderBy: [{ createdAt: "asc" }, { requestId: "asc" }],
            });
          const preAdmissionInScope =
            pendingInScope ??
            (await transaction.reviewRequestedIntent.findFirst({
              where: {
                ...scopeWhere(command.candidate),
                state: {
                  in: [
                    intentStateToPrisma(ReviewRequestedIntentState.Dispatching),
                    intentStateToPrisma(
                      ReviewRequestedIntentState.AwaitingAuthorization,
                    ),
                  ],
                },
              },
              orderBy: [{ createdAt: "asc" }, { requestId: "asc" }],
            }));
          const decision = decideReviewRequestedRegistration({
            candidate: command.candidate,
            existingByDelivery:
              existingByDelivery === null
                ? null
                : intentToDomain(existingByDelivery),
            existingByRequestId:
              existingByRequestId === null
                ? null
                : intentToDomain(existingByRequestId),
            preAdmissionInScope:
              preAdmissionInScope === null
                ? null
                : intentToDomain(preAdmissionInScope),
          });
          if (
            decision.status ===
            ReviewRequestedRegistrationDecisionStatus.Restore
          ) {
            return {
              status: ReviewRequestedRegisterStatus.Restored,
              intent: decision.intent,
            };
          }
          if (
            decision.status ===
            ReviewRequestedRegistrationDecisionStatus.IdempotencyConflict
          ) {
            return {
              status: ReviewRequestedRegisterStatus.IdempotencyConflict,
              intent: decision.intent,
            };
          }
          if (
            decision.status ===
            ReviewRequestedRegistrationDecisionStatus.RegisterAndSupersede
          ) {
            const updated = await transaction.reviewRequestedIntent.updateMany({
              where: {
                requestId: decision.supersededIntent.requestId,
                version: decision.supersededIntent.version - 1n,
              },
              data: mutableIntentData(decision.supersededIntent),
            });
            if (updated.count !== 1) {
              throw new ConcurrentIntentMutationError();
            }
          }
          const created = await transaction.reviewRequestedIntent.create({
            data: intentCreateData(decision.intent),
          });
          return {
            status: ReviewRequestedRegisterStatus.Registered,
            intent: intentToDomain(created),
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      );
    } catch (error) {
      if (error instanceof ConcurrentIntentMutationError) {
        return this.resolveRegistrationRace(command);
      }
      if (isConcurrencyError(error)) {
        return this.resolveRegistrationRace(command);
      }
      throw error;
    }
  }

  async claimIntent(command: ClaimReviewRequestedIntentCommand) {
    const observed = await this.prisma.reviewRequestedIntent.findUnique({
      where: { requestId: command.requestId },
    });
    if (observed === null) {
      return { status: ReviewRequestedClaimStatus.Missing };
    }
    try {
      return await this.prisma.$transaction(
        async (transaction) => {
          await lockScope(transaction, intentToDomain(observed));
          await lockIntent(transaction, command.requestId);
          const record = await transaction.reviewRequestedIntent.findUnique({
            where: { requestId: command.requestId },
          });
          if (record === null) {
            return { status: ReviewRequestedClaimStatus.Missing };
          }
          const intent = intentToDomain(record);
          const now = await databaseNow(transaction);
          const laneBusy = await transaction.reviewRequestedIntent.findFirst({
            where: {
              ...scopeWhere(intent),
              requestId: { not: intent.requestId },
              OR: [
                {
                  state: intentStateToPrisma(
                    ReviewRequestedIntentState.AwaitingAuthorization,
                  ),
                },
                {
                  state: intentStateToPrisma(
                    ReviewRequestedIntentState.Dispatching,
                  ),
                  claimUntil: { gt: now },
                },
              ],
            },
            select: { requestId: true },
          });
          if (laneBusy !== null) {
            return { status: ReviewRequestedClaimStatus.Busy };
          }
          const claimUntil = databaseRelativeDate(
            now,
            command.now,
            command.claimUntil,
            "claim_deadline",
          );
          const decision = assessReviewRequestedClaim({
            intent,
            claimId: command.claimId,
            ownerIdHash: command.ownerIdHash,
            now,
            claimUntil,
          });
          if (decision === ReviewRequestedClaimDecisionStatus.Restored) {
            return {
              status: ReviewRequestedClaimStatus.Restored,
              intent,
            };
          }
          if (decision === ReviewRequestedClaimDecisionStatus.Busy) {
            return { status: ReviewRequestedClaimStatus.Busy };
          }
          const fencingToken = await nextClaimFencingToken(transaction);
          const claimed = claimReviewRequestedIntent({
            intent,
            claimId: command.claimId,
            ownerIdHash: command.ownerIdHash,
            fencingToken,
            now,
            claimUntil,
          });
          await updateIntent(transaction, intent, claimed);
          return {
            status: ReviewRequestedClaimStatus.Claimed,
            intent: claimed,
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (isConcurrencyError(error)) {
        return { status: ReviewRequestedClaimStatus.StaleClaim };
      }
      throw error;
    }
  }

  async recordDispatch(command: RecordReviewRequestedDispatchCommand) {
    return this.transitionIntent(
      command.requestId,
      async (transaction, intent) =>
        decideReviewRequestedDispatch({
          intent,
          claimId: command.claimId,
          ownerIdHash: command.ownerIdHash,
          fencingToken: command.fencingToken,
          sourceRunId: command.sourceRunId,
          sourceRunAttempt: command.sourceRunAttempt,
          now: await databaseNow(transaction),
        }),
    );
  }

  async linkAdmission(command: LinkReviewRequestedAdmissionCommand) {
    return this.transitionIntent(
      command.requestId,
      async (transaction, intent) =>
        decideReviewRequestedAdmissionLink({
          intent,
          sourceRunId: command.sourceRunId,
          sourceRunAttempt: command.sourceRunAttempt,
          authorizationId: command.authorizationId,
          executionId: command.executionId,
          revision: command.revision,
          now: await databaseNow(transaction),
        }),
    );
  }

  async cancelPreAdmission(
    command: CancelReviewRequestedPreAdmissionCommand,
  ): Promise<{ readonly cancelled: number }> {
    return this.prisma.$transaction(
      async (transaction) => {
        await lockScope(transaction, command);
        const records = await transaction.reviewRequestedIntent.findMany({
          where: {
            ...scopeWhere(command),
            state: {
              in: [
                intentStateToPrisma(ReviewRequestedIntentState.PendingDispatch),
                intentStateToPrisma(ReviewRequestedIntentState.Dispatching),
                intentStateToPrisma(
                  ReviewRequestedIntentState.AwaitingAuthorization,
                ),
              ],
            },
          },
          orderBy: { requestId: "asc" },
        });
        for (const record of records) {
          const intent = intentToDomain(record);
          await updateIntent(
            transaction,
            intent,
            cancelReviewRequestedPreAdmissionIntent(intent, command.now),
          );
        }
        return { cancelled: records.length };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async recoverDispatch(command: RecoverReviewRequestedDispatchCommand) {
    const observed = await this.prisma.reviewRequestedIntent.findUnique({
      where: { requestId: command.requestId },
    });
    if (observed === null) {
      return { status: ReviewRequestedTransitionStatus.Missing };
    }
    try {
      return await this.prisma.$transaction(
        async (transaction) => {
          await lockScope(transaction, intentToDomain(observed));
          await lockIntent(transaction, command.requestId);
          const record = await transaction.reviewRequestedIntent.findUnique({
            where: { requestId: command.requestId },
          });
          if (record === null) {
            return { status: ReviewRequestedTransitionStatus.Missing };
          }
          const intent = intentToDomain(record);
          const replacementRecord =
            await transaction.reviewRequestedIntent.findFirst({
              where: {
                ...scopeWhere(intent),
                requestId: { not: intent.requestId },
                state: intentStateToPrisma(
                  ReviewRequestedIntentState.PendingDispatch,
                ),
              },
              orderBy: [{ createdAt: "asc" }, { requestId: "asc" }],
            });
          const now = await databaseNow(transaction);
          const decision = decideReviewRequestedDispatchRecovery({
            intent,
            replacementPending:
              replacementRecord === null
                ? null
                : intentToDomain(replacementRecord),
            successorCandidate: command.successorCandidate,
            sourceRunId: command.sourceRunId,
            sourceRunAttempt: command.sourceRunAttempt,
            now,
          });
          if (
            decision.status ===
            ReviewRequestedDispatchRecoveryDecisionStatus.Conflict
          ) {
            return { status: ReviewRequestedTransitionStatus.Conflict };
          }
          if (decision.createSuccessor) {
            if (
              decision.successor === null ||
              command.successorCandidate === null
            ) {
              throw new Error("review_requested_recovery_successor_missing");
            }
            await transaction.reviewRequestedIntent.create({
              data: intentCreateData({
                ...decision.successor,
                createdAt: now,
                updatedAt: now,
                notBefore: databaseRelativeDate(
                  now,
                  command.successorCandidate.createdAt,
                  command.successorCandidate.notBefore,
                  "dispatch_recovery_deadline",
                ),
                retainUntil: databaseRelativeDate(
                  now,
                  command.successorCandidate.createdAt,
                  command.successorCandidate.retainUntil,
                  "dispatch_recovery_retention_deadline",
                ),
              }),
            });
          }
          await updateIntent(transaction, intent, decision.intent);
          return {
            status: ReviewRequestedTransitionStatus.Applied,
            intent: decision.intent,
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (isConcurrencyError(error)) {
        return { status: ReviewRequestedTransitionStatus.StaleClaim };
      }
      throw error;
    }
  }

  async pruneRetainedIntents(input: {
    readonly limit: number;
  }): Promise<number> {
    assertLimit(input.limit);
    const removed = await this.prisma.$queryRaw<Array<{ requestId: string }>>(
      Prisma.sql`
        WITH removable AS (
          SELECT intent."requestId"
          FROM "ReviewRequestedIntent" AS intent
          WHERE intent."retainUntil" < (clock_timestamp() AT TIME ZONE 'UTC')
            AND intent.state IN ('dispatched', 'superseded')
            AND NOT EXISTS (
              SELECT 1
              FROM "ReviewRequestedIntent" AS dependent
              WHERE dependent."supersededByRequestId" = intent."requestId"
            )
          ORDER BY intent."retainUntil", intent."requestId"
          LIMIT ${input.limit}
          FOR UPDATE SKIP LOCKED
        )
        DELETE FROM "ReviewRequestedIntent" AS intent
        USING removable
        WHERE intent."requestId" = removable."requestId"
        RETURNING intent."requestId"
      `,
    );
    return removed.length;
  }

  private async transitionIntent(
    requestId: string,
    decide: (
      transaction: Transaction,
      intent: ReviewRequestedIntent,
    ) => Promise<ReturnType<typeof decideReviewRequestedDispatch>>,
  ) {
    try {
      return await this.prisma.$transaction(
        async (transaction) => {
          await lockIntent(transaction, requestId);
          const record = await transaction.reviewRequestedIntent.findUnique({
            where: { requestId },
          });
          if (record === null) {
            return { status: ReviewRequestedTransitionStatus.Missing };
          }
          const intent = intentToDomain(record);
          const decision = await decide(transaction, intent);
          if (
            decision.status === ReviewRequestedTransitionDecisionStatus.Restored
          ) {
            return {
              status: ReviewRequestedTransitionStatus.Restored,
              intent: decision.intent,
            };
          }
          if (
            decision.status ===
            ReviewRequestedTransitionDecisionStatus.StaleClaim
          ) {
            return { status: ReviewRequestedTransitionStatus.StaleClaim };
          }
          if (
            decision.status === ReviewRequestedTransitionDecisionStatus.Conflict
          ) {
            return { status: ReviewRequestedTransitionStatus.Conflict };
          }
          await updateIntent(transaction, intent, decision.intent);
          return {
            status: ReviewRequestedTransitionStatus.Applied,
            intent: decision.intent,
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (isConcurrencyError(error)) {
        return { status: ReviewRequestedTransitionStatus.StaleClaim };
      }
      throw error;
    }
  }

  private async resolveRegistrationRace(
    command: RegisterReviewRequestedIntentCommand,
  ) {
    const [byDelivery, byRequest] = await Promise.all([
      this.findByDeliveryIdentity(command.candidate.deliveryIdentityHash),
      this.findByRequestId(command.candidate.requestId),
    ]);
    const existing = byDelivery ?? byRequest;
    if (existing !== null) {
      return {
        status:
          byDelivery !== null &&
          byDelivery.canonicalRequestHash ===
            command.candidate.canonicalRequestHash
            ? ReviewRequestedRegisterStatus.Restored
            : ReviewRequestedRegisterStatus.IdempotencyConflict,
        intent: existing,
      };
    }
    throw new ConcurrentIntentMutationError();
  }
}

function intentCreateData(intent: ReviewRequestedIntent) {
  return {
    requestId: intent.requestId,
    dispatchAttempt: intent.dispatchAttempt,
    version: intent.version,
    workspaceId: intent.workspaceId,
    repositoryConnectionId: intent.repositoryConnectionId,
    scmRepositoryIdentityId: intent.scmRepositoryIdentityId,
    pullRequestNumber: intent.pullRequestNumber,
    baseSha: intent.revision.baseSha,
    mergeBaseSha: intent.revision.mergeBaseSha,
    headSha: intent.revision.headSha,
    reviewRevisionHash: intent.revision.reviewRevisionHash,
    triggerKind: triggerKindToPrisma(intent.triggerKind),
    deliveryIdentityHash: intent.deliveryIdentityHash,
    canonicalRequestHash: intent.canonicalRequestHash,
    state: intentStateToPrisma(intent.state),
    notBefore: intent.notBefore,
    claimId: intent.claim?.claimId ?? null,
    claimOwnerIdHash: intent.claim?.ownerIdHash ?? null,
    claimFencingToken: intent.claim?.fencingToken ?? null,
    claimedAt: intent.claim?.claimedAt ?? null,
    claimUntil: intent.claim?.claimUntil ?? null,
    sourceRunId: intent.sourceRunId,
    sourceRunAttempt: intent.sourceRunAttempt,
    authorizationId: intent.authorizationId,
    executionId: intent.executionId,
    supersededByRequestId: intent.supersededByRequestId,
    createdAt: intent.createdAt,
    updatedAt: intent.updatedAt,
    retainUntil: intent.retainUntil,
  };
}

function mutableIntentData(intent: ReviewRequestedIntent) {
  return {
    version: intent.version,
    state: intentStateToPrisma(intent.state),
    notBefore: intent.notBefore,
    claimId: intent.claim?.claimId ?? null,
    claimOwnerIdHash: intent.claim?.ownerIdHash ?? null,
    claimFencingToken: intent.claim?.fencingToken ?? null,
    claimedAt: intent.claim?.claimedAt ?? null,
    claimUntil: intent.claim?.claimUntil ?? null,
    sourceRunId: intent.sourceRunId,
    sourceRunAttempt: intent.sourceRunAttempt,
    authorizationId: intent.authorizationId,
    executionId: intent.executionId,
    supersededByRequestId: intent.supersededByRequestId,
    updatedAt: intent.updatedAt,
  };
}

async function updateIntent(
  transaction: Transaction,
  current: ReviewRequestedIntent,
  next: ReviewRequestedIntent,
): Promise<void> {
  const result = await transaction.reviewRequestedIntent.updateMany({
    where: { requestId: current.requestId, version: current.version },
    data: mutableIntentData(next),
  });
  if (result.count !== 1) throw new ConcurrentIntentMutationError();
}

function scopeWhere(scope: ReviewExecutionScope) {
  return {
    workspaceId: scope.workspaceId,
    repositoryConnectionId: scope.repositoryConnectionId,
    scmRepositoryIdentityId: scope.scmRepositoryIdentityId,
    pullRequestNumber: scope.pullRequestNumber,
  };
}

async function lockScope(
  transaction: Transaction,
  scope: ReviewExecutionScope,
): Promise<void> {
  const lockKey = JSON.stringify([
    scope.workspaceId,
    scope.repositoryConnectionId,
    scope.scmRepositoryIdentityId,
    scope.pullRequestNumber,
  ]);
  await transaction.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
  );
}

async function lockIntent(
  transaction: Transaction,
  requestId: string,
): Promise<void> {
  await transaction.$queryRaw(
    Prisma.sql`SELECT "requestId" FROM "ReviewRequestedIntent" WHERE "requestId" = ${requestId} FOR UPDATE`,
  );
}

async function nextClaimFencingToken(
  transaction: Transaction,
): Promise<bigint> {
  const [row] = await transaction.$queryRaw<Array<{ value: bigint }>>(
    Prisma.sql`SELECT nextval('"ReviewRequestedIntent_claimFencingToken_seq"') AS value`,
  );
  if (row === undefined) throw new Error("review_requested_fence_unavailable");
  return row.value;
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

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000) {
    throw new Error("review_requested_invalid_limit");
  }
}

function assertAwaitingQuery(minimumAgeMs: number, limit: number): void {
  if (
    !Number.isSafeInteger(minimumAgeMs) ||
    minimumAgeMs <= 0 ||
    minimumAgeMs > 86_400_000
  ) {
    throw new Error("review_requested_awaiting_age_invalid");
  }
  assertLimit(limit);
}

function isConcurrencyError(error: unknown): boolean {
  return (
    (error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002") ||
    isTransactionConflictError(error)
  );
}

class ConcurrentIntentMutationError extends Error {}
