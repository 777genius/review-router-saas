import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  allocateVersionedProviderSecretNamespace,
  createVersionedProviderSecretNamespace,
  fingerprintDatabaseRecoveryWitness,
} from "@reviewrouter/features-codex-oauth-rotating";
import type {
  PrepareZeroLoginRolloverInput,
  ZeroLoginRolloverLedgerPort,
  ZeroLoginRolloverRecord,
  ZeroLoginConfirmedSetupCandidateActivatorPort,
} from "../../application/ports/codex-zero-login-rollover-port.js";
import type { CodexRotatingVersionedWritebackLedgerPort } from "../../application/ports/codex-rotating-oauth-repository-port.js";

export class PrismaCodexZeroLoginRolloverLedger
  implements ZeroLoginRolloverLedgerPort
{
  constructor(
    private readonly prisma: PrismaClient,
    private readonly runtimeWritebacks: CodexRotatingVersionedWritebackLedgerPort,
    private readonly options: {
      actionOwnerRepo: string;
      databaseRecoveryWitness: string;
      existingSetupCandidateActivator?: ZeroLoginConfirmedSetupCandidateActivatorPort;
    },
  ) {}

  async prepare(input: PrepareZeroLoginRolloverInput) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(1381126735, 1515015247)
      `);
      const existing = await tx.codexOAuthNamespaceRolloverIntent.findUnique({
        where: { operationId: input.operationId },
        include: { candidateNamespace: true },
      });
      if (existing) {
        if (
          existing.repositoryFullName !== input.repositoryFullName ||
          existing.providerInstanceId !== input.providerInstanceId ||
          existing.sourceRunId !== input.schedule.runId ||
          existing.sourceRunAttempt !== input.schedule.runAttempt ||
          existing.expectedRerunAttempt !== input.expectedRerunAttempt ||
          existing.sourceActionCommitSha !== input.schedule.workflowActionCommitSha ||
          existing.sourceWorkflowCommitSha !== input.schedule.workflowSourceCommitSha ||
          existing.sourceDefaultHeadSha !== input.schedule.sourceDefaultHeadSha ||
          existing.targetActionCommitSha !== input.release.actionCommitSha ||
          existing.releaseEvidenceDigest !== sha256(input.release) ||
          (input.expectedCandidateEpoch !== undefined &&
            existing.candidateNamespaceEpoch !== input.expectedCandidateEpoch) ||
          (input.expectedCandidateName !== undefined &&
            existing.candidateNamespace.secretName !== input.expectedCandidateName)
        ) throw new Error("zero_login_rollover_prepare_idempotency_conflict");
        return toRecord(existing, this.options.actionOwnerRepo);
      }
      const provider = await tx.codexOAuthProviderInstance.findFirst({
        where: {
          providerInstanceId: input.providerInstanceId,
          repository: { fullName: input.repositoryFullName },
        },
        include: {
          repository: { include: { installation: true } },
          activeSecretNamespace: true,
        },
      });
      if (!provider?.repository.githubRepositoryId) {
        throw new Error("zero_login_rollover_provider_not_found");
      }
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "CodexOAuthProviderInstance"
        WHERE "id"=${provider.id} FOR UPDATE
      `);
      const preexistingExactLease = await tx.codexOAuthLease.findFirst({
        where: {
          providerInstanceRowId: provider.id,
          githubRunId: input.schedule.runId,
          githubRunAttempt: input.expectedRerunAttempt,
        },
        select: { id: true },
      });
      if (preexistingExactLease) {
        throw new Error("zero_login_rollover_exact_rerun_already_exists");
      }
      const reusableCandidate = await tx.codexOAuthSecretNamespace.findFirst({
        where: {
          providerInstanceRowId: provider.id,
          status: "confirmed_candidate",
          permanentlyRetired: false,
        },
        orderBy: { namespaceEpoch: "asc" },
      });
      const namespaceEpochs = await tx.codexOAuthSecretNamespace.aggregate({
        where: { providerInstanceRowId: provider.id },
        _max: { namespaceEpoch: true },
      });
      const candidateEpoch = selectZeroLoginRolloverCandidateEpoch({
        reusableConfirmedEpoch: reusableCandidate?.namespaceEpoch ?? null,
        maxNamespaceEpoch: namespaceEpochs._max.namespaceEpoch,
      });
      if (
        input.expectedCandidateEpoch !== undefined &&
        input.expectedCandidateEpoch !== candidateEpoch
      ) {
        throw new Error("zero_login_rollover_candidate_epoch_mismatch");
      }
      let candidate = reusableCandidate ?? await tx.codexOAuthSecretNamespace.findUnique({
        where: {
          providerInstanceRowId_namespaceEpoch: {
            providerInstanceRowId: provider.id,
            namespaceEpoch: candidateEpoch,
          },
        },
      });
      if (candidate?.permanentlyRetired) {
        throw new Error("zero_login_rollover_candidate_retired");
      }
      if (candidate?.status === "dispatch_authorized") {
        throw new Error("zero_login_rollover_candidate_in_flight");
      }
      if (candidate && candidate.status !== "confirmed_candidate") {
        throw new Error("zero_login_rollover_candidate_state_invalid");
      }
      if (candidate?.status === "confirmed_candidate") {
        const proof = await tx.codexOAuthSetupDispatchAttempt.findFirst({
          where: {
            namespaceId: candidate.id,
            status: "confirmed",
            claim: {
              providerInstanceRowId: provider.id,
              status: "confirmed_candidate",
              confirmedAttemptId: { not: null },
            },
          },
          include: { claim: true },
        });
        if (
          !proof ||
          proof.claim.confirmedAttemptId !== proof.id ||
          proof.claim.accountIdentityAlgorithm !==
            "provider_issuer_subject_account_v1" ||
          !provider.activeAccountIdentityHash ||
          proof.claim.accountIdentityHash !== provider.activeAccountIdentityHash ||
          proof.claim.generationHash !== provider.latestGenerationHash ||
          proof.claim.databaseRecoveryWitness !== candidate.databaseRecoveryWitness ||
          provider.mutationOwner !== "setup" ||
          provider.mutationOwnerId !== proof.claim.manifestId
        ) {
          throw new Error("zero_login_rollover_confirmed_candidate_unproven");
        }
      }
      if (!candidate) {
        if (!provider.activeSecretNamespaceId || !provider.activeSecretNamespace) {
          throw new Error("zero_login_rollover_active_namespace_missing");
        }
        const admission = await tx.$queryRaw<Array<{ admitted: boolean }>>(Prisma.sql`
          SELECT (
            provider."state"='active'
            AND provider."mutationOwner" IS NULL
            AND provider."mutationOwnerId" IS NULL
            AND provider."activeLeaseId" IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM "CodexOAuthLease" lease
              WHERE lease."providerInstanceRowId"=provider."id"
                AND lease."status" IN ('preleased','finalized')
                AND lease."expiresAt">clock_timestamp()
            )
            AND NOT EXISTS (
              SELECT 1 FROM "CodexOAuthWritebackIntent" intent
              WHERE intent."providerInstanceRowId"=provider."id"
                AND (intent."status"='pending' OR (
                  intent."status"='remote_outcome_unknown'
                  AND intent."recoveryResolvedAt" IS NULL
                ))
            )
            AND NOT EXISTS (
              SELECT 1 FROM "CodexOAuthSetupManifest" manifest
              WHERE manifest."providerInstanceRowId"=provider."id"
                AND manifest."status" IN ('issued','fetched')
            )
            AND NOT EXISTS (
              SELECT 1 FROM "CodexOAuthSetupRecoveryRequest" recovery
              WHERE recovery."providerInstanceRowId"=provider."id"
                AND recovery."state"='active'
            )
          ) AS admitted
          FROM "CodexOAuthProviderInstance" provider
          WHERE provider."id"=${provider.id}
        `);
        if (admission[0]?.admitted !== true) {
          throw new Error("zero_login_rollover_provider_not_exclusive");
        }
        const allocated = allocateVersionedProviderSecretNamespace({
          scope: {
            repositoryId: provider.repository.githubRepositoryId!.toString(),
            providerInstanceId: provider.providerInstanceId,
          },
          epoch: candidateEpoch,
        });
        if (
          input.expectedCandidateName !== undefined &&
          input.expectedCandidateName !== allocated.name
        ) {
          throw new Error("zero_login_rollover_candidate_name_mismatch");
        }
        await tx.codexOAuthProviderInstance.update({
          where: { id: provider.id },
          data: {
            mutationEpoch: { increment: 1 },
            mutationOwner: "runtime",
            mutationOwnerId: input.operationId,
          },
        });
        candidate = await tx.codexOAuthSecretNamespace.create({
          data: {
            id: allocated.namespaceId,
            providerInstanceRowId: provider.id,
            githubRepositoryId: provider.repository.githubRepositoryId!.toString(),
            namespaceEpoch: allocated.epoch,
            secretName: allocated.name,
            databaseRecoveryWitness: fingerprintDatabaseRecoveryWitness(
              this.options.databaseRecoveryWitness,
            ),
            status: "dispatch_authorized",
          },
        });
      } else if (
        input.expectedCandidateName !== undefined &&
        input.expectedCandidateName !== candidate.secretName
      ) {
        throw new Error("zero_login_rollover_candidate_name_mismatch");
      }
      const row = await tx.codexOAuthNamespaceRolloverIntent.create({
        data: {
          id: `zlr_${randomUUID()}`,
          operationId: input.operationId,
          activeGlobalSlot: 1,
          workspaceId: provider.workspaceId,
          repositoryId: provider.repositoryId,
          providerInstanceRowId: provider.id,
          providerInstanceId: provider.providerInstanceId,
          githubRepositoryId: provider.repository.githubRepositoryId!.toString(),
          repositoryFullName: provider.repository.fullName,
          state:
            candidate.status === "confirmed_candidate"
              ? "provider_confirmed"
              : "prepared",
          sourceRunId: input.schedule.runId,
          sourceRunAttempt: input.schedule.runAttempt,
          expectedRerunAttempt: input.expectedRerunAttempt,
          sourceActionCommitSha: input.schedule.workflowActionCommitSha,
          sourceWorkflowCommitSha: input.schedule.workflowSourceCommitSha,
          sourceDefaultHeadSha: input.schedule.sourceDefaultHeadSha,
          sourceActiveNamespaceId: provider.activeSecretNamespaceId,
          verifiedScheduleCompletedAt: new Date(input.schedule.completedAt),
          releaseEvidenceId: input.release.evidenceId,
          releaseEvidenceDigest: sha256(input.release),
          targetActionCommitSha: input.release.actionCommitSha,
          targetWorkflowSchemaVersion: 5,
          renderOverlapEvidenceJson: input.release as never,
          candidateNamespaceId: candidate.id,
          candidateNamespaceEpoch: candidate.namespaceEpoch,
        },
        include: { candidateNamespace: true },
      });
      return toRecord(row, this.options.actionOwnerRepo);
    });
  }

  async status(operationId: string) {
    const row = await this.reconcileOperation(operationId);
    return row ? toRecord(row, this.options.actionOwnerRepo) : null;
  }

  async loadSetupPullRequestPlan(operationId: string) {
    await this.reconcileOperation(operationId);
    const row = await this.prisma.codexOAuthNamespaceRolloverIntent.findUniqueOrThrow({
      where: { operationId },
      include: {
        candidateNamespace: true,
        repository: { include: { installation: true } },
      },
    });
    if (row.state !== "provider_confirmed" && row.state !== "setup_pr_open") {
      throw new Error("zero_login_rollover_setup_pr_not_ready");
    }
    return {
      intentId: row.id,
      repository: toRepository(row.repository),
      providerInstanceId: row.providerInstanceId,
      candidate: createVersionedProviderSecretNamespace({
        scope: {
          repositoryId: row.githubRepositoryId,
          providerInstanceId: row.providerInstanceId,
        },
        namespaceId: row.candidateNamespaceId,
        name: row.candidateNamespace.secretName,
        epoch: row.candidateNamespaceEpoch,
      }),
      targetActionRef: `${this.options.actionOwnerRepo}@${row.targetActionCommitSha}`,
      targetWorkflowSchemaVersion: 5 as const,
      sourceActionRef: `${this.options.actionOwnerRepo}@${row.sourceActionCommitSha}`,
      expectedBaseSha: row.sourceDefaultHeadSha,
      ...(row.sourceActiveNamespaceId
        ? { sourceActiveNamespaceId: row.sourceActiveNamespaceId }
        : {}),
    };
  }

  async abort(input: { operationId: string; reason: string }) {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.codexOAuthNamespaceRolloverIntent.findUniqueOrThrow({
        where: { operationId: input.operationId },
        include: { candidateNamespace: true },
      });
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "CodexOAuthProviderInstance"
        WHERE "id"=${current.providerInstanceRowId} FOR UPDATE
      `);
      if (current.state !== "prepared") {
        throw new Error("zero_login_rollover_abort_after_dispatch_forbidden");
      }
      if (current.candidateNamespace.status === "dispatch_authorized") {
        await tx.codexOAuthSecretNamespace.update({
          where: { id: current.candidateNamespaceId },
          data: {
            status: "retired_predispatch",
            permanentlyRetired: true,
            retiredAt: new Date(),
          },
        });
      }
      await tx.codexOAuthProviderInstance.updateMany({
        where: {
          id: current.providerInstanceRowId,
          mutationOwner: "runtime",
          mutationOwnerId: current.operationId,
        },
        data: { mutationOwner: null, mutationOwnerId: null, mutationEpoch: { increment: 1 } },
      });
      const row = await tx.codexOAuthNamespaceRolloverIntent.update({
        where: { id: current.id },
        data: {
          state: "aborted",
          activeGlobalSlot: null,
          abortedAt: new Date(),
          safeErrorCode: `operator_abort:${sha256(input.reason).slice(0, 16)}`,
        },
        include: { candidateNamespace: true },
      });
      return toRecord(row, this.options.actionOwnerRepo);
    });
  }

  async claimWriteback(input: Parameters<ZeroLoginRolloverLedgerPort["claimWriteback"]>[0]) {
    return this.prisma.$transaction(async (tx) => {
      const lease = await tx.codexOAuthLease.findUnique({
        where: { id: input.request.leaseId },
        include: {
          providerInstance: {
            include: {
              repository: { include: { installation: true } },
              activeSecretNamespace: true,
            },
          },
        },
      });
      if (!lease) return { status: "no_match" as const };
      const lockedClock = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`
        SELECT clock_timestamp() AS "now" FROM "CodexOAuthProviderInstance"
        WHERE "id"=${lease.providerInstanceRowId} FOR UPDATE
      `);
      const foundRollover = await tx.codexOAuthNamespaceRolloverIntent.findFirst({
        where: {
          providerInstanceRowId: lease.providerInstanceRowId,
          sourceRunId: lease.githubRunId,
          expectedRerunAttempt: lease.githubRunAttempt,
        },
        include: { candidateNamespace: true },
      });
      if (!foundRollover) return { status: "no_match" as const };
      let rollover: NonNullable<typeof foundRollover> = await this.reconcileRow(
        tx,
        foundRollover,
      );
      if (
        rollover.sourceRunId !== lease.githubRunId ||
        rollover.expectedRerunAttempt !== lease.githubRunAttempt ||
        rollover.providerInstanceId !== input.request.providerInstanceId
      ) return { status: "writeback_recovery_required" as const };
      if (rollover.state === "setup_pr_open" || rollover.state === "activated") {
        return {
          status: "idempotent_replay" as const,
          generation: rollover.writebackGeneration!,
        };
      }
      if (
        rollover.state === "provider_outcome_unknown" ||
        rollover.state === "aborted"
      ) {
        return { status: "writeback_recovery_required" as const };
      }
      if (rollover.state === "prepared" || rollover.state === "put_authorized") {
        const now = lockedClock[0]?.now;
        const provider = lease.providerInstance;
        const activeNamespace = provider.activeSecretNamespace;
        if (
          !now ||
          input.request.leaseId !== lease.id ||
          input.request.providerInstanceId !== provider.providerInstanceId ||
          provider.activeLeaseId !== lease.id ||
          !provider.activeLeaseExpiresAt ||
          provider.activeLeaseExpiresAt <= now ||
          provider.mutationOwner !== "runtime" ||
          provider.mutationOwnerId !== lease.id ||
          lease.mutationEpoch === null ||
          provider.mutationEpoch !== lease.mutationEpoch ||
          lease.status !== "finalized" ||
          lease.expiresAt <= now ||
          lease.nextGeneration !== input.request.generation ||
          lease.writebackPreflightKeyId !== input.request.keyId ||
          lease.secretNamespaceId !== rollover.sourceActiveNamespaceId ||
          provider.activeSecretNamespaceId !== rollover.sourceActiveNamespaceId ||
          activeNamespace?.id !== rollover.sourceActiveNamespaceId ||
          activeNamespace.status !== "active" ||
          activeNamespace.databaseRecoveryWitness !==
            fingerprintDatabaseRecoveryWitness(this.options.databaseRecoveryWitness) ||
          provider.activeAccountIdentityHash !== input.request.accountIdentityHash ||
          input.request.accountIdentityAlgorithm !==
            "provider_issuer_subject_account_v1"
        ) {
          return { status: "writeback_recovery_required" as const };
        }
        const conflictingIntent = await tx.codexOAuthWritebackIntent.findFirst({
          where: {
            OR: [
              { leaseId: lease.id },
              {
                providerInstanceId: input.request.providerInstanceId,
                idempotencyKey: input.request.idempotencyKey,
              },
            ],
            id: { not: rollover.id },
          },
          select: { id: true },
        });
        if (conflictingIntent) {
          return { status: "writeback_recovery_required" as const };
        }
      }
      const repository = lease.providerInstance.repository;
      const candidate = createVersionedProviderSecretNamespace({
        scope: {
          repositoryId: rollover.githubRepositoryId,
          providerInstanceId: rollover.providerInstanceId,
        },
        namespaceId: rollover.candidateNamespace.id,
        name: rollover.candidateNamespace.secretName,
        epoch: rollover.candidateNamespace.namespaceEpoch,
      });
      const baseClaim = {
        intentId: rollover.id,
        executorOwner: rollover.executorOwner ?? `zle_${randomUUID()}`,
        repository: toRepository(repository),
        writeTarget: {
          expectedProviderInstanceId: rollover.providerInstanceId,
          githubInstallationId: repository.installation!.githubInstallationId.toString(),
          githubRepositoryId: rollover.githubRepositoryId,
          repositoryFullName: repository.fullName,
          owner: repository.owner,
          repo: repository.name,
          secretName: candidate.name,
        },
        candidate,
        targetActionRef: `${this.options.actionOwnerRepo}@${rollover.targetActionCommitSha}`,
        targetWorkflowSchemaVersion: 5 as const,
        sourceActionRef: `${this.options.actionOwnerRepo}@${rollover.sourceActionCommitSha}`,
        expectedBaseSha: rollover.sourceDefaultHeadSha,
        sourceActiveNamespaceId: lease.providerInstance.activeSecretNamespaceId!,
      };
      if (rollover.state === "provider_confirmed") {
        return { status: "ready_publish" as const, ...baseClaim };
      }
      if (rollover.state === "put_authorized") {
        const standardIntent = await tx.codexOAuthWritebackIntent.findUnique({
          where: { id: rollover.id },
        });
        if (
          !standardIntent ||
          rollover.encryptedPayloadDigest !== input.encryptedPayloadDigest ||
          rollover.writebackIdempotencyKey !== input.request.idempotencyKey ||
          standardIntent.leaseId !== input.request.leaseId ||
          standardIntent.generation !== input.request.generation ||
          standardIntent.latestGenerationHash !== input.request.latestGenerationHash ||
          standardIntent.keyId !== input.request.keyId ||
          standardIntent.accountIdentityHash !== input.request.accountIdentityHash ||
          standardIntent.accountIdentityAlgorithm !== input.request.accountIdentityAlgorithm ||
          standardIntent.encryptedPayloadDigest !== input.encryptedPayloadDigest
        ) return { status: "writeback_recovery_required" as const };
        if (rollover.executorLeaseExpiresAt! > new Date()) {
          return { status: "in_progress" as const, retryAfter: rollover.executorLeaseExpiresAt! };
        }
        return { status: "writeback_recovery_required" as const };
      }
      if (rollover.state !== "prepared" || lease.status !== "finalized") {
        return { status: "writeback_recovery_required" as const };
      }
      const executorLeaseExpiresAt = new Date(
        Math.min(lease.expiresAt.getTime(), Date.now() + 5 * 60_000),
      );
      const databaseIncarnation = await readDatabaseIncarnation(tx);
      await tx.codexOAuthWritebackIntent.create({
        data: {
          id: rollover.id,
          providerInstanceRowId: lease.providerInstanceRowId,
          leaseId: lease.id,
          providerInstanceId: rollover.providerInstanceId,
          idempotencyKey: input.request.idempotencyKey,
          generation: input.request.generation,
          latestGenerationHash: input.request.latestGenerationHash,
          encryptedPayloadDigest: input.encryptedPayloadDigest,
          keyId: input.request.keyId,
          status: "pending",
          mutationEpoch: lease.mutationEpoch,
          dispatchAttemptId: rollover.id,
          dispatchAuthorizedAt: new Date(),
          secretNamespaceId: candidate.namespaceId,
          databaseIncarnation,
          databaseRecoveryWitness: fingerprintDatabaseRecoveryWitness(
            this.options.databaseRecoveryWitness,
          ),
          accountIdentityHash: input.request.accountIdentityHash,
          accountIdentityAlgorithm: input.request.accountIdentityAlgorithm,
          executorOwner: baseClaim.executorOwner,
          executorLeaseExpiresAt,
        },
      });
      await tx.codexOAuthNamespaceRolloverIntent.update({
        where: { id: rollover.id },
        data: {
          state: "put_authorized",
          encryptedPayloadDigest: input.encryptedPayloadDigest,
          writebackIdempotencyKey: input.request.idempotencyKey,
          writebackGeneration: input.request.generation,
          writebackGenerationHash: input.request.latestGenerationHash,
          writebackAccountIdentityHash: input.request.accountIdentityHash,
          executorOwner: baseClaim.executorOwner,
          executorLeaseExpiresAt,
        },
      });
      return { status: "ready_put" as const, ...baseClaim };
    });
  }

  async confirmProviderWrite(input: Parameters<ZeroLoginRolloverLedgerPort["confirmProviderWrite"]>[0]) {
    await this.runtimeWritebacks.confirmVersionedProviderWrite({
      ...input,
      attemptId: input.intentId,
    });
    await this.prisma.$transaction(async (tx) => {
      const rollover = await tx.codexOAuthNamespaceRolloverIntent.findUniqueOrThrow({
        where: { id: input.intentId },
      });
      const confirmedIntent = await tx.codexOAuthWritebackIntent.findUniqueOrThrow({
        where: { id: input.intentId },
        select: { providerResponseCode: true, providerConfirmedAt: true },
      });
      if (
        confirmedIntent.providerResponseCode !== input.statusCode ||
        confirmedIntent.providerConfirmedAt === null
      ) {
        throw new Error("zero_login_rollover_provider_confirmation_unproven");
      }
      await tx.codexOAuthNamespaceRolloverIntent.update({
        where: { id: input.intentId },
        data: {
          state: "provider_confirmed",
          providerResponseCode: confirmedIntent.providerResponseCode,
          providerConfirmedAt: confirmedIntent.providerConfirmedAt,
        },
      });
      await tx.codexOAuthProviderInstance.update({
        where: { id: rollover.providerInstanceRowId },
        data: {
          state: "workflow_update_required",
        },
      });
    });
  }

  async retirePreDispatch(input: Parameters<ZeroLoginRolloverLedgerPort["retirePreDispatch"]>[0]) {
    const row = await this.prisma.codexOAuthNamespaceRolloverIntent.findUniqueOrThrow({ where: { id: input.intentId } });
    await this.runtimeWritebacks.retirePreDispatchVersionedWriteback({
      ...input,
      attemptId: input.intentId,
      safeErrorCode: "zero_login_rollover_pre_dispatch_failed_v1",
    });
    await this.prisma.codexOAuthNamespaceRolloverIntent.update({
      where: { id: input.intentId },
      data: { state: "aborted", activeGlobalSlot: null, abortedAt: new Date(), safeErrorCode: "zero_login_rollover_pre_dispatch_failed_v1" },
    });
    void row;
  }

  async retireAmbiguous(input: Parameters<ZeroLoginRolloverLedgerPort["retireAmbiguous"]>[0]) {
    const row = await this.prisma.codexOAuthNamespaceRolloverIntent.findUniqueOrThrow({
      where: { id: input.intentId }, include: { candidateNamespace: true },
    });
    await this.runtimeWritebacks.retireAmbiguousVersionedWriteback({
      ...input,
      attemptId: input.intentId,
      safeErrorCode: "zero_login_rollover_provider_outcome_unknown_v1",
      retirementIdentity: {
        providerInstanceId: row.providerInstanceId,
        mutationOwner: "runtime",
        mutationOwnerId: (await this.prisma.codexOAuthWritebackIntent.findUniqueOrThrow({ where: { id: row.id } })).leaseId,
        mutationEpoch: (await this.prisma.codexOAuthWritebackIntent.findUniqueOrThrow({ where: { id: row.id } })).mutationEpoch!,
        namespaceId: row.candidateNamespaceId,
        generation: row.writebackGeneration!,
        latestGenerationHash: row.writebackGenerationHash!,
        accountIdentityHash: row.writebackAccountIdentityHash!,
      },
    });
    await this.prisma.codexOAuthNamespaceRolloverIntent.update({
      where: { id: input.intentId },
      data: { state: "provider_outcome_unknown", activeGlobalSlot: null, safeErrorCode: "zero_login_rollover_provider_outcome_unknown_v1" },
    });
  }

  async markSetupPullRequest(input: Parameters<ZeroLoginRolloverLedgerPort["markSetupPullRequest"]>[0]) {
    const existing = await this.prisma.codexOAuthNamespaceRolloverIntent.findUniqueOrThrow({
      where: { id: input.intentId },
    });
    if (existing.state === "setup_pr_open") {
      if (
        existing.setupPullRequestUrl !== input.url ||
        existing.setupPullRequestNumber !== input.number ||
        existing.setupPullRequestHeadSha !== input.headSha ||
        existing.setupPullRequestBaseBranch !== input.baseBranch
      ) throw new Error("zero_login_rollover_setup_pr_idempotency_conflict");
      return { generation: existing.writebackGeneration ?? 1 };
    }
    const row = await this.prisma.codexOAuthNamespaceRolloverIntent.update({
      where: { id: input.intentId },
      data: {
        state: "setup_pr_open",
        setupPullRequestUrl: input.url,
        setupPullRequestNumber: input.number,
        setupPullRequestHeadSha: input.headSha,
        setupPullRequestBaseBranch: input.baseBranch,
        setupPullRequestOpenedAt: new Date(),
      },
    });
    return { generation: row.writebackGeneration ?? 1 };
  }

  async activateAfterAttestation(
    input: Parameters<ZeroLoginRolloverLedgerPort["activateAfterAttestation"]>[0],
  ) {
    const row = await this.prisma.codexOAuthNamespaceRolloverIntent.findUniqueOrThrow({
      where: { operationId: input.operationId },
      include: {
        candidateNamespace: true,
        providerInstance: true,
      },
    });
    if (
      row.candidateNamespaceEpoch !== input.expectedNamespaceEpoch ||
      input.attestation.secretNamespace.namespaceId !== row.candidateNamespaceId ||
      input.attestation.secretNamespace.epoch !== row.candidateNamespaceEpoch
    ) {
      throw new Error("zero_login_rollover_activation_namespace_mismatch");
    }
    if (row.state === "activated") {
      return toRecord(row, this.options.actionOwnerRepo);
    }
    const standardIntent = await this.prisma.codexOAuthWritebackIntent.findUnique({
      where: { id: row.id },
    });
    const alreadyActive =
      row.candidateNamespace.status === "active" &&
      row.providerInstance.activeSecretNamespaceId === row.candidateNamespaceId &&
      (standardIntent?.status === "completed" ||
        (standardIntent === null && row.writebackGeneration === null));
    if (!alreadyActive && standardIntent === null) {
      if (row.state !== "setup_pr_open") {
        throw new Error("zero_login_rollover_activation_state_invalid");
      }
      const proof = await this.prisma.codexOAuthSetupDispatchAttempt.findFirst({
        where: {
          namespaceId: row.candidateNamespaceId,
          status: "confirmed",
          claim: {
            providerInstanceRowId: row.providerInstanceRowId,
            status: "confirmed_candidate",
          },
        },
        include: { claim: true },
      });
      if (!proof || !this.options.existingSetupCandidateActivator) {
        throw new Error("zero_login_rollover_existing_setup_activation_unavailable");
      }
      await this.options.existingSetupCandidateActivator.activateConfirmedCandidate({
        claimId: proof.claimId,
        attemptId: proof.id,
        candidateNamespaceId: row.candidateNamespaceId,
        attestation: input.attestation,
      });
      const promoted = await this.prisma.codexOAuthSecretNamespace.findUniqueOrThrow({
        where: { id: row.candidateNamespaceId },
        include: { activeForProvider: true },
      });
      if (
        promoted.status !== "active" ||
        promoted.activeForProvider?.activeSecretNamespaceId !== row.candidateNamespaceId
      ) {
        throw new Error("zero_login_rollover_existing_setup_activation_unproven");
      }
    } else if (!alreadyActive) {
      if (
        row.state !== "setup_pr_open" ||
        !row.executorOwner ||
        standardIntent?.status !== "pending"
      ) {
        throw new Error("zero_login_rollover_activation_state_invalid");
      }
      await this.runtimeWritebacks.activateVersionedWriteback({
        intentId: row.id,
        attemptId: row.id,
        executorOwner: row.executorOwner,
        attestation: input.attestation,
        rolloverOperationId: input.operationId,
      });
    }
    const reconciled = await this.prisma.codexOAuthNamespaceRolloverIntent.findUniqueOrThrow({
      where: { id: row.id },
      include: { candidateNamespace: true },
    });
    if (reconciled.state === "activated") {
      return toRecord(reconciled, this.options.actionOwnerRepo);
    }
    const activated = await this.prisma.codexOAuthNamespaceRolloverIntent.update({
      where: { id: row.id },
      data: {
        state: "activated",
        activeGlobalSlot: null,
        activatedAt: new Date(),
      },
      include: { candidateNamespace: true },
    });
    return toRecord(activated, this.options.actionOwnerRepo);
  }

  private async reconcileOperation(operationId: string) {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.codexOAuthNamespaceRolloverIntent.findUnique({
        where: { operationId },
        include: { candidateNamespace: true },
      });
      if (!row) return null;
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "CodexOAuthProviderInstance"
        WHERE "id"=${row.providerInstanceRowId} FOR UPDATE
      `);
      return this.reconcileRow(tx, row);
    });
  }

  private async reconcileRow(tx: Prisma.TransactionClient, row: any) {
    if (row.state === "put_authorized") {
      const intent = await tx.codexOAuthWritebackIntent.findUnique({
        where: { id: row.id },
        include: { secretNamespace: true },
      });
      if (
        intent?.status === "pending" &&
        intent.providerResponseCode !== null &&
        (intent.providerResponseCode === 201 || intent.providerResponseCode === 204) &&
        intent.providerConfirmedAt &&
        intent.secretNamespace?.status === "confirmed_candidate"
      ) {
        await tx.codexOAuthProviderInstance.update({
          where: { id: row.providerInstanceRowId },
          data: { state: "workflow_update_required" },
        });
        return tx.codexOAuthNamespaceRolloverIntent.update({
          where: { id: row.id },
          data: {
            state: "provider_confirmed",
            providerResponseCode: intent.providerResponseCode,
            providerConfirmedAt: intent.providerConfirmedAt,
          },
          include: { candidateNamespace: true },
        });
      }
      if (
        intent?.status === "remote_outcome_unknown" &&
        intent.secretNamespace?.status === "retired_ambiguous" &&
        intent.secretNamespace.permanentlyRetired
      ) {
        return tx.codexOAuthNamespaceRolloverIntent.update({
          where: { id: row.id },
          data: {
            state: "provider_outcome_unknown",
            activeGlobalSlot: null,
            safeErrorCode: intent.safeErrorCode ?? "zero_login_rollover_provider_outcome_unknown_v1",
          },
          include: { candidateNamespace: true },
        });
      }
      if (
        intent?.status === "failed" &&
        intent.secretNamespace?.status === "retired_predispatch" &&
        intent.secretNamespace.permanentlyRetired
      ) {
        return tx.codexOAuthNamespaceRolloverIntent.update({
          where: { id: row.id },
          data: {
            state: "aborted",
            activeGlobalSlot: null,
            abortedAt: new Date(),
            safeErrorCode: intent.safeErrorCode ?? "zero_login_rollover_pre_dispatch_failed_v1",
          },
          include: { candidateNamespace: true },
        });
      }
    }
    if (row.state === "setup_pr_open") {
      const provider = await tx.codexOAuthProviderInstance.findUniqueOrThrow({
        where: { id: row.providerInstanceRowId },
        select: { activeSecretNamespaceId: true, state: true },
      });
      const intent = await tx.codexOAuthWritebackIntent.findUnique({
        where: { id: row.id },
        select: { status: true },
      });
      if (
        row.candidateNamespace.status === "active" &&
        provider.activeSecretNamespaceId === row.candidateNamespaceId &&
        provider.state === "active" &&
        (intent?.status === "completed" || intent === null)
      ) {
        return tx.codexOAuthNamespaceRolloverIntent.update({
          where: { id: row.id },
          data: { state: "activated", activeGlobalSlot: null, activatedAt: new Date() },
          include: { candidateNamespace: true },
        });
      }
    }
    return row;
  }
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function selectZeroLoginRolloverCandidateEpoch(input: {
  reusableConfirmedEpoch: bigint | null;
  maxNamespaceEpoch: bigint | null;
}): bigint {
  return input.reusableConfirmedEpoch ?? (input.maxNamespaceEpoch ?? 0n) + 1n;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("zero_login_rollover_evidence_invalid");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("zero_login_rollover_evidence_invalid");
}

async function readDatabaseIncarnation(tx: Prisma.TransactionClient): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ databaseIncarnation: string }>>(Prisma.sql`
    SELECT "system_identifier"::text AS "databaseIncarnation" FROM pg_control_system()
  `);
  const value = rows[0]?.databaseIncarnation;
  if (!value || !/^[1-9][0-9]+$/u.test(value)) throw new Error("zero_login_rollover_database_incarnation_unproven");
  return value;
}

function toRepository(row: {
  id: string; workspaceId: string; githubRepositoryId: bigint | null;
  fullName: string; owner: string; selected: boolean;
  installation: { githubInstallationId: bigint } | null;
}) {
  return {
    workspaceId: row.workspaceId,
    repositoryId: row.id,
    githubRepositoryId: row.githubRepositoryId!.toString(),
    githubInstallationId: row.installation!.githubInstallationId.toString(),
    fullName: row.fullName,
    owner: row.owner,
    selected: row.selected,
    installationStatus: "active" as const,
  };
}

function toRecord(row: any, actionOwnerRepo: string): ZeroLoginRolloverRecord {
  return {
    id: row.id,
    operationId: row.operationId,
    repositoryFullName: row.repositoryFullName,
    providerInstanceId: row.providerInstanceId,
    state: row.state,
    sourceRunId: row.sourceRunId,
    sourceRunAttempt: row.sourceRunAttempt,
    expectedRerunAttempt: row.expectedRerunAttempt,
    sourceActionCommitSha: row.sourceActionCommitSha,
    sourceWorkflowCommitSha: row.sourceWorkflowCommitSha,
    sourceDefaultHeadSha: row.sourceDefaultHeadSha,
    targetActionCommitSha: row.targetActionCommitSha,
    targetWorkflowSchemaVersion: 5,
    candidateNamespaceId: row.candidateNamespaceId,
    candidateNamespaceEpoch: row.candidateNamespaceEpoch,
    candidateNamespaceName: row.candidateNamespace.secretName,
    sourceActionRef: `${actionOwnerRepo}@${row.sourceActionCommitSha}`,
    ...(row.sourceActiveNamespaceId
      ? { sourceActiveNamespaceId: row.sourceActiveNamespaceId }
      : {}),
    targetActionRef: `${actionOwnerRepo}@${row.targetActionCommitSha}`,
    ...(row.setupPullRequestUrl ? { setupPullRequestUrl: row.setupPullRequestUrl } : {}),
    ...(row.setupPullRequestNumber ? { setupPullRequestNumber: row.setupPullRequestNumber } : {}),
    ...(row.setupPullRequestHeadSha ? { setupPullRequestHeadSha: row.setupPullRequestHeadSha } : {}),
    ...(row.setupPullRequestBaseBranch ? { setupPullRequestBaseBranch: row.setupPullRequestBaseBranch } : {}),
  };
}
