import { Prisma, type PrismaClient } from "@prisma/client";
import {
  ReviewRequestedClaimStatus,
  ReviewRequestedRegisterStatus,
  ReviewRequestedTransitionStatus,
  type ClaimReviewRequestedIntentCommand,
  type LinkReviewRequestedAdmissionCommand,
  type RecordReviewRequestedDispatchCommand,
  type RegisterReviewRequestedIntentCommand,
  type ReviewRequestedIntentCommandPort,
  type ReviewRequestedIntentPrunerPort,
  type ReviewRequestedIntentQueryPort,
} from "../../application/ports/review-requested-intent-ports";
import {
  ReviewRequestedClaimDecisionStatus,
  ReviewRequestedRegistrationDecisionStatus,
  ReviewRequestedTransitionDecisionStatus,
  ReviewRequestedIntentState,
  assessReviewRequestedClaim,
  claimReviewRequestedIntent,
  decideReviewRequestedAdmissionLink,
  decideReviewRequestedDispatch,
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
      WHERE intent."state" = 'pending_dispatch'::"ReviewRequestedIntentStateV2"
        AND intent."notBefore" <= (statement_timestamp() AT TIME ZONE 'UTC')
      ORDER BY intent."notBefore", intent."createdAt", intent."requestId"
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
            pendingInScope:
              pendingInScope === null ? null : intentToDomain(pendingInScope),
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
    try {
      return await this.prisma.$transaction(
        async (transaction) => {
          await lockIntent(transaction, command.requestId);
          const record = await transaction.reviewRequestedIntent.findUnique({
            where: { requestId: command.requestId },
          });
          if (record === null) {
            return { status: ReviewRequestedClaimStatus.Missing };
          }
          const intent = intentToDomain(record);
          const now = await databaseNow(transaction);
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

function isConcurrencyError(error: unknown): boolean {
  return (
    (error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002") ||
    isTransactionConflictError(error)
  );
}

class ConcurrentIntentMutationError extends Error {}
