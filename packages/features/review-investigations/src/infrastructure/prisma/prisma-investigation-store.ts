import {
  Prisma,
  ReviewInvestigationConclusionV1 as PrismaConclusion,
  ReviewInvestigationCriticDecisionV1 as PrismaCriticDecision,
  ReviewInvestigationObligationKindV1 as PrismaObligationKind,
  ReviewInvestigationObligationOriginV1 as PrismaObligationOrigin,
  ReviewInvestigationObligationStateV1 as PrismaObligationState,
  ReviewInvestigationReceiptKindV1 as PrismaReceiptKind,
  ReviewInvestigationLeasePurposeV1 as PrismaLeasePurpose,
  ReviewInvestigationLeaseStateV1 as PrismaLeaseState,
  ReviewInvestigationRuntimeProfileV1 as PrismaRuntimeProfile,
  ReviewInvestigationStateV1 as PrismaInvestigationState,
  ReviewInvestigationTurnPurposeV1 as PrismaTurnPurpose,
  ReviewInvestigationTurnStateV1 as PrismaTurnState,
  type PrismaClient,
  type ReviewInvestigationCertificate as PrismaCertificateRecord,
  type ReviewInvestigationObligation as PrismaObligationRecord,
  type ReviewInvestigationPrivateMaterial as PrismaPrivateMaterialRecord,
  type ReviewInvestigationLease as PrismaLeaseRecord,
  type ReviewInvestigationReceipt as PrismaReceiptRecord,
  type ReviewInvestigationReplayEvidenceCheckpoint as PrismaReplayEvidenceCheckpointRecord,
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
import { InvestigationExecutionAuthorityVerdict } from "../../application/ports/execution-authority-port";
import {
  InvestigationStoreCommitGuardKind,
  InvestigationStoreCommitStatus,
  InvestigationStoreTransitionKind,
  type InvestigationStoreCommitResult,
  type InvestigationStorePort,
  type InvestigationStoreTransition,
} from "../../application/ports/investigation-store-port";
import {
  assertPersistedInvestigationRequirementsSanitized,
  validateInvestigationPrivateMaterialCommit,
} from "../../application/investigation-private-material-commit-policy";
import { ReconcileExpiredInvestigationPrivateMaterial } from "../../application/use-cases/reconcile-expired-investigation-private-material";
import {
  assertInvestigationPolicy,
  assertInvestigationPolicyCanonicalCompatibility,
  parseInvestigationPolicyCanonicalVersion,
  type ReviewInvestigationPolicy,
} from "../../domain/investigation-policy";
import {
  createEncryptedInvestigationPrivateMaterial,
  InvestigationPrivateMaterialExpiryDisposition,
  InvestigationPrivateMaterialExpiryReason,
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
import type { ReplayEvidenceCheckpoint } from "../../domain/replay-evidence-checkpoint";
import {
  summarizeTerminalDiscoveryProvenance,
  type InvestigationFinding,
  type InvestigationTurn,
  type InvestigationTurnProvenance,
} from "../../domain/investigation-turn";
import { isValidInvestigationTokenUsage } from "../../domain/investigation-token-usage";
import type { ReviewInvestigation } from "../../domain/review-investigation";
import { TurnResultAdmissionKind } from "../../domain/turn-result-admission";
import {
  ContextCriticDecision,
  InvestigationFindingSeverity,
  InvestigationTurnProviderKind,
  InvestigationObligationKind,
  InvestigationObligationState,
  ReviewInvestigationConclusion,
  ReviewInvestigationRuntimeProfile,
  ReviewInvestigationState,
  ReviewInvestigationTurnPurpose,
} from "../../domain/review-investigation-types";
import { NodeSha256InvestigationDigest } from "../node/node-sha256-digest";
import {
  assertReviewInvestigationLease,
  decideReviewInvestigationLeaseReplay,
  expireReviewInvestigationLease,
  reviewInvestigationLeaseBindingIsCurrent,
  releaseReviewInvestigationLease,
  revokeReviewInvestigationLease,
  renewReviewInvestigationLease,
  ReviewInvestigationLeasePurpose,
  ReviewInvestigationLeaseReplayStatus,
  ReviewInvestigationLeaseState,
  ReviewInvestigationLeaseTransitionStatus,
  type CreateReviewInvestigationLeaseInput,
  type ReviewInvestigationLease,
} from "../../domain/investigation-lease";
import {
  InvestigationLeaseAcquireStatus,
  type InvestigationLeaseAcquireResult,
  type InvestigationLeaseStorePort,
} from "../../application/ports/investigation-lease-store-port";

type InvestigationDb = Pick<
  PrismaClient,
  | "reviewInvestigation"
  | "reviewInvestigationObligation"
  | "reviewInvestigationTurn"
  | "reviewInvestigationLease"
  | "reviewInvestigationReceipt"
  | "reviewInvestigationPrivateMaterial"
  | "reviewInvestigationCertificate"
  | "reviewInvestigationReplayEvidenceCheckpoint"
  | "reviewInvestigationCommandReceipt"
>;

type ExpiredPrivateMaterialCandidate = Readonly<{
  privateMaterialId: string;
  investigationId: string;
  obligationId: string | null;
}>;

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
    InvestigationPrunerPort,
    InvestigationLeaseStorePort
{
  private readonly options: PrismaInvestigationStoreOptions;
  private readonly privateMaterialExpiry =
    new ReconcileExpiredInvestigationPrivateMaterial(
      new NodeSha256InvestigationDigest(),
    );

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
    const command =
      await this.prisma.reviewInvestigationCommandReceipt.findUnique({
        where: { commandId: input.commandId },
      });
    if (!command) return null;
    if (command.commandHash !== input.commandHash) {
      return result(InvestigationStoreCommitStatus.IdempotencyConflict, null);
    }
    const investigation = await loadAggregate(
      this.prisma,
      command.investigationId,
    );
    if (!investigation)
      throw new Error("investigation_command_snapshot_missing");
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

  async findByCertificateId(
    certificateId: string,
  ): Promise<ReviewInvestigation | null> {
    const record = await this.prisma.reviewInvestigationCertificate.findUnique({
      where: { certificateId },
      select: { investigationId: true },
    });
    return record ? loadAggregate(this.prisma, record.investigationId) : null;
  }

  async findReplayCandidates(
    input: Parameters<InvestigationStorePort["findReplayCandidates"]>[0],
  ): Promise<readonly ReviewInvestigation[]> {
    const records = await this.prisma.reviewInvestigation.findMany({
      where: {
        workspaceId: input.scope.workspaceId,
        repositoryConnectionId: input.scope.repositoryConnectionId,
        scmRepositoryIdentityId: input.scope.scmRepositoryIdentityId,
        pullRequestNumber: input.scope.pullRequestNumber,
        trustDomain: input.scope.trustDomain,
        authorizationScopeHash: input.scope.authorizationScopeHash,
        reviewRevisionHash: { not: input.targetReviewRevisionHash },
        stableReviewUnitKey: input.stableReviewUnitKey,
        providerVoteLaneId: input.providerVoteLaneId,
        producerReleaseId: input.producerReleaseId,
        replayEvidenceCheckpointId: { not: null },
      },
      select: { investigationId: true },
      orderBy: [{ updatedAt: "desc" }, { investigationId: "asc" }],
      take: input.limit,
    });
    const candidates = await Promise.all(
      records.map((record) =>
        loadAggregate(this.prisma, record.investigationId),
      ),
    );
    return candidates
      .filter(
        (candidate): candidate is ReviewInvestigation => candidate !== null,
      )
      .sort(
        (left, right) =>
          right.replayEvidenceCheckpoint!.issuedAt.localeCompare(
            left.replayEvidenceCheckpoint!.issuedAt,
          ) || left.investigationId.localeCompare(right.investigationId),
      );
  }

  async findExpiredActiveTurnIds(input: {
    readonly expiresAtOrBefore: string;
    readonly limit: number;
  }): Promise<readonly string[]> {
    assertPruneLimit(input.limit);
    const cutoff = parseCanonicalCutoff(
      input.expiresAtOrBefore,
      "investigation_turn_expiry_cutoff_invalid",
    );
    return this.prisma.$transaction(
      async (transaction) => {
        const databaseNow = await investigationDatabaseNow(transaction);
        const effectiveCutoff = cutoff < databaseNow ? cutoff : databaseNow;
        const candidates = await transaction.$queryRaw<
          Array<{ investigationId: string }>
        >(Prisma.sql`
          SELECT investigation."investigationId"
          FROM "ReviewInvestigation" AS investigation
          INNER JOIN "ReviewInvestigationTurn" AS turn
            ON turn."investigationId" = investigation."investigationId"
           AND turn."turnId" = investigation."activeTurnId"
          WHERE investigation."state" = 'turn_leased'::"ReviewInvestigationStateV1"
            AND turn."state" = 'leased'::"ReviewInvestigationTurnStateV1"
            AND turn."expiresAt" <= ${effectiveCutoff}
          ORDER BY turn."expiresAt" ASC, investigation."investigationId" ASC
          LIMIT ${input.limit}
          FOR UPDATE OF investigation SKIP LOCKED
        `);
        return candidates.map((candidate) => candidate.investigationId);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }

  async findLease(leaseId: string): Promise<ReviewInvestigationLease | null> {
    const record = await this.prisma.reviewInvestigationLease.findUnique({
      where: { leaseId },
    });
    return record ? investigationLeaseFromRecord(record) : null;
  }

  async acquireLease(
    candidate: Omit<CreateReviewInvestigationLeaseInput, "fencingToken">,
  ): Promise<InvestigationLeaseAcquireResult> {
    return this.prisma.$transaction(
      async (transaction) => {
        await transaction.$queryRaw(Prisma.sql`
          SELECT "investigationId"
          FROM "ReviewInvestigation"
          WHERE "investigationId" = ${candidate.investigationId}
          FOR UPDATE
        `);
        const investigation = await loadAggregate(
          transaction,
          candidate.investigationId,
        );
        if (
          !investigation ||
          !reviewInvestigationLeaseBindingIsCurrent(candidate, investigation)
        ) {
          await transaction.reviewInvestigationLease.updateMany({
            where: {
              investigationId: candidate.investigationId,
              state: PrismaLeaseState.active,
            },
            data: { state: PrismaLeaseState.revoked },
          });
          return investigationLeaseAcquireResult(
            InvestigationLeaseAcquireStatus.BindingStale,
            null,
          );
        }
        const existingRecord =
          await transaction.reviewInvestigationLease.findUnique({
            where: {
              investigationId_turnId_acquireRequestIdHash: {
                investigationId: candidate.investigationId,
                turnId: candidate.turnId,
                acquireRequestIdHash: candidate.acquireRequestIdHash,
              },
            },
          });
        const existing = existingRecord
          ? investigationLeaseFromRecord(existingRecord)
          : null;
        const replay = decideReviewInvestigationLeaseReplay({
          existing,
          candidate,
        });
        if (replay === ReviewInvestigationLeaseReplayStatus.Restored) {
          return investigationLeaseAcquireResult(
            InvestigationLeaseAcquireStatus.Restored,
            existing,
          );
        }
        if (
          replay === ReviewInvestigationLeaseReplayStatus.IdempotencyConflict
        ) {
          return investigationLeaseAcquireResult(
            InvestigationLeaseAcquireStatus.IdempotencyConflict,
            null,
          );
        }
        const activeRecord =
          await transaction.reviewInvestigationLease.findFirst({
            where: {
              investigationId: candidate.investigationId,
              turnId: candidate.turnId,
              state: PrismaLeaseState.active,
            },
            orderBy: { fencingToken: "desc" },
          });
        if (
          activeRecord &&
          activeRecord.expiresAt > new Date(candidate.acquiredAt)
        ) {
          return investigationLeaseAcquireResult(
            InvestigationLeaseAcquireStatus.Busy,
            null,
          );
        }
        if (activeRecord) {
          const expired = expireReviewInvestigationLease(
            investigationLeaseFromRecord(activeRecord),
          );
          await transaction.reviewInvestigationLease.update({
            where: { leaseId: expired.leaseId },
            data: { state: toPrismaLeaseState(expired.state) },
          });
        }
        const created = await transaction.reviewInvestigationLease.create({
          data: toInvestigationLeaseCreate(candidate),
        });
        return investigationLeaseAcquireResult(
          InvestigationLeaseAcquireStatus.Acquired,
          investigationLeaseFromRecord(created),
        );
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }

  async renewLease(
    input: Parameters<InvestigationLeaseStorePort["renewLease"]>[0],
  ) {
    return this.transitionLease(input.leaseId, (lease) =>
      renewReviewInvestigationLease({ lease, ...input }),
    );
  }

  async releaseLease(
    input: Parameters<InvestigationLeaseStorePort["releaseLease"]>[0],
  ) {
    return this.transitionLease(input.leaseId, (lease) =>
      releaseReviewInvestigationLease({ lease, ...input }),
    );
  }

  private async transitionLease(
    leaseId: string,
    transition: (
      lease: ReviewInvestigationLease,
    ) => import("../../domain/investigation-lease").ReviewInvestigationLeaseTransitionResult,
  ) {
    return this.prisma.$transaction(
      async (transaction) => {
        const initial = await transaction.reviewInvestigationLease.findUnique({
          where: { leaseId },
          select: { investigationId: true },
        });
        if (!initial) return null;
        await transaction.$queryRaw(Prisma.sql`
          SELECT "investigationId"
          FROM "ReviewInvestigation"
          WHERE "investigationId" = ${initial.investigationId}
          FOR UPDATE
        `);
        await transaction.$queryRaw(Prisma.sql`
          SELECT "leaseId"
          FROM "ReviewInvestigationLease"
          WHERE "leaseId" = ${leaseId}
          FOR UPDATE
        `);
        const record = await transaction.reviewInvestigationLease.findUnique({
          where: { leaseId },
        });
        if (!record) return null;
        const lease = investigationLeaseFromRecord(record);
        const investigation = await loadAggregate(
          transaction,
          lease.investigationId,
        );
        if (
          !investigation ||
          !reviewInvestigationLeaseBindingIsCurrent(lease, investigation)
        ) {
          const revoked = revokeReviewInvestigationLease(lease);
          const updated = await transaction.reviewInvestigationLease.update({
            where: { leaseId },
            data: toInvestigationLeaseTransitionUpdate(revoked),
          });
          return {
            status: ReviewInvestigationLeaseTransitionStatus.BindingStale,
            lease: investigationLeaseFromRecord(updated),
          };
        }
        const result = transition(lease);
        if (result.lease !== lease) {
          const updated = await transaction.reviewInvestigationLease.update({
            where: { leaseId },
            data: toInvestigationLeaseTransitionUpdate(result.lease),
          });
          return { ...result, lease: investigationLeaseFromRecord(updated) };
        }
        return result;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }

  async commit(
    input: Parameters<InvestigationStorePort["commit"]>[0],
  ): Promise<InvestigationStoreCommitResult> {
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

          const privateMaterials = validateInvestigationPrivateMaterialCommit({
            investigation: input.investigation,
            expectedVersion: input.expectedVersion,
            transition: input.transition,
            privateMaterials: input.privateMaterials ?? [],
          });

          if (input.expectedVersion === null) {
            return this.createAggregate(transaction, {
              investigation: input.investigation,
              expectedVersion: null,
              commandId: input.commandId,
              commandHash: input.commandHash,
              transition: input.transition,
              privateMaterials,
            });
          }
          if (input.guard !== undefined) {
            await lockInvestigationExecutionScope(
              transaction,
              input.investigation,
            );
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
          if (!(await commitGuardIsCurrent(transaction, input, current))) {
            return result(
              InvestigationStoreCommitStatus.LeaseFenceConflict,
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
          await persistCertificate(transaction, current, input.investigation);
          await persistReplayEvidenceCheckpoint(
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
          await revokeStaleInvestigationLeases(
            transaction,
            input.investigation,
          );
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
      return result(
        InvestigationStoreCommitStatus.ConcurrencyConflict,
        existing,
      );
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
      const existing =
        await this.prisma.reviewInvestigationPrivateMaterial.findFirst({
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
      if (!existing)
        throw new Error("private_material_unique_conflict_missing", {
          cause: error,
        });
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
    const record =
      await this.prisma.reviewInvestigationPrivateMaterial.findFirst({
        where: {
          investigationId: input.investigationId,
          obligationId: input.obligationId,
          expiresAt: { gt: new Date(input.activeAfter) },
        },
        orderBy: [{ expiresAt: "desc" }, { privateMaterialId: "asc" }],
      });
    return record ? toPrivateMaterial(record) : null;
  }

  async reconcileExpiredPrivateMaterial(input: {
    readonly expiresAtOrBefore: string;
    readonly limit: number;
  }): Promise<number> {
    assertPruneLimit(input.limit);
    const cutoff = parseCanonicalCutoff(
      input.expiresAtOrBefore,
      "investigation_private_material_expiry_cutoff_invalid",
    );
    return this.prisma.$transaction(
      async (transaction) => {
        const databaseNow = await investigationDatabaseNow(transaction);
        const effectiveCutoff = cutoff < databaseNow ? cutoff : databaseNow;
        const candidates = await transaction.$queryRaw<
          ExpiredPrivateMaterialCandidate[]
        >(Prisma.sql`
          SELECT
            material."privateMaterialId",
            material."investigationId",
            material."obligationId"
          FROM "ReviewInvestigationPrivateMaterial" AS material
          INNER JOIN "ReviewInvestigation" AS investigation
            ON investigation."investigationId" = material."investigationId"
          WHERE material."expiresAt" <= ${effectiveCutoff}
            AND investigation."activeTurnId" IS NULL
          ORDER BY material."expiresAt" ASC, material."privateMaterialId" ASC
          LIMIT ${input.limit}
          FOR UPDATE OF investigation, material SKIP LOCKED
        `);
        if (candidates.length === 0) return 0;

        let removedCount = 0;
        for (const group of groupPrivateMaterialCandidates(candidates)) {
          const current = await loadAggregate(
            transaction,
            group.investigationId,
          );
          if (current === null) {
            throw new Error("investigation_private_material_parent_missing");
          }
          const reconciled = await this.privateMaterialExpiry.execute({
            investigation: current,
            privateMaterialIds: group.privateMaterialIds,
            obligationIds: group.obligationIds,
            expiredAt: effectiveCutoff.toISOString(),
          });
          if (
            reconciled.disposition ===
            InvestigationPrivateMaterialExpiryDisposition.DeferredActiveTurn
          ) {
            continue;
          }
          if (
            reconciled.disposition ===
            InvestigationPrivateMaterialExpiryDisposition.Inconclusive
          ) {
            if (reconciled.command === null) {
              throw new Error(
                "investigation_private_material_expiry_command_missing",
              );
            }
            const next = reconciled.investigation;
            const transition: InvestigationStoreTransition = {
              kind: InvestigationStoreTransitionKind.PrivateMaterialExpired,
              affectedObligationIds: reconciled.affectedObligationIds,
              expiredTurnId: reconciled.expiredTurnId,
            };
            assertUpdate(current, next, transition);
            const retainUntil = aggregateRetainUntil(
              next,
              this.options.operationalRetentionMs,
            );
            await persistTransition(
              transaction,
              current,
              next,
              transition,
              retainUntil,
            );
            await persistObligations(
              transaction,
              current,
              next,
              transition,
              retainUntil,
            );
            const updated = await transaction.reviewInvestigation.updateMany({
              where: {
                investigationId: next.investigationId,
                version: BigInt(current.version),
              },
              data: toMainUpdate(next, retainUntil),
            });
            if (updated.count !== 1) throw new InvestigationWriteRaceError();
            await revokeStaleInvestigationLeases(transaction, next);
            await transaction.reviewInvestigationCommandReceipt.create({
              data: {
                commandId: reconciled.command.commandId,
                investigationId: next.investigationId,
                commandHash: reconciled.command.commandHash,
                resultingVersion: BigInt(next.version),
                createdAt: new Date(next.updatedAt),
                retainUntil,
              },
            });
          }

          const deleted =
            await transaction.reviewInvestigationPrivateMaterial.deleteMany({
              where: {
                privateMaterialId: { in: [...group.privateMaterialIds] },
                investigationId: group.investigationId,
                expiresAt: { lte: effectiveCutoff },
              },
            });
          if (deleted.count !== group.privateMaterialIds.length) {
            throw new Error(
              "investigation_private_material_expiry_fence_changed",
            );
          }
          removedCount += deleted.count;
        }
        return removedCount;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }

  async pruneRetainedInvestigations(input: {
    readonly retainUntilOrBefore: string;
    readonly limit: number;
  }): Promise<number> {
    assertPruneLimit(input.limit);
    const cutoff = new Date(input.retainUntilOrBefore);
    return this.prisma.$transaction(
      async (transaction) => {
        const candidates = await transaction.$queryRaw<
          Array<{ investigationId: string }>
        >(Prisma.sql`
          SELECT investigation."investigationId"
          FROM "ReviewInvestigation" AS investigation
          WHERE investigation."retainUntil" <= ${cutoff}
            AND investigation."state" IN (
              'concluded'::"ReviewInvestigationStateV1",
              'inconclusive'::"ReviewInvestigationStateV1",
              'superseded'::"ReviewInvestigationStateV1",
              'expired'::"ReviewInvestigationStateV1"
            )
            AND NOT EXISTS (
              SELECT 1 FROM "ReviewInvestigationReceipt" AS receipt
              WHERE receipt."investigationId" = investigation."investigationId"
                AND receipt."retainUntil" > ${cutoff}
            )
            AND NOT EXISTS (
              SELECT 1 FROM "ReviewInvestigationCertificate" AS certificate
              WHERE certificate."investigationId" = investigation."investigationId"
                AND certificate."expiresAt" > ${cutoff}
            )
            AND NOT EXISTS (
              SELECT 1 FROM "ReviewInvestigationReplayEvidenceCheckpoint" AS checkpoint
              WHERE checkpoint."sourceInvestigationId" = investigation."investigationId"
                AND checkpoint."expiresAt" > ${cutoff}
            )
            AND NOT EXISTS (
              SELECT 1 FROM "ReviewInvestigationPrivateMaterial" AS material
              WHERE material."investigationId" = investigation."investigationId"
                AND material."expiresAt" > ${cutoff}
            )
            AND NOT EXISTS (
              SELECT 1 FROM "ReviewInvestigationTurn" AS turn
              WHERE turn."investigationId" = investigation."investigationId"
                AND turn."retainUntil" > ${cutoff}
            )
            AND NOT EXISTS (
              SELECT 1 FROM "ReviewInvestigationLease" AS lease
              WHERE lease."investigationId" = investigation."investigationId"
                AND lease."retainUntil" > ${cutoff}
            )
            AND NOT EXISTS (
              SELECT 1 FROM "ReviewInvestigationCommandReceipt" AS command
              WHERE command."investigationId" = investigation."investigationId"
                AND command."retainUntil" > ${cutoff}
            )
            AND NOT EXISTS (
              SELECT 1 FROM "ReviewInvestigation" AS dependent
              WHERE dependent."supersededByInvestigationId" = investigation."investigationId"
                AND dependent."investigationId" <> investigation."investigationId"
            )
          ORDER BY investigation."retainUntil" ASC, investigation."investigationId" ASC
          LIMIT ${input.limit}
          FOR UPDATE OF investigation SKIP LOCKED
        `);
        const ids = candidates.map((item) => item.investigationId);
        if (ids.length === 0) return 0;
        await transaction.reviewInvestigation.updateMany({
          where: { investigationId: { in: ids } },
          data: {
            activeTurnId: null,
            certificateId: null,
            replayEvidenceCheckpointId: null,
          },
        });
        await transaction.reviewInvestigationObligation.updateMany({
          where: { investigationId: { in: ids } },
          data: {
            state: PrismaObligationState.open,
            receiptId: null,
            unresolvableReason: null,
          },
        });
        await transaction.reviewInvestigationReceipt.deleteMany({
          where: {
            investigationId: { in: ids },
            retainUntil: { lte: cutoff },
          },
        });
        await transaction.reviewInvestigationCertificate.deleteMany({
          where: {
            investigationId: { in: ids },
            expiresAt: { lte: cutoff },
          },
        });
        await transaction.reviewInvestigationReplayEvidenceCheckpoint.deleteMany(
          {
            where: {
              sourceInvestigationId: { in: ids },
              expiresAt: { lte: cutoff },
            },
          },
        );
        await transaction.reviewInvestigationCommandReceipt.deleteMany({
          where: {
            investigationId: { in: ids },
            retainUntil: { lte: cutoff },
          },
        });
        await transaction.reviewInvestigationPrivateMaterial.deleteMany({
          where: {
            investigationId: { in: ids },
            expiresAt: { lte: cutoff },
          },
        });
        await transaction.reviewInvestigationLease.deleteMany({
          where: {
            investigationId: { in: ids },
            retainUntil: { lte: cutoff },
          },
        });
        await transaction.reviewInvestigationTurn.deleteMany({
          where: {
            investigationId: { in: ids },
            retainUntil: { lte: cutoff },
          },
        });
        await transaction.reviewInvestigationObligation.deleteMany({
          where: { investigationId: { in: ids } },
        });
        const deleted = await transaction.reviewInvestigation.deleteMany({
          where: {
            investigationId: { in: ids },
            retainUntil: { lte: cutoff },
            state: {
              in: [
                PrismaInvestigationState.concluded,
                PrismaInvestigationState.inconclusive,
                PrismaInvestigationState.superseded,
                PrismaInvestigationState.expired,
              ],
            },
          },
        });
        if (deleted.count !== ids.length) {
          throw new Error("investigation_prune_fence_changed");
        }
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
      readonly privateMaterials: readonly EncryptedInvestigationPrivateMaterial[];
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
    await persistPrivateMaterials(transaction, input.privateMaterials);
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
  const replayEvidenceCheckpoint = record.replayEvidenceCheckpointId
    ? await database.reviewInvestigationReplayEvidenceCheckpoint.findUnique({
        where: { checkpointId: record.replayEvidenceCheckpointId },
      })
    : null;
  const receiptById = new Map(receipts.map((item) => [item.receiptId, item]));
  const domainObligations = obligations.map((item) =>
    toObligation(
      item,
      item.receiptId ? receiptById.get(item.receiptId) : undefined,
    ),
  );
  if (domainObligations.some((item) => item === null)) {
    throw new Error("investigation_obligation_receipt_missing");
  }
  const policyCanonicalVersion = parseInvestigationPolicyCanonicalVersion(
    record.policyCanonicalVersion,
  );
  const policy = toPolicy(record.policy);
  assertInvestigationPolicyCanonicalCompatibility(
    policy,
    policyCanonicalVersion,
  );
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
      authorizationScopeHash: requiredCertificateField(
        record.authorizationScopeHash,
        "authorization_scope_hash",
      ),
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
    investigationManifestCanonicalJson:
      record.investigationManifestCanonicalJson,
    investigationManifestHash: record.investigationManifestHash,
    runtimeProfile: fromPrismaRuntimeProfile(record.runtimeProfile),
    contract: {
      coverageContractVersion: record.coverageContractVersion,
      expansionRulesVersion: record.expansionRulesVersion,
      criticPolicyVersion: record.criticPolicyVersion,
      gatewayPolicyVersion: record.gatewayPolicyVersion,
      probePolicyVersion: record.probePolicyVersion,
      producerReleaseId: record.producerReleaseId,
      runtimeProfileVersion: record.runtimeProfileVersion,
      searchPolicyVersion: record.searchPolicyVersion,
    },
    policyCanonicalVersion,
    policy,
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
    totalUsageTokens: safeNumber(
      record.totalUsageTokens,
      "investigation_total_usage_tokens",
    ),
    totalDurationMs: safeNumber(
      record.totalDurationMs,
      "investigation_total_duration_ms",
    ),
    turnProvenance: toTurnProvenance(record.turnProvenance),
    conclusion:
      record.conclusion === null
        ? null
        : fromPrismaConclusion(record.conclusion),
    certificate: certificate ? toCertificate(certificate) : null,
    replayEvidenceCheckpoint: replayEvidenceCheckpoint
      ? toReplayEvidenceCheckpoint(replayEvidenceCheckpoint)
      : null,
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
    case InvestigationStoreTransitionKind.ActiveTurnExpired: {
      const updated = await transaction.reviewInvestigationTurn.updateMany({
        where: {
          turnId: transition.turnId,
          investigationId: next.investigationId,
          state: PrismaTurnState.leased,
        },
        data: {
          state: PrismaTurnState.expired,
          abortReason: "expired_active_turn",
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
    case InvestigationStoreTransitionKind.PrivateMaterialExpired: {
      if (transition.expiredTurnId === null) return;
      const updated = await transaction.reviewInvestigationTurn.updateMany({
        where: {
          turnId: transition.expiredTurnId,
          investigationId: next.investigationId,
          state: PrismaTurnState.leased,
        },
        data: {
          state: PrismaTurnState.expired,
          abortReason:
            InvestigationPrivateMaterialExpiryReason.RegenerationUnavailable,
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
  const existingRecords =
    await transaction.reviewInvestigationObligation.findMany({
      where: { investigationId: next.investigationId },
    });
  const existingById = new Map(
    existingRecords.map((item) => [item.obligationId, item]),
  );
  const existingReceipts =
    await transaction.reviewInvestigationReceipt.findMany({
      where: { investigationId: next.investigationId },
    });
  const receiptById = new Map(
    existingReceipts.map((item) => [item.receiptId, item]),
  );
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
      if (
        !obligation.receipt ||
        obligation.receipt.receiptId !== existing.receiptId
      ) {
        throw new Error("investigation_receipt_mutation_forbidden");
      }
      const persistedReceipt = receiptById.get(existing.receiptId);
      if (
        !persistedReceipt ||
        !sameReceipt(toReceipt(persistedReceipt), obligation.receipt)
      ) {
        throw new Error("investigation_receipt_mutation_forbidden");
      }
    } else if (obligation.receipt) {
      if (
        transition.kind === InvestigationStoreTransitionKind.TurnCommitted &&
        obligation.receipt.acceptedAttestationId !==
          transition.acceptedAttestationId
      ) {
        throw new Error(
          "investigation_receipt_attestation_transition_mismatch",
        );
      }
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
          operationReceiptIds: [...obligation.receipt.operationReceiptIds],
          acceptedAttestationHash: obligation.receipt.acceptedAttestationHash,
          replayProofId: obligation.receipt.replayProofId,
          complete: obligation.receipt.complete,
          truncated: obligation.receipt.truncated,
          failed: obligation.receipt.failed,
          acceptedAttestationId: obligation.receipt.acceptedAttestationId,
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

async function persistPrivateMaterials(
  transaction: Prisma.TransactionClient,
  materials: readonly EncryptedInvestigationPrivateMaterial[],
): Promise<void> {
  for (const material of materials) {
    await transaction.reviewInvestigationPrivateMaterial.create({
      data: toPrivateMaterialCreate(material),
    });
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
      scopeHash: certificate.scopeHash,
      coverageStateHash: certificate.coverageStateHash,
      contextAttestationSetHash: certificate.contextAttestationSetHash,
      turnProvenanceHash: certificate.turnProvenanceHash,
      terminalProviderKind: certificate.terminalProviderKind,
      terminalActualModel: certificate.terminalActualModel,
      terminalOutcomeHash: certificate.terminalOutcomeHash,
      terminalObservationCanonicalJson:
        certificate.terminalObservationCanonicalJson,
      criticAttestationId: certificate.criticAttestationId,
      criticAttestationHash: certificate.criticAttestationHash,
      criticDecision:
        certificate.criticDecision === null
          ? null
          : toPrismaCriticDecision(certificate.criticDecision),
      issuedAt: new Date(certificate.issuedAt),
      expiresAt: new Date(certificate.expiresAt),
    },
  });
}

async function persistReplayEvidenceCheckpoint(
  transaction: Prisma.TransactionClient,
  current: ReviewInvestigation,
  next: ReviewInvestigation,
): Promise<void> {
  if (current.replayEvidenceCheckpoint) {
    if (
      next.replayEvidenceCheckpoint?.checkpointHash !==
      current.replayEvidenceCheckpoint.checkpointHash
    ) {
      throw new Error("investigation_replay_checkpoint_mutation_forbidden");
    }
    return;
  }
  const checkpoint = next.replayEvidenceCheckpoint;
  if (!checkpoint) return;
  await transaction.reviewInvestigationReplayEvidenceCheckpoint.create({
    data: {
      ...checkpoint,
      sourceInvestigationVersion: BigInt(checkpoint.sourceInvestigationVersion),
      sourceState: toPrismaInvestigationState(checkpoint.sourceState),
      sourceConclusion:
        checkpoint.sourceConclusion === null
          ? null
          : toPrismaConclusion(checkpoint.sourceConclusion),
      issuedAt: new Date(checkpoint.issuedAt),
      expiresAt: new Date(checkpoint.expiresAt),
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
    authorizationScopeHash: investigation.scope.authorizationScopeHash,
    baseSha: investigation.revision.baseSha,
    mergeBaseSha: investigation.revision.mergeBaseSha,
    headSha: investigation.revision.headSha,
    reviewRevisionHash: investigation.revision.reviewRevisionHash,
    executionId: investigation.executionId,
    workSlotId: investigation.workSlotId,
    stableReviewUnitKey: investigation.stableReviewUnitKey,
    providerVoteLaneId: investigation.providerVoteLaneId,
    providerStrategyId: investigation.providerStrategyId,
    investigationManifestCanonicalJson:
      investigation.investigationManifestCanonicalJson,
    investigationManifestHash: investigation.investigationManifestHash,
    runtimeProfile: toPrismaRuntimeProfile(investigation.runtimeProfile),
    coverageContractVersion: investigation.contract.coverageContractVersion,
    expansionRulesVersion: investigation.contract.expansionRulesVersion,
    criticPolicyVersion: investigation.contract.criticPolicyVersion,
    gatewayPolicyVersion: investigation.contract.gatewayPolicyVersion,
    probePolicyVersion: investigation.contract.probePolicyVersion,
    producerReleaseId: investigation.contract.producerReleaseId,
    runtimeProfileVersion: investigation.contract.runtimeProfileVersion,
    searchPolicyVersion: investigation.contract.searchPolicyVersion,
    policyCanonicalVersion: investigation.policyCanonicalVersion,
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
    totalUsageTokens: BigInt(investigation.totalUsageTokens),
    totalDurationMs: BigInt(investigation.totalDurationMs),
    turnProvenance:
      investigation.turnProvenance as unknown as Prisma.InputJsonValue,
    conclusion:
      investigation.conclusion === null
        ? null
        : toPrismaConclusion(investigation.conclusion),
    certificateId: null,
    replayEvidenceCheckpointId: null,
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
    policyCanonicalVersion: investigation.policyCanonicalVersion,
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
    totalUsageTokens: BigInt(investigation.totalUsageTokens),
    totalDurationMs: BigInt(investigation.totalDurationMs),
    turnProvenance:
      investigation.turnProvenance as unknown as Prisma.InputJsonValue,
    conclusion:
      investigation.conclusion === null
        ? null
        : toPrismaConclusion(investigation.conclusion),
    certificateId: investigation.certificate?.certificateId ?? null,
    replayEvidenceCheckpointId:
      investigation.replayEvidenceCheckpoint?.checkpointId ?? null,
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
    next.providerStrategyId !== current.providerStrategyId ||
    next.investigationManifestCanonicalJson !==
      current.investigationManifestCanonicalJson ||
    next.investigationManifestHash !== current.investigationManifestHash ||
    next.contract.coverageContractVersion !==
      current.contract.coverageContractVersion ||
    next.contract.probePolicyVersion !== current.contract.probePolicyVersion ||
    next.contract.runtimeProfileVersion !==
      current.contract.runtimeProfileVersion ||
    next.contract.searchPolicyVersion !== current.contract.searchPolicyVersion
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
    case InvestigationStoreTransitionKind.ActiveTurnExpired:
      if (
        current.activeTurn?.turnId !== transition.turnId ||
        next.activeTurn !== null ||
        ![
          ReviewInvestigationState.AwaitingTurn,
          ReviewInvestigationState.AwaitingCritic,
          ReviewInvestigationState.Inconclusive,
          ReviewInvestigationState.Superseded,
        ].includes(next.state)
      ) {
        throw new Error("investigation_turn_expiry_transition_invalid");
      }
      return;
    case InvestigationStoreTransitionKind.PrivateMaterialExpired: {
      if (
        next.state !== ReviewInvestigationState.Inconclusive ||
        next.conclusion !== ReviewInvestigationConclusion.Inconclusive ||
        next.activeTurn !== null ||
        (transition.expiredTurnId !== current.activeTurn?.turnId &&
          !(
            transition.expiredTurnId === null && current.activeTurn === null
          )) ||
        transition.affectedObligationIds.length === 0
      ) {
        throw new Error(
          "investigation_private_material_expiry_transition_invalid",
        );
      }
      const currentById = new Map(
        current.obligations.map((item) => [item.obligationId, item]),
      );
      const nextById = new Map(
        next.obligations.map((item) => [item.obligationId, item]),
      );
      for (const obligationId of transition.affectedObligationIds) {
        const before = currentById.get(obligationId);
        const after = nextById.get(obligationId);
        if (
          before?.state !== InvestigationObligationState.Open ||
          after?.state !== InvestigationObligationState.Unresolvable ||
          after.unresolvableReason !==
            InvestigationPrivateMaterialExpiryReason.RegenerationUnavailable
        ) {
          throw new Error(
            "investigation_private_material_expiry_obligation_invalid",
          );
        }
      }
      return;
    }
    case InvestigationStoreTransitionKind.Concluded:
      if (current.certificate !== null || next.certificate === null) {
        throw new Error("investigation_conclusion_transition_invalid");
      }
  }
}

function assertRehydratedAggregate(investigation: ReviewInvestigation): void {
  assertPersistedInvestigationRequirementsSanitized(investigation);
  assertDigest(investigation.naturalIdentityHash, "natural_identity_hash");
  assertDigest(
    investigation.revision.reviewRevisionHash,
    "review_revision_hash",
  );
  assertDigest(investigation.dossierDigest, "dossier_digest");
  if (
    !Number.isSafeInteger(investigation.version) ||
    investigation.version <= 0
  ) {
    throw new Error("investigation_version_corrupt");
  }
  for (const [field, value] of [
    ["semantic_turns", investigation.semanticTurns],
    ["operational_attempts", investigation.operationalAttempts],
    ["expansion_depth", investigation.expansionDepth],
    ["critic_cycles", investigation.criticCycles],
    ["total_usage_tokens", investigation.totalUsageTokens],
    ["total_duration_ms", investigation.totalDurationMs],
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
        ReviewInvestigationState.Inconclusive,
        ReviewInvestigationState.Expired,
        ReviewInvestigationState.Superseded,
      ].includes(investigation.state))
  ) {
    throw new Error("investigation_certificate_state_corrupt");
  }
  if (
    investigation.turnProvenance.length >
      investigation.semanticTurns + investigation.criticCycles ||
    new Set(investigation.turnProvenance.map((item) => item.turnId)).size !==
      investigation.turnProvenance.length
  ) {
    throw new Error("investigation_turn_provenance_corrupt");
  }
  for (const provenance of investigation.turnProvenance) {
    assertDigest(
      provenance.acceptedAttestationHash,
      "accepted_attestation_hash",
    );
    assertDigest(provenance.terminalOutcomeHash, "terminal_outcome_hash");
    if (
      provenance.runtimeProfile !== investigation.runtimeProfile ||
      !isValidInvestigationTokenUsage(provenance)
    ) {
      throw new Error("investigation_turn_provenance_binding_corrupt");
    }
  }
  if (investigation.certificate) {
    const terminalProvenance = summarizeTerminalDiscoveryProvenance(
      investigation.turnProvenance,
    );
    if (
      investigation.certificate.investigationId !==
        investigation.investigationId ||
      investigation.certificate.investigationVersion + 1 !==
        investigation.version ||
      investigation.certificate.conclusion !== investigation.conclusion ||
      investigation.certificate.terminalProviderKind !==
        terminalProvenance.providerKind ||
      investigation.certificate.terminalActualModel !==
        terminalProvenance.actualModel
    ) {
      throw new Error("investigation_certificate_binding_corrupt");
    }
  }
  const checkpoint = investigation.replayEvidenceCheckpoint;
  if (
    checkpoint !== null &&
    (checkpoint.sourceInvestigationId !== investigation.investigationId ||
      checkpoint.sourceInvestigationVersion !== investigation.version ||
      checkpoint.sourceState !== investigation.state ||
      checkpoint.sourceConclusion !== investigation.conclusion ||
      Date.parse(checkpoint.expiresAt) <= Date.parse(checkpoint.issuedAt))
  ) {
    throw new Error("investigation_replay_checkpoint_binding_corrupt");
  }
  const acceptedReceipts = new Set<string>();
  let inventoryWitnessCount = 0;
  for (const obligation of investigation.obligations) {
    if (obligation.kind === InvestigationObligationKind.InventoryWitness) {
      inventoryWitnessCount += 1;
    }
    const satisfied =
      obligation.state === InvestigationObligationState.Satisfied;
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
  const checkpointExpiry = investigation.replayEvidenceCheckpoint
    ? new Date(investigation.replayEvidenceCheckpoint.expiresAt)
    : null;
  return [operational, certificateExpiry, checkpointExpiry]
    .filter((value): value is Date => value !== null)
    .reduce((latest, value) => (value > latest ? value : latest), operational);
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
    operationReceiptIds: toStringArray(
      record.operationReceiptIds,
      "receipt_operation_receipt_ids",
    ),
    acceptedAttestationId:
      record.acceptedAttestationHash === null
        ? null
        : record.acceptedAttestationId,
    acceptedAttestationHash: record.acceptedAttestationHash,
    replayProofId: record.replayProofId,
    complete: record.complete,
    truncated: record.truncated,
    failed: record.failed,
  };
}

function toTurn(record: PrismaTurnRecord): InvestigationTurn {
  if (record.state !== PrismaTurnState.leased) {
    throw new Error("investigation_active_turn_not_leased");
  }
  const obligationIds = toStringArray(
    record.obligationIds,
    "turn_obligation_ids",
  );
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
    investigationVersion: safeNumber(
      record.terminalVersion,
      "certificate_version",
    ),
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
    scopeHash: requiredCertificateField(record.scopeHash, "scope_hash"),
    coverageStateHash: requiredCertificateField(
      record.coverageStateHash,
      "coverage_state_hash",
    ),
    contextAttestationSetHash: requiredCertificateField(
      record.contextAttestationSetHash,
      "context_attestation_set_hash",
    ),
    turnProvenanceHash: requiredCertificateField(
      record.turnProvenanceHash,
      "turn_provenance_hash",
    ),
    terminalProviderKind:
      record.terminalProviderKind === null
        ? null
        : parseTerminalProviderKind(record.terminalProviderKind),
    terminalActualModel: record.terminalActualModel,
    terminalOutcomeHash: requiredCertificateField(
      record.terminalOutcomeHash,
      "terminal_outcome_hash",
    ),
    terminalObservationCanonicalJson: requiredCertificateField(
      record.terminalObservationCanonicalJson,
      "terminal_observation_canonical_json",
    ),
    criticAttestationId: record.criticAttestationId,
    criticAttestationHash: record.criticAttestationHash,
    criticDecision:
      record.criticDecision === null
        ? null
        : fromPrismaCriticDecision(record.criticDecision),
    issuedAt: record.issuedAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
  };
}

function toReplayEvidenceCheckpoint(
  record: PrismaReplayEvidenceCheckpointRecord,
): ReplayEvidenceCheckpoint {
  return {
    checkpointId: record.checkpointId,
    checkpointHash: record.checkpointHash,
    sourceInvestigationId: record.sourceInvestigationId,
    sourceInvestigationVersion: safeNumber(
      record.sourceInvestigationVersion,
      "replay_checkpoint_source_version",
    ),
    sourceDossierDigest: record.sourceDossierDigest,
    scopeHash: record.scopeHash,
    reviewRevisionHash: record.reviewRevisionHash,
    stableReviewUnitKey: record.stableReviewUnitKey,
    providerVoteLaneId: record.providerVoteLaneId,
    contractHash: record.contractHash,
    policyHash: record.policyHash,
    producerReleaseId: record.producerReleaseId,
    producerReleaseHash: record.producerReleaseHash,
    runtimeProfileHash: record.runtimeProfileHash,
    receiptSetHash: record.receiptSetHash,
    contextAttestationSetHash: record.contextAttestationSetHash,
    sourceState: fromPrismaInvestigationState(record.sourceState),
    sourceConclusion:
      record.sourceConclusion === null
        ? null
        : fromPrismaConclusion(record.sourceConclusion),
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
  const maxSeedProbesPerFile = optionalNumberField(
    value,
    "maxSeedProbesPerFile",
  );
  const maxSeedProbesOverall = optionalNumberField(
    value,
    "maxSeedProbesOverall",
  );
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
    ...(maxSeedProbesPerFile === undefined ? {} : { maxSeedProbesPerFile }),
    ...(maxSeedProbesOverall === undefined ? {} : { maxSeedProbesOverall }),
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
      severity: findingSeverity(stringField(item, "severity")),
      title: stringField(item, "title"),
      body: stringField(item, "body"),
      path: stringField(item, "path"),
      line,
      evidenceReceiptIds,
    };
  });
}

function findingSeverity(value: string): InvestigationFindingSeverity {
  switch (value) {
    case InvestigationFindingSeverity.Critical:
      return InvestigationFindingSeverity.Critical;
    case InvestigationFindingSeverity.Major:
      return InvestigationFindingSeverity.Major;
    case InvestigationFindingSeverity.Minor:
      return InvestigationFindingSeverity.Minor;
    default:
      throw new Error("investigation_finding_severity_corrupt");
  }
}

function toTurnProvenance(
  value: Prisma.JsonValue,
): readonly InvestigationTurnProvenance[] {
  if (!Array.isArray(value)) {
    throw new Error("investigation_turn_provenance_corrupt");
  }
  return value.map((item) => {
    if (!isObject(item)) {
      throw new Error("investigation_turn_provenance_item_corrupt");
    }
    const purpose = stringEnumField(
      item,
      "purpose",
      ReviewInvestigationTurnPurpose,
    );
    const actualProviderKind = stringEnumField(
      item,
      "actualProviderKind",
      InvestigationTurnProviderKind,
    );
    const runtimeProfile = stringEnumField(
      item,
      "runtimeProfile",
      ReviewInvestigationRuntimeProfile,
    );
    return {
      turnId: stringField(item, "turnId"),
      purpose,
      actualProviderKind,
      actualModel: stringField(item, "actualModel"),
      runtimeProfile,
      inputTokens: numberField(item, "inputTokens"),
      cachedInputTokens: numberField(item, "cachedInputTokens"),
      outputTokens: numberField(item, "outputTokens"),
      reasoningOutputTokens: numberField(item, "reasoningOutputTokens"),
      totalTokens: numberField(item, "totalTokens"),
      durationMs: numberField(item, "durationMs"),
      acceptedAttestationId: stringField(item, "acceptedAttestationId"),
      acceptedAttestationHash: stringField(item, "acceptedAttestationHash"),
      terminalOutcomeHash: stringField(item, "terminalOutcomeHash"),
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

function parseCanonicalCutoff(value: string, code: string): Date {
  const cutoff = new Date(value);
  if (!Number.isFinite(cutoff.getTime()) || cutoff.toISOString() !== value) {
    throw new Error(code);
  }
  return cutoff;
}

function groupPrivateMaterialCandidates(
  candidates: readonly ExpiredPrivateMaterialCandidate[],
): readonly Readonly<{
  investigationId: string;
  privateMaterialIds: readonly string[];
  obligationIds: readonly string[];
}>[] {
  const groups = new Map<
    string,
    { privateMaterialIds: string[]; obligationIds: string[] }
  >();
  for (const candidate of candidates) {
    const group = groups.get(candidate.investigationId) ?? {
      privateMaterialIds: [],
      obligationIds: [],
    };
    group.privateMaterialIds.push(candidate.privateMaterialId);
    if (candidate.obligationId !== null) {
      group.obligationIds.push(candidate.obligationId);
    }
    groups.set(candidate.investigationId, group);
  }
  return [...groups.entries()].map(([investigationId, group]) => ({
    investigationId,
    privateMaterialIds: Object.freeze([...group.privateMaterialIds].sort()),
    obligationIds: Object.freeze([...new Set(group.obligationIds)].sort()),
  }));
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

function optionalNumberField(
  value: Record<string, unknown>,
  field: string,
): number | undefined {
  return value[field] === undefined ? undefined : numberField(value, field);
}

function stringEnumField<T extends Record<string, string>>(
  value: Record<string, unknown>,
  field: string,
  source: T,
): T[keyof T] {
  const candidate = stringField(value, field);
  if (!Object.values(source).includes(candidate)) {
    throw new Error(`${field}_corrupt`);
  }
  return candidate as T[keyof T];
}

function requiredCertificateField(value: string | null, field: string): string {
  if (value === null)
    throw new Error(`investigation_certificate_${field}_missing`);
  return value;
}

function toStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field}_corrupt`);
  }
  return [...value] as string[];
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

function isRetryablePersistenceConflict(error: unknown): boolean {
  return (
    error instanceof InvestigationWriteRaceError ||
    isUniqueConstraintError(error) ||
    (error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2034")
  );
}

class InvestigationWriteRaceError extends Error {}

async function commitGuardIsCurrent(
  transaction: Prisma.TransactionClient,
  input: Parameters<InvestigationStorePort["commit"]>[0],
  current: ReviewInvestigation,
): Promise<boolean> {
  if (input.guard === undefined) return true;
  const databaseNow = await investigationDatabaseNow(transaction);
  if (
    input.guard.kind === InvestigationStoreCommitGuardKind.ExecutionAuthority
  ) {
    return (
      (await executionAuthorityVerdict(transaction, current, databaseNow)) ===
      input.guard.expectedVerdict
    );
  }
  if (
    input.guard.kind === InvestigationStoreCommitGuardKind.ExpiredActiveTurn
  ) {
    return (
      input.transition.kind ===
        InvestigationStoreTransitionKind.ActiveTurnExpired &&
      input.transition.turnId === input.guard.turnId &&
      current.activeTurn?.turnId === input.guard.turnId &&
      current.activeTurn.expiresAt === input.guard.expiresAt &&
      databaseNow >= new Date(input.guard.expiresAt) &&
      (await executionAuthorityVerdict(transaction, current, databaseNow)) ===
        input.guard.expectedVerdict
    );
  }
  if (input.guard.kind !== InvestigationStoreCommitGuardKind.LeaseFence) {
    return false;
  }
  if (
    input.transition.kind !== InvestigationStoreTransitionKind.TurnCommitted ||
    input.transition.turnId !== input.guard.turnId
  ) {
    return false;
  }
  const source = await transaction.reviewInvestigationLease.findUnique({
    where: { leaseId: input.guard.leaseId },
  });
  if (
    !source ||
    source.state !== PrismaLeaseState.active ||
    source.investigationId !== input.investigation.investigationId ||
    source.turnId !== input.guard.turnId ||
    source.attemptId !== input.guard.attemptId ||
    source.fencingToken.toString(10) !== input.guard.fencingToken ||
    (input.guard.leaseCapabilityId !== undefined &&
      source.leaseCapabilityId !== input.guard.leaseCapabilityId) ||
    (input.guard.authorizationId !== undefined &&
      source.authorizationId !== input.guard.authorizationId) ||
    (input.guard.mutationEpoch !== undefined &&
      source.mutationEpoch !== input.guard.mutationEpoch)
  ) {
    return false;
  }
  if (
    input.guard.authorizationId !== undefined &&
    input.guard.mutationEpoch !== undefined
  ) {
    const authorization = await transaction.reviewRunAuthorization.findUnique({
      where: { authorizationId: input.guard.authorizationId },
      select: { state: true, mutationEpoch: true, expiresAt: true },
    });
    if (
      authorization?.state !== "active" ||
      authorization.mutationEpoch !== input.guard.mutationEpoch ||
      authorization.expiresAt <= databaseNow
    ) {
      return false;
    }
    const emergencyStops = await transaction.reviewSafetyEmergencyControl.count(
      {
        where: {
          stopped: true,
          OR: [
            { policyScope: "global" },
            {
              policyScope: "workspace",
              workspaceId: current.scope.workspaceId,
            },
            {
              policyScope: "repository",
              workspaceId: current.scope.workspaceId,
              repositoryConnectionId: current.scope.repositoryConnectionId,
              scmRepositoryIdentityId: current.scope.scmRepositoryIdentityId,
            },
          ],
        },
      },
    );
    if (emergencyStops > 0) return false;
  }
  if (
    !resultAdmissionDeadlineIsCurrent(input.guard, source, current, databaseNow)
  ) {
    return false;
  }
  if (
    input.guard.resultAdmission === TurnResultAdmissionKind.Rejected ||
    (input.guard.resultAdmission === TurnResultAdmissionKind.HistoricalDrain &&
      input.investigation.state !== ReviewInvestigationState.Superseded) ||
    (input.guard.resultAdmission === TurnResultAdmissionKind.Current &&
      input.investigation.state === ReviewInvestigationState.Superseded)
  ) {
    return false;
  }
  if (input.guard.resultAdmission !== undefined) {
    const expectedVerdict =
      input.guard.resultAdmission === TurnResultAdmissionKind.Current
        ? InvestigationExecutionAuthorityVerdict.Current
        : InvestigationExecutionAuthorityVerdict.Superseded;
    if (
      (await executionAuthorityVerdict(transaction, current, databaseNow)) !==
      expectedVerdict
    ) {
      return false;
    }
  }
  if (
    !reviewInvestigationLeaseBindingIsCurrent(
      investigationLeaseFromRecord(source),
      current,
    )
  ) {
    return false;
  }
  const newest = await transaction.reviewInvestigationLease.findFirst({
    where: {
      investigationId: source.investigationId,
      turnId: source.turnId,
    },
    orderBy: { fencingToken: "desc" },
    select: { fencingToken: true },
  });
  return newest?.fencingToken === source.fencingToken;
}

function resultAdmissionDeadlineIsCurrent(
  guard: Extract<
    NonNullable<Parameters<InvestigationStorePort["commit"]>[0]["guard"]>,
    { kind: InvestigationStoreCommitGuardKind.LeaseFence }
  >,
  lease: PrismaLeaseRecord,
  investigation: ReviewInvestigation,
  databaseNow: Date,
): boolean {
  const values = [
    guard.resultAdmission,
    guard.admittedAt,
    guard.effectiveDeadline,
  ];
  if (values.every((value) => value === undefined)) return true;
  if (values.some((value) => value === undefined)) return false;
  const admittedAt = new Date(guard.admittedAt!);
  const effectiveDeadline = new Date(guard.effectiveDeadline!);
  return (
    Number.isFinite(admittedAt.getTime()) &&
    Number.isFinite(effectiveDeadline.getTime()) &&
    admittedAt < effectiveDeadline &&
    databaseNow < effectiveDeadline &&
    effectiveDeadline <= lease.resultReportUntil &&
    investigation.activeTurn !== null &&
    effectiveDeadline <= new Date(investigation.activeTurn.expiresAt)
  );
}

async function executionAuthorityVerdict(
  transaction: Prisma.TransactionClient,
  investigation: ReviewInvestigation,
  databaseNow: Date,
): Promise<InvestigationExecutionAuthorityVerdict> {
  const execution = await transaction.reviewExecutionV2.findUnique({
    where: { executionId: investigation.executionId },
  });
  if (execution === null) {
    return InvestigationExecutionAuthorityVerdict.Missing;
  }
  const [authorization, slot, stream] = await Promise.all([
    transaction.reviewRunAuthorization.findUnique({
      where: { authorizationId: execution.authorizationId },
    }),
    transaction.reviewExecutionWorkSlotV2.findUnique({
      where: {
        executionId_workSlotId: {
          executionId: investigation.executionId,
          workSlotId: investigation.workSlotId,
        },
      },
    }),
    transaction.reviewExecutionStreamV2.findUnique({
      where: {
        workspaceId_repositoryConnectionId_scmRepositoryIdentityId_pullRequestNumber:
          {
            workspaceId: investigation.scope.workspaceId,
            repositoryConnectionId: investigation.scope.repositoryConnectionId,
            scmRepositoryIdentityId:
              investigation.scope.scmRepositoryIdentityId,
            pullRequestNumber: investigation.scope.pullRequestNumber,
          },
      },
    }),
  ]);
  if (
    authorization === null ||
    slot === null ||
    execution.workspaceId !== investigation.scope.workspaceId ||
    execution.repositoryConnectionId !==
      investigation.scope.repositoryConnectionId ||
    execution.scmRepositoryIdentityId !==
      investigation.scope.scmRepositoryIdentityId ||
    execution.pullRequestNumber !== investigation.scope.pullRequestNumber ||
    execution.authorizationId !== authorization.authorizationId ||
    execution.mutationEpoch !== authorization.mutationEpoch ||
    authorization.workspaceId !== investigation.scope.workspaceId ||
    authorization.repositoryConnectionId !==
      investigation.scope.repositoryConnectionId ||
    authorization.scmRepositoryIdentityId !==
      investigation.scope.scmRepositoryIdentityId ||
    authorization.pullRequestNumber !== investigation.scope.pullRequestNumber ||
    authorization.trustDomain !== investigation.scope.trustDomain ||
    authorization.reviewRevisionHash !==
      investigation.revision.reviewRevisionHash ||
    authorization.state !== "active" ||
    authorization.expiresAt <= databaseNow ||
    slot.providerVoteIdentityHash !== investigation.providerVoteLaneId
  ) {
    return InvestigationExecutionAuthorityVerdict.Unauthorized;
  }
  if (
    execution.state !== "running" ||
    stream?.activeExecutionId !== execution.executionId ||
    stream.currentReviewRevisionHash !==
      investigation.revision.reviewRevisionHash ||
    execution.reviewRevisionHash !==
      investigation.revision.reviewRevisionHash ||
    execution.headSha !== investigation.revision.headSha
  ) {
    return InvestigationExecutionAuthorityVerdict.Superseded;
  }
  return InvestigationExecutionAuthorityVerdict.Current;
}

async function lockInvestigationExecutionScope(
  transaction: Prisma.TransactionClient,
  investigation: ReviewInvestigation,
): Promise<void> {
  const key = JSON.stringify([
    investigation.scope.workspaceId,
    investigation.scope.repositoryConnectionId,
    investigation.scope.scmRepositoryIdentityId,
    investigation.scope.pullRequestNumber,
  ]);
  await transaction.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
  );
}

async function investigationDatabaseNow(
  transaction: Prisma.TransactionClient,
): Promise<Date> {
  const [row] = await transaction.$queryRaw<Array<{ epochMs: bigint }>>(
    Prisma.sql`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS "epochMs"`,
  );
  if (row === undefined) throw new Error("investigation_database_time_missing");
  const epochMs = Number(row.epochMs);
  if (!Number.isSafeInteger(epochMs)) {
    throw new Error("investigation_database_time_invalid");
  }
  return new Date(epochMs);
}

async function revokeStaleInvestigationLeases(
  transaction: Prisma.TransactionClient,
  investigation: ReviewInvestigation,
): Promise<void> {
  const active = await transaction.reviewInvestigationLease.findMany({
    where: {
      investigationId: investigation.investigationId,
      state: PrismaLeaseState.active,
    },
  });
  const staleLeaseIds = active
    .map(investigationLeaseFromRecord)
    .filter(
      (lease) =>
        !reviewInvestigationLeaseBindingIsCurrent(lease, investigation),
    )
    .map((lease) => lease.leaseId);
  if (staleLeaseIds.length === 0) return;
  await transaction.reviewInvestigationLease.updateMany({
    where: {
      leaseId: { in: staleLeaseIds },
      state: PrismaLeaseState.active,
    },
    data: { state: PrismaLeaseState.revoked },
  });
}

function investigationLeaseFromRecord(
  record: PrismaLeaseRecord,
): ReviewInvestigationLease {
  const lease: ReviewInvestigationLease = Object.freeze({
    leaseId: record.leaseId,
    purpose: fromPrismaLeasePurpose(record.purpose),
    workspaceId: record.workspaceId,
    repositoryConnectionId: record.repositoryConnectionId,
    scmRepositoryIdentityId: record.scmRepositoryIdentityId,
    pullRequestNumber: record.pullRequestNumber,
    authorizationId: record.authorizationId,
    mutationEpoch: record.mutationEpoch,
    executionId: record.executionId,
    workSlotId: record.workSlotId,
    revision: {
      baseSha: record.baseSha,
      mergeBaseSha: record.mergeBaseSha,
      headSha: record.headSha,
      reviewRevisionHash: record.reviewRevisionHash,
    },
    investigationId: record.investigationId,
    investigationVersion: safeNumber(
      record.investigationVersion,
      "investigation_lease_version",
    ),
    turnId: record.turnId,
    turnPurpose: fromPrismaTurnPurpose(record.turnPurpose),
    providerVoteLaneId: record.providerVoteLaneId,
    providerStrategyId: record.providerStrategyId,
    investigationManifestCanonicalJson:
      record.investigationManifestCanonicalJson,
    investigationManifestHash: record.investigationManifestHash,
    attemptId: record.attemptId,
    acquireRequestIdHash: record.acquireRequestIdHash,
    acquireRequestHash: record.acquireRequestHash,
    lastRenewRequestIdHash: record.lastRenewRequestIdHash,
    lastRenewRequestHash: record.lastRenewRequestHash,
    lastReleaseRequestIdHash: record.lastReleaseRequestIdHash,
    lastReleaseRequestHash: record.lastReleaseRequestHash,
    ownerIdHash: record.ownerIdHash,
    leaseCapabilityId: record.leaseCapabilityId,
    capabilitySigningKeyId: record.capabilitySigningKeyId,
    fencingToken: record.fencingToken,
    state: fromPrismaLeaseState(record.state),
    acquiredAt: record.acquiredAt.toISOString(),
    renewedAt: record.renewedAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
    resultReportUntil: record.resultReportUntil.toISOString(),
    retainUntil: record.retainUntil.toISOString(),
  });
  assertReviewInvestigationLease(lease);
  return lease;
}

function toInvestigationLeaseCreate(
  lease: Omit<CreateReviewInvestigationLeaseInput, "fencingToken">,
) {
  return {
    leaseId: lease.leaseId,
    purpose: PrismaLeasePurpose.shadow_turn,
    workspaceId: lease.workspaceId,
    repositoryConnectionId: lease.repositoryConnectionId,
    scmRepositoryIdentityId: lease.scmRepositoryIdentityId,
    pullRequestNumber: lease.pullRequestNumber,
    authorizationId: lease.authorizationId,
    mutationEpoch: lease.mutationEpoch,
    executionId: lease.executionId,
    workSlotId: lease.workSlotId,
    baseSha: lease.revision.baseSha,
    mergeBaseSha: lease.revision.mergeBaseSha,
    headSha: lease.revision.headSha,
    reviewRevisionHash: lease.revision.reviewRevisionHash,
    investigationId: lease.investigationId,
    investigationVersion: BigInt(lease.investigationVersion),
    turnId: lease.turnId,
    turnPurpose: toPrismaTurnPurpose(lease.turnPurpose),
    providerVoteLaneId: lease.providerVoteLaneId,
    providerStrategyId: lease.providerStrategyId,
    investigationManifestCanonicalJson:
      lease.investigationManifestCanonicalJson,
    investigationManifestHash: lease.investigationManifestHash,
    attemptId: lease.attemptId,
    acquireRequestIdHash: lease.acquireRequestIdHash,
    acquireRequestHash: lease.acquireRequestHash,
    ownerIdHash: lease.ownerIdHash,
    leaseCapabilityId: lease.leaseCapabilityId,
    capabilitySigningKeyId: lease.capabilitySigningKeyId,
    acquiredAt: new Date(lease.acquiredAt),
    renewedAt: new Date(lease.acquiredAt),
    expiresAt: new Date(lease.expiresAt),
    resultReportUntil: new Date(lease.resultReportUntil),
    retainUntil: new Date(lease.retainUntil),
  };
}

function toInvestigationLeaseTransitionUpdate(lease: ReviewInvestigationLease) {
  return {
    state: toPrismaLeaseState(lease.state),
    lastRenewRequestIdHash: lease.lastRenewRequestIdHash,
    lastRenewRequestHash: lease.lastRenewRequestHash,
    lastReleaseRequestIdHash: lease.lastReleaseRequestIdHash,
    lastReleaseRequestHash: lease.lastReleaseRequestHash,
    renewedAt: new Date(lease.renewedAt),
    expiresAt: new Date(lease.expiresAt),
  };
}

function investigationLeaseAcquireResult(
  status: InvestigationLeaseAcquireStatus,
  lease: ReviewInvestigationLease | null,
): InvestigationLeaseAcquireResult {
  return Object.freeze({ status, lease });
}

const runtimeProfileToPrisma: Readonly<
  Record<ReviewInvestigationRuntimeProfile, PrismaRuntimeProfile>
> = {
  [ReviewInvestigationRuntimeProfile.GatewayAttestedAgentV1]:
    PrismaRuntimeProfile.gateway_attested_agent_v1,
  [ReviewInvestigationRuntimeProfile.OrchestratedToolLoopV1]:
    PrismaRuntimeProfile.orchestrated_tool_loop_v1,
  [ReviewInvestigationRuntimeProfile.PreassembledContextV1]:
    PrismaRuntimeProfile.preassembled_context_v1,
  [ReviewInvestigationRuntimeProfile.PromptOnlyV1]:
    PrismaRuntimeProfile.prompt_only_v1,
  [ReviewInvestigationRuntimeProfile.AgenticUnboundedV1]:
    PrismaRuntimeProfile.agentic_unbounded_v1,
};
const investigationStateToPrisma: Readonly<
  Record<ReviewInvestigationState, PrismaInvestigationState>
> = {
  [ReviewInvestigationState.Provisional]: PrismaInvestigationState.provisional,
  [ReviewInvestigationState.AwaitingTurn]:
    PrismaInvestigationState.awaiting_turn,
  [ReviewInvestigationState.TurnLeased]: PrismaInvestigationState.turn_leased,
  [ReviewInvestigationState.AwaitingCritic]:
    PrismaInvestigationState.awaiting_critic,
  [ReviewInvestigationState.ReadyToConclude]:
    PrismaInvestigationState.ready_to_conclude,
  [ReviewInvestigationState.Concluded]: PrismaInvestigationState.concluded,
  [ReviewInvestigationState.Inconclusive]:
    PrismaInvestigationState.inconclusive,
  [ReviewInvestigationState.Superseded]: PrismaInvestigationState.superseded,
  [ReviewInvestigationState.Expired]: PrismaInvestigationState.expired,
};
const obligationStateToPrisma: Readonly<
  Record<InvestigationObligationState, PrismaObligationState>
> = {
  [InvestigationObligationState.Open]: PrismaObligationState.open,
  [InvestigationObligationState.Satisfied]: PrismaObligationState.satisfied,
  [InvestigationObligationState.Unresolvable]:
    PrismaObligationState.unresolvable,
};
const obligationKindToPrisma: Readonly<
  Record<InvestigationObligationKind, PrismaObligationKind>
> = {
  [InvestigationObligationKind.InventoryWitness]:
    PrismaObligationKind.inventory_witness,
  [InvestigationObligationKind.ChangedContent]:
    PrismaObligationKind.changed_content,
  [InvestigationObligationKind.BaseContent]: PrismaObligationKind.base_content,
  [InvestigationObligationKind.RelatedManifest]:
    PrismaObligationKind.related_manifest,
  [InvestigationObligationKind.DirectReferenceSearch]:
    PrismaObligationKind.direct_reference_search,
  [InvestigationObligationKind.DirectCaller]:
    PrismaObligationKind.direct_caller,
  [InvestigationObligationKind.DirectCallee]:
    PrismaObligationKind.direct_callee,
  [InvestigationObligationKind.TestEvidence]:
    PrismaObligationKind.test_evidence,
  [InvestigationObligationKind.SchemaContract]:
    PrismaObligationKind.schema_contract,
  [InvestigationObligationKind.ConfigurationContract]:
    PrismaObligationKind.configuration_contract,
  [InvestigationObligationKind.MigrationContract]:
    PrismaObligationKind.migration_contract,
  [InvestigationObligationKind.GeneratedSource]:
    PrismaObligationKind.generated_source,
  [InvestigationObligationKind.DependencyContract]:
    PrismaObligationKind.dependency_contract,
  [InvestigationObligationKind.SideEffectParity]:
    PrismaObligationKind.side_effect_parity,
  [InvestigationObligationKind.ExternalContract]:
    PrismaObligationKind.external_contract,
  [InvestigationObligationKind.BinaryArtifact]:
    PrismaObligationKind.binary_artifact,
  [InvestigationObligationKind.FindingRevalidation]:
    PrismaObligationKind.finding_revalidation,
  [InvestigationObligationKind.ContextCritic]:
    PrismaObligationKind.context_critic,
};
const obligationOriginToPrisma: Readonly<
  Record<InvestigationObligationOrigin, PrismaObligationOrigin>
> = {
  [InvestigationObligationOrigin.CoverageContract]:
    PrismaObligationOrigin.coverage_contract,
  [InvestigationObligationOrigin.DeterministicExpansion]:
    PrismaObligationOrigin.deterministic_expansion,
  [InvestigationObligationOrigin.AgentProposal]:
    PrismaObligationOrigin.agent_proposal,
  [InvestigationObligationOrigin.CriticProposal]:
    PrismaObligationOrigin.critic_proposal,
};
const receiptKindToPrisma: Readonly<
  Record<InvestigationReceiptKind, PrismaReceiptKind>
> = {
  [InvestigationReceiptKind.Blob]: PrismaReceiptKind.blob,
  [InvestigationReceiptKind.Tree]: PrismaReceiptKind.tree,
  [InvestigationReceiptKind.Search]: PrismaReceiptKind.search,
  [InvestigationReceiptKind.GitFact]: PrismaReceiptKind.git_fact,
  [InvestigationReceiptKind.Relation]: PrismaReceiptKind.relation,
  [InvestigationReceiptKind.Critic]: PrismaReceiptKind.critic,
};
const turnPurposeToPrisma: Readonly<
  Record<ReviewInvestigationTurnPurpose, PrismaTurnPurpose>
> = {
  [ReviewInvestigationTurnPurpose.Discovery]: PrismaTurnPurpose.discovery,
  [ReviewInvestigationTurnPurpose.Critic]: PrismaTurnPurpose.critic,
};
const leasePurposeToPrisma: Readonly<
  Record<ReviewInvestigationLeasePurpose, PrismaLeasePurpose>
> = {
  [ReviewInvestigationLeasePurpose.ShadowTurn]: PrismaLeasePurpose.shadow_turn,
};
const leaseStateToPrisma: Readonly<
  Record<ReviewInvestigationLeaseState, PrismaLeaseState>
> = {
  [ReviewInvestigationLeaseState.Active]: PrismaLeaseState.active,
  [ReviewInvestigationLeaseState.Released]: PrismaLeaseState.released,
  [ReviewInvestigationLeaseState.Expired]: PrismaLeaseState.expired,
  [ReviewInvestigationLeaseState.Revoked]: PrismaLeaseState.revoked,
};
const criticDecisionToPrisma: Readonly<
  Record<ContextCriticDecision, PrismaCriticDecision>
> = {
  [ContextCriticDecision.Accept]: PrismaCriticDecision.accept,
  [ContextCriticDecision.Veto]: PrismaCriticDecision.veto,
  [ContextCriticDecision.Abstain]: PrismaCriticDecision.abstain,
};
const conclusionToPrisma: Readonly<
  Record<ReviewInvestigationConclusion, PrismaConclusion>
> = {
  [ReviewInvestigationConclusion.VerifiedClean]:
    PrismaConclusion.verified_clean,
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
const leasePurposeFromPrisma = invertEnumMap(leasePurposeToPrisma);
const leaseStateFromPrisma = invertEnumMap(leaseStateToPrisma);
const criticDecisionFromPrisma = invertEnumMap(criticDecisionToPrisma);
const conclusionFromPrisma = invertEnumMap(conclusionToPrisma);

const toPrismaRuntimeProfile = (value: ReviewInvestigationRuntimeProfile) =>
  runtimeProfileToPrisma[value];
const fromPrismaRuntimeProfile = (value: PrismaRuntimeProfile) =>
  runtimeProfileFromPrisma[value];
const toPrismaInvestigationState = (value: ReviewInvestigationState) =>
  investigationStateToPrisma[value];
const fromPrismaInvestigationState = (value: PrismaInvestigationState) =>
  investigationStateFromPrisma[value];
const toPrismaObligationState = (value: InvestigationObligationState) =>
  obligationStateToPrisma[value];
const fromPrismaObligationState = (value: PrismaObligationState) =>
  obligationStateFromPrisma[value];
const toPrismaObligationKind = (value: InvestigationObligationKind) =>
  obligationKindToPrisma[value];
const fromPrismaObligationKind = (value: PrismaObligationKind) =>
  obligationKindFromPrisma[value];
const toPrismaObligationOrigin = (value: InvestigationObligationOrigin) =>
  obligationOriginToPrisma[value];
const fromPrismaObligationOrigin = (value: PrismaObligationOrigin) =>
  obligationOriginFromPrisma[value];
const toPrismaReceiptKind = (value: InvestigationReceiptKind) =>
  receiptKindToPrisma[value];
const fromPrismaReceiptKind = (value: PrismaReceiptKind) =>
  receiptKindFromPrisma[value];
const toPrismaTurnPurpose = (value: ReviewInvestigationTurnPurpose) =>
  turnPurposeToPrisma[value];
const fromPrismaTurnPurpose = (value: PrismaTurnPurpose) =>
  turnPurposeFromPrisma[value];
const toPrismaLeaseState = (value: ReviewInvestigationLeaseState) =>
  leaseStateToPrisma[value];
const fromPrismaLeaseState = (value: PrismaLeaseState) =>
  leaseStateFromPrisma[value];
const fromPrismaLeasePurpose = (value: PrismaLeasePurpose) =>
  leasePurposeFromPrisma[value];
const toPrismaCriticDecision = (value: ContextCriticDecision) =>
  criticDecisionToPrisma[value];
const fromPrismaCriticDecision = (value: PrismaCriticDecision) =>
  criticDecisionFromPrisma[value];
const toPrismaConclusion = (value: ReviewInvestigationConclusion) =>
  conclusionToPrisma[value];
const fromPrismaConclusion = (value: PrismaConclusion) =>
  conclusionFromPrisma[value];

function parseTerminalProviderKind(
  value: string,
): InvestigationTurnProviderKind {
  if (
    value === InvestigationTurnProviderKind.Codex ||
    value === InvestigationTurnProviderKind.ClaudeCode
  ) {
    return value;
  }
  throw new Error("investigation_terminal_provider_kind_invalid");
}

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
