import {
  Prisma,
  ReviewInvestigationConclusionV1 as PrismaConclusion,
  ReviewInvestigationCriticDecisionV1 as PrismaCriticDecision,
  ReviewInvestigationObligationKindV1 as PrismaObligationKind,
  ReviewInvestigationObligationOriginV1 as PrismaObligationOrigin,
  ReviewInvestigationObligationStateV1 as PrismaObligationState,
  ReviewInvestigationReceiptKindV1 as PrismaReceiptKind,
  ReviewInvestigationRuntimeProfileV1 as PrismaRuntimeProfile,
  ReviewInvestigationStateV1 as PrismaInvestigationState,
  ReviewInvestigationTurnPurposeV1 as PrismaTurnPurpose,
  ReviewInvestigationTurnStateV1 as PrismaTurnState,
  type PrismaClient,
  type ReviewInvestigation as PrismaInvestigationRecord,
  type ReviewInvestigationCertificate as PrismaCertificateRecord,
  type ReviewInvestigationObligation as PrismaObligationRecord,
  type ReviewInvestigationPrivateMaterial as PrismaPrivateMaterialRecord,
  type ReviewInvestigationReceipt as PrismaReceiptRecord,
  type ReviewInvestigationTurn as PrismaTurnRecord,
} from "@prisma/client";
import {
  assertDigest,
  assertNonNegativeInteger,
} from "../../domain/canonicalization";
import {
  InvestigationPrivateMaterialPersistenceStatus,
  type InvestigationPrivateMaterialStorePort,
  type InvestigationPrunerPort,
} from "../../application/ports/investigation-private-material-ports";
import {
  InvestigationStoreCommitStatus,
  InvestigationStoreTransitionKind,
  type InvestigationStoreCommitResult,
  type InvestigationStorePort,
  type InvestigationStoreTransition,
} from "../../application/ports/investigation-store-port";
import { assertInvestigationPolicy, type ReviewInvestigationPolicy } from "../../domain/investigation-policy";
import {
  createEncryptedInvestigationPrivateMaterial,
  investigationPrivateMaterialEncryptionAlgorithm,
  type EncryptedInvestigationPrivateMaterial,
} from "../../domain/investigation-private-material";
import {
  InvestigationObligationOrigin,
  InvestigationReceiptKind,
  type InvestigationEvidenceReceipt,
  type InvestigationObligation,
} from "../../domain/investigation-obligation";
import type { ReviewInvestigationCertificate } from "../../domain/investigation-certificate";
import type {
  InvestigationFinding,
  InvestigationTurn,
} from "../../domain/investigation-turn";
import type { ReviewInvestigation } from "../../domain/review-investigation";
import {
  ContextCriticDecision,
  InvestigationObligationKind,
  InvestigationObligationState,
  ReviewInvestigationConclusion,
  ReviewInvestigationRuntimeProfile,
  ReviewInvestigationState,
  ReviewInvestigationTurnPurpose,
} from "../../domain/review-investigation-types";

type InvestigationDb = Pick<
  PrismaClient,
  | "reviewInvestigation"
  | "reviewInvestigationObligation"
  | "reviewInvestigationTurn"
  | "reviewInvestigationReceipt"
  | "reviewInvestigationPrivateMaterial"
  | "reviewInvestigationCertificate"
  | "reviewInvestigationCommandReceipt"
>;

export type PrismaInvestigationStoreOptions = Readonly<{
  operationalRetentionMs: number;
}>;

const defaultOptions: PrismaInvestigationStoreOptions = Object.freeze({
  operationalRetentionMs: 30 * 24 * 60 * 60 * 1_000,
});

export class PrismaInvestigationStore
  implements
    InvestigationStorePort,
    InvestigationPrivateMaterialStorePort,
    InvestigationPrunerPort
{
  private readonly options: PrismaInvestigationStoreOptions;

  constructor(
    private readonly prisma: PrismaClient,
    options: Partial<PrismaInvestigationStoreOptions> = {},
  ) {
    this.options = { ...defaultOptions, ...options };
    if (
      !Number.isSafeInteger(this.options.operationalRetentionMs) ||
      this.options.operationalRetentionMs <= 0
    ) {
      throw new Error("investigation_operational_retention_invalid");
    }
  }

  async restoreCommand(input: {
    readonly commandId: string;
    readonly commandHash: string;
  }): Promise<InvestigationStoreCommitResult | null> {
    const command = await this.prisma.reviewInvestigationCommandReceipt.findUnique({
      where: { commandId: input.commandId },
    });
    if (!command) return null;
    if (command.commandHash !== input.commandHash) {
      return result(InvestigationStoreCommitStatus.IdempotencyConflict, null);
    }
    const investigation = await loadAggregate(this.prisma, command.investigationId);
    if (!investigation) throw new Error("investigation_command_snapshot_missing");
    return result(InvestigationStoreCommitStatus.Restored, investigation);
  }

  async findById(investigationId: string): Promise<ReviewInvestigation | null> {
    return loadAggregate(this.prisma, investigationId);
  }

  async findByNaturalIdentity(
    naturalIdentityHash: string,
  ): Promise<ReviewInvestigation | null> {
    const record = await this.prisma.reviewInvestigation.findUnique({
      where: { naturalIdentityHash },
      select: { investigationId: true },
    });
    return record ? loadAggregate(this.prisma, record.investigationId) : null;
  }

  async commit(input: {
    readonly investigation: ReviewInvestigation;
    readonly expectedVersion: number | null;
    readonly commandId: string;
    readonly commandHash: string;
    readonly transition: InvestigationStoreTransition;
  }): Promise<InvestigationStoreCommitResult> {
    try {
      return await this.prisma.$transaction(
        async (transaction) => {
          const command =
            await transaction.reviewInvestigationCommandReceipt.findUnique({
              where: { commandId: input.commandId },
            });
          if (command) {
            if (command.commandHash !== input.commandHash) {
              return result(
                InvestigationStoreCommitStatus.IdempotencyConflict,
                null,
              );
            }
            const restored = await loadAggregate(
              transaction,
              command.investigationId,
            );
            if (!restored) {
              throw new Error("investigation_command_snapshot_missing");
            }
            return result(InvestigationStoreCommitStatus.Restored, restored);
          }

          if (input.expectedVersion === null) {
            return this.createAggregate(transaction, {
              investigation: input.investigation,
              expectedVersion: null,
              commandId: input.commandId,
              commandHash: input.commandHash,
              transition: input.transition,
            });
          }
          await transaction.$queryRaw(Prisma.sql`
            SELECT "investigationId"
            FROM "ReviewInvestigation"
            WHERE "investigationId" = ${input.investigation.investigationId}
            FOR UPDATE
          `);
          const current = await loadAggregate(
            transaction,
            input.investigation.investigationId,
          );
          if (!current || current.version !== input.expectedVersion) {
            return result(
              InvestigationStoreCommitStatus.ConcurrencyConflict,
              current,
            );
          }
          assertUpdate(current, input.investigation, input.transition);
          const retainUntil = aggregateRetainUntil(
            input.investigation,
            this.options.operationalRetentionMs,
          );
          await persistTransition(
            transaction,
            current,
            input.investigation,
            input.transition,
            retainUntil,
          );
          await persistObligations(
            transaction,
            current,
            input.investigation,
            input.transition,
            retainUntil,
          );
          await persistCertificate(
            transaction,
            current,
            input.investigation,
          );
          const updated = await transaction.reviewInvestigation.updateMany({
            where: {
              investigationId: input.investigation.investigationId,
              version: BigInt(input.expectedVersion),
            },
            data: toMainUpdate(input.investigation, retainUntil),
          });
          if (updated.count !== 1) {
            throw new InvestigationWriteRaceError();
          }
          if (input.investigation.certificate) {
            await transaction.reviewInvestigationReceipt.updateMany({
              where: {
                investigationId: input.investigation.investigationId,
                retainUntil: { lt: retainUntil },
              },
              data: { retainUntil },
            });
          }
          await transaction.reviewInvestigationCommandReceipt.create({
            data: {
              commandId: input.commandId,
              investigationId: input.investigation.investigationId,
              commandHash: input.commandHash,
              resultingVersion: BigInt(input.investigation.version),
              createdAt: new Date(input.investigation.updatedAt),
              retainUntil,
            },
          });
          const stored = await loadAggregate(
            transaction,
            input.investigation.investigationId,
          );
          if (!stored) throw new Error("investigation_commit_snapshot_missing");
          return result(InvestigationStoreCommitStatus.Committed, stored);
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      );
    } catch (error) {
      if (!isRetryablePersistenceConflict(error)) throw error;
      const restored = await this.restoreCommand({
        commandId: input.commandId,
        commandHash: input.commandHash,
      });
      if (restored) return restored;
      const existing =
        (await this.findById(input.investigation.investigationId)) ??
        (await this.findByNaturalIdentity(
          input.investigation.naturalIdentityHash,
        ));
      return result(InvestigationStoreCommitStatus.ConcurrencyConflict, existing);
    }
  }

  async savePrivateMaterial(
    materialInput: EncryptedInvestigationPrivateMaterial,
  ): Promise<InvestigationPrivateMaterialPersistenceStatus> {
    const material = createEncryptedInvestigationPrivateMaterial(materialInput);
    try {
      await this.prisma.reviewInvestigationPrivateMaterial.create({
        data: toPrivateMaterialCreate(material),
      });
      return InvestigationPrivateMaterialPersistenceStatus.Created;
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const existing = await this.prisma.reviewInvestigationPrivateMaterial.findFirst({
        where: {
          OR: [
            { privateMaterialId: material.privateMaterialId },
            {
              investigationId: material.investigationId,
              obligationId: material.obligationId,
            },
          ],
        },
        orderBy: { privateMaterialId: "asc" },
      });
      if (!existing) throw new Error("private_material_unique_conflict_missing");
      return samePrivateMaterial(toPrivateMaterial(existing), material)
        ? InvestigationPrivateMaterialPersistenceStatus.Idempotent
        : InvestigationPrivateMaterialPersistenceStatus.Conflict;
    }
  }

  async findActivePrivateMaterial(input: {
    readonly investigationId: string;
    readonly obligationId: string | null;
    readonly activeAfter: string;
  }): Promise<EncryptedInvestigationPrivateMaterial | null> {
    const record = await this.prisma.reviewInvestigationPrivateMaterial.findFirst({
      where: {
        investigationId: input.investigationId,
        obligationId: input.obligationId,
        expiresAt: { gt: new Date(input.activeAfter) },
      },
      orderBy: [{ expiresAt: "desc" }, { privateMaterialId: "asc" }],
    });
    return record ? toPrivateMaterial(record) : null;
  }

  async pruneExpiredPrivateMaterial(input: {
    readonly expiresAtOrBefore: string;
    readonly limit: number;
  }): Promise<number> {
    assertPruneLimit(input.limit);
    const removed = await this.prisma.$queryRaw<Array<{ privateMaterialId: string }>>(
      Prisma.sql`
        WITH removable AS (
          SELECT material."privateMaterialId"
          FROM "ReviewInvestigationPrivateMaterial" AS material
          WHERE material."expiresAt" <= ${new Date(input.expiresAtOrBefore)}
          ORDER BY material."expiresAt" ASC, material."privateMaterialId" ASC
          LIMIT ${input.limit}
          FOR UPDATE SKIP LOCKED
        )
        DELETE FROM "ReviewInvestigationPrivateMaterial" AS material
        USING removable
        WHERE material."privateMaterialId" = removable."privateMaterialId"
        RETURNING material."privateMaterialId"
      `,
    );
    return removed.length;
  }

  async pruneRetainedInvestigations(input: {
    readonly retainUntilOrBefore: string;
    readonly limit: number;
  }): Promise<number> {
    assertPruneLimit(input.limit);
    return this.prisma.$transaction(
      async (transaction) => {
        const candidates = await transaction.$queryRaw<
          Array<{ investigationId: string }>
        >(Prisma.sql`
          SELECT investigation."investigationId"
          FROM "ReviewInvestigation" AS investigation
          WHERE investigation."retainUntil" <= ${new Date(input.retainUntilOrBefore)}
            AND investigation."state" IN (
              'inconclusive'::"ReviewInvestigationStateV1",
              'superseded'::"ReviewInvestigationStateV1",
              'expired'::"ReviewInvestigationStateV1"
            )
            AND NOT EXISTS (
              SELECT 1 FROM "ReviewInvestigationReceipt" AS receipt
              WHERE receipt."investigationId" = investigation."investigationId"
            )
            AND NOT EXISTS (
              SELECT 1 FROM "ReviewInvestigationCertificate" AS certificate
              WHERE certificate."investigationId" = investigation."investigationId"
            )
          ORDER BY investigation."retainUntil" ASC, investigation."investigationId" ASC
          LIMIT ${input.limit}
          FOR UPDATE SKIP LOCKED
        `);
        const ids = candidates.map((item) => item.investigationId);
        if (ids.length === 0) return 0;
        await transaction.reviewInvestigation.updateMany({
          where: { investigationId: { in: ids } },
          data: { activeTurnId: null },
        });
        await transaction.reviewInvestigationCommandReceipt.deleteMany({
          where: { investigationId: { in: ids } },
        });
        await transaction.reviewInvestigationPrivateMaterial.deleteMany({
          where: { investigationId: { in: ids } },
        });
        await transaction.reviewInvestigationTurn.deleteMany({
          where: { investigationId: { in: ids } },
        });
        await transaction.reviewInvestigationObligation.deleteMany({
          where: { investigationId: { in: ids } },
        });
        const deleted = await transaction.reviewInvestigation.deleteMany({
          where: { investigationId: { in: ids } },
        });
        return deleted.count;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }

  private async createAggregate(
    transaction: Prisma.TransactionClient,
    input: {
      readonly investigation: ReviewInvestigation;
      readonly expectedVersion: null;
      readonly commandId: string;
      readonly commandHash: string;
      readonly transition: InvestigationStoreTransition;
    },
  ): Promise<InvestigationStoreCommitResult> {
    if (
      input.transition.kind !== InvestigationStoreTransitionKind.Opened ||
      input.investigation.version !== 1 ||
      input.investigation.activeTurn !== null ||
      input.investigation.certificate !== null
    ) {
      throw new Error("investigation_open_transition_invalid");
    }
    const existing = await transaction.reviewInvestigation.findFirst({
      where: {
        OR: [
          { investigationId: input.investigation.investigationId },
          { naturalIdentityHash: input.investigation.naturalIdentityHash },
        ],
      },
      select: { investigationId: true },
    });
    if (existing) {
      return result(
        InvestigationStoreCommitStatus.ConcurrencyConflict,
        await loadAggregate(transaction, existing.investigationId),
      );
    }
    const retainUntil = aggregateRetainUntil(
      input.investigation,
      this.options.operationalRetentionMs,
    );
    await transaction.reviewInvestigation.create({
      data: toMainCreate(input.investigation, retainUntil),
    });
    await persistObligations(
      transaction,
      null,
      input.investigation,
      input.transition,
      retainUntil,
    );
    await transaction.reviewInvestigationCommandReceipt.create({
      data: {
        commandId: input.commandId,
        investigationId: input.investigation.investigationId,
        commandHash: input.commandHash,
        resultingVersion: BigInt(input.investigation.version),
        createdAt: new Date(input.investigation.updatedAt),
        retainUntil,
      },
    });
    const stored = await loadAggregate(
      transaction,
      input.investigation.investigationId,
    );
    if (!stored) throw new Error("investigation_open_snapshot_missing");
    return result(InvestigationStoreCommitStatus.Committed, stored);
  }
}

async function loadAggregate(
  database: InvestigationDb,
  investigationId: string,
): Promise<ReviewInvestigation | null> {
  const record = await database.reviewInvestigation.findUnique({
    where: { investigationId },
  });
  if (!record) return null;
  const obligations = await database.reviewInvestigationObligation.findMany({
    where: { investigationId },
    orderBy: { obligationId: "asc" },
  });
  const receipts = await database.reviewInvestigationReceipt.findMany({
    where: { investigationId },
    orderBy: { receiptId: "asc" },
  });
  const activeTurn = record.activeTurnId
    ? await database.reviewInvestigationTurn.findUnique({
        where: { turnId: record.activeTurnId },
      })
    : null;
  const certificate = record.certificateId
    ? await database.reviewInvestigationCertificate.findUnique({
        where: { certificateId: record.certificateId },
      })
    : null;
  const receiptById = new Map(receipts.map((item) => [item.receiptId, item]));
  const domainObligations = obligations.map((item) =>
    toObligation(item, item.receiptId ? receiptById.get(item.receiptId) : undefined),
  );
  if (domainObligations.some((item) => item === null)) {
    throw new Error("investigation_obligation_receipt_missing");
  }
  const aggregate: ReviewInvestigation = {
    investigationId: record.investigationId,
    naturalIdentityHash: record.naturalIdentityHash,
    version: safeNumber(record.version, "investigation_version"),
    scope: {
      workspaceId: record.workspaceId,
      repositoryConnectionId: record.repositoryConnectionId,
      scmRepositoryIdentityId: record.scmRepositoryIdentityId,
      pullRequestNumber: record.pullRequestNumber,
      trustDomain: record.trustDomain,
    },
    revision: {
      baseSha: record.baseSha,
      mergeBaseSha: record.mergeBaseSha,
      headSha: record.headSha,
      reviewRevisionHash: record.reviewRevisionHash,
    },
    executionId: record.executionId,
    workSlotId: record.workSlotId,
    stableReviewUnitKey: record.stableReviewUnitKey,
    providerVoteLaneId: record.providerVoteLaneId,
    providerStrategyId: record.providerStrategyId,
    runtimeProfile: fromPrismaRuntimeProfile(record.runtimeProfile),
    contract: {
      coverageContractVersion: record.coverageContractVersion,
      expansionRulesVersion: record.expansionRulesVersion,
      criticPolicyVersion: record.criticPolicyVersion,
      gatewayPolicyVersion: record.gatewayPolicyVersion,
      producerReleaseId: record.producerReleaseId,
      runtimeProfileVersion: record.runtimeProfileVersion,
    },
    policy: toPolicy(record.policy),
    state: fromPrismaInvestigationState(record.state),
    obligations: domainObligations as readonly InvestigationObligation[],
    findings: toFindings(record.findings),
    activeTurn: activeTurn ? toTurn(activeTurn) : null,
    semanticTurns: record.semanticTurns,
    operationalAttempts: record.operationalAttempts,
    expansionDepth: record.expansionDepth,
    criticCycles: record.criticCycles,
    criticDecision:
      record.criticDecision === null
        ? null
        : fromPrismaCriticDecision(record.criticDecision),
    conclusion:
      record.conclusion === null
        ? null
        : fromPrismaConclusion(record.conclusion),
    certificate: certificate ? toCertificate(certificate) : null,
    dossierDigest: record.dossierDigest,
    nextEligibleAt: record.nextEligibleAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
  assertRehydratedAggregate(aggregate);
  return aggregate;
}

async function persistTransition(
  transaction: Prisma.TransactionClient,
  current: ReviewInvestigation,
  next: ReviewInvestigation,
  transition: InvestigationStoreTransition,
  retainUntil: Date,
): Promise<void> {
  switch (transition.kind) {
    case InvestigationStoreTransitionKind.Opened:
      throw new Error("investigation_update_open_transition_invalid");
    case InvestigationStoreTransitionKind.TurnPlanned: {
      const turn = next.activeTurn;
      if (!turn || turn.turnId !== transition.turnId) {
        throw new Error("investigation_turn_plan_persistence_invalid");
      }
      const last = await transaction.reviewInvestigationTurn.findFirst({
        where: { investigationId: next.investigationId },
        orderBy: { turnOrdinal: "desc" },
        select: { turnOrdinal: true },
      });
      await transaction.reviewInvestigationTurn.create({
        data: {
          turnId: turn.turnId,
          investigationId: next.investigationId,
          turnOrdinal: (last?.turnOrdinal ?? 0) + 1,
          purpose: toPrismaTurnPurpose(turn.purpose),
          state: PrismaTurnState.leased,
          leasedAtVersion: BigInt(turn.leasedAtVersion),
          dossierDigest: turn.dossierDigest,
          obligationIds: [...turn.obligationIds],
          semanticTurnOrdinal: turn.semanticTurnOrdinal,
          criticCycleOrdinal: turn.criticCycleOrdinal,
          acceptedAttestationId: null,
          sanitizedOutcomeHash: null,
          abortReason: null,
          leasedAt: new Date(turn.leasedAt),
          expiresAt: new Date(turn.expiresAt),
          completedAt: null,
          retainUntil,
        },
      });
      return;
    }
    case InvestigationStoreTransitionKind.TurnCommitted: {
      const updated = await transaction.reviewInvestigationTurn.updateMany({
        where: {
          turnId: transition.turnId,
          investigationId: next.investigationId,
          state: PrismaTurnState.leased,
        },
        data: {
          state: PrismaTurnState.committed,
          acceptedAttestationId: transition.acceptedAttestationId,
          sanitizedOutcomeHash: transition.sanitizedOutcomeHash,
          completedAt: new Date(next.updatedAt),
          retainUntil,
        },
      });
      if (updated.count !== 1) throw new InvestigationWriteRaceError();
      return;
    }
    case InvestigationStoreTransitionKind.TurnAborted: {
      const updated = await transaction.reviewInvestigationTurn.updateMany({
        where: {
          turnId: transition.turnId,
          investigationId: next.investigationId,
          state: PrismaTurnState.leased,
        },
        data: {
          state: PrismaTurnState.aborted,
          abortReason: transition.reason,
          completedAt: new Date(next.updatedAt),
          retainUntil,
        },
      });
      if (updated.count !== 1) throw new InvestigationWriteRaceError();
      return;
    }
    case InvestigationStoreTransitionKind.Concluded:
      if (current.activeTurn !== null || next.certificate === null) {
        throw new Error("investigation_conclusion_persistence_invalid");
      }
  }
}

async function persistObligations(
  transaction: Prisma.TransactionClient,
  current: ReviewInvestigation | null,
  next: ReviewInvestigation,
  transition: InvestigationStoreTransition,
  retainUntil: Date,
): Promise<void> {
  const existingRecords = await transaction.reviewInvestigationObligation.findMany({
    where: { investigationId: next.investigationId },
  });
  const existingById = new Map(existingRecords.map((item) => [item.obligationId, item]));
  const existingReceipts = await transaction.reviewInvestigationReceipt.findMany({
    where: { investigationId: next.investigationId },
  });
  const receiptById = new Map(existingReceipts.map((item) => [item.receiptId, item]));
  const nextIds = new Set(next.obligations.map((item) => item.obligationId));
  if (existingRecords.some((item) => !nextIds.has(item.obligationId))) {
    throw new Error("investigation_obligation_deletion_forbidden");
  }
  const committedTurnId =
    transition.kind === InvestigationStoreTransitionKind.TurnCommitted
      ? transition.turnId
      : null;

  for (const obligation of next.obligations) {
    const existing = existingById.get(obligation.obligationId);
    if (existing) assertObligationIdentity(existing, obligation);
    if (!existing) {
      await transaction.reviewInvestigationObligation.create({
        data: {
          investigationId: next.investigationId,
          obligationId: obligation.obligationId,
          coverageContractVersion: obligation.coverageContractVersion,
          stableReviewUnitKey: obligation.stableReviewUnitKey,
          kind: toPrismaObligationKind(obligation.kind),
          canonicalSubject: obligation.canonicalSubject,
          canonicalRequirement: obligation.canonicalRequirement,
          riskPriority: obligation.riskPriority,
          origin: toPrismaObligationOrigin(obligation.origin),
          state: PrismaObligationState.open,
          receiptId: null,
          unresolvableReason: null,
          createdAt: new Date(next.updatedAt),
          updatedAt: new Date(next.updatedAt),
        },
      });
    }
    if (existing?.receiptId) {
      if (!obligation.receipt || obligation.receipt.receiptId !== existing.receiptId) {
        throw new Error("investigation_receipt_mutation_forbidden");
      }
      const persistedReceipt = receiptById.get(existing.receiptId);
      if (!persistedReceipt || !sameReceipt(toReceipt(persistedReceipt), obligation.receipt)) {
        throw new Error("investigation_receipt_mutation_forbidden");
      }
    } else if (obligation.receipt) {
      await transaction.reviewInvestigationReceipt.create({
        data: {
          receiptId: obligation.receipt.receiptId,
          investigationId: next.investigationId,
          obligationId: obligation.obligationId,
          turnId: committedTurnId,
          operationKey: obligation.receipt.operationKey,
          kind: toPrismaReceiptKind(obligation.receipt.kind),
          canonicalSubject: obligation.receipt.canonicalSubject,
          reviewRevisionHash: obligation.receipt.reviewRevisionHash,
          gatewayPolicyVersion: obligation.receipt.gatewayPolicyVersion,
          evidenceDigest: obligation.receipt.evidenceDigest,
          complete: obligation.receipt.complete,
          truncated: obligation.receipt.truncated,
          failed: obligation.receipt.failed,
          acceptedAttestationId:
            transition.kind === InvestigationStoreTransitionKind.TurnCommitted
              ? transition.acceptedAttestationId
              : null,
          acceptedAt: new Date(next.updatedAt),
          retainUntil,
        },
      });
    }
    await transaction.reviewInvestigationObligation.update({
      where: {
        investigationId_obligationId: {
          investigationId: next.investigationId,
          obligationId: obligation.obligationId,
        },
      },
      data: {
        riskPriority: obligation.riskPriority,
        origin: toPrismaObligationOrigin(obligation.origin),
        state: toPrismaObligationState(obligation.state),
        receiptId: obligation.receipt?.receiptId ?? null,
        unresolvableReason: obligation.unresolvableReason,
        updatedAt: new Date(next.updatedAt),
      },
    });
  }
  if (current && current.obligations.length > next.obligations.length) {
    throw new Error("investigation_obligation_deletion_forbidden");
  }
}

async function persistCertificate(
  transaction: Prisma.TransactionClient,
  current: ReviewInvestigation,
  next: ReviewInvestigation,
): Promise<void> {
  if (current.certificate) {
    if (
      !next.certificate ||
      current.certificate.certificateHash !== next.certificate.certificateHash
    ) {
      throw new Error("investigation_certificate_mutation_forbidden");
    }
    return;
  }
  if (!next.certificate) return;
  const certificate = next.certificate;
  await transaction.reviewInvestigationCertificate.create({
    data: {
      certificateId: certificate.certificateId,
      certificateHash: certificate.certificateHash,
      investigationId: certificate.investigationId,
      terminalVersion: BigInt(certificate.investigationVersion),
      dossierDigest: certificate.dossierDigest,
      reviewRevisionHash: certificate.reviewRevisionHash,
      stableReviewUnitKey: certificate.stableReviewUnitKey,
      providerVoteLaneId: certificate.providerVoteLaneId,
      coverageContractVersion: certificate.coverageContractVersion,
      expansionRulesVersion: certificate.expansionRulesVersion,
      gatewayPolicyVersion: certificate.gatewayPolicyVersion,
      criticPolicyVersion: certificate.criticPolicyVersion,
      runtimeProfileVersion: certificate.runtimeProfileVersion,
      producerReleaseId: certificate.producerReleaseId,
      conclusion: toPrismaConclusion(certificate.conclusion),
      findingSetHash: certificate.findingSetHash,
      obligationSetHash: certificate.obligationSetHash,
      receiptSetHash: certificate.receiptSetHash,
      issuedAt: new Date(certificate.issuedAt),
      expiresAt: new Date(certificate.expiresAt),
    },
  });
}

function toMainCreate(
  investigation: ReviewInvestigation,
  retainUntil: Date,
): Prisma.ReviewInvestigationUncheckedCreateInput {
  return {
    investigationId: investigation.investigationId,
    naturalIdentityHash: investigation.naturalIdentityHash,
    workspaceId: investigation.scope.workspaceId,
    repositoryConnectionId: investigation.scope.repositoryConnectionId,
    scmRepositoryIdentityId: investigation.scope.scmRepositoryIdentityId,
    pullRequestNumber: investigation.scope.pullRequestNumber,
    trustDomain: investigation.scope.trustDomain,
    baseSha: investigation.revision.baseSha,
    mergeBaseSha: investigation.revision.mergeBaseSha,
    headSha: investigation.revision.headSha,
    reviewRevisionHash: investigation.revision.reviewRevisionHash,
    executionId: investigation.executionId,
    workSlotId: investigation.workSlotId,
    stableReviewUnitKey: investigation.stableReviewUnitKey,
    providerVoteLaneId: investigation.providerVoteLaneId,
    providerStrategyId: investigation.providerStrategyId,
    runtimeProfile: toPrismaRuntimeProfile(investigation.runtimeProfile),
    coverageContractVersion: investigation.contract.coverageContractVersion,
    expansionRulesVersion: investigation.contract.expansionRulesVersion,
    criticPolicyVersion: investigation.contract.criticPolicyVersion,
    gatewayPolicyVersion: investigation.contract.gatewayPolicyVersion,
    producerReleaseId: investigation.contract.producerReleaseId,
    runtimeProfileVersion: investigation.contract.runtimeProfileVersion,
    version: BigInt(investigation.version),
    policy: investigation.policy as unknown as Prisma.InputJsonValue,
    state: toPrismaInvestigationState(investigation.state),
    findings: investigation.findings as unknown as Prisma.InputJsonValue,
    activeTurnId: null,
    semanticTurns: investigation.semanticTurns,
    operationalAttempts: investigation.operationalAttempts,
    expansionDepth: investigation.expansionDepth,
    criticCycles: investigation.criticCycles,
    criticDecision:
      investigation.criticDecision === null
        ? null
        : toPrismaCriticDecision(investigation.criticDecision),
    conclusion:
      investigation.conclusion === null
        ? null
        : toPrismaConclusion(investigation.conclusion),
    certificateId: null,
    dossierDigest: investigation.dossierDigest,
    nextEligibleAt:
      investigation.nextEligibleAt === null
        ? null
        : new Date(investigation.nextEligibleAt),
    supersededByInvestigationId: null,
    createdAt: new Date(investigation.createdAt),
    updatedAt: new Date(investigation.updatedAt),
    retainUntil,
  };
}

function toMainUpdate(
  investigation: ReviewInvestigation,
  retainUntil: Date,
): Prisma.ReviewInvestigationUncheckedUpdateManyInput {
  return mainScalarData(investigation, retainUntil);
}

function mainScalarData(
  investigation: ReviewInvestigation,
  retainUntil: Date,
): Prisma.ReviewInvestigationUncheckedUpdateManyInput {
  return {
    version: BigInt(investigation.version),
    policy: investigation.policy as unknown as Prisma.InputJsonValue,
    state: toPrismaInvestigationState(investigation.state),
    findings: investigation.findings as unknown as Prisma.InputJsonValue,
    activeTurnId: investigation.activeTurn?.turnId ?? null,
    semanticTurns: investigation.semanticTurns,
    operationalAttempts: investigation.operationalAttempts,
    expansionDepth: investigation.expansionDepth,
    criticCycles: investigation.criticCycles,
    criticDecision:
      investigation.criticDecision === null
        ? null
        : toPrismaCriticDecision(investigation.criticDecision),
    conclusion:
      investigation.conclusion === null
        ? null
        : toPrismaConclusion(investigation.conclusion),
    certificateId: investigation.certificate?.certificateId ?? null,
    dossierDigest: investigation.dossierDigest,
    nextEligibleAt:
      investigation.nextEligibleAt === null
        ? null
        : new Date(investigation.nextEligibleAt),
    updatedAt: new Date(investigation.updatedAt),
    retainUntil,
  };
}

function assertUpdate(
  current: ReviewInvestigation,
  next: ReviewInvestigation,
  transition: InvestigationStoreTransition,
): void {
  if (
    next.version !== current.version + 1 ||
    next.investigationId !== current.investigationId ||
    next.naturalIdentityHash !== current.naturalIdentityHash ||
    next.executionId !== current.executionId ||
    next.workSlotId !== current.workSlotId ||
    next.revision.reviewRevisionHash !== current.revision.reviewRevisionHash ||
    next.stableReviewUnitKey !== current.stableReviewUnitKey ||
    next.providerVoteLaneId !== current.providerVoteLaneId ||
    next.contract.coverageContractVersion !==
      current.contract.coverageContractVersion ||
    next.contract.runtimeProfileVersion !== current.contract.runtimeProfileVersion
  ) {
    throw new Error("investigation_immutable_identity_changed");
  }
  switch (transition.kind) {
    case InvestigationStoreTransitionKind.Opened:
      throw new Error("investigation_update_open_transition_invalid");
    case InvestigationStoreTransitionKind.TurnPlanned:
      if (
        current.activeTurn !== null ||
        next.activeTurn?.turnId !== transition.turnId
      ) {
        throw new Error("investigation_turn_plan_transition_invalid");
      }
      return;
    case InvestigationStoreTransitionKind.TurnCommitted:
    case InvestigationStoreTransitionKind.TurnAborted:
      if (
        current.activeTurn?.turnId !== transition.turnId ||
        next.activeTurn !== null
      ) {
        throw new Error("investigation_turn_terminal_transition_invalid");
      }
      return;
    case InvestigationStoreTransitionKind.Concluded:
      if (current.certificate !== null || next.certificate === null) {
        throw new Error("investigation_conclusion_transition_invalid");
      }
  }
}

function assertRehydratedAggregate(
  investigation: ReviewInvestigation,
): void {
  assertDigest(investigation.naturalIdentityHash, "natural_identity_hash");
  assertDigest(investigation.revision.reviewRevisionHash, "review_revision_hash");
  assertDigest(investigation.dossierDigest, "dossier_digest");
  if (!Number.isSafeInteger(investigation.version) || investigation.version <= 0) {
    throw new Error("investigation_version_corrupt");
  }
  for (const [field, value] of [
    ["semantic_turns", investigation.semanticTurns],
    ["operational_attempts", investigation.operationalAttempts],
    ["expansion_depth", investigation.expansionDepth],
    ["critic_cycles", investigation.criticCycles],
  ] as const) {
    assertNonNegativeInteger(value, field);
  }
  if (
    (investigation.state === ReviewInvestigationState.TurnLeased) !==
    (investigation.activeTurn !== null)
  ) {
    throw new Error("investigation_active_turn_state_corrupt");
  }
  if (
    investigation.activeTurn !== null &&
    investigation.activeTurn.leasedAtVersion !== investigation.version
  ) {
    throw new Error("investigation_active_turn_version_corrupt");
  }
  if (
    (investigation.state === ReviewInvestigationState.Concluded &&
      investigation.certificate === null) ||
    (investigation.certificate !== null &&
      ![
        ReviewInvestigationState.Concluded,
        ReviewInvestigationState.Expired,
        ReviewInvestigationState.Superseded,
      ].includes(investigation.state))
  ) {
    throw new Error("investigation_certificate_state_corrupt");
  }
  if (investigation.certificate) {
    if (
      investigation.certificate.investigationId !==
        investigation.investigationId ||
      investigation.certificate.investigationVersion + 1 !==
        investigation.version ||
      investigation.certificate.conclusion !== investigation.conclusion
    ) {
      throw new Error("investigation_certificate_binding_corrupt");
    }
  }
  const acceptedReceipts = new Set<string>();
  let inventoryWitnessCount = 0;
  for (const obligation of investigation.obligations) {
    if (obligation.kind === InvestigationObligationKind.InventoryWitness) {
      inventoryWitnessCount += 1;
    }
    const satisfied = obligation.state === InvestigationObligationState.Satisfied;
    if (satisfied !== (obligation.receipt !== null)) {
      throw new Error("investigation_obligation_receipt_state_corrupt");
    }
    if (
      obligation.state === InvestigationObligationState.Unresolvable
        ? obligation.unresolvableReason === null
        : obligation.unresolvableReason !== null
    ) {
      throw new Error("investigation_obligation_resolution_state_corrupt");
    }
    if (obligation.receipt) {
      if (
        !obligation.receipt.complete ||
        obligation.receipt.truncated ||
        obligation.receipt.failed ||
        obligation.receipt.canonicalSubject !== obligation.canonicalSubject ||
        obligation.receipt.reviewRevisionHash !==
          investigation.revision.reviewRevisionHash ||
        obligation.receipt.gatewayPolicyVersion !==
          investigation.contract.gatewayPolicyVersion
      ) {
        throw new Error("investigation_receipt_binding_corrupt");
      }
      acceptedReceipts.add(obligation.receipt.receiptId);
    }
  }
  if (inventoryWitnessCount !== 1) {
    throw new Error("investigation_inventory_witness_corrupt");
  }
  for (const finding of investigation.findings) {
    if (
      finding.evidenceReceiptIds.some(
        (receiptId) => !acceptedReceipts.has(receiptId),
      )
    ) {
      throw new Error("investigation_finding_evidence_binding_corrupt");
    }
  }
}

function aggregateRetainUntil(
  investigation: ReviewInvestigation,
  operationalRetentionMs: number,
): Date {
  const operational = new Date(
    new Date(investigation.updatedAt).getTime() + operationalRetentionMs,
  );
  const certificateExpiry = investigation.certificate
    ? new Date(investigation.certificate.expiresAt)
    : null;
  return certificateExpiry && certificateExpiry > operational
    ? certificateExpiry
    : operational;
}

function toObligation(
  record: PrismaObligationRecord,
  receipt: PrismaReceiptRecord | undefined,
): InvestigationObligation | null {
  if (record.receiptId !== null && !receipt) return null;
  return {
    obligationId: record.obligationId,
    coverageContractVersion: record.coverageContractVersion,
    stableReviewUnitKey: record.stableReviewUnitKey,
    kind: fromPrismaObligationKind(record.kind),
    canonicalSubject: record.canonicalSubject,
    canonicalRequirement: record.canonicalRequirement,
    riskPriority: record.riskPriority,
    origin: fromPrismaObligationOrigin(record.origin),
    state: fromPrismaObligationState(record.state),
    receipt: receipt ? toReceipt(receipt) : null,
    unresolvableReason: record.unresolvableReason,
  };
}

function toReceipt(record: PrismaReceiptRecord): InvestigationEvidenceReceipt {
  return {
    receiptId: record.receiptId,
    operationKey: record.operationKey,
    kind: fromPrismaReceiptKind(record.kind),
    canonicalSubject: record.canonicalSubject,
    reviewRevisionHash: record.reviewRevisionHash,
    gatewayPolicyVersion: record.gatewayPolicyVersion,
    evidenceDigest: record.evidenceDigest,
    complete: record.complete,
    truncated: record.truncated,
    failed: record.failed,
  };
}

function toTurn(record: PrismaTurnRecord): InvestigationTurn {
  if (record.state !== PrismaTurnState.leased) {
    throw new Error("investigation_active_turn_not_leased");
  }
  const obligationIds = toStringArray(record.obligationIds, "turn_obligation_ids");
  return {
    turnId: record.turnId,
    purpose: fromPrismaTurnPurpose(record.purpose),
    leasedAtVersion: safeNumber(record.leasedAtVersion, "turn_leased_version"),
    dossierDigest: record.dossierDigest,
    obligationIds,
    semanticTurnOrdinal: record.semanticTurnOrdinal,
    criticCycleOrdinal: record.criticCycleOrdinal,
    leasedAt: record.leasedAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
  };
}

function toCertificate(
  record: PrismaCertificateRecord,
): ReviewInvestigationCertificate {
  return {
    certificateId: record.certificateId,
    certificateHash: record.certificateHash,
    investigationId: record.investigationId,
    investigationVersion: safeNumber(record.terminalVersion, "certificate_version"),
    dossierDigest: record.dossierDigest,
    reviewRevisionHash: record.reviewRevisionHash,
    stableReviewUnitKey: record.stableReviewUnitKey,
    providerVoteLaneId: record.providerVoteLaneId,
    coverageContractVersion: record.coverageContractVersion,
    expansionRulesVersion: record.expansionRulesVersion,
    gatewayPolicyVersion: record.gatewayPolicyVersion,
    criticPolicyVersion: record.criticPolicyVersion,
    runtimeProfileVersion: record.runtimeProfileVersion,
    producerReleaseId: record.producerReleaseId,
    conclusion: fromPrismaConclusion(record.conclusion),
    findingSetHash: record.findingSetHash,
    obligationSetHash: record.obligationSetHash,
    receiptSetHash: record.receiptSetHash,
    issuedAt: record.issuedAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
  };
}

function toPrivateMaterialCreate(
  material: EncryptedInvestigationPrivateMaterial,
): Prisma.ReviewInvestigationPrivateMaterialUncheckedCreateInput {
  return {
    privateMaterialId: material.privateMaterialId,
    investigationId: material.investigationId,
    obligationId: material.obligationId,
    encryptionAlgorithm: material.algorithm,
    encryptionKeyId: material.keyId,
    nonce: Buffer.from(material.nonceBase64Url, "base64url"),
    authTag: Buffer.from(material.authTagBase64Url, "base64url"),
    ciphertext: Buffer.from(material.ciphertextBase64Url, "base64url"),
    associatedDataHash: material.associatedDataHash,
    plaintextHash: material.plaintextHash,
    byteCount: material.byteCount,
    createdAt: new Date(material.createdAt),
    expiresAt: new Date(material.expiresAt),
  };
}

function toPrivateMaterial(
  record: PrismaPrivateMaterialRecord,
): EncryptedInvestigationPrivateMaterial {
  return createEncryptedInvestigationPrivateMaterial({
    privateMaterialId: record.privateMaterialId,
    investigationId: record.investigationId,
    obligationId: record.obligationId,
    algorithm: parsePrivateMaterialAlgorithm(record.encryptionAlgorithm),
    keyId: record.encryptionKeyId,
    nonceBase64Url: Buffer.from(record.nonce).toString("base64url"),
    authTagBase64Url: Buffer.from(record.authTag).toString("base64url"),
    ciphertextBase64Url: Buffer.from(record.ciphertext).toString("base64url"),
    associatedDataHash: record.associatedDataHash,
    plaintextHash: record.plaintextHash,
    byteCount: record.byteCount,
    createdAt: record.createdAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
  });
}

function toPolicy(value: Prisma.JsonValue): ReviewInvestigationPolicy {
  if (!isObject(value)) throw new Error("investigation_policy_corrupt");
  const policy = {
    policyId: stringField(value, "policyId"),
    maxObligations: numberField(value, "maxObligations"),
    maxExpansionDepth: numberField(value, "maxExpansionDepth"),
    maxSemanticTurns: numberField(value, "maxSemanticTurns"),
    maxOperationalAttempts: numberField(value, "maxOperationalAttempts"),
    maxCriticCycles: numberField(value, "maxCriticCycles"),
    maxFindings: numberField(value, "maxFindings"),
    maxProposalsPerTurn: numberField(value, "maxProposalsPerTurn"),
    maxReceiptsPerTurn: numberField(value, "maxReceiptsPerTurn"),
  };
  assertInvestigationPolicy(policy);
  return policy;
}

function parsePrivateMaterialAlgorithm(
  value: string,
): typeof investigationPrivateMaterialEncryptionAlgorithm {
  if (value !== investigationPrivateMaterialEncryptionAlgorithm) {
    throw new Error("investigation_private_material_algorithm_corrupt");
  }
  return investigationPrivateMaterialEncryptionAlgorithm;
}

function toFindings(value: Prisma.JsonValue): readonly InvestigationFinding[] {
  if (!Array.isArray(value)) throw new Error("investigation_findings_corrupt");
  return value.map((item) => {
    if (!isObject(item)) throw new Error("investigation_finding_corrupt");
    const line = item.line;
    if (
      line !== null &&
      (typeof line !== "number" || !Number.isSafeInteger(line) || line <= 0)
    ) {
      throw new Error("investigation_finding_line_corrupt");
    }
    const evidenceReceiptIds = toStringArray(
      item.evidenceReceiptIds,
      "finding_evidence_receipt_ids",
    );
    if (evidenceReceiptIds.length === 0) {
      throw new Error("investigation_finding_evidence_corrupt");
    }
    return {
      fingerprint: stringField(item, "fingerprint"),
      severity: stringField(item, "severity"),
      title: stringField(item, "title"),
      body: stringField(item, "body"),
      path: stringField(item, "path"),
      line,
      evidenceReceiptIds,
    };
  });
}

function assertObligationIdentity(
  record: PrismaObligationRecord,
  obligation: InvestigationObligation,
): void {
  if (
    record.coverageContractVersion !== obligation.coverageContractVersion ||
    record.stableReviewUnitKey !== obligation.stableReviewUnitKey ||
    fromPrismaObligationKind(record.kind) !== obligation.kind ||
    record.canonicalSubject !== obligation.canonicalSubject ||
    record.canonicalRequirement !== obligation.canonicalRequirement
  ) {
    throw new Error("investigation_obligation_identity_changed");
  }
}

function sameReceipt(
  left: InvestigationEvidenceReceipt,
  right: InvestigationEvidenceReceipt,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function samePrivateMaterial(
  left: EncryptedInvestigationPrivateMaterial,
  right: EncryptedInvestigationPrivateMaterial,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function result(
  status: InvestigationStoreCommitStatus,
  investigation: ReviewInvestigation | null,
): InvestigationStoreCommitResult {
  return { status, investigation };
}

function safeNumber(value: bigint, field: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`${field}_unsafe`);
  return number;
}

function assertPruneLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000) {
    throw new Error("investigation_prune_limit_invalid");
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, field: string): string {
  const candidate = value[field];
  if (typeof candidate !== "string") throw new Error(`${field}_corrupt`);
  return candidate;
}

function numberField(value: Record<string, unknown>, field: string): number {
  const candidate = value[field];
  if (typeof candidate !== "number" || !Number.isSafeInteger(candidate)) {
    throw new Error(`${field}_corrupt`);
  }
  return candidate;
}

function toStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field}_corrupt`);
  }
  return [...value] as string[];
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
  );
}

function isRetryablePersistenceConflict(error: unknown): boolean {
  return (
    error instanceof InvestigationWriteRaceError ||
    isUniqueConstraintError(error) ||
    (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034")
  );
}

class InvestigationWriteRaceError extends Error {}

const runtimeProfileToPrisma: Readonly<Record<ReviewInvestigationRuntimeProfile, PrismaRuntimeProfile>> = {
  [ReviewInvestigationRuntimeProfile.GatewayAttestedAgentV1]: PrismaRuntimeProfile.gateway_attested_agent_v1,
  [ReviewInvestigationRuntimeProfile.OrchestratedToolLoopV1]: PrismaRuntimeProfile.orchestrated_tool_loop_v1,
  [ReviewInvestigationRuntimeProfile.PreassembledContextV1]: PrismaRuntimeProfile.preassembled_context_v1,
  [ReviewInvestigationRuntimeProfile.PromptOnlyV1]: PrismaRuntimeProfile.prompt_only_v1,
  [ReviewInvestigationRuntimeProfile.AgenticUnboundedV1]: PrismaRuntimeProfile.agentic_unbounded_v1,
};
const investigationStateToPrisma: Readonly<Record<ReviewInvestigationState, PrismaInvestigationState>> = {
  [ReviewInvestigationState.Provisional]: PrismaInvestigationState.provisional,
  [ReviewInvestigationState.AwaitingTurn]: PrismaInvestigationState.awaiting_turn,
  [ReviewInvestigationState.TurnLeased]: PrismaInvestigationState.turn_leased,
  [ReviewInvestigationState.AwaitingCritic]: PrismaInvestigationState.awaiting_critic,
  [ReviewInvestigationState.ReadyToConclude]: PrismaInvestigationState.ready_to_conclude,
  [ReviewInvestigationState.Concluded]: PrismaInvestigationState.concluded,
  [ReviewInvestigationState.Inconclusive]: PrismaInvestigationState.inconclusive,
  [ReviewInvestigationState.Superseded]: PrismaInvestigationState.superseded,
  [ReviewInvestigationState.Expired]: PrismaInvestigationState.expired,
};
const obligationStateToPrisma: Readonly<Record<InvestigationObligationState, PrismaObligationState>> = {
  [InvestigationObligationState.Open]: PrismaObligationState.open,
  [InvestigationObligationState.Satisfied]: PrismaObligationState.satisfied,
  [InvestigationObligationState.Unresolvable]: PrismaObligationState.unresolvable,
};
const obligationKindToPrisma: Readonly<Record<InvestigationObligationKind, PrismaObligationKind>> = {
  [InvestigationObligationKind.InventoryWitness]: PrismaObligationKind.inventory_witness,
  [InvestigationObligationKind.ChangedContent]: PrismaObligationKind.changed_content,
  [InvestigationObligationKind.BaseContent]: PrismaObligationKind.base_content,
  [InvestigationObligationKind.RelatedManifest]: PrismaObligationKind.related_manifest,
  [InvestigationObligationKind.DirectReferenceSearch]: PrismaObligationKind.direct_reference_search,
  [InvestigationObligationKind.DirectCaller]: PrismaObligationKind.direct_caller,
  [InvestigationObligationKind.DirectCallee]: PrismaObligationKind.direct_callee,
  [InvestigationObligationKind.TestEvidence]: PrismaObligationKind.test_evidence,
  [InvestigationObligationKind.SchemaContract]: PrismaObligationKind.schema_contract,
  [InvestigationObligationKind.ConfigurationContract]: PrismaObligationKind.configuration_contract,
  [InvestigationObligationKind.MigrationContract]: PrismaObligationKind.migration_contract,
  [InvestigationObligationKind.GeneratedSource]: PrismaObligationKind.generated_source,
  [InvestigationObligationKind.DependencyContract]: PrismaObligationKind.dependency_contract,
  [InvestigationObligationKind.SideEffectParity]: PrismaObligationKind.side_effect_parity,
  [InvestigationObligationKind.ExternalContract]: PrismaObligationKind.external_contract,
  [InvestigationObligationKind.BinaryArtifact]: PrismaObligationKind.binary_artifact,
  [InvestigationObligationKind.ContextCritic]: PrismaObligationKind.context_critic,
};
const obligationOriginToPrisma: Readonly<Record<InvestigationObligationOrigin, PrismaObligationOrigin>> = {
  [InvestigationObligationOrigin.CoverageContract]: PrismaObligationOrigin.coverage_contract,
  [InvestigationObligationOrigin.DeterministicExpansion]: PrismaObligationOrigin.deterministic_expansion,
  [InvestigationObligationOrigin.AgentProposal]: PrismaObligationOrigin.agent_proposal,
  [InvestigationObligationOrigin.CriticProposal]: PrismaObligationOrigin.critic_proposal,
};
const receiptKindToPrisma: Readonly<Record<InvestigationReceiptKind, PrismaReceiptKind>> = {
  [InvestigationReceiptKind.Blob]: PrismaReceiptKind.blob,
  [InvestigationReceiptKind.Tree]: PrismaReceiptKind.tree,
  [InvestigationReceiptKind.Search]: PrismaReceiptKind.search,
  [InvestigationReceiptKind.GitFact]: PrismaReceiptKind.git_fact,
  [InvestigationReceiptKind.Relation]: PrismaReceiptKind.relation,
  [InvestigationReceiptKind.Critic]: PrismaReceiptKind.critic,
};
const turnPurposeToPrisma: Readonly<Record<ReviewInvestigationTurnPurpose, PrismaTurnPurpose>> = {
  [ReviewInvestigationTurnPurpose.Discovery]: PrismaTurnPurpose.discovery,
  [ReviewInvestigationTurnPurpose.Critic]: PrismaTurnPurpose.critic,
};
const criticDecisionToPrisma: Readonly<Record<ContextCriticDecision, PrismaCriticDecision>> = {
  [ContextCriticDecision.Accept]: PrismaCriticDecision.accept,
  [ContextCriticDecision.Veto]: PrismaCriticDecision.veto,
  [ContextCriticDecision.Abstain]: PrismaCriticDecision.abstain,
};
const conclusionToPrisma: Readonly<Record<ReviewInvestigationConclusion, PrismaConclusion>> = {
  [ReviewInvestigationConclusion.VerifiedClean]: PrismaConclusion.verified_clean,
  [ReviewInvestigationConclusion.Findings]: PrismaConclusion.findings,
  [ReviewInvestigationConclusion.Inconclusive]: PrismaConclusion.inconclusive,
};

const runtimeProfileFromPrisma = invertEnumMap(runtimeProfileToPrisma);
const investigationStateFromPrisma = invertEnumMap(investigationStateToPrisma);
const obligationStateFromPrisma = invertEnumMap(obligationStateToPrisma);
const obligationKindFromPrisma = invertEnumMap(obligationKindToPrisma);
const obligationOriginFromPrisma = invertEnumMap(obligationOriginToPrisma);
const receiptKindFromPrisma = invertEnumMap(receiptKindToPrisma);
const turnPurposeFromPrisma = invertEnumMap(turnPurposeToPrisma);
const criticDecisionFromPrisma = invertEnumMap(criticDecisionToPrisma);
const conclusionFromPrisma = invertEnumMap(conclusionToPrisma);

const toPrismaRuntimeProfile = (value: ReviewInvestigationRuntimeProfile) => runtimeProfileToPrisma[value];
const fromPrismaRuntimeProfile = (value: PrismaRuntimeProfile) => runtimeProfileFromPrisma[value];
const toPrismaInvestigationState = (value: ReviewInvestigationState) => investigationStateToPrisma[value];
const fromPrismaInvestigationState = (value: PrismaInvestigationState) => investigationStateFromPrisma[value];
const toPrismaObligationState = (value: InvestigationObligationState) => obligationStateToPrisma[value];
const fromPrismaObligationState = (value: PrismaObligationState) => obligationStateFromPrisma[value];
const toPrismaObligationKind = (value: InvestigationObligationKind) => obligationKindToPrisma[value];
const fromPrismaObligationKind = (value: PrismaObligationKind) => obligationKindFromPrisma[value];
const toPrismaObligationOrigin = (value: InvestigationObligationOrigin) => obligationOriginToPrisma[value];
const fromPrismaObligationOrigin = (value: PrismaObligationOrigin) => obligationOriginFromPrisma[value];
const toPrismaReceiptKind = (value: InvestigationReceiptKind) => receiptKindToPrisma[value];
const fromPrismaReceiptKind = (value: PrismaReceiptKind) => receiptKindFromPrisma[value];
const toPrismaTurnPurpose = (value: ReviewInvestigationTurnPurpose) => turnPurposeToPrisma[value];
const fromPrismaTurnPurpose = (value: PrismaTurnPurpose) => turnPurposeFromPrisma[value];
const toPrismaCriticDecision = (value: ContextCriticDecision) => criticDecisionToPrisma[value];
const fromPrismaCriticDecision = (value: PrismaCriticDecision) => criticDecisionFromPrisma[value];
const toPrismaConclusion = (value: ReviewInvestigationConclusion) => conclusionToPrisma[value];
const fromPrismaConclusion = (value: PrismaConclusion) => conclusionFromPrisma[value];

function invertEnumMap<DomainValue extends string, PrismaValue extends string>(
  mapping: Readonly<Record<DomainValue, PrismaValue>>,
): Readonly<Record<PrismaValue, DomainValue>> {
  const inverse = Object.create(null) as Record<PrismaValue, DomainValue>;
  for (const [domainValue, prismaValue] of Object.entries(mapping) as Array<
    [DomainValue, PrismaValue]
  >) {
    if (inverse[prismaValue] !== undefined) {
      throw new Error("investigation_prisma_enum_mapping_not_bijective");
    }
    inverse[prismaValue] = domainValue;
  }
  return Object.freeze(inverse);
}
