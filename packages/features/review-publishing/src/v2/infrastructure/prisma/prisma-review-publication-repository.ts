import {
  Prisma,
  ReviewPublicationAttemptStateV2 as DbAttemptState,
  ReviewPublicationClaimStateV2 as DbClaimState,
  ReviewPublicationOperationAttemptStateV2 as DbOperationAttemptState,
  ReviewPublicationOperationStateV2 as DbOperationState,
  ReviewPublicationTerminalOutcomeV2 as DbTerminalOutcome,
  type PrismaClient,
} from "@prisma/client";
import {
  ReviewPublicationCorrectionReason,
  ReviewPublicationOperationRole,
  ReviewPublicationOperationState,
  ReviewPublicationReceiptStatus,
  ReviewPublicationTerminalOutcome,
  assertOperationCapabilityMatches,
  assertReviewPublicationAttemptCandidate,
  claimCapabilityFacts,
  hasEveryRequiredCanonicalReceipt,
  operationCapabilityFacts,
  selectCanonicalExternalEffect,
  type ReviewPublicationAttempt,
  type ReviewPublicationAuditTombstone,
  type ReviewPublicationExternalEffect,
  type ReviewPublicationOperation,
  type ReviewPublicationOutcomeCorrection,
  type ReviewPublicationReceipt,
} from "../../domain/review-publication-attempt";
import {
  AdjudicateReviewPublicationOutcomeStatus,
  BeginReviewPublicationOperationStatus,
  ClaimReviewPublicationStatus,
  CompleteReviewPublicationOperationStatus,
  RecordReviewExternalEffectStatus,
  RenewReviewPublicationClaimStatus,
  RequestReviewPublicationStatus,
  TerminalizeUnknownReviewPublicationStatus,
  type AdjudicateReviewPublicationOutcomeCommand,
  type AdjudicateReviewPublicationOutcomeCommandPort,
  type AdjudicateReviewPublicationOutcomeResult,
  type BeginReviewPublicationOperationCommand,
  type BeginReviewPublicationOperationCommandPort,
  type BeginReviewPublicationOperationResult,
  type ClaimReviewPublicationCommand,
  type ClaimReviewPublicationCommandPort,
  type ClaimReviewPublicationResult,
  type CompleteReviewPublicationOperationCommand,
  type CompleteReviewPublicationOperationCommandPort,
  type CompleteReviewPublicationOperationResult,
  type RecordReviewExternalEffectCommand,
  type RecordReviewExternalEffectCommandPort,
  type RecordReviewExternalEffectResult,
  type RenewReviewPublicationClaimCommand,
  type RenewReviewPublicationClaimCommandPort,
  type RenewReviewPublicationClaimResult,
  type RequestReviewPublicationCommand,
  type RequestReviewPublicationCommandPort,
  type RequestReviewPublicationResult,
  type ReviewPublicationAttemptQueryPort,
  type ReviewPublicationAttemptView,
  type ReviewPublicationIdempotencyQueryPort,
  type TerminalizeUnknownReviewPublicationCommand,
  type TerminalizeUnknownReviewPublicationCommandPort,
  type TerminalizeUnknownReviewPublicationResult,
} from "../../application/ports/review-publication-ports";
import {
  toDbEffectKind,
  toDbEffectStrategy,
  toDbOperationRole,
  toDbOperationState,
  toDbPublicationKind,
  toDbTerminalOutcome,
  toDomainAttempt,
  toDomainClaim,
  toDomainCorrection,
  toDomainEffect,
  toDomainOperation,
  toDomainOperationAttempt,
  toDomainReceipt,
  toDomainTombstone,
} from "./review-publication-prisma-mappers";

type Transaction = Prisma.TransactionClient;

export class PrismaReviewPublicationRepository
  implements
    ReviewPublicationAttemptQueryPort,
    ReviewPublicationIdempotencyQueryPort,
    RequestReviewPublicationCommandPort,
    ClaimReviewPublicationCommandPort,
    RenewReviewPublicationClaimCommandPort,
    BeginReviewPublicationOperationCommandPort,
    RecordReviewExternalEffectCommandPort,
    CompleteReviewPublicationOperationCommandPort,
    TerminalizeUnknownReviewPublicationCommandPort,
    AdjudicateReviewPublicationOutcomeCommandPort
{
  constructor(private readonly prisma: PrismaClient) {}

  async findById(
    publicationAttemptId: string,
  ): Promise<ReviewPublicationAttemptView | null> {
    return loadAttemptView(this.prisma, publicationAttemptId);
  }

  async findByPermitIdentity(
    permit: ReviewPublicationAttempt["permit"],
  ): Promise<ReviewPublicationAttemptView | null> {
    const row = await this.prisma.reviewPublicationAttemptV2.findUnique({
      where: {
        workspaceId_repositoryConnectionId_scmRepositoryIdentityId_pullRequestNumber_executionId_generation_projectionHash:
          {
            workspaceId: permit.workspaceId,
            repositoryConnectionId: permit.repositoryConnectionId,
            scmRepositoryIdentityId: permit.scmRepositoryIdentityId,
            pullRequestNumber: permit.pullRequestNumber,
            executionId: permit.executionId,
            generation: permit.generation,
            projectionHash: permit.projectionHash,
          },
      },
      select: { publicationAttemptId: true },
    });
    return row === null
      ? null
      : loadAttemptView(this.prisma, row.publicationAttemptId);
  }

  async findClaimByRequest(input: {
    readonly publicationAttemptId: string;
    readonly acquireRequestIdHash: string;
  }) {
    const claim = await this.prisma.reviewPublicationClaimTermV2.findUnique({
      where: {
        publicationAttemptId_acquireRequestIdHash: input,
      },
    });
    if (claim === null) return null;
    const view = await this.findById(input.publicationAttemptId);
    if (view === null) return null;
    const domainClaim = toDomainClaim(claim);
    return {
      requestHash: claim.acquireRequestHash,
      attempt: view.attempt,
      claim: domainClaim,
      capability: claimCapabilityFacts(
        view.attempt,
        domainClaim,
        claim.reportUntil,
      ),
    };
  }

  async findOperationBeginByRequest(input: {
    readonly publicationAttemptId: string;
    readonly publicationOperationId: string;
    readonly claimId: string;
    readonly acquireRequestIdHash: string;
  }) {
    const operationAttempt =
      await this.prisma.reviewPublicationOperationAttemptV2.findUnique({
        where: {
          publicationOperationId_claimId_acquireRequestIdHash: {
            publicationOperationId: input.publicationOperationId,
            claimId: input.claimId,
            acquireRequestIdHash: input.acquireRequestIdHash,
          },
        },
      });
    if (
      operationAttempt === null ||
      operationAttempt.publicationAttemptId !== input.publicationAttemptId
    ) {
      return null;
    }
    const view = await this.findById(input.publicationAttemptId);
    const operation = view?.attempt.operations.find(
      (candidate) =>
        candidate.publicationOperationId === input.publicationOperationId,
    );
    if (!view || !operation) return null;
    const domainAttempt = toDomainOperationAttempt(operationAttempt);
    return {
      requestHash: operationAttempt.acquireRequestHash,
      attempt: view.attempt,
      operation,
      operationAttempt: domainAttempt,
      capability: operationCapabilityFacts({
        attempt: view.attempt,
        operation,
        operationAttempt: domainAttempt,
        targetExternalObjectId: dependencyExternalObjectId(
          view.receipts,
          operation,
        ),
      }),
    };
  }

  async request(
    command: RequestReviewPublicationCommand,
  ): Promise<RequestReviewPublicationResult> {
    assertReviewPublicationAttemptCandidate(command);
    const candidateFingerprint = fingerprint({
      publicationAttemptId: command.publicationAttemptId,
      permit: command.permit,
      operations: command.operations,
      createdAt: command.createdAt,
      retainUntil: command.retainUntil,
    });

    return this.withSerializableTransaction(async (transaction) => {
      const byRequest =
        await transaction.reviewPublicationRequestReceiptV2.findUnique({
          where: { requestIdHash: command.requestIdHash },
        });
      if (byRequest !== null) {
        if (
          byRequest.publicationAttemptId !== command.publicationAttemptId ||
          byRequest.requestHash !== command.requestHash ||
          byRequest.requestFingerprint !== candidateFingerprint
        ) {
          return { status: RequestReviewPublicationStatus.RequestConflict };
        }
        return {
          status: RequestReviewPublicationStatus.Restored,
          attempt: await requiredAttempt(
            transaction,
            byRequest.publicationAttemptId,
          ),
        };
      }

      const byIdentity =
        await transaction.reviewPublicationAttemptV2.findUnique({
          where: {
            workspaceId_repositoryConnectionId_scmRepositoryIdentityId_pullRequestNumber_executionId_generation_projectionHash:
              {
                workspaceId: command.permit.workspaceId,
                repositoryConnectionId: command.permit.repositoryConnectionId,
                scmRepositoryIdentityId: command.permit.scmRepositoryIdentityId,
                pullRequestNumber: command.permit.pullRequestNumber,
                executionId: command.permit.executionId,
                generation: command.permit.generation,
                projectionHash: command.permit.projectionHash,
              },
          },
        });
      if (byIdentity !== null) {
        if (
          byIdentity.requestHash !== command.requestHash ||
          byIdentity.requestFingerprint !== candidateFingerprint
        ) {
          return { status: RequestReviewPublicationStatus.IdentityConflict };
        }
        await transaction.reviewPublicationRequestReceiptV2.create({
          data: {
            requestIdHash: command.requestIdHash,
            publicationAttemptId: byIdentity.publicationAttemptId,
            requestHash: command.requestHash,
            requestFingerprint: candidateFingerprint,
          },
        });
        return {
          status: RequestReviewPublicationStatus.Restored,
          attempt: await requiredAttempt(
            transaction,
            byIdentity.publicationAttemptId,
          ),
        };
      }
      const byId = await transaction.reviewPublicationAttemptV2.findUnique({
        where: { publicationAttemptId: command.publicationAttemptId },
        select: { publicationAttemptId: true },
      });
      if (byId !== null) {
        return { status: RequestReviewPublicationStatus.IdentityConflict };
      }

      await transaction.reviewPublicationAttemptV2.create({
        data: {
          publicationAttemptId: command.publicationAttemptId,
          requestHash: command.requestHash,
          requestFingerprint: candidateFingerprint,
          workspaceId: command.permit.workspaceId,
          repositoryConnectionId: command.permit.repositoryConnectionId,
          scmRepositoryIdentityId: command.permit.scmRepositoryIdentityId,
          pullRequestNumber: command.permit.pullRequestNumber,
          executionId: command.permit.executionId,
          generation: command.permit.generation,
          reviewedHeadSha: command.permit.reviewedHeadSha,
          reviewRevisionHash: command.permit.reviewRevisionHash,
          authorizationId: command.permit.authorizationId,
          producerReleaseId: command.permit.producerReleaseId,
          projectionHash: command.permit.projectionHash,
          permitEpoch: command.permit.permitEpoch,
          publicationSafetyDecisionHash:
            command.permit.publicationSafetyDecisionHash,
          publicationNotAfter: command.permit.publicationNotAfter,
          lifecycleStateHash: command.permit.lifecycleStateHash,
          commandLedgerWatermark: command.permit.commandLedgerWatermark,
          version: 1n,
          state: DbAttemptState.pending,
          createdAt: command.createdAt,
          retainUntil: command.retainUntil,
        },
      });
      await transaction.reviewPublicationRequestReceiptV2.create({
        data: {
          requestIdHash: command.requestIdHash,
          publicationAttemptId: command.publicationAttemptId,
          requestHash: command.requestHash,
          requestFingerprint: candidateFingerprint,
        },
      });
      await transaction.reviewPublicationOperationV2.createMany({
        data: command.operations.map((operation) => ({
          publicationOperationId: operation.publicationOperationId,
          publicationAttemptId: command.publicationAttemptId,
          publicationKind: toDbPublicationKind(operation.publicationKind),
          chunkIndex: operation.chunkIndex,
          effectStrategy: toDbEffectStrategy(operation.effectStrategy),
          role: toDbOperationRole(operation.role),
          markerHash: operation.markerHash,
          bodyHash: operation.bodyHash,
          renderPolicyVersion: operation.renderPolicyVersion,
          targetCommitId: operation.targetCommitId,
          reviewRevisionHash: operation.reviewRevisionHash,
          required: operation.required,
          dependsOnOperationId: operation.dependsOnOperationId,
          state: DbOperationState.planned,
          reconcileUntil: operation.reconcileUntil,
        })),
      });
      return {
        status: RequestReviewPublicationStatus.Applied,
        attempt: await requiredAttempt(
          transaction,
          command.publicationAttemptId,
        ),
      };
    });
  }

  async claim(
    command: ClaimReviewPublicationCommand,
  ): Promise<ClaimReviewPublicationResult> {
    const commandFingerprint = fingerprint(withoutKey(command, "acquiredAt"));
    return this.withSerializableTransaction(async (transaction) => {
      if (!(await lockAttempt(transaction, command.publicationAttemptId))) {
        return { status: ClaimReviewPublicationStatus.Missing };
      }
      const existing =
        await transaction.reviewPublicationClaimTermV2.findUnique({
          where: {
            publicationAttemptId_acquireRequestIdHash: {
              publicationAttemptId: command.publicationAttemptId,
              acquireRequestIdHash: command.acquireRequestIdHash,
            },
          },
        });
      if (existing !== null) {
        if (
          existing.acquireRequestHash !== command.requestHash ||
          existing.commandFingerprint !== commandFingerprint
        ) {
          return { status: ClaimReviewPublicationStatus.RequestConflict };
        }
        return claimRestored(transaction, existing);
      }
      const attemptRow =
        await transaction.reviewPublicationAttemptV2.findUniqueOrThrow({
          where: { publicationAttemptId: command.publicationAttemptId },
        });
      if (attemptRow.state === DbAttemptState.terminal) {
        return { status: ClaimReviewPublicationStatus.Terminal };
      }
      if (attemptRow.version !== command.expectedAttemptVersion) {
        return {
          status: ClaimReviewPublicationStatus.VersionConflict,
          currentVersion: attemptRow.version,
        };
      }
      const now = await databaseNow(transaction);
      const active = await transaction.reviewPublicationClaimTermV2.findFirst({
        where: {
          publicationAttemptId: command.publicationAttemptId,
          state: DbClaimState.active,
        },
      });
      if (active !== null && active.expiresAt > now) {
        return { status: ClaimReviewPublicationStatus.AlreadyClaimed };
      }
      if (
        command.expiresAt <= now ||
        command.reportUntil < command.expiresAt ||
        command.retainUntil < command.reportUntil
      ) {
        throw new Error("publication_claim_window_invalid");
      }
      const conflictingIdentity =
        await transaction.reviewPublicationClaimTermV2.findFirst({
          where: {
            OR: [
              { claimId: command.claimId },
              { claimCapabilityId: command.claimCapabilityId },
            ],
          },
          select: { claimId: true },
        });
      if (conflictingIdentity !== null) {
        return { status: ClaimReviewPublicationStatus.RequestConflict };
      }

      if (active !== null) {
        await expireClaimAndWork(transaction, active.claimId);
      }
      const claimRow = await transaction.reviewPublicationClaimTermV2.create({
        data: {
          claimId: command.claimId,
          publicationAttemptId: command.publicationAttemptId,
          ownerIdHash: command.ownerIdHash,
          acquireRequestIdHash: command.acquireRequestIdHash,
          acquireRequestHash: command.requestHash,
          commandFingerprint,
          claimCapabilityId: command.claimCapabilityId,
          capabilitySigningKeyId: command.capabilitySigningKeyId,
          state: DbClaimState.active,
          acquiredAt: now,
          renewedAt: now,
          expiresAt: command.expiresAt,
          reportUntil: command.reportUntil,
          retainUntil: command.retainUntil,
        },
      });
      await exactAttemptUpdate(transaction, {
        publicationAttemptId: command.publicationAttemptId,
        expectedVersion: command.expectedAttemptVersion,
        data: {
          version: { increment: 1n },
          activeClaimId: claimRow.claimId,
          state: DbAttemptState.publishing,
        },
      });
      const attempt = await requiredAttempt(
        transaction,
        command.publicationAttemptId,
      );
      const claim = toDomainClaim(claimRow);
      return {
        status: ClaimReviewPublicationStatus.Acquired,
        attempt,
        claim,
        capability: claimCapabilityFacts(attempt, claim, claimRow.reportUntil),
      };
    });
  }

  async renewClaim(
    command: RenewReviewPublicationClaimCommand,
  ): Promise<RenewReviewPublicationClaimResult> {
    return this.withSerializableTransaction(async (transaction) => {
      if (!(await lockAttempt(transaction, command.publicationAttemptId))) {
        return { status: RenewReviewPublicationClaimStatus.Missing };
      }
      const attempt =
        await transaction.reviewPublicationAttemptV2.findUniqueOrThrow({
          where: { publicationAttemptId: command.publicationAttemptId },
          select: { activeClaimId: true, state: true },
        });
      if (attempt.state === DbAttemptState.terminal) {
        return { status: RenewReviewPublicationClaimStatus.Terminal };
      }
      const now = await databaseNow(transaction);
      const claim = await transaction.reviewPublicationClaimTermV2.findUnique({
        where: { claimId: command.claimId },
      });
      if (
        claim === null ||
        claim.publicationAttemptId !== command.publicationAttemptId ||
        claim.ownerIdHash !== command.ownerIdHash ||
        claim.fencingToken !== command.claimFencingToken ||
        claim.state !== DbClaimState.active ||
        claim.expiresAt <= now ||
        attempt.activeClaimId !== claim.claimId
      ) {
        return { status: RenewReviewPublicationClaimStatus.StaleClaim };
      }
      const requestedExpiry = new Date(now.getTime() + command.extendByMs);
      const expiresAt = new Date(
        Math.min(
          claim.retainUntil.getTime(),
          Math.max(claim.expiresAt.getTime(), requestedExpiry.getTime()),
        ),
      );
      if (expiresAt.getTime() - now.getTime() < command.minimumRemainingMs) {
        return {
          status: RenewReviewPublicationClaimStatus.InsufficientWindow,
        };
      }
      const renewed = await transaction.reviewPublicationClaimTermV2.updateMany(
        {
          where: {
            claimId: claim.claimId,
            publicationAttemptId: command.publicationAttemptId,
            ownerIdHash: command.ownerIdHash,
            fencingToken: command.claimFencingToken,
            state: DbClaimState.active,
            expiresAt: { gt: now },
          },
          data: { renewedAt: now, expiresAt },
        },
      );
      if (renewed.count !== 1) {
        return { status: RenewReviewPublicationClaimStatus.StaleClaim };
      }
      return {
        status: RenewReviewPublicationClaimStatus.Renewed,
        claim: toDomainClaim(
          await transaction.reviewPublicationClaimTermV2.findUniqueOrThrow({
            where: { claimId: claim.claimId },
          }),
        ),
      };
    });
  }

  async begin(
    command: BeginReviewPublicationOperationCommand,
  ): Promise<BeginReviewPublicationOperationResult> {
    const commandFingerprint = fingerprint(withoutKey(command, "startedAt"));
    return this.withSerializableTransaction(async (transaction) => {
      if (!(await lockAttempt(transaction, command.publicationAttemptId))) {
        return { status: BeginReviewPublicationOperationStatus.Missing };
      }
      const existing =
        await transaction.reviewPublicationOperationAttemptV2.findUnique({
          where: {
            publicationOperationId_claimId_acquireRequestIdHash: {
              publicationOperationId: command.publicationOperationId,
              claimId: command.claimId,
              acquireRequestIdHash: command.acquireRequestIdHash,
            },
          },
        });
      if (existing !== null) {
        if (
          existing.publicationAttemptId !== command.publicationAttemptId ||
          existing.acquireRequestHash !== command.requestHash ||
          existing.commandFingerprint !== commandFingerprint
        ) {
          return {
            status: BeginReviewPublicationOperationStatus.RequestConflict,
          };
        }
        return operationBeginRestored(transaction, existing);
      }

      const attemptRow =
        await transaction.reviewPublicationAttemptV2.findUniqueOrThrow({
          where: { publicationAttemptId: command.publicationAttemptId },
        });
      if (attemptRow.state === DbAttemptState.terminal) {
        return { status: BeginReviewPublicationOperationStatus.Terminal };
      }
      if (attemptRow.version !== command.expectedAttemptVersion) {
        return {
          status: BeginReviewPublicationOperationStatus.VersionConflict,
          currentVersion: attemptRow.version,
        };
      }
      const now = await databaseNow(transaction);
      const claimRow =
        await transaction.reviewPublicationClaimTermV2.findUnique({
          where: { claimId: command.claimId },
        });
      if (
        claimRow === null ||
        claimRow.publicationAttemptId !== command.publicationAttemptId ||
        claimRow.state !== DbClaimState.active ||
        claimRow.fencingToken !== command.claimFencingToken ||
        claimRow.expiresAt <= now ||
        attemptRow.activeClaimId !== claimRow.claimId
      ) {
        return { status: BeginReviewPublicationOperationStatus.StaleClaim };
      }
      const operationRow =
        await transaction.reviewPublicationOperationV2.findUnique({
          where: { publicationOperationId: command.publicationOperationId },
        });
      if (
        operationRow === null ||
        operationRow.publicationAttemptId !== command.publicationAttemptId
      ) {
        return { status: BeginReviewPublicationOperationStatus.Missing };
      }
      if (operationRow.state === DbOperationState.completed) {
        return {
          status: BeginReviewPublicationOperationStatus.OperationCompleted,
        };
      }
      if (operationRow.state === DbOperationState.in_flight) {
        const inFlight =
          await transaction.reviewPublicationOperationAttemptV2.findFirst({
            where: {
              publicationOperationId: operationRow.publicationOperationId,
              claimId: claimRow.claimId,
              state: { not: DbOperationAttemptState.stale },
            },
            select: { operationAttemptId: true },
          });
        if (inFlight !== null) {
          return {
            status: BeginReviewPublicationOperationStatus.OperationInFlight,
          };
        }
      }
      const targetExternalObjectId = await dependencyExternalObjectIdFromDb(
        transaction,
        operationRow.dependsOnOperationId,
      );
      if (
        operationRow.role ===
          toDbOperationRole(
            ReviewPublicationOperationRole.PendingReviewSubmit,
          ) &&
        targetExternalObjectId === null
      ) {
        return {
          status: BeginReviewPublicationOperationStatus.DependencyNotCompleted,
        };
      }
      if (
        command.effectReportUntil <= now ||
        command.retainUntil < command.effectReportUntil
      ) {
        throw new Error("publication_operation_window_invalid");
      }
      const conflictingIdentity =
        await transaction.reviewPublicationOperationAttemptV2.findFirst({
          where: {
            OR: [
              { operationAttemptId: command.operationAttemptId },
              { operationCapabilityId: command.operationCapabilityId },
              { effectReportId: command.effectReportId },
            ],
          },
          select: { operationAttemptId: true },
        });
      if (conflictingIdentity !== null) {
        return {
          status: BeginReviewPublicationOperationStatus.RequestConflict,
        };
      }

      const operationAttemptRow =
        await transaction.reviewPublicationOperationAttemptV2.create({
          data: {
            operationAttemptId: command.operationAttemptId,
            publicationOperationId: command.publicationOperationId,
            publicationAttemptId: command.publicationAttemptId,
            claimId: command.claimId,
            acquireRequestIdHash: command.acquireRequestIdHash,
            acquireRequestHash: command.requestHash,
            commandFingerprint,
            operationCapabilityId: command.operationCapabilityId,
            capabilitySigningKeyId: command.capabilitySigningKeyId,
            effectReportId: command.effectReportId,
            claimFencingToken: command.claimFencingToken,
            state: DbOperationAttemptState.active,
            startedAt: now,
            effectReportUntil: command.effectReportUntil,
            retainUntil: command.retainUntil,
          },
        });
      const operationUpdate =
        await transaction.reviewPublicationOperationV2.updateMany({
          where: {
            publicationOperationId: command.publicationOperationId,
            publicationAttemptId: command.publicationAttemptId,
            state: operationRow.state,
          },
          data: { state: DbOperationState.in_flight },
        });
      ensureUpdatedOnce(
        operationUpdate.count,
        "publication_operation_cas_conflict",
      );
      await exactAttemptUpdate(transaction, {
        publicationAttemptId: command.publicationAttemptId,
        expectedVersion: command.expectedAttemptVersion,
        data: { version: { increment: 1n } },
      });
      const attempt = await requiredAttempt(
        transaction,
        command.publicationAttemptId,
      );
      const operation = toDomainOperation({
        ...operationRow,
        state: DbOperationState.in_flight,
      });
      const operationAttempt = toDomainOperationAttempt(operationAttemptRow);
      return {
        status: BeginReviewPublicationOperationStatus.Begun,
        attempt,
        operation,
        operationAttempt,
        capability: operationCapabilityFacts({
          attempt,
          operation,
          operationAttempt,
          targetExternalObjectId,
        }),
      };
    });
  }

  async record(
    command: RecordReviewExternalEffectCommand,
  ): Promise<RecordReviewExternalEffectResult> {
    return this.withSerializableTransaction(async (transaction) => {
      if (
        !(await lockAttempt(
          transaction,
          command.capability.publicationAttemptId,
        ))
      ) {
        return { status: RecordReviewExternalEffectStatus.Missing };
      }
      const attempt = await requiredAttempt(
        transaction,
        command.capability.publicationAttemptId,
      );
      const operationRow =
        await transaction.reviewPublicationOperationV2.findUnique({
          where: {
            publicationOperationId: command.capability.publicationOperationId,
          },
        });
      const operationAttemptRow =
        await transaction.reviewPublicationOperationAttemptV2.findUnique({
          where: {
            operationAttemptId: command.capability.operationAttemptId,
          },
        });
      if (
        operationRow === null ||
        operationAttemptRow === null ||
        operationRow.publicationAttemptId !== attempt.publicationAttemptId ||
        operationAttemptRow.publicationAttemptId !==
          attempt.publicationAttemptId ||
        operationAttemptRow.publicationOperationId !==
          operationRow.publicationOperationId
      ) {
        return { status: RecordReviewExternalEffectStatus.Missing };
      }
      const operation = toDomainOperation(operationRow);
      const operationAttempt = toDomainOperationAttempt(operationAttemptRow);
      const targetExternalObjectId = await dependencyExternalObjectIdFromDb(
        transaction,
        operationRow.dependsOnOperationId,
      );
      try {
        assertOperationCapabilityMatches(
          command.capability,
          attempt,
          operation,
          operationAttempt,
        );
        if (
          command.capability.targetExternalObjectId !== targetExternalObjectId
        ) {
          throw new Error("publication_operation_capability_mismatch");
        }
      } catch {
        return {
          status: RecordReviewExternalEffectStatus.CapabilityMismatch,
        };
      }
      const now = await databaseNow(transaction);
      if (now > operationAttemptRow.effectReportUntil) {
        return { status: RecordReviewExternalEffectStatus.ReportExpired };
      }
      if (
        targetExternalObjectId !== null &&
        command.externalObjectId !== targetExternalObjectId
      ) {
        return {
          status: RecordReviewExternalEffectStatus.CapabilityMismatch,
        };
      }
      const existing =
        await transaction.reviewPublicationExternalEffectV2.findUnique({
          where: {
            operationAttemptId_effectReportId: {
              operationAttemptId: operationAttemptRow.operationAttemptId,
              effectReportId: operationAttemptRow.effectReportId,
            },
          },
        });
      if (existing !== null) {
        return sameEffect(toDomainEffect(existing), command)
          ? {
              status: RecordReviewExternalEffectStatus.Restored,
              effect: toDomainEffect(existing),
            }
          : { status: RecordReviewExternalEffectStatus.RequestConflict };
      }
      const byObject =
        await transaction.reviewPublicationExternalEffectV2.findFirst({
          where: {
            publicationOperationId: operation.publicationOperationId,
            effectKind: toDbEffectKind(command.effectKind),
            externalObjectId: command.externalObjectId,
          },
          select: { effectId: true },
        });
      if (byObject !== null) {
        return {
          status: RecordReviewExternalEffectStatus.ExternalObjectConflict,
        };
      }
      const byId =
        await transaction.reviewPublicationExternalEffectV2.findUnique({
          where: { effectId: command.effectId },
          select: { effectId: true },
        });
      if (byId !== null) {
        return { status: RecordReviewExternalEffectStatus.RequestConflict };
      }
      const effectRow =
        await transaction.reviewPublicationExternalEffectV2.create({
          data: {
            effectId: command.effectId,
            publicationAttemptId: attempt.publicationAttemptId,
            publicationOperationId: operation.publicationOperationId,
            operationAttemptId: operationAttempt.operationAttemptId,
            effectReportId: operationAttempt.effectReportId,
            reportRequestHash: command.reportRequestHash,
            externalObjectId: command.externalObjectId,
            observedObjectHash: command.observedObjectHash,
            effectKind: toDbEffectKind(command.effectKind),
            observedAt: command.observedAt,
          },
        });
      return {
        status: RecordReviewExternalEffectStatus.Recorded,
        effect: toDomainEffect(effectRow),
      };
    });
  }

  async complete(
    command: CompleteReviewPublicationOperationCommand,
  ): Promise<CompleteReviewPublicationOperationResult> {
    const completionFingerprint = fingerprint(
      withoutKey(command, "completedAt"),
    );
    return this.withSerializableTransaction(async (transaction) => {
      if (!(await lockAttempt(transaction, command.publicationAttemptId))) {
        return { status: CompleteReviewPublicationOperationStatus.Missing };
      }
      const existing = await transaction.reviewPublicationReceiptV2.findUnique({
        where: {
          publicationAttemptId_completionRequestIdHash: {
            publicationAttemptId: command.publicationAttemptId,
            completionRequestIdHash: command.completionRequestIdHash,
          },
        },
      });
      if (existing !== null) {
        if (
          existing.completionRequestHash !== command.requestHash ||
          existing.completionFingerprint !== completionFingerprint
        ) {
          return {
            status: CompleteReviewPublicationOperationStatus.RequestConflict,
          };
        }
        return {
          status: CompleteReviewPublicationOperationStatus.Restored,
          attempt: await requiredAttempt(
            transaction,
            command.publicationAttemptId,
          ),
          receipt: toDomainReceipt(existing),
        };
      }
      const attemptRow =
        await transaction.reviewPublicationAttemptV2.findUniqueOrThrow({
          where: { publicationAttemptId: command.publicationAttemptId },
        });
      if (attemptRow.state === DbAttemptState.terminal) {
        return { status: CompleteReviewPublicationOperationStatus.Terminal };
      }
      if (attemptRow.version !== command.expectedAttemptVersion) {
        return {
          status: CompleteReviewPublicationOperationStatus.VersionConflict,
          currentVersion: attemptRow.version,
        };
      }
      const now = await databaseNow(transaction);
      const claimRow =
        await transaction.reviewPublicationClaimTermV2.findUnique({
          where: { claimId: command.claimId },
        });
      if (
        claimRow === null ||
        claimRow.publicationAttemptId !== command.publicationAttemptId ||
        claimRow.state !== DbClaimState.active ||
        claimRow.fencingToken !== command.claimFencingToken ||
        claimRow.expiresAt <= now ||
        attemptRow.activeClaimId !== claimRow.claimId
      ) {
        return { status: CompleteReviewPublicationOperationStatus.StaleClaim };
      }
      const operationRow =
        await transaction.reviewPublicationOperationV2.findUnique({
          where: { publicationOperationId: command.publicationOperationId },
        });
      if (
        operationRow === null ||
        operationRow.publicationAttemptId !== command.publicationAttemptId
      ) {
        return { status: CompleteReviewPublicationOperationStatus.Missing };
      }
      const effectRows =
        await transaction.reviewPublicationExternalEffectV2.findMany({
          where: { publicationOperationId: command.publicationOperationId },
          orderBy: [{ observedAt: "asc" }, { effectId: "asc" }],
        });
      const canonical = selectCanonicalExternalEffect(
        effectRows.map(toDomainEffect),
      );
      if (
        canonical === null ||
        canonical.effectId !== command.canonicalEffectId
      ) {
        return {
          status:
            CompleteReviewPublicationOperationStatus.CanonicalEffectConflict,
        };
      }
      const targetExternalObjectId = await dependencyExternalObjectIdFromDb(
        transaction,
        operationRow.dependsOnOperationId,
      );
      if (
        targetExternalObjectId !== null &&
        canonical.externalObjectId !== targetExternalObjectId
      ) {
        return {
          status:
            CompleteReviewPublicationOperationStatus.CanonicalEffectConflict,
        };
      }
      const conflictingReceipt =
        await transaction.reviewPublicationReceiptV2.findFirst({
          where: {
            OR: [
              { publicationOperationId: command.publicationOperationId },
              { receiptId: command.receiptId },
            ],
          },
          select: { receiptId: true },
        });
      if (conflictingReceipt !== null) {
        return {
          status: CompleteReviewPublicationOperationStatus.RequestConflict,
        };
      }

      const receiptRow = await transaction.reviewPublicationReceiptV2.create({
        data: {
          receiptId: command.receiptId,
          publicationAttemptId: command.publicationAttemptId,
          publicationOperationId: command.publicationOperationId,
          completionRequestIdHash: command.completionRequestIdHash,
          completionRequestHash: command.requestHash,
          completionFingerprint,
          canonicalEffectId: canonical.effectId,
          canonicalExternalObjectId: canonical.externalObjectId,
          receiptHash: command.receiptHash,
          status: ReviewPublicationReceiptStatus.Succeeded,
          updatedAt: command.completedAt,
        },
      });
      const operationUpdate =
        await transaction.reviewPublicationOperationV2.updateMany({
          where: {
            publicationOperationId: command.publicationOperationId,
            publicationAttemptId: command.publicationAttemptId,
            state: operationRow.state,
          },
          data: { state: DbOperationState.completed },
        });
      ensureUpdatedOnce(
        operationUpdate.count,
        "publication_operation_cas_conflict",
      );
      await transaction.reviewPublicationOperationAttemptV2.updateMany({
        where: { publicationOperationId: command.publicationOperationId },
        data: { state: DbOperationAttemptState.stale },
      });
      await transaction.reviewPublicationOperationAttemptV2.updateMany({
        where: {
          publicationOperationId: command.publicationOperationId,
          claimId: command.claimId,
        },
        data: { state: DbOperationAttemptState.completed },
      });

      const operations =
        await transaction.reviewPublicationOperationV2.findMany({
          where: { publicationAttemptId: command.publicationAttemptId },
        });
      const receipts = await transaction.reviewPublicationReceiptV2.findMany({
        where: { publicationAttemptId: command.publicationAttemptId },
      });
      const allRequiredCompleted = hasEveryRequiredCanonicalReceipt({
        operations: operations.map(toDomainOperation),
        receipts: receipts.map(toDomainReceipt),
      });
      await exactAttemptUpdate(transaction, {
        publicationAttemptId: command.publicationAttemptId,
        expectedVersion: command.expectedAttemptVersion,
        data: {
          version: { increment: 1n },
          state: allRequiredCompleted
            ? DbAttemptState.terminal
            : DbAttemptState.publishing,
          terminalOutcome: allRequiredCompleted
            ? DbTerminalOutcome.succeeded
            : null,
          activeClaimId: allRequiredCompleted ? null : command.claimId,
        },
      });
      if (allRequiredCompleted) {
        await transaction.reviewPublicationClaimTermV2.updateMany({
          where: {
            claimId: command.claimId,
            state: DbClaimState.active,
            fencingToken: command.claimFencingToken,
          },
          data: { state: DbClaimState.released },
        });
      }
      return {
        status: CompleteReviewPublicationOperationStatus.Completed,
        attempt: await requiredAttempt(
          transaction,
          command.publicationAttemptId,
        ),
        receipt: toDomainReceipt(receiptRow),
      };
    });
  }

  async terminalizeUnknown(
    command: TerminalizeUnknownReviewPublicationCommand,
  ): Promise<TerminalizeUnknownReviewPublicationResult> {
    return this.withSerializableTransaction(async (transaction) => {
      if (!(await lockAttempt(transaction, command.publicationAttemptId))) {
        return { status: TerminalizeUnknownReviewPublicationStatus.Missing };
      }
      const existing =
        await transaction.reviewPublicationAuditTombstoneV2.findUnique({
          where: { publicationOperationId: command.publicationOperationId },
        });
      if (existing !== null) {
        if (!sameTombstone(toDomainTombstone(existing), command)) {
          return { status: TerminalizeUnknownReviewPublicationStatus.Conflict };
        }
        return {
          status: TerminalizeUnknownReviewPublicationStatus.Restored,
          attempt: await requiredAttempt(
            transaction,
            command.publicationAttemptId,
          ),
          tombstone: toDomainTombstone(existing),
        };
      }
      const attemptRow =
        await transaction.reviewPublicationAttemptV2.findUniqueOrThrow({
          where: { publicationAttemptId: command.publicationAttemptId },
        });
      if (attemptRow.version !== command.expectedAttemptVersion) {
        return {
          status: TerminalizeUnknownReviewPublicationStatus.VersionConflict,
          currentVersion: attemptRow.version,
        };
      }
      const now = await databaseNow(transaction);
      const finalOutcome =
        command.finalOutcome ??
        ReviewPublicationTerminalOutcome.TerminalUnknown;
      const claimRow =
        command.claimId === null
          ? null
          : await transaction.reviewPublicationClaimTermV2.findUnique({
              where: { claimId: command.claimId },
            });
      const unclaimedNoEffect =
        command.claimId === null &&
        command.claimFencingToken === null &&
        attemptRow.activeClaimId === null &&
        (finalOutcome === ReviewPublicationTerminalOutcome.SupersededNoEffect ||
          finalOutcome === ReviewPublicationTerminalOutcome.FailedNoEffect);
      const currentClaim =
        claimRow !== null &&
        claimRow.publicationAttemptId === command.publicationAttemptId &&
        claimRow.state === DbClaimState.active &&
        claimRow.fencingToken === command.claimFencingToken &&
        claimRow.expiresAt > now &&
        attemptRow.activeClaimId === claimRow.claimId;
      if (!unclaimedNoEffect && !currentClaim) {
        return { status: TerminalizeUnknownReviewPublicationStatus.StaleClaim };
      }
      const operationRow =
        await transaction.reviewPublicationOperationV2.findUnique({
          where: { publicationOperationId: command.publicationOperationId },
        });
      if (
        operationRow === null ||
        operationRow.publicationAttemptId !== command.publicationAttemptId
      ) {
        return { status: TerminalizeUnknownReviewPublicationStatus.Missing };
      }
      if (
        finalOutcome === ReviewPublicationTerminalOutcome.TerminalUnknown &&
        now < operationRow.reconcileUntil
      ) {
        return { status: TerminalizeUnknownReviewPublicationStatus.TooEarly };
      }
      const tombstoneById =
        await transaction.reviewPublicationAuditTombstoneV2.findUnique({
          where: { tombstoneId: command.tombstoneId },
          select: { tombstoneId: true },
        });
      if (tombstoneById !== null) {
        return { status: TerminalizeUnknownReviewPublicationStatus.Conflict };
      }
      const externalObjects =
        await transaction.reviewPublicationExternalEffectV2.findMany({
          where: { publicationOperationId: command.publicationOperationId },
          distinct: ["externalObjectId"],
          orderBy: { externalObjectId: "asc" },
          select: { externalObjectId: true },
        });
      const tombstoneRow =
        await transaction.reviewPublicationAuditTombstoneV2.create({
          data: {
            tombstoneId: command.tombstoneId,
            publicationAttemptId: command.publicationAttemptId,
            publicationOperationId: command.publicationOperationId,
            reviewRevisionHash: operationRow.reviewRevisionHash,
            markerHash: operationRow.markerHash,
            bodyHash: operationRow.bodyHash,
            knownExternalObjectIds: externalObjects.map(
              ({ externalObjectId }) => externalObjectId,
            ),
            finalOutcome: toDbTerminalOutcome(finalOutcome),
            finalReason: command.finalReason,
            lastErrorCode: command.lastErrorCode,
            terminalizedBy: command.terminalizedBy,
            terminalizedAt: command.terminalizedAt,
            retainUntil: command.retainUntil,
          },
        });
      const operationUpdate =
        await transaction.reviewPublicationOperationV2.updateMany({
          where: {
            publicationOperationId: command.publicationOperationId,
            publicationAttemptId: command.publicationAttemptId,
            state: operationRow.state,
          },
          data: { state: toDbOperationState(operationStateFor(finalOutcome)) },
        });
      ensureUpdatedOnce(
        operationUpdate.count,
        "publication_operation_cas_conflict",
      );
      if (command.claimId !== null && command.claimFencingToken !== null) {
        await transaction.reviewPublicationClaimTermV2.updateMany({
          where: {
            claimId: command.claimId,
            state: DbClaimState.active,
            fencingToken: command.claimFencingToken,
          },
          data: { state: DbClaimState.released },
        });
      }
      await transaction.reviewPublicationOperationAttemptV2.updateMany({
        where: {
          publicationOperationId: command.publicationOperationId,
          state: { not: DbOperationAttemptState.completed },
        },
        data: {
          state:
            finalOutcome === ReviewPublicationTerminalOutcome.TerminalUnknown
              ? DbOperationAttemptState.terminal_unknown
              : DbOperationAttemptState.stale,
        },
      });
      await exactAttemptUpdate(transaction, {
        publicationAttemptId: command.publicationAttemptId,
        expectedVersion: command.expectedAttemptVersion,
        data: {
          version: { increment: 1n },
          activeClaimId: null,
          state: DbAttemptState.terminal,
          terminalOutcome: toDbTerminalOutcome(finalOutcome),
        },
      });
      return {
        status: TerminalizeUnknownReviewPublicationStatus.Terminalized,
        attempt: await requiredAttempt(
          transaction,
          command.publicationAttemptId,
        ),
        tombstone: toDomainTombstone(tombstoneRow),
      };
    });
  }

  async adjudicate(
    command: AdjudicateReviewPublicationOutcomeCommand,
  ): Promise<AdjudicateReviewPublicationOutcomeResult> {
    return this.withSerializableTransaction(async (transaction) => {
      if (!(await lockAttempt(transaction, command.publicationAttemptId))) {
        return { status: AdjudicateReviewPublicationOutcomeStatus.Missing };
      }
      const existing =
        await transaction.reviewPublicationOutcomeCorrectionV2.findFirst({
          where: {
            OR: [
              { correctionId: command.correctionId },
              {
                publicationAttemptId: command.publicationAttemptId,
                correctionOrdinal: command.correctionOrdinal,
              },
            ],
          },
        });
      if (existing !== null) {
        const correction = toDomainCorrection(existing);
        if (
          !sameCorrection(correction, command) ||
          !(await provenReceiptsMatch(transaction, command))
        ) {
          return { status: AdjudicateReviewPublicationOutcomeStatus.Conflict };
        }
        return {
          status: AdjudicateReviewPublicationOutcomeStatus.Restored,
          attempt: await requiredAttempt(
            transaction,
            command.publicationAttemptId,
          ),
          correction,
        };
      }
      const attemptRow =
        await transaction.reviewPublicationAttemptV2.findUniqueOrThrow({
          where: { publicationAttemptId: command.publicationAttemptId },
        });
      if (attemptRow.terminalOutcome !== DbTerminalOutcome.terminal_unknown) {
        return {
          status: AdjudicateReviewPublicationOutcomeStatus.NotTerminalUnknown,
        };
      }
      if (attemptRow.version !== command.expectedAttemptVersion) {
        return {
          status: AdjudicateReviewPublicationOutcomeStatus.VersionConflict,
          currentVersion: attemptRow.version,
        };
      }
      const correctionCount =
        await transaction.reviewPublicationOutcomeCorrectionV2.count({
          where: { publicationAttemptId: command.publicationAttemptId },
        });
      if (
        command.correctionOrdinal !== correctionCount + 1 ||
        command.safeReason !==
          expectedCorrectionReason(command.correctedOutcome)
      ) {
        return { status: AdjudicateReviewPublicationOutcomeStatus.Conflict };
      }
      if (
        command.correctedOutcome === ReviewPublicationTerminalOutcome.Succeeded
      ) {
        if (command.provenReceipts.length === 0) {
          return {
            status:
              AdjudicateReviewPublicationOutcomeStatus.MissingCanonicalReceipts,
          };
        }
        const operations =
          await transaction.reviewPublicationOperationV2.findMany({
            where: { publicationAttemptId: command.publicationAttemptId },
          });
        const operationIds = new Set<string>();
        const existingReceipts =
          await transaction.reviewPublicationReceiptV2.findMany({
            where: { publicationAttemptId: command.publicationAttemptId },
          });
        const successfulOperationIds = new Set(
          existingReceipts
            .filter(
              ({ status }) =>
                status === ReviewPublicationReceiptStatus.Succeeded,
            )
            .map(({ publicationOperationId }) => publicationOperationId),
        );
        const pendingReceipts: Prisma.ReviewPublicationReceiptV2CreateManyInput[] =
          [];
        const pendingReceiptIds = new Set<string>();
        for (const proof of command.provenReceipts) {
          if (operationIds.has(proof.publicationOperationId)) {
            return {
              status: AdjudicateReviewPublicationOutcomeStatus.Conflict,
            };
          }
          operationIds.add(proof.publicationOperationId);
          if (
            !operations.some(
              ({ publicationOperationId }) =>
                publicationOperationId === proof.publicationOperationId,
            )
          ) {
            return {
              status: AdjudicateReviewPublicationOutcomeStatus.Conflict,
            };
          }
          const receipt = existingReceipts.find(
            ({ publicationOperationId }) =>
              publicationOperationId === proof.publicationOperationId,
          );
          if (receipt !== undefined) {
            if (!sameProvenReceipt(toDomainReceipt(receipt), proof)) {
              return {
                status: AdjudicateReviewPublicationOutcomeStatus.Conflict,
              };
            }
            successfulOperationIds.add(proof.publicationOperationId);
            continue;
          }
          const receiptIdConflict =
            await transaction.reviewPublicationReceiptV2.findUnique({
              where: { receiptId: proof.receiptId },
              select: { receiptId: true },
            });
          if (receiptIdConflict !== null) {
            return {
              status: AdjudicateReviewPublicationOutcomeStatus.Conflict,
            };
          }
          if (pendingReceiptIds.has(proof.receiptId)) {
            return {
              status: AdjudicateReviewPublicationOutcomeStatus.Conflict,
            };
          }
          pendingReceiptIds.add(proof.receiptId);
          pendingReceipts.push({
            receiptId: proof.receiptId,
            publicationAttemptId: command.publicationAttemptId,
            publicationOperationId: proof.publicationOperationId,
            completionRequestIdHash: `adjudication:${command.correctionId}:${proof.publicationOperationId}`,
            completionRequestHash: command.evidenceHash,
            completionFingerprint: fingerprint(proof),
            canonicalEffectId: proof.canonicalEffectId,
            canonicalExternalObjectId: proof.canonicalExternalObjectId,
            receiptHash: proof.receiptHash,
            status: ReviewPublicationReceiptStatus.Succeeded,
            updatedAt: proof.provenAt,
          });
          successfulOperationIds.add(proof.publicationOperationId);
        }
        if (
          operations
            .filter(({ required }) => required)
            .some(
              ({ publicationOperationId }) =>
                !successfulOperationIds.has(publicationOperationId),
            )
        ) {
          return {
            status:
              AdjudicateReviewPublicationOutcomeStatus.MissingCanonicalReceipts,
          };
        }
        if (pendingReceipts.length > 0) {
          await transaction.reviewPublicationReceiptV2.createMany({
            data: pendingReceipts,
          });
        }
      } else if (command.provenReceipts.length > 0) {
        return { status: AdjudicateReviewPublicationOutcomeStatus.Conflict };
      }

      const correctionRow =
        await transaction.reviewPublicationOutcomeCorrectionV2.create({
          data: {
            correctionId: command.correctionId,
            publicationAttemptId: command.publicationAttemptId,
            correctionOrdinal: command.correctionOrdinal,
            priorOutcome: DbTerminalOutcome.terminal_unknown,
            correctedOutcome: toDbTerminalOutcome(command.correctedOutcome),
            evidenceHash: command.evidenceHash,
            safeReason: command.safeReason,
            correctedBy: command.correctedBy,
            correctedAt: command.correctedAt,
            retainUntil: command.retainUntil,
          },
        });
      await exactAttemptUpdate(transaction, {
        publicationAttemptId: command.publicationAttemptId,
        expectedVersion: command.expectedAttemptVersion,
        data: { version: { increment: 1n } },
      });
      return {
        status: AdjudicateReviewPublicationOutcomeStatus.Corrected,
        attempt: await requiredAttempt(
          transaction,
          command.publicationAttemptId,
        ),
        correction: toDomainCorrection(correctionRow),
      };
    });
  }

  private async withSerializableTransaction<T>(
    operation: (transaction: Transaction) => Promise<T>,
  ): Promise<T> {
    // This boundary persists domain state only. Retrying the whole transaction
    // reloads the current claim/version and never repeats an external SCM effect.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (!isTransactionConflict(error) || attempt === 3) throw error;
      }
    }
    throw new Error("review_publication_transaction_retry_exhausted");
  }
}

type PublicationReader = Pick<
  Transaction,
  | "reviewPublicationAttemptV2"
  | "reviewPublicationClaimTermV2"
  | "reviewPublicationOperationV2"
  | "reviewPublicationOperationAttemptV2"
  | "reviewPublicationExternalEffectV2"
  | "reviewPublicationReceiptV2"
  | "reviewPublicationAuditTombstoneV2"
  | "reviewPublicationOutcomeCorrectionV2"
>;

function isTransactionConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === "P2034") return true;
  if (error.code !== "P2010") return false;
  const details = `${safeJson(error.meta)} ${error.message}`;
  return /(?:^|\D)(?:40001|40P01)(?:\D|$)/u.test(details);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

async function loadAttemptView(
  client: PublicationReader,
  publicationAttemptId: string,
): Promise<ReviewPublicationAttemptView | null> {
  const attemptRow = await client.reviewPublicationAttemptV2.findUnique({
    where: { publicationAttemptId },
  });
  if (attemptRow === null) return null;
  const operations = await client.reviewPublicationOperationV2.findMany({
    where: { publicationAttemptId },
    orderBy: [{ chunkIndex: "asc" }, { publicationOperationId: "asc" }],
  });
  const activeClaim =
    attemptRow.activeClaimId === null
      ? null
      : await client.reviewPublicationClaimTermV2.findFirst({
          where: {
            claimId: attemptRow.activeClaimId,
            publicationAttemptId,
            state: DbClaimState.active,
          },
        });
  const operationAttempts =
    await client.reviewPublicationOperationAttemptV2.findMany({
      where: { publicationAttemptId },
      orderBy: [{ startedAt: "asc" }, { operationAttemptId: "asc" }],
    });
  const effects = await client.reviewPublicationExternalEffectV2.findMany({
    where: { publicationAttemptId },
    orderBy: [{ observedAt: "asc" }, { effectId: "asc" }],
  });
  const receipts = await client.reviewPublicationReceiptV2.findMany({
    where: { publicationAttemptId },
    orderBy: { publicationOperationId: "asc" },
  });
  const tombstones = await client.reviewPublicationAuditTombstoneV2.findMany({
    where: { publicationAttemptId },
    orderBy: { publicationOperationId: "asc" },
  });
  const corrections =
    await client.reviewPublicationOutcomeCorrectionV2.findMany({
      where: { publicationAttemptId },
      orderBy: { correctionOrdinal: "asc" },
    });
  return {
    attempt: toDomainAttempt(attemptRow, operations),
    activeClaim: activeClaim === null ? null : toDomainClaim(activeClaim),
    operationAttempts: operationAttempts.map(toDomainOperationAttempt),
    effects: effects.map(toDomainEffect),
    receipts: receipts.map(toDomainReceipt),
    tombstones: tombstones.map(toDomainTombstone),
    corrections: corrections.map(toDomainCorrection),
  };
}

async function requiredAttempt(
  client: PublicationReader,
  publicationAttemptId: string,
): Promise<ReviewPublicationAttempt> {
  const view = await loadAttemptView(client, publicationAttemptId);
  if (view === null) throw new Error("publication_attempt_missing_after_write");
  return view.attempt;
}

async function lockAttempt(
  transaction: Transaction,
  publicationAttemptId: string,
): Promise<boolean> {
  const rows = await transaction.$queryRaw<
    readonly { readonly publicationAttemptId: string }[]
  >(Prisma.sql`
    SELECT "publicationAttemptId"
    FROM "ReviewPublicationAttemptV2"
    WHERE "publicationAttemptId" = ${publicationAttemptId}
    FOR UPDATE
  `);
  return rows.length === 1;
}

async function databaseNow(transaction: Transaction): Promise<Date> {
  const [row] = await transaction.$queryRaw<
    readonly { readonly epochMs: bigint }[]
  >(Prisma.sql`
    SELECT floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint
      AS "epochMs"
  `);
  if (!row) throw new Error("publication_database_clock_unavailable");
  return new Date(Number(row.epochMs));
}

async function exactAttemptUpdate(
  transaction: Transaction,
  input: {
    readonly publicationAttemptId: string;
    readonly expectedVersion: bigint;
    readonly data: Prisma.ReviewPublicationAttemptV2UpdateManyMutationInput;
  },
): Promise<void> {
  const result = await transaction.reviewPublicationAttemptV2.updateMany({
    where: {
      publicationAttemptId: input.publicationAttemptId,
      version: input.expectedVersion,
    },
    data: input.data,
  });
  if (result.count !== 1) throw new Error("publication_attempt_cas_conflict");
}

async function claimRestored(
  transaction: Transaction,
  row: Awaited<
    ReturnType<Transaction["reviewPublicationClaimTermV2"]["findUniqueOrThrow"]>
  >,
): Promise<ClaimReviewPublicationResult> {
  const attempt = await requiredAttempt(transaction, row.publicationAttemptId);
  const claim = toDomainClaim(row);
  return {
    status: ClaimReviewPublicationStatus.Restored,
    attempt,
    claim,
    capability: claimCapabilityFacts(attempt, claim, row.reportUntil),
  };
}

async function operationBeginRestored(
  transaction: Transaction,
  row: Awaited<
    ReturnType<
      Transaction["reviewPublicationOperationAttemptV2"]["findUniqueOrThrow"]
    >
  >,
): Promise<BeginReviewPublicationOperationResult> {
  const attempt = await requiredAttempt(transaction, row.publicationAttemptId);
  const operationRow =
    await transaction.reviewPublicationOperationV2.findUnique({
      where: { publicationOperationId: row.publicationOperationId },
    });
  if (operationRow === null) {
    return { status: BeginReviewPublicationOperationStatus.RequestConflict };
  }
  const operation = toDomainOperation(operationRow);
  const operationAttempt = toDomainOperationAttempt(row);
  return {
    status: BeginReviewPublicationOperationStatus.Restored,
    attempt,
    operation,
    operationAttempt,
    capability: operationCapabilityFacts({
      attempt,
      operation,
      operationAttempt,
      targetExternalObjectId: await dependencyExternalObjectIdFromDb(
        transaction,
        operationRow.dependsOnOperationId,
      ),
    }),
  };
}

async function expireClaimAndWork(
  transaction: Transaction,
  claimId: string,
): Promise<void> {
  await transaction.reviewPublicationClaimTermV2.updateMany({
    where: { claimId, state: DbClaimState.active },
    data: { state: DbClaimState.expired },
  });
  const unfinished =
    await transaction.reviewPublicationOperationAttemptV2.findMany({
      where: {
        claimId,
        state: {
          notIn: [
            DbOperationAttemptState.completed,
            DbOperationAttemptState.stale,
          ],
        },
      },
      select: { publicationOperationId: true },
    });
  if (unfinished.length === 0) return;
  await transaction.reviewPublicationOperationAttemptV2.updateMany({
    where: {
      claimId,
      state: {
        notIn: [
          DbOperationAttemptState.completed,
          DbOperationAttemptState.stale,
        ],
      },
    },
    data: { state: DbOperationAttemptState.stale },
  });
  await transaction.reviewPublicationOperationV2.updateMany({
    where: {
      publicationOperationId: {
        in: [
          ...new Set(
            unfinished.map(
              ({ publicationOperationId }) => publicationOperationId,
            ),
          ),
        ],
      },
      state: DbOperationState.in_flight,
    },
    data: { state: DbOperationState.reconciling },
  });
}

function dependencyExternalObjectId(
  receipts: readonly ReviewPublicationReceipt[],
  operation: ReviewPublicationOperation,
): string | null {
  if (operation.dependsOnOperationId === null) return null;
  return (
    receipts.find(
      (receipt) =>
        receipt.publicationOperationId === operation.dependsOnOperationId,
    )?.canonicalExternalObjectId ?? null
  );
}

async function dependencyExternalObjectIdFromDb(
  transaction: Transaction,
  dependencyOperationId: string | null,
): Promise<string | null> {
  if (dependencyOperationId === null) return null;
  const receipt = await transaction.reviewPublicationReceiptV2.findUnique({
    where: { publicationOperationId: dependencyOperationId },
    select: { canonicalExternalObjectId: true },
  });
  return receipt?.canonicalExternalObjectId ?? null;
}

function sameEffect(
  effect: ReviewPublicationExternalEffect,
  command: RecordReviewExternalEffectCommand,
): boolean {
  return (
    effect.effectId === command.effectId &&
    effect.reportRequestHash === command.reportRequestHash &&
    effect.externalObjectId === command.externalObjectId &&
    effect.observedObjectHash === command.observedObjectHash &&
    effect.effectKind === command.effectKind
  );
}

function sameTombstone(
  tombstone: ReviewPublicationAuditTombstone,
  command: TerminalizeUnknownReviewPublicationCommand,
): boolean {
  return (
    tombstone.tombstoneId === command.tombstoneId &&
    tombstone.publicationAttemptId === command.publicationAttemptId &&
    tombstone.finalOutcome ===
      (command.finalOutcome ??
        ReviewPublicationTerminalOutcome.TerminalUnknown) &&
    tombstone.finalReason === command.finalReason &&
    tombstone.lastErrorCode === command.lastErrorCode &&
    tombstone.terminalizedBy === command.terminalizedBy &&
    tombstone.retainUntil.getTime() === command.retainUntil.getTime()
  );
}

function operationStateFor(
  outcome: Exclude<
    ReviewPublicationTerminalOutcome,
    ReviewPublicationTerminalOutcome.Succeeded
  >,
): ReviewPublicationOperationState {
  switch (outcome) {
    case ReviewPublicationTerminalOutcome.SupersededNoEffect:
      return ReviewPublicationOperationState.SupersededNoEffect;
    case ReviewPublicationTerminalOutcome.FailedNoEffect:
      return ReviewPublicationOperationState.FailedNoEffect;
    case ReviewPublicationTerminalOutcome.StaleCompensated:
      return ReviewPublicationOperationState.StaleCompensated;
    case ReviewPublicationTerminalOutcome.StaleVisible:
      return ReviewPublicationOperationState.StaleVisible;
    case ReviewPublicationTerminalOutcome.TerminalUnknown:
      return ReviewPublicationOperationState.TerminalUnknown;
  }
}

function sameCorrection(
  correction: ReviewPublicationOutcomeCorrection,
  command: AdjudicateReviewPublicationOutcomeCommand,
): boolean {
  return (
    correction.correctionId === command.correctionId &&
    correction.publicationAttemptId === command.publicationAttemptId &&
    correction.correctionOrdinal === command.correctionOrdinal &&
    correction.correctedOutcome === command.correctedOutcome &&
    correction.evidenceHash === command.evidenceHash &&
    correction.safeReason === command.safeReason &&
    correction.correctedBy === command.correctedBy &&
    correction.retainUntil.getTime() === command.retainUntil.getTime()
  );
}

async function provenReceiptsMatch(
  transaction: Transaction,
  command: AdjudicateReviewPublicationOutcomeCommand,
): Promise<boolean> {
  for (const proof of command.provenReceipts) {
    const receipt = await transaction.reviewPublicationReceiptV2.findUnique({
      where: { publicationOperationId: proof.publicationOperationId },
    });
    if (
      receipt === null ||
      !sameProvenReceipt(toDomainReceipt(receipt), proof)
    ) {
      return false;
    }
  }
  return true;
}

function sameProvenReceipt(
  receipt: ReviewPublicationReceipt,
  proof: AdjudicateReviewPublicationOutcomeCommand["provenReceipts"][number],
): boolean {
  return (
    receipt.status === ReviewPublicationReceiptStatus.Succeeded &&
    receipt.receiptId === proof.receiptId &&
    receipt.canonicalEffectId === proof.canonicalEffectId &&
    receipt.canonicalExternalObjectId === proof.canonicalExternalObjectId &&
    receipt.receiptHash === proof.receiptHash &&
    receipt.updatedAt.getTime() === proof.provenAt.getTime()
  );
}

function expectedCorrectionReason(
  outcome:
    | ReviewPublicationTerminalOutcome.Succeeded
    | ReviewPublicationTerminalOutcome.StaleCompensated
    | ReviewPublicationTerminalOutcome.StaleVisible,
): ReviewPublicationCorrectionReason {
  switch (outcome) {
    case ReviewPublicationTerminalOutcome.Succeeded:
      return ReviewPublicationCorrectionReason.CanonicalEffectsProven;
    case ReviewPublicationTerminalOutcome.StaleCompensated:
      return ReviewPublicationCorrectionReason.StaleEffectCompensated;
    case ReviewPublicationTerminalOutcome.StaleVisible:
      return ReviewPublicationCorrectionReason.StaleEffectVisible;
  }
}

function fingerprint(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function withoutKey<T extends object, K extends keyof T>(
  value: T,
  key: K,
): Omit<T, K> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

function normalize(value: unknown): unknown {
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (value instanceof Date) return { $date: value.toISOString() };
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalize(nested)]),
    );
  }
  return value;
}

function ensureUpdatedOnce(count: number, code: string): void {
  if (count !== 1) throw new Error(code);
}
