import { Prisma, type PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import {
  PostgresTransactionClock,
  type TransactionClock,
} from "@reviewrouter/platform-db";
import {
  assertRuntimeVersionedAmbiguousRetirementAuthorized,
  assertSameRuntimeVersionedWritebackIdentity,
  assertProviderSecretTransitionAuthorized,
  assertSameVersionedProviderSecretNamespace,
  assertCanonicalCodexRotatingProviderId,
  classifyCodexRotatingMutationOwnership,
  assertExternalRecoveryWitnessAdmission,
  classifyExternalRecoveryWitnessRelation,
  fingerprintDatabaseRecoveryWitness,
  codexRotatingAuthMode,
  codexRotatingCanonicalT0WorkflowSchemaVersions,
  codexRotatingSecretName,
  mapActiveVersionedProviderSecretNamespace,
  parseVersionedProviderSecretName,
  RuntimeVersionedDurableMarker,
  WorkflowSourceTrust,
  reserveRuntimeVersionedEffectConfirmationWindow,
  type CodexRotatingEncryptedWritebackRequest,
  type CodexRotatingProviderBinding,
  type VersionedSecretWorkflowSourceAttestation,
} from "@reviewrouter/features-codex-oauth-rotating";
import type { ActionRepositoryContext } from "../../domain/action-control-plane.js";
import {
  codexRotatingReviewExecutionCheckpointAccessTtlMs,
  codexRotatingReviewSnapshotAccessTtlMs,
  isCodexRotatingCompletedLeasePostingWindowActive,
} from "../../domain/codex-rotating-oauth-posting-window.js";
import type {
  CodexRotatingOAuthRepositoryPort,
  CodexRotatingPreleaseRecord,
  CodexRotatingSecretWriteTarget,
  CodexRotatingVersionedWritebackLedgerPort,
} from "../../application/ports/codex-rotating-oauth-repository-port.js";
import type { CodexRotatingReviewSnapshotAccessPort } from "../../application/ports/codex-rotating-review-snapshot-access-port.js";
import type { CodexRotatingReviewExecutionCheckpointAccessPort } from "../../application/ports/codex-rotating-review-execution-checkpoint-access-port.js";

const codexRotatingRepositoryContextSelect = {
  id: true,
  workspaceId: true,
  provider: true,
  githubRepositoryId: true,
  fullName: true,
  owner: true,
  name: true,
  selected: true,
  installation: {
    select: {
      githubInstallationId: true,
      status: true,
    },
  },
} as const;

async function signDatabaseAuthorityChallenge(input: {
  readonly tx: Prisma.TransactionClient;
  readonly authority: Pick<PrismaClient, "$queryRaw">;
  readonly effect: string;
  readonly ownerId: string;
  readonly effectCode: number;
}): Promise<string> {
  const challengeRows = await input.tx.$queryRaw<
    readonly { challenge: string }[]
  >`
    SELECT "codex_oauth_database_authority_challenge"(
      ${input.effect}, ${input.ownerId}, ${input.effectCode}
    ) AS challenge
  `;
  const challenge = challengeRows[0]?.challenge;
  if (!challenge) throw new Error("codex_oauth_database_authority_unavailable");
  const signatureRows = await input.authority.$queryRaw<
    readonly { signature: string }[]
  >`
    SELECT "codex_oauth_sign_database_authority"(${challenge}) AS signature
  `;
  const signature = signatureRows[0]?.signature;
  if (!signature || !/^[a-f0-9]{64}$/u.test(signature)) {
    throw new Error("codex_oauth_database_authority_unavailable");
  }
  return signature;
}

export class PrismaCodexRotatingOAuthRepository
  implements
    CodexRotatingOAuthRepositoryPort,
    CodexRotatingVersionedWritebackLedgerPort,
    CodexRotatingReviewSnapshotAccessPort,
    CodexRotatingReviewExecutionCheckpointAccessPort
{
  constructor(
    private readonly prisma: PrismaClient,
    private readonly options: {
      readonly actionRef?: string;
      readonly allowedActionRefs?: readonly string[] | undefined;
      readonly actionOwnerRepo: string;
      readonly workflowPath?: string;
      readonly databaseRecoveryWitness?: string;
      readonly databaseEffectAuthority?: Pick<PrismaClient, "$queryRaw">;
      readonly transactionClock?: TransactionClock;
    },
  ) {}

  private get transactionClock(): TransactionClock {
    return this.options.transactionClock ?? new PostgresTransactionClock();
  }

  private requireDatabaseEffectAuthority(): Pick<PrismaClient, "$queryRaw"> {
    if (!this.options.databaseEffectAuthority) {
      throw new Error("codex_oauth_database_effect_authority_unavailable");
    }
    return this.options.databaseEffectAuthority;
  }

  async findProviderBinding(input: {
    readonly repository: ActionRepositoryContext;
    readonly providerInstanceId: string;
    readonly workflowSha: string;
    readonly workflowSchemaVersion: number;
  }): Promise<CodexRotatingProviderBinding | null> {
    if (
      !codexRotatingCanonicalT0WorkflowSchemaVersions.includes(
        input.workflowSchemaVersion as (typeof codexRotatingCanonicalT0WorkflowSchemaVersions)[number],
      )
    ) {
      return null;
    }
    assertCanonicalCodexRotatingProviderId({
      providerInstanceId: input.providerInstanceId,
      githubRepositoryId: input.repository.githubRepositoryId,
    });

    const provider = await this.prisma.codexOAuthProviderInstance.findUnique({
      where: { providerInstanceId: input.providerInstanceId },
      select: {
        id: true,
        workspaceId: true,
        repositoryId: true,
        authMode: true,
        activeSecretNamespaceId: true,
        activeSecretNamespaceEpoch: true,
        activeSecretNamespace: {
          select: {
            id: true,
            githubRepositoryId: true,
            namespaceEpoch: true,
            secretName: true,
            status: true,
            workflowPath: true,
            workflowSourceCommitSha: true,
            workflowSourceBlobSha: true,
            workflowSourceSha256: true,
            workflowSemanticSha256: true,
            workflowSourceTrust: true,
            workflowSchemaVersion: true,
            attestedRepositoryId: true,
          },
        },
      },
    });
    if (
      !provider ||
      provider.workspaceId !== input.repository.workspaceId ||
      provider.repositoryId !== input.repository.repositoryId ||
      provider.authMode !== codexRotatingAuthMode
    ) {
      return null;
    }
    let activeSecretNamespace;
    try {
      activeSecretNamespace = mapActiveVersionedProviderSecretNamespace({
        scope: {
          repositoryId: input.repository.githubRepositoryId,
          providerInstanceId: input.providerInstanceId,
        },
        row: provider,
      });
    } catch {
      return null;
    }
    const source = provider.activeSecretNamespace;
    if (
      !source?.workflowPath ||
      !source.workflowSourceCommitSha ||
      !source.workflowSourceBlobSha ||
      !source.workflowSourceSha256 ||
      source.workflowSourceTrust !== "trusted_default_branch_revision" ||
      source.workflowSchemaVersion !== input.workflowSchemaVersion ||
      !source.attestedRepositoryId ||
      !source.workflowSemanticSha256
    ) {
      return null;
    }

    return {
      providerInstanceId: input.providerInstanceId,
      repositoryFullName: input.repository.fullName,
      githubRepositoryId: input.repository.githubRepositoryId,
      actionRef:
        this.options.actionRef ??
        `${this.options.actionOwnerRepo}@${input.workflowSha}`,
      ...(this.options.allowedActionRefs?.length
        ? { allowedActionRefs: this.options.allowedActionRefs }
        : {}),
      workflowPath:
        this.options.workflowPath ?? ".github/workflows/reviewrouter-codex.yml",
      workflowSchemaVersion: input.workflowSchemaVersion,
      activeSecretNamespace,
      activeWorkflowSource: {
        workflowPath: source.workflowPath,
        workflowSourceCommitSha: source.workflowSourceCommitSha,
        workflowSourceBlobSha: source.workflowSourceBlobSha,
        workflowSourceSha256: source.workflowSourceSha256,
        workflowSemanticSha256: source.workflowSemanticSha256,
        sourceTrust: source.workflowSourceTrust,
        repositoryId: source.attestedRepositoryId,
      },
    };
  }

  async ensureVerifiedProviderBinding(input: {
    readonly repository: ActionRepositoryContext;
    readonly binding: CodexRotatingProviderBinding;
  }): Promise<void> {
    // The workflow verifier returns its source proof as a separate attestation.
    // The prelease use case validates that proof against the durable source
    // before this identity/namespace check runs.
    if (!input.binding.activeSecretNamespace) {
      throw new Error("codex_rotating_active_secret_namespace_required");
    }
    const activeSecretNamespace = input.binding.activeSecretNamespace;
    if (
      input.binding.githubRepositoryId !==
        input.repository.githubRepositoryId ||
      input.binding.repositoryFullName.toLowerCase() !==
        input.repository.fullName.toLowerCase()
    ) {
      throw new Error("codex_rotating_provider_identity_mismatch");
    }
    assertCanonicalCodexRotatingProviderId({
      providerInstanceId: input.binding.providerInstanceId,
      githubRepositoryId: input.repository.githubRepositoryId,
    });
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.codexOAuthProviderInstance.findUnique({
        where: {
          repositoryId_authMode: {
            repositoryId: input.repository.repositoryId,
            authMode: codexRotatingAuthMode,
          },
        },
      });
      if (existing) {
        if (
          existing.workspaceId !== input.repository.workspaceId ||
          existing.repositoryId !== input.repository.repositoryId ||
          existing.providerInstanceId !== input.binding.providerInstanceId ||
          existing.authMode !== codexRotatingAuthMode ||
          existing.activeSecretNamespaceId !== activeSecretNamespace.namespaceId
        ) {
          throw new Error("codex_rotating_provider_identity_mismatch");
        }
        return;
      }
      throw new Error("codex_rotating_provider_binding_not_found");
    });
  }

  async acquirePrelease(input: {
    readonly repository: ActionRepositoryContext;
    readonly providerInstanceId: string;
    readonly githubRunId: string;
    readonly githubRunAttempt: string;
    readonly pullRequestNumber?: number | undefined;
    readonly verifiedWorkflowAttestation: VersionedSecretWorkflowSourceAttestation;
    readonly newWorkAdmissionBarrier: Readonly<{
      assertAdmitted(): void;
    }>;
  }): Promise<CodexRotatingPreleaseRecord> {
    assertCanonicalCodexRotatingProviderId({
      providerInstanceId: input.providerInstanceId,
      githubRepositoryId: input.repository.githubRepositoryId,
    });
    const leaseKey = `${input.providerInstanceId}:${input.githubRunId}:${input.githubRunAttempt}`;

    return this.prisma.$transaction(async (tx) => {
      await setBoundedProviderRowWaits(tx);
      // A shared transaction-scoped advisory lock makes every admitted
      // prelease attempt observable in pg_locks until the lease transaction
      // commits or aborts. Drain tooling can take the matching exclusive lock
      // to establish a hard zero-in-flight barrier.
      await tx.$queryRaw<Array<{ locked: boolean }>>(Prisma.sql`
        SELECT pg_advisory_xact_lock_shared(1381126735, 1129271119) IS NULL AS "locked"
      `);
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "CodexOAuthProviderInstance"
        WHERE "providerInstanceId" = ${input.providerInstanceId}
        FOR UPDATE
      `);
      const now = await this.transactionClock.now(tx);
      const expiresAt = new Date(now.getTime() + 15 * 60 * 1000);
      const provider = await tx.codexOAuthProviderInstance.findUnique({
        where: { providerInstanceId: input.providerInstanceId },
        select: {
          id: true,
          workspaceId: true,
          repositoryId: true,
          providerInstanceId: true,
          authMode: true,
          secretName: true,
          activeLeaseId: true,
          activeLeaseExpiresAt: true,
          mutationEpoch: true,
          mutationOwner: true,
          mutationOwnerId: true,
          activeSecretNamespaceId: true,
          activeSecretNamespaceEpoch: true,
          activeSecretNamespaceName: true,
          activeSecretNamespace: {
            select: {
              id: true,
              githubRepositoryId: true,
              namespaceEpoch: true,
              secretName: true,
              status: true,
              databaseRecoveryWitness: true,
            },
          },
          state: true,
          latestGeneration: true,
          latestGenerationHash: true,
          generationHashSalt: true,
          accountFingerprintSalt: true,
        },
      });
      if (!provider) {
        throw new Error("codex_rotating_provider_not_found");
      }
      if (
        provider.workspaceId !== input.repository.workspaceId ||
        provider.repositoryId !== input.repository.repositoryId ||
        provider.providerInstanceId !== input.providerInstanceId ||
        provider.authMode !== codexRotatingAuthMode ||
        provider.secretName !== codexRotatingSecretName
      ) {
        throw new Error("codex_rotating_provider_identity_mismatch");
      }
      const activeNamespace = requireActiveNamespaceBinding(provider);
      const lockedWorkflowAdmissions = await tx.$queryRaw<
        LockedWorkflowAdmissionRow[]
      >(Prisma.sql`
          SELECT namespace."id", namespace."githubRepositoryId",
            namespace."namespaceEpoch", namespace."secretName",
            namespace."status", namespace."permanentlyRetired",
            namespace."workflowPath", namespace."workflowSourceCommitSha",
            namespace."workflowSourceBlobSha", namespace."workflowSourceSha256",
            namespace."workflowSemanticSha256", namespace."workflowSourceTrust",
            namespace."workflowSchemaVersion", namespace."attestedRepositoryId"
          FROM "CodexOAuthSecretNamespace" namespace
          WHERE namespace."id" = ${provider.activeSecretNamespaceId}
            AND namespace."providerInstanceRowId" = ${provider.id}
          FOR UPDATE
        `);
      assertLockedWorkflowAdmissionMatches({
        persisted:
          lockedWorkflowAdmissions.length === 1
            ? lockedWorkflowAdmissions[0]!
            : null,
        activeNamespace,
        verified: input.verifiedWorkflowAttestation,
      });
      assertAutomaticRuntimeDatabaseRecoveryWitness(
        provider.activeSecretNamespace?.databaseRecoveryWitness,
        this.options.databaseRecoveryWitness,
      );
      // The final policy assertion deliberately runs after the provider row is
      // locked and in the same transaction that creates the lease. This is the
      // admission barrier: a closed or malformed fence cannot race a lease.
      input.newWorkAdmissionBarrier.assertAdmitted();
      if (
        provider.state === "unknown_auth_state" ||
        provider.state === "needs_reconnect" ||
        provider.state === "permission_required"
      ) {
        throw new Error(`codex_rotating_provider_${provider.state}`);
      }
      const pendingIntent = await tx.codexOAuthWritebackIntent.findFirst({
        where: {
          providerInstanceRowId: provider.id,
          OR: [
            { status: "pending" },
            {
              status: "remote_outcome_unknown",
              recoveryResolvedAt: null,
            },
          ],
        },
        select: { id: true },
      });
      const blockingSetup = await tx.codexOAuthSetupManifest.findFirst({
        where: {
          providerInstanceRowId: provider.id,
          OR: [
            { status: "fetched" },
            { status: "issued", expiresAt: { gt: now } },
          ],
        },
        select: { id: true },
      });
      if (
        provider.mutationOwner === "setup" ||
        provider.mutationOwner === "recovery" ||
        pendingIntent ||
        blockingSetup
      ) {
        throw new Error("codex_rotating_mutation_fence_conflict");
      }
      if (
        provider.activeLeaseId &&
        provider.activeLeaseExpiresAt &&
        provider.activeLeaseExpiresAt > now
      ) {
        const activeLease = await tx.codexOAuthLease.findUnique({
          where: { id: provider.activeLeaseId },
          select: {
            id: true,
            githubRunId: true,
            githubRunAttempt: true,
            pullRequestNumber: true,
            status: true,
            expiresAt: true,
            mutationEpoch: true,
            secretNamespaceId: true,
            secretNamespaceEpoch: true,
          },
        });
        if (
          activeLease &&
          activeLease.status !== "completed" &&
          activeLease.expiresAt > now
        ) {
          if (
            activeLease.githubRunId === input.githubRunId &&
            activeLease.githubRunAttempt === input.githubRunAttempt &&
            activeLease.status === "preleased" &&
            (activeNamespace.id === null ||
              (activeLease.secretNamespaceId === activeNamespace.id &&
                activeLease.secretNamespaceEpoch === activeNamespace.epoch))
          ) {
            return {
              leaseId: activeLease.id,
              providerInstanceId: input.providerInstanceId,
              runId: input.githubRunId,
              runAttempt: input.githubRunAttempt,
              status: "preleased" as const,
              expiresAt: activeLease.expiresAt,
              repository: input.repository,
              generationHashSalt: provider.generationHashSalt,
              accountFingerprintSalt: provider.accountFingerprintSalt,
              currentGeneration: provider.latestGeneration,
              mutationEpoch:
                activeLease.mutationEpoch ?? provider.mutationEpoch,
              ...(activeLease.secretNamespaceId
                ? { secretNamespaceId: activeLease.secretNamespaceId }
                : {}),
              ...(activeLease.secretNamespaceEpoch !== null
                ? { secretNamespaceEpoch: activeLease.secretNamespaceEpoch }
                : {}),
              ...(provider.latestGenerationHash
                ? { currentGenerationHash: provider.latestGenerationHash }
                : {}),
            };
          }
          if (
            activeLease.githubRunId === input.githubRunId &&
            activeLease.githubRunAttempt !== input.githubRunAttempt
          ) {
            await tx.codexOAuthLease.update({
              where: { id: activeLease.id },
              data: {
                status: "expired",
                expiresAt: now,
              },
            });
          } else {
            return {
              leaseId: activeLease.id,
              providerInstanceId: input.providerInstanceId,
              runId: activeLease.githubRunId,
              runAttempt: activeLease.githubRunAttempt,
              status: "conflict" as const,
              expiresAt: activeLease.expiresAt,
              repository: input.repository,
              generationHashSalt: provider.generationHashSalt,
              accountFingerprintSalt: provider.accountFingerprintSalt,
              currentGeneration: provider.latestGeneration,
              mutationEpoch:
                activeLease.mutationEpoch ?? provider.mutationEpoch,
              ...(provider.latestGenerationHash
                ? { currentGenerationHash: provider.latestGenerationHash }
                : {}),
            };
          }
        }
      }

      const mutationEpoch = provider.mutationEpoch + 1n;
      await tx.codexOAuthProviderInstance.update({
        where: { id: provider.id },
        data: {
          mutationEpoch,
          mutationOwner: "runtime",
          mutationOwnerId: leaseKey,
        },
      });
      const lease = await tx.codexOAuthLease.upsert({
        where: { leaseKey },
        update: {
          status: "preleased",
          expiresAt,
          mutationEpoch,
          secretNamespaceId: activeNamespace.id,
          secretNamespaceEpoch: activeNamespace.epoch,
          ...(input.pullRequestNumber
            ? { pullRequestNumber: input.pullRequestNumber }
            : {}),
        },
        create: {
          providerInstanceRowId: provider.id,
          providerInstanceId: input.providerInstanceId,
          workspaceId: input.repository.workspaceId,
          repositoryId: input.repository.repositoryId,
          githubRunId: input.githubRunId,
          githubRunAttempt: input.githubRunAttempt,
          ...(input.pullRequestNumber
            ? { pullRequestNumber: input.pullRequestNumber }
            : {}),
          leaseKey,
          status: "preleased",
          expiresAt,
          mutationEpoch,
          secretNamespaceId: activeNamespace.id,
          secretNamespaceEpoch: activeNamespace.epoch,
        },
      });
      await tx.codexOAuthProviderInstance.update({
        where: { id: provider.id },
        data: {
          activeLeaseId: lease.id,
          activeLeaseExpiresAt: expiresAt,
          state: "setup_pending",
          mutationEpoch,
          mutationOwner: "runtime",
          mutationOwnerId: lease.id,
        },
      });

      return {
        leaseId: lease.id,
        providerInstanceId: input.providerInstanceId,
        runId: input.githubRunId,
        runAttempt: input.githubRunAttempt,
        status: "preleased" as const,
        expiresAt,
        repository: input.repository,
        generationHashSalt: provider.generationHashSalt,
        accountFingerprintSalt: provider.accountFingerprintSalt,
        currentGeneration: provider.latestGeneration,
        mutationEpoch,
        ...(activeNamespace.id
          ? { secretNamespaceId: activeNamespace.id }
          : {}),
        ...(activeNamespace.epoch !== null
          ? { secretNamespaceEpoch: activeNamespace.epoch }
          : {}),
        ...(provider.latestGenerationHash
          ? { currentGenerationHash: provider.latestGenerationHash }
          : {}),
      };
    });
  }

  async finalizeLease(input: {
    readonly leaseId: string;
    readonly providerInstanceId: string;
    readonly restoredGenerationHash: string;
  }): Promise<{
    readonly leaseId: string;
    readonly nextGeneration: number;
    readonly repository?: ActionRepositoryContext;
    readonly status: "finalized" | "stale_queued_secret";
  }> {
    return this.prisma.$transaction(async (tx) => {
      await lockProviderByInstanceId(tx, input.providerInstanceId);
      const now = await this.transactionClock.now(tx);
      const provider = await tx.codexOAuthProviderInstance.findUnique({
        where: { providerInstanceId: input.providerInstanceId },
        select: {
          id: true,
          activeLeaseId: true,
          activeLeaseExpiresAt: true,
          mutationEpoch: true,
          mutationOwner: true,
          mutationOwnerId: true,
          latestGeneration: true,
          latestGenerationHash: true,
          activeSecretNamespace: {
            select: { databaseRecoveryWitness: true },
          },
          repository: {
            select: codexRotatingRepositoryContextSelect,
          },
          leases: {
            where: { id: input.leaseId },
            take: 1,
            select: { mutationEpoch: true },
          },
        },
      });
      if (
        !provider ||
        provider.activeLeaseId !== input.leaseId ||
        provider.mutationOwner !== "runtime" ||
        provider.mutationOwnerId !== input.leaseId ||
        provider.leases[0]?.mutationEpoch !== provider.mutationEpoch ||
        !provider.activeLeaseExpiresAt ||
        provider.activeLeaseExpiresAt <= now
      ) {
        throw new Error("codex_rotating_lease_not_active");
      }
      assertAutomaticRuntimeDatabaseRecoveryWitness(
        provider.activeSecretNamespace?.databaseRecoveryWitness,
        this.options.databaseRecoveryWitness,
      );

      const nextGeneration = provider.latestGeneration + 1;
      if (
        provider.latestGenerationHash &&
        provider.latestGenerationHash !== input.restoredGenerationHash
      ) {
        await tx.codexOAuthLease.update({
          where: { id: input.leaseId },
          data: {
            status: "stale_queued_secret",
            restoredGenerationHash: input.restoredGenerationHash,
            nextGeneration,
            finalizedAt: now,
          },
        });
        await tx.codexOAuthProviderInstance.update({
          where: { id: provider.id },
          data: {
            state: "stale_queued_secret",
            activeLeaseId: null,
            activeLeaseExpiresAt: null,
            mutationEpoch: { increment: 1 },
            mutationOwner: "recovery",
            mutationOwnerId: input.leaseId,
          },
        });
        return {
          leaseId: input.leaseId,
          nextGeneration,
          repository: toActionRepositoryContext(
            requireGitHubRepositoryContext(provider.repository),
          ),
          status: "stale_queued_secret" as const,
        };
      }

      await tx.codexOAuthLease.update({
        where: { id: input.leaseId },
        data: {
          status: "finalized",
          restoredGenerationHash: input.restoredGenerationHash,
          nextGeneration,
          finalizedAt: now,
        },
      });
      return {
        leaseId: input.leaseId,
        nextGeneration,
        repository: toActionRepositoryContext(
          requireGitHubRepositoryContext(provider.repository),
        ),
        status: "finalized" as const,
      };
    });
  }

  async abandonLease(input: {
    readonly leaseId: string;
    readonly providerInstanceId: string;
    readonly reason: "needs_reconnect" | "unknown_auth_state";
  }): Promise<{
    readonly status: "abandoned" | "lease_not_active";
  }> {
    return this.prisma.$transaction(async (tx) => {
      await lockProviderByInstanceId(tx, input.providerInstanceId);
      const now = await this.transactionClock.now(tx);
      const provider = await tx.codexOAuthProviderInstance.findUnique({
        where: { providerInstanceId: input.providerInstanceId },
        select: {
          id: true,
          activeLeaseId: true,
          activeLeaseExpiresAt: true,
          mutationEpoch: true,
          mutationOwner: true,
          mutationOwnerId: true,
          activeSecretNamespace: {
            select: { databaseRecoveryWitness: true },
          },
          leases: {
            where: { id: input.leaseId },
            take: 1,
            select: {
              id: true,
              status: true,
              expiresAt: true,
              mutationEpoch: true,
              secretNamespaceId: true,
              secretNamespaceEpoch: true,
            },
          },
        },
      });
      const lease = provider?.leases[0];
      const ownership =
        provider && lease
          ? classifyCodexRotatingMutationOwnership({
              owner: provider.mutationOwner,
              ownerId: provider.mutationOwnerId,
              now,
              runtimeLease: {
                id: lease.id,
                status: lease.status,
                expiresAt: lease.expiresAt,
              },
            })
          : { classification: "ambiguous" as const };
      if (
        !provider ||
        !lease ||
        provider.activeLeaseId !== input.leaseId ||
        provider.mutationOwner !== "runtime" ||
        provider.mutationOwnerId !== input.leaseId ||
        ownership.classification !== "active" ||
        lease.mutationEpoch !== provider.mutationEpoch ||
        !provider.activeLeaseExpiresAt ||
        provider.activeLeaseExpiresAt <= now ||
        lease.expiresAt <= now ||
        lease.status === "completed"
      ) {
        return { status: "lease_not_active" as const };
      }
      assertAutomaticRuntimeDatabaseRecoveryWitness(
        provider.activeSecretNamespace?.databaseRecoveryWitness,
        this.options.databaseRecoveryWitness,
      );

      await tx.codexOAuthLease.update({
        where: { id: input.leaseId },
        data: {
          status: input.reason,
          expiresAt: now,
        },
      });
      await tx.codexOAuthProviderInstance.update({
        where: { id: provider.id },
        data: {
          state: input.reason,
          activeLeaseId: null,
          activeLeaseExpiresAt: null,
          mutationEpoch: { increment: 1 },
          mutationOwner: "recovery",
          mutationOwnerId: input.leaseId,
        },
      });
      return { status: "abandoned" as const };
    });
  }

  async preflightWriteback(input: {
    readonly leaseId: string;
    readonly providerInstanceId: string;
    readonly githubKeyId: string;
  }): Promise<
    | {
        readonly status: "ready";
        readonly writeTarget: CodexRotatingSecretWriteTarget;
      }
    | {
        readonly status:
          | "lease_not_active"
          | "stale_queued_secret"
          | "permission_required";
      }
  > {
    return this.prisma.$transaction(async (tx) => {
      await lockProviderByInstanceId(tx, input.providerInstanceId);
      const now = await this.transactionClock.now(tx);
      const provider = await tx.codexOAuthProviderInstance.findUnique({
        where: { providerInstanceId: input.providerInstanceId },
        select: {
          id: true,
          activeLeaseId: true,
          activeLeaseExpiresAt: true,
          mutationEpoch: true,
          mutationOwner: true,
          mutationOwnerId: true,
          activeSecretNamespaceId: true,
          activeSecretNamespaceEpoch: true,
          activeSecretNamespaceName: true,
          activeSecretNamespace: {
            select: {
              id: true,
              githubRepositoryId: true,
              namespaceEpoch: true,
              secretName: true,
              status: true,
              databaseRecoveryWitness: true,
            },
          },
          repository: { select: codexRotatingRepositoryContextSelect },
          leases: {
            where: { id: input.leaseId },
            take: 1,
            select: {
              id: true,
              status: true,
              expiresAt: true,
              nextGeneration: true,
              mutationEpoch: true,
              secretNamespaceId: true,
              secretNamespaceEpoch: true,
            },
          },
        },
      });
      const lease = provider?.leases[0];
      const ownership =
        provider && lease
          ? classifyCodexRotatingMutationOwnership({
              owner: provider.mutationOwner,
              ownerId: provider.mutationOwnerId,
              now,
              runtimeLease: {
                id: lease.id,
                status: lease.status,
                expiresAt: lease.expiresAt,
              },
            })
          : { classification: "ambiguous" as const };
      if (
        !provider ||
        !lease ||
        provider.activeLeaseId !== input.leaseId ||
        provider.mutationOwner !== "runtime" ||
        provider.mutationOwnerId !== input.leaseId ||
        lease.mutationEpoch !== provider.mutationEpoch ||
        !provider.activeLeaseExpiresAt ||
        provider.activeLeaseExpiresAt <= now ||
        lease.expiresAt <= now
      ) {
        return { status: "lease_not_active" as const };
      }
      if (lease.status === "stale_queued_secret") {
        return { status: "stale_queued_secret" as const };
      }
      const activeNamespace = requireActiveNamespaceBinding(provider);
      assertAutomaticRuntimeDatabaseRecoveryWitness(
        provider.activeSecretNamespace?.databaseRecoveryWitness,
        this.options.databaseRecoveryWitness,
      );
      if (
        activeNamespace.id !== null &&
        (lease.secretNamespaceId !== activeNamespace.id ||
          lease.secretNamespaceEpoch !== activeNamespace.epoch)
      ) {
        return { status: "stale_queued_secret" as const };
      }
      if (
        lease.status !== "finalized" ||
        !lease.nextGeneration ||
        ownership.classification !== "active"
      ) {
        return { status: "lease_not_active" as const };
      }

      await tx.codexOAuthLease.update({
        where: { id: input.leaseId },
        data: {
          writebackPreflightKeyId: input.githubKeyId,
          writebackPreflightedAt: now,
        },
      });

      return {
        status: "ready" as const,
        writeTarget: toSecretWriteTarget(
          requireGitHubRepositoryContext(provider.repository),
          requireActiveSecretNamespace(provider),
        ),
      };
    });
  }

  async prepareVersionedWriteback(input: {
    readonly request: CodexRotatingEncryptedWritebackRequest;
    readonly encryptedPayloadDigest: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      await lockProviderByInstanceId(tx, input.request.providerInstanceId);
      const now = await this.transactionClock.now(tx);
      const existingForLease = await tx.codexOAuthWritebackIntent.findFirst({
        where: { leaseId: input.request.leaseId },
        select: {
          id: true,
          providerInstanceRowId: true,
          leaseId: true,
          providerInstanceId: true,
          idempotencyKey: true,
          encryptedPayloadDigest: true,
          keyId: true,
          latestGenerationHash: true,
          generation: true,
          status: true,
          mutationEpoch: true,
          dispatchAttemptId: true,
          secretNamespaceId: true,
          databaseIncarnation: true,
          databaseRecoveryWitness: true,
          accountIdentityHash: true,
          accountIdentityAlgorithm: true,
          executorOwner: true,
          executorLeaseExpiresAt: true,
        },
      });
      const existing =
        existingForLease ??
        (await tx.codexOAuthWritebackIntent.findUnique({
          where: {
            providerInstanceId_idempotencyKey: {
              providerInstanceId: input.request.providerInstanceId,
              idempotencyKey: input.request.idempotencyKey,
            },
          },
          select: {
            id: true,
            providerInstanceRowId: true,
            leaseId: true,
            providerInstanceId: true,
            idempotencyKey: true,
            encryptedPayloadDigest: true,
            keyId: true,
            latestGenerationHash: true,
            generation: true,
            status: true,
            mutationEpoch: true,
            dispatchAttemptId: true,
            secretNamespaceId: true,
            databaseIncarnation: true,
            databaseRecoveryWitness: true,
            accountIdentityHash: true,
            accountIdentityAlgorithm: true,
            executorOwner: true,
            executorLeaseExpiresAt: true,
          },
        }));
      if (existing) {
        if (
          existing.providerInstanceId !== input.request.providerInstanceId ||
          existing.idempotencyKey !== input.request.idempotencyKey ||
          existing.accountIdentityHash !== input.request.accountIdentityHash ||
          existing.accountIdentityAlgorithm !==
            input.request.accountIdentityAlgorithm ||
          existing.leaseId !== input.request.leaseId ||
          existing.generation !== input.request.generation ||
          existing.latestGenerationHash !==
            input.request.latestGenerationHash ||
          existing.keyId !== input.request.keyId
        ) {
          return { status: "writeback_idempotency_conflict" as const };
        }
        if (existing.status === "completed") {
          if (
            existing.encryptedPayloadDigest !== input.encryptedPayloadDigest
          ) {
            return { status: "writeback_idempotency_conflict" as const };
          }
          await assertDatabaseIncarnation(
            tx,
            existing.databaseIncarnation,
            existing.databaseRecoveryWitness,
            this.options.databaseRecoveryWitness,
          );
          return {
            status: "idempotent_replay" as const,
            generation: existing.generation,
          };
        }
        if (existing.encryptedPayloadDigest !== input.encryptedPayloadDigest) {
          return { status: "writeback_idempotency_conflict" as const };
        }
        if (
          existing.status === "pending" &&
          existing.dispatchAttemptId &&
          existing.secretNamespaceId &&
          existing.mutationEpoch !== null
        ) {
          await assertDatabaseIncarnation(
            tx,
            existing.databaseIncarnation,
            existing.databaseRecoveryWitness,
            this.options.databaseRecoveryWitness,
          );
          if (
            existing.executorOwner &&
            existing.executorLeaseExpiresAt &&
            existing.executorLeaseExpiresAt > now
          ) {
            return {
              status: "in_progress" as const,
              retryAfter: existing.executorLeaseExpiresAt,
            };
          }
          const providerState =
            await tx.codexOAuthProviderInstance.findUniqueOrThrow({
              where: { id: existing.providerInstanceRowId },
              select: { activeSecretNamespaceId: true },
            });
          const reusesActiveNamespace =
            providerState.activeSecretNamespaceId ===
            existing.secretNamespaceId;
          if (!reusesActiveNamespace) {
            const retiredNamespace =
              await tx.codexOAuthSecretNamespace.updateMany({
                where: {
                  id: existing.secretNamespaceId,
                  status: {
                    in: ["dispatch_authorized", "confirmed_candidate"],
                  },
                },
                data: {
                  status: "retired_ambiguous",
                  permanentlyRetired: true,
                  retiredAt: now,
                },
              });
            if (retiredNamespace.count !== 1) {
              throw new Error(
                "codex_rotating_interrupted_namespace_retirement_conflict",
              );
            }
          }
          const retiredIntent = await tx.codexOAuthWritebackIntent.updateMany({
            where: { id: existing.id, status: "pending" },
            data: {
              status: "remote_outcome_unknown",
              safeErrorCode:
                RuntimeVersionedDurableMarker.InterruptedAttemptRecoveredV1,
              ...(reusesActiveNamespace ? {} : { namespaceRetiredAt: now }),
            },
          });
          if (retiredIntent.count !== 1) {
            throw new Error(
              "codex_rotating_interrupted_intent_retirement_conflict",
            );
          }
          const recoveredProvider =
            await tx.codexOAuthProviderInstance.updateMany({
              where: {
                id: existing.providerInstanceRowId,
                mutationEpoch: existing.mutationEpoch,
                mutationOwner: "runtime",
                mutationOwnerId: existing.leaseId,
              },
              data: {
                state: "unknown_auth_state",
                activeLeaseId: null,
                activeLeaseExpiresAt: null,
                mutationEpoch: { increment: 1 },
                mutationOwner: "recovery",
                mutationOwnerId: existing.id,
              },
            });
          if (recoveredProvider.count !== 1) {
            throw new Error(
              "codex_rotating_interrupted_provider_fence_conflict",
            );
          }
          const expiredLease = await tx.codexOAuthLease.updateMany({
            where: {
              id: existing.leaseId,
              status: { in: ["preleased", "finalized"] },
            },
            data: { status: "unknown_auth_state", expiresAt: now },
          });
          if (expiredLease.count !== 1) {
            throw new Error(
              "codex_rotating_interrupted_lease_retirement_conflict",
            );
          }
          return { status: "writeback_recovery_required" as const };
        }
        return { status: "writeback_recovery_required" as const };
      }

      const provider = await tx.codexOAuthProviderInstance.findUnique({
        where: { providerInstanceId: input.request.providerInstanceId },
        select: {
          id: true,
          providerInstanceId: true,
          activeLeaseId: true,
          activeLeaseExpiresAt: true,
          mutationEpoch: true,
          mutationOwner: true,
          mutationOwnerId: true,
          latestGeneration: true,
          latestGenerationHash: true,
          activeAccountIdentityHash: true,
          activeSecretNamespaceId: true,
          activeSecretNamespaceEpoch: true,
          activeSecretNamespaceName: true,
          activeSecretNamespace: {
            select: {
              id: true,
              githubRepositoryId: true,
              namespaceEpoch: true,
              secretName: true,
              status: true,
              databaseRecoveryWitness: true,
            },
          },
          repository: { select: codexRotatingRepositoryContextSelect },
          leases: {
            where: { id: input.request.leaseId },
            take: 1,
            select: {
              id: true,
              status: true,
              expiresAt: true,
              nextGeneration: true,
              restoredGenerationHash: true,
              writebackPreflightKeyId: true,
              mutationEpoch: true,
              secretNamespaceId: true,
              secretNamespaceEpoch: true,
            },
          },
        },
      });
      const lease = provider?.leases[0];
      if (
        !provider ||
        !lease ||
        provider.activeLeaseId !== lease.id ||
        provider.mutationOwner !== "runtime" ||
        provider.mutationOwnerId !== lease.id ||
        lease.mutationEpoch !== provider.mutationEpoch ||
        !provider.activeLeaseExpiresAt ||
        provider.activeLeaseExpiresAt <= now ||
        lease.expiresAt <= now ||
        lease.status !== "finalized" ||
        lease.nextGeneration !== input.request.generation ||
        lease.writebackPreflightKeyId !== input.request.keyId
      ) {
        throw new Error("codex_rotating_lease_not_active");
      }
      const activeNamespace = requireActiveNamespaceBinding(provider);
      assertAutomaticRuntimeDatabaseRecoveryWitness(
        provider.activeSecretNamespace?.databaseRecoveryWitness,
        this.options.databaseRecoveryWitness,
      );
      if (
        !activeNamespace.id ||
        lease.secretNamespaceId !== activeNamespace.id ||
        lease.secretNamespaceEpoch !== activeNamespace.epoch
      ) {
        throw new Error("codex_rotating_stale_secret_namespace");
      }
      if (
        !provider.activeAccountIdentityHash ||
        provider.activeAccountIdentityHash !== input.request.accountIdentityHash
      ) {
        throw new Error("codex_rotating_account_switch_epoch_required");
      }
      const databaseIncarnation = await readDatabaseIncarnation(tx);
      const databaseRecoveryWitness = fingerprintDatabaseRecoveryWitness(
        this.options.databaseRecoveryWitness ?? "",
      );

      // A no-op is legal only with positive, three-way generation proof: the
      // bytes restored into this lease, the database-active generation, and
      // the freshly compacted runtime bytes are identical.
      if (
        lease.restoredGenerationHash === input.request.latestGenerationHash &&
        provider.latestGenerationHash === input.request.latestGenerationHash
      ) {
        const noOpIntent = await tx.codexOAuthWritebackIntent.create({
          data: {
            providerInstanceRowId: provider.id,
            leaseId: lease.id,
            providerInstanceId: provider.providerInstanceId,
            idempotencyKey: input.request.idempotencyKey,
            generation: input.request.generation,
            latestGenerationHash: input.request.latestGenerationHash,
            encryptedPayloadDigest: input.encryptedPayloadDigest,
            keyId: input.request.keyId,
            status: "pending",
            mutationEpoch: provider.mutationEpoch,
            databaseIncarnation,
            databaseRecoveryWitness,
            accountIdentityHash: input.request.accountIdentityHash,
            accountIdentityAlgorithm: input.request.accountIdentityAlgorithm,
          },
        });
        const databaseAuthoritySignature = await signDatabaseAuthorityChallenge(
          {
            tx,
            authority: this.requireDatabaseEffectAuthority(),
            effect: "runtime_completion",
            ownerId: noOpIntent.id,
            effectCode: 0,
          },
        );
        await tx.$executeRaw`
          SELECT "codex_oauth_authorize_runtime_completion"(
            ${noOpIntent.id}, ${databaseAuthoritySignature}
          )
        `;
        await tx.codexOAuthLease.update({
          where: { id: lease.id },
          data: { status: "completed", completedAt: now },
        });
        await tx.codexOAuthProviderInstance.update({
          where: { id: provider.id },
          data: {
            latestGeneration: input.request.generation,
            activeLeaseId: null,
            activeLeaseExpiresAt: null,
            mutationEpoch: { increment: 1 },
          },
        });
        const released = await tx.codexOAuthProviderInstance.updateMany({
          where: {
            id: provider.id,
            mutationOwner: "runtime",
            mutationOwnerId: lease.id,
            mutationEpoch: provider.mutationEpoch + 1n,
          },
          data: { mutationOwner: null, mutationOwnerId: null, state: "active" },
        });
        if (released.count !== 1) {
          throw new Error("codex_rotating_unchanged_generation_release_failed");
        }
        await tx.codexOAuthWritebackIntent.update({
          where: { id: noOpIntent.id },
          data: {
            status: "completed",
            safeErrorCode: "unchanged_generation_positive_proof_v1",
            completedAt: now,
          },
        });
        return {
          status: "unchanged_generation" as const,
          generation: input.request.generation,
        };
      }

      const repository = requireGitHubRepositoryContext(provider.repository);
      const namespace = mapActiveVersionedProviderSecretNamespace({
        scope: {
          repositoryId: repository.githubRepositoryId.toString(),
          providerInstanceId: provider.providerInstanceId,
        },
        row: provider,
      });
      const attemptId = `wba_${randomUUID()}`;
      const executorOwner = `wbe_${randomUUID()}`;
      const authorizationExpiresAt =
        lease.expiresAt < provider.activeLeaseExpiresAt
          ? lease.expiresAt
          : provider.activeLeaseExpiresAt;
      const executorLeaseExpiresAt =
        reserveRuntimeVersionedEffectConfirmationWindow({
          now,
          authorizationExpiresAt,
        });
      const intent = await tx.codexOAuthWritebackIntent.create({
        data: {
          providerInstanceRowId: provider.id,
          leaseId: lease.id,
          providerInstanceId: provider.providerInstanceId,
          idempotencyKey: input.request.idempotencyKey,
          generation: input.request.generation,
          latestGenerationHash: input.request.latestGenerationHash,
          encryptedPayloadDigest: input.encryptedPayloadDigest,
          keyId: input.request.keyId,
          status: "pending",
          safeErrorCode: RuntimeVersionedDurableMarker.DispatchAuthorizedV1,
          mutationEpoch: provider.mutationEpoch,
          dispatchAttemptId: attemptId,
          dispatchAuthorizedAt: now,
          secretNamespaceId: namespace.namespaceId,
          databaseIncarnation,
          databaseRecoveryWitness,
          accountIdentityHash: input.request.accountIdentityHash,
          accountIdentityAlgorithm: input.request.accountIdentityAlgorithm,
          executorOwner,
          executorLeaseExpiresAt,
        },
      });
      return {
        status: "ready" as const,
        intentId: intent.id,
        attemptId,
        executorOwner,
        retirementIdentity: {
          providerInstanceId: provider.providerInstanceId,
          mutationOwner: "runtime" as const,
          mutationOwnerId: lease.id,
          mutationEpoch: provider.mutationEpoch,
          namespaceId: namespace.namespaceId,
          generation: input.request.generation,
          latestGenerationHash: input.request.latestGenerationHash,
          accountIdentityHash: input.request.accountIdentityHash,
        },
        namespace,
        repository: toActionRepositoryContext(repository),
        writeTarget: toSecretWriteTarget(repository, namespace.name),
      };
    });
  }

  async confirmVersionedProviderWrite(input: {
    readonly intentId: string;
    readonly attemptId: string;
    readonly executorOwner: string;
    readonly statusCode: 201 | 204;
  }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const locator = await tx.codexOAuthWritebackIntent.findUnique({
        where: { id: input.intentId },
        select: { providerInstanceRowId: true },
      });
      if (!locator) {
        throw new Error("codex_rotating_versioned_attempt_mismatch");
      }
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "CodexOAuthProviderInstance"
        WHERE "id" = ${locator.providerInstanceRowId} FOR UPDATE
      `);
      const now = await this.transactionClock.now(tx);
      const intent = await tx.codexOAuthWritebackIntent.findUnique({
        where: { id: input.intentId },
        select: {
          leaseId: true,
          dispatchAttemptId: true,
          secretNamespaceId: true,
          status: true,
          mutationEpoch: true,
          databaseIncarnation: true,
          databaseRecoveryWitness: true,
          accountIdentityHash: true,
          accountIdentityAlgorithm: true,
          executorOwner: true,
          executorLeaseExpiresAt: true,
          secretNamespace: { select: { status: true } },
          providerInstance: {
            select: {
              activeLeaseId: true,
              activeLeaseExpiresAt: true,
              activeSecretNamespaceId: true,
              mutationEpoch: true,
              mutationOwner: true,
              mutationOwnerId: true,
            },
          },
          lease: { select: { status: true, expiresAt: true } },
        },
      });
      if (
        !intent?.secretNamespaceId ||
        intent.dispatchAttemptId !== input.attemptId ||
        intent.executorOwner !== input.executorOwner ||
        !intent.executorLeaseExpiresAt ||
        intent.executorLeaseExpiresAt <= now ||
        !intent.accountIdentityHash ||
        intent.accountIdentityAlgorithm !==
          "provider_issuer_subject_account_v1" ||
        intent.status !== "pending" ||
        intent.mutationEpoch === null ||
        intent.providerInstance.activeLeaseId !== intent.leaseId ||
        intent.lease.status !== "finalized"
      ) {
        throw new Error("codex_rotating_versioned_attempt_mismatch");
      }
      await assertDatabaseIncarnation(
        tx,
        intent.databaseIncarnation,
        intent.databaseRecoveryWitness,
        this.options.databaseRecoveryWitness,
      );
      try {
        assertProviderSecretTransitionAuthorized({
          expectedOwner: "runtime",
          expectedOwnerId: intent.leaseId,
          expectedEpoch: intent.mutationEpoch,
          actualFence: {
            owner:
              intent.providerInstance.mutationOwner === "setup" ||
              intent.providerInstance.mutationOwner === "runtime" ||
              intent.providerInstance.mutationOwner === "recovery"
                ? intent.providerInstance.mutationOwner
                : null,
            ownerId: intent.providerInstance.mutationOwnerId,
            epoch: intent.providerInstance.mutationEpoch,
          },
          authorizationExpiresAt:
            intent.providerInstance.activeLeaseExpiresAt &&
            intent.providerInstance.activeLeaseExpiresAt <
              intent.lease.expiresAt
              ? intent.providerInstance.activeLeaseExpiresAt
              : intent.lease.expiresAt,
          now,
        });
      } catch {
        throw new Error("codex_rotating_versioned_confirmation_stale_epoch");
      }
      const databaseAuthoritySignature = await signDatabaseAuthorityChallenge({
        tx,
        authority: this.requireDatabaseEffectAuthority(),
        effect: "runtime_confirmation",
        ownerId: input.intentId,
        effectCode: input.statusCode,
      });
      await tx.$executeRaw`
        SELECT "codex_oauth_authorize_runtime_confirmation"(
          ${input.intentId}, ${input.executorOwner}, ${input.statusCode},
          ${databaseAuthoritySignature}
        )
      `;
      const updated = await tx.codexOAuthWritebackIntent.updateMany({
        where: {
          id: input.intentId,
          dispatchAttemptId: input.attemptId,
          status: "pending",
        },
        data: {
          safeErrorCode: RuntimeVersionedDurableMarker.ProviderConfirmedV1,
          providerResponseCode: input.statusCode,
          providerConfirmedAt: now,
        },
      });
      if (updated.count !== 1) {
        throw new Error("codex_rotating_versioned_confirmation_conflict");
      }
      const reusesActiveNamespace =
        intent.secretNamespaceId ===
        intent.providerInstance.activeSecretNamespaceId;
      if (reusesActiveNamespace) {
        if (intent.secretNamespace?.status !== "active") {
          throw new Error(
            "codex_rotating_versioned_namespace_confirmation_conflict",
          );
        }
      } else {
        const confirmedNamespace =
          await tx.codexOAuthSecretNamespace.updateMany({
            where: {
              id: intent.secretNamespaceId,
              status: "dispatch_authorized",
            },
            data: { status: "confirmed_candidate", confirmedAt: now },
          });
        if (confirmedNamespace.count !== 1) {
          throw new Error(
            "codex_rotating_versioned_namespace_confirmation_conflict",
          );
        }
      }
    });
  }

  async retireAmbiguousVersionedWriteback(input: {
    readonly intentId: string;
    readonly attemptId: string;
    readonly executorOwner: string;
    readonly retirementIdentity: import("@reviewrouter/features-codex-oauth-rotating").RuntimeVersionedWritebackIdentity;
    readonly safeErrorCode: string;
  }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const locator = await tx.codexOAuthWritebackIntent.findUnique({
        where: { id: input.intentId },
        select: { providerInstanceRowId: true, dispatchAttemptId: true },
      });
      if (!locator || locator.dispatchAttemptId !== input.attemptId) return;
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "CodexOAuthProviderInstance"
        WHERE "id" = ${locator.providerInstanceRowId} FOR UPDATE
      `);
      const now = await this.transactionClock.now(tx);
      const intent = await tx.codexOAuthWritebackIntent.findUnique({
        where: { id: input.intentId },
        select: {
          providerInstanceRowId: true,
          providerInstanceId: true,
          leaseId: true,
          dispatchAttemptId: true,
          secretNamespaceId: true,
          status: true,
          mutationEpoch: true,
          generation: true,
          latestGenerationHash: true,
          accountIdentityHash: true,
          databaseIncarnation: true,
          databaseRecoveryWitness: true,
          executorOwner: true,
          executorLeaseExpiresAt: true,
          providerInstance: {
            select: {
              activeSecretNamespaceId: true,
              mutationEpoch: true,
              mutationOwner: true,
              mutationOwnerId: true,
              activeAccountIdentityHash: true,
            },
          },
        },
      });
      if (!intent || intent.dispatchAttemptId !== input.attemptId) return;
      if (intent.executorOwner !== input.executorOwner) {
        throw new Error("codex_rotating_versioned_executor_lease_conflict");
      }
      if (
        !intent.executorLeaseExpiresAt ||
        intent.mutationEpoch === null ||
        !intent.secretNamespaceId ||
        !intent.accountIdentityHash
      ) {
        throw new Error("codex_rotating_versioned_attempt_epoch_missing");
      }
      const persistedRetirementIdentity = {
        providerInstanceId: intent.providerInstanceId,
        mutationOwner: "runtime" as const,
        mutationOwnerId: intent.leaseId,
        mutationEpoch: intent.mutationEpoch,
        namespaceId: intent.secretNamespaceId,
        generation: intent.generation,
        latestGenerationHash: intent.latestGenerationHash,
        accountIdentityHash: intent.accountIdentityHash,
      };
      assertSameRuntimeVersionedWritebackIdentity({
        expected: persistedRetirementIdentity,
        actual: input.retirementIdentity,
      });
      await assertDatabaseIncarnation(
        tx,
        intent.databaseIncarnation,
        intent.databaseRecoveryWitness,
        this.options.databaseRecoveryWitness,
      );
      if (
        intent.status === "completed" ||
        intent.status === "remote_outcome_unknown"
      )
        return;
      try {
        assertRuntimeVersionedAmbiguousRetirementAuthorized({
          expected: persistedRetirementIdentity,
          actual: {
            ...persistedRetirementIdentity,
            mutationOwner:
              intent.providerInstance.mutationOwner === "setup" ||
              intent.providerInstance.mutationOwner === "runtime" ||
              intent.providerInstance.mutationOwner === "recovery"
                ? intent.providerInstance.mutationOwner
                : null,
            mutationOwnerId: intent.providerInstance.mutationOwnerId,
            mutationEpoch: intent.providerInstance.mutationEpoch,
            accountIdentityHash:
              intent.providerInstance.activeAccountIdentityHash,
          },
          executorLeaseExpiresAt: intent.executorLeaseExpiresAt,
          now,
        });
      } catch {
        throw new Error("codex_rotating_versioned_retirement_fence_conflict");
      }
      const reusesActiveNamespace =
        intent.secretNamespaceId ===
        intent.providerInstance.activeSecretNamespaceId;
      if (!reusesActiveNamespace) {
        const retiredNamespace = await tx.codexOAuthSecretNamespace.updateMany({
          where: {
            id: intent.secretNamespaceId,
            status: { in: ["dispatch_authorized", "confirmed_candidate"] },
          },
          data: {
            status: "retired_ambiguous",
            permanentlyRetired: true,
            retiredAt: now,
          },
        });
        if (retiredNamespace.count !== 1) {
          throw new Error(
            "codex_rotating_versioned_retirement_namespace_conflict",
          );
        }
      }
      const retiredIntent = await tx.codexOAuthWritebackIntent.updateMany({
        where: { id: input.intentId, status: { not: "completed" } },
        data: {
          status: "remote_outcome_unknown",
          safeErrorCode: input.safeErrorCode,
          ...(reusesActiveNamespace ? {} : { namespaceRetiredAt: now }),
        },
      });
      if (retiredIntent.count !== 1) {
        throw new Error("codex_rotating_versioned_retirement_intent_conflict");
      }
      const recoveredProvider = await tx.codexOAuthProviderInstance.updateMany({
        where: {
          id: intent.providerInstanceRowId,
          mutationEpoch: intent.mutationEpoch,
          mutationOwner: "runtime",
          mutationOwnerId: intent.leaseId,
        },
        data: {
          state: "unknown_auth_state",
          activeLeaseId: null,
          activeLeaseExpiresAt: null,
          mutationEpoch: { increment: 1 },
          mutationOwner: "recovery",
          mutationOwnerId: input.intentId,
        },
      });
      if (recoveredProvider.count !== 1) {
        throw new Error("codex_rotating_versioned_retirement_fence_conflict");
      }
      const retiredLease = await tx.codexOAuthLease.updateMany({
        where: {
          id: intent.leaseId,
          status: { in: ["preleased", "finalized"] },
        },
        data: { status: "unknown_auth_state", expiresAt: now },
      });
      if (retiredLease.count !== 1) {
        throw new Error("codex_rotating_versioned_retirement_lease_conflict");
      }
    });
  }

  async retirePreDispatchVersionedWriteback(input: {
    readonly intentId: string;
    readonly attemptId: string;
    readonly executorOwner: string;
    readonly safeErrorCode: string;
  }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const locator = await tx.codexOAuthWritebackIntent.findUnique({
        where: { id: input.intentId },
        select: { providerInstanceRowId: true, dispatchAttemptId: true },
      });
      if (!locator || locator.dispatchAttemptId !== input.attemptId) return;
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "CodexOAuthProviderInstance"
        WHERE "id" = ${locator.providerInstanceRowId} FOR UPDATE
      `);
      const now = await this.transactionClock.now(tx);
      const intent = await tx.codexOAuthWritebackIntent.findUnique({
        where: { id: input.intentId },
        select: {
          providerInstanceRowId: true,
          leaseId: true,
          dispatchAttemptId: true,
          secretNamespaceId: true,
          status: true,
          providerConfirmedAt: true,
          mutationEpoch: true,
          databaseIncarnation: true,
          databaseRecoveryWitness: true,
          executorOwner: true,
          executorLeaseExpiresAt: true,
          providerInstance: { select: { activeSecretNamespaceId: true } },
        },
      });
      if (!intent || intent.dispatchAttemptId !== input.attemptId) return;
      if (
        intent.executorOwner !== input.executorOwner ||
        !intent.executorLeaseExpiresAt ||
        intent.executorLeaseExpiresAt <= now
      ) {
        throw new Error("codex_rotating_versioned_executor_lease_conflict");
      }
      await assertDatabaseIncarnation(
        tx,
        intent.databaseIncarnation,
        intent.databaseRecoveryWitness,
        this.options.databaseRecoveryWitness,
      );
      if (intent.status === "failed") return;
      if (
        intent.status !== "pending" ||
        intent.providerConfirmedAt !== null ||
        intent.mutationEpoch === null ||
        !intent.secretNamespaceId
      ) {
        throw new Error(
          "codex_rotating_versioned_predispatch_retirement_conflict",
        );
      }
      const reusesActiveNamespace =
        intent.secretNamespaceId ===
        intent.providerInstance.activeSecretNamespaceId;
      if (!reusesActiveNamespace) {
        const retiredNamespace = await tx.codexOAuthSecretNamespace.updateMany({
          where: {
            id: intent.secretNamespaceId,
            status: "dispatch_authorized",
          },
          data: {
            status: "retired_predispatch",
            permanentlyRetired: true,
            retiredAt: now,
          },
        });
        if (retiredNamespace.count !== 1) {
          throw new Error(
            "codex_rotating_versioned_retirement_namespace_conflict",
          );
        }
      }
      const retiredIntent = await tx.codexOAuthWritebackIntent.updateMany({
        where: {
          id: input.intentId,
          dispatchAttemptId: input.attemptId,
          status: "pending",
          providerConfirmedAt: null,
        },
        data: {
          status: "failed",
          safeErrorCode: input.safeErrorCode,
          ...(reusesActiveNamespace ? {} : { namespaceRetiredAt: now }),
          completedAt: now,
        },
      });
      if (retiredIntent.count !== 1) {
        throw new Error("codex_rotating_versioned_retirement_intent_conflict");
      }
      const releasedProvider = await tx.codexOAuthProviderInstance.updateMany({
        where: {
          id: intent.providerInstanceRowId,
          mutationEpoch: intent.mutationEpoch,
          mutationOwner: "runtime",
          mutationOwnerId: intent.leaseId,
        },
        data: {
          state: "active",
          activeLeaseId: null,
          activeLeaseExpiresAt: null,
          mutationEpoch: { increment: 1 },
        },
      });
      if (releasedProvider.count !== 1) {
        throw new Error("codex_rotating_versioned_retirement_fence_conflict");
      }
      const clearedOwner = await tx.codexOAuthProviderInstance.updateMany({
        where: {
          id: intent.providerInstanceRowId,
          mutationEpoch: intent.mutationEpoch + 1n,
          mutationOwner: "runtime",
          mutationOwnerId: intent.leaseId,
        },
        data: { mutationOwner: null, mutationOwnerId: null },
      });
      if (clearedOwner.count !== 1) {
        throw new Error("codex_rotating_versioned_retirement_release_failed");
      }
      const retiredLease = await tx.codexOAuthLease.updateMany({
        where: {
          id: intent.leaseId,
          status: "finalized",
          mutationEpoch: intent.mutationEpoch,
        },
        data: { status: "failed", expiresAt: now },
      });
      if (retiredLease.count !== 1) {
        throw new Error("codex_rotating_versioned_retirement_lease_conflict");
      }
    });
  }

  async activateVersionedWriteback(input: {
    readonly intentId: string;
    readonly attemptId: string;
    readonly executorOwner: string;
    readonly attestation: VersionedSecretWorkflowSourceAttestation;
  }): Promise<{ readonly generation: number }> {
    return this.prisma.$transaction(async (tx) => {
      const locator = await tx.codexOAuthWritebackIntent.findUniqueOrThrow({
        where: { id: input.intentId },
        select: { providerInstanceRowId: true },
      });
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "CodexOAuthProviderInstance"
        WHERE "id" = ${locator.providerInstanceRowId} FOR UPDATE
      `);
      const now = await this.transactionClock.now(tx);
      const intent = await tx.codexOAuthWritebackIntent.findUniqueOrThrow({
        where: { id: input.intentId },
        select: {
          id: true,
          leaseId: true,
          generation: true,
          latestGenerationHash: true,
          accountIdentityHash: true,
          accountIdentityAlgorithm: true,
          mutationEpoch: true,
          dispatchAttemptId: true,
          providerResponseCode: true,
          providerConfirmedAt: true,
          databaseIncarnation: true,
          databaseRecoveryWitness: true,
          executorOwner: true,
          executorLeaseExpiresAt: true,
          secretNamespace: true,
          providerInstance: {
            select: {
              id: true,
              providerInstanceId: true,
              activeLeaseId: true,
              activeLeaseExpiresAt: true,
              activeSecretNamespaceId: true,
              mutationEpoch: true,
              mutationOwner: true,
              mutationOwnerId: true,
            },
          },
          lease: { select: { status: true, expiresAt: true } },
        },
      });
      const namespace = intent.secretNamespace;
      await assertDatabaseIncarnation(
        tx,
        intent.databaseIncarnation,
        intent.databaseRecoveryWitness,
        this.options.databaseRecoveryWitness,
      );
      if (
        intent.mutationEpoch === null ||
        intent.executorOwner !== input.executorOwner ||
        !intent.executorLeaseExpiresAt ||
        intent.executorLeaseExpiresAt <= now ||
        intent.lease.status !== "finalized"
      ) {
        throw new Error("codex_rotating_versioned_activation_stale_epoch");
      }
      try {
        assertProviderSecretTransitionAuthorized({
          expectedOwner: "runtime",
          expectedOwnerId: intent.leaseId,
          expectedEpoch: intent.mutationEpoch,
          actualFence: {
            owner:
              intent.providerInstance.mutationOwner === "setup" ||
              intent.providerInstance.mutationOwner === "runtime" ||
              intent.providerInstance.mutationOwner === "recovery"
                ? intent.providerInstance.mutationOwner
                : null,
            ownerId: intent.providerInstance.mutationOwnerId,
            epoch: intent.providerInstance.mutationEpoch,
          },
          authorizationExpiresAt:
            intent.providerInstance.activeLeaseExpiresAt &&
            intent.providerInstance.activeLeaseExpiresAt <
              intent.lease.expiresAt
              ? intent.providerInstance.activeLeaseExpiresAt
              : intent.lease.expiresAt,
          now,
        });
      } catch {
        throw new Error("codex_rotating_versioned_activation_stale_epoch");
      }
      if (
        intent.dispatchAttemptId !== input.attemptId ||
        !intent.accountIdentityHash ||
        intent.accountIdentityAlgorithm !==
          "provider_issuer_subject_account_v1" ||
        !intent.providerConfirmedAt ||
        (intent.providerResponseCode !== 201 &&
          intent.providerResponseCode !== 204) ||
        !namespace ||
        (namespace.status !== "confirmed_candidate" &&
          !(
            namespace.status === "active" &&
            intent.providerInstance.activeSecretNamespaceId === namespace.id
          )) ||
        intent.providerInstance.activeLeaseId !== intent.leaseId ||
        intent.providerInstance.mutationEpoch !== intent.mutationEpoch ||
        intent.providerInstance.mutationOwner !== "runtime" ||
        intent.providerInstance.mutationOwnerId !== intent.leaseId
      ) {
        throw new Error("codex_rotating_versioned_activation_stale_epoch");
      }
      const expectedNamespace = {
        mode: input.attestation.secretNamespace.mode,
        scope: {
          repositoryId: namespace.githubRepositoryId,
          providerInstanceId: intent.providerInstance.providerInstanceId,
        },
        namespaceId: namespace.id,
        name: namespace.secretName,
        epoch: namespace.namespaceEpoch,
      } as const;
      assertSameVersionedProviderSecretNamespace({
        expected: expectedNamespace,
        actual: input.attestation.secretNamespace,
      });
      if (
        input.attestation.repositoryId !== namespace.githubRepositoryId ||
        input.attestation.sourceTrust !== "trusted_default_branch_revision"
      ) {
        throw new Error("codex_rotating_versioned_attestation_invalid");
      }
      const databaseAuthoritySignature = await signDatabaseAuthorityChallenge({
        tx,
        authority: this.requireDatabaseEffectAuthority(),
        effect: "runtime_completion",
        ownerId: intent.id,
        effectCode: 0,
      });
      await tx.$executeRaw`
        SELECT "codex_oauth_authorize_runtime_completion"(
          ${intent.id}, ${databaseAuthoritySignature}
        )
      `;
      const reusesActiveNamespace =
        intent.providerInstance.activeSecretNamespaceId === namespace.id;
      if (!reusesActiveNamespace) {
        await tx.codexOAuthSecretNamespace.updateMany({
          where: {
            providerInstanceRowId: locator.providerInstanceRowId,
            status: "active",
            id: { not: namespace.id },
          },
          data: {
            status: "retired_superseded",
            permanentlyRetired: true,
            retiredAt: now,
          },
        });
        // Active namespace evidence is immutable. Runtime refreshes only
        // re-attest it; setup/recovery owns namespace promotion and mutation.
        await tx.codexOAuthSecretNamespace.update({
          where: { id: namespace.id },
          data: {
            status: "active",
            workflowPath: input.attestation.workflowPath,
            workflowSourceCommitSha: input.attestation.workflowSourceCommitSha,
            workflowSourceBlobSha: input.attestation.workflowSourceBlobSha,
            workflowSourceSha256: input.attestation.workflowSourceSha256,
            workflowSemanticSha256: input.attestation.workflowSemanticSha256,
            workflowSourceTrust: input.attestation.sourceTrust,
            workflowSchemaVersion: input.attestation.workflowSchemaVersion,
            attestedRepositoryId: input.attestation.repositoryId,
            activatedAt: now,
          },
        });
      }
      await tx.codexOAuthProviderInstance.update({
        where: { id: locator.providerInstanceRowId },
        data: {
          activeSecretNamespaceId: namespace.id,
          activeSecretNamespaceEpoch: namespace.namespaceEpoch,
          activeSecretNamespaceName: namespace.secretName,
          latestGeneration: intent.generation,
          latestGenerationHash: intent.latestGenerationHash,
          activeAccountIdentityHash: intent.accountIdentityHash,
          state: "active",
          activeLeaseId: null,
          activeLeaseExpiresAt: null,
          mutationEpoch: { increment: 1 },
        },
      });
      const released = await tx.codexOAuthProviderInstance.updateMany({
        where: {
          id: locator.providerInstanceRowId,
          mutationOwner: "runtime",
          mutationOwnerId: intent.leaseId,
          mutationEpoch: intent.mutationEpoch + 1n,
        },
        data: { mutationOwner: null, mutationOwnerId: null },
      });
      if (released.count !== 1) {
        throw new Error("codex_rotating_versioned_activation_release_failed");
      }
      const completedLease = await tx.codexOAuthLease.updateMany({
        where: {
          id: intent.leaseId,
          status: "finalized",
          mutationEpoch: intent.mutationEpoch,
        },
        data: {
          status: "completed",
          completedAt: now,
          secretNamespaceId: namespace.id,
          secretNamespaceEpoch: namespace.namespaceEpoch,
        },
      });
      if (completedLease.count !== 1) {
        throw new Error("codex_rotating_versioned_activation_stale_epoch");
      }
      await tx.codexOAuthWritebackIntent.update({
        where: { id: intent.id },
        data: { status: "completed", completedAt: now },
      });
      return { generation: intent.generation };
    });
  }

  async findCompletedLeaseWriteTarget(input: {
    readonly leaseId: string;
    readonly providerInstanceId: string;
    readonly now: Date;
    readonly completedLeaseTtlMs?: number | undefined;
  }): Promise<
    | {
        readonly status: "ready";
        readonly writeTarget: CodexRotatingSecretWriteTarget;
      }
    | {
        readonly status: "lease_not_completed" | "lease_not_active";
      }
  > {
    const context = await this.findCompletedLeaseContext(input);
    if (context.status !== "ready") return context;
    return {
      status: "ready" as const,
      writeTarget: toSecretWriteTarget(context.repository, context.secretName),
    };
  }

  async authorizeReviewSnapshotAccess(input: {
    readonly leaseId: string;
    readonly providerInstanceId: string;
    readonly pullRequestNumber: number;
    readonly now: Date;
  }) {
    const context = await this.findCompletedLeaseContext({
      ...input,
      completedLeaseTtlMs: codexRotatingReviewSnapshotAccessTtlMs,
    });
    if (
      context.status !== "ready" ||
      context.pullRequestNumber !== input.pullRequestNumber
    ) {
      return { status: "lease_not_active" as const };
    }
    return {
      status: "ready" as const,
      scope: {
        workspaceId: context.repository.workspaceId,
        repositoryId: context.repository.id,
        sourceRunId: context.sourceRunId,
        sourceRunAttempt: context.sourceRunAttempt,
        pullRequestNumber: context.pullRequestNumber,
      },
    };
  }

  async authorizeReviewExecutionCheckpointAccess(input: {
    readonly leaseId: string;
    readonly providerInstanceId: string;
    readonly pullRequestNumber: number;
    readonly now: Date;
  }) {
    const context = await this.findCompletedLeaseContext({
      ...input,
      completedLeaseTtlMs: codexRotatingReviewExecutionCheckpointAccessTtlMs,
    });
    if (
      context.status !== "ready" ||
      context.pullRequestNumber !== input.pullRequestNumber
    ) {
      return { status: "lease_not_active" as const };
    }
    return {
      status: "ready" as const,
      scope: {
        workspaceId: context.repository.workspaceId,
        repositoryId: context.repository.id,
        sourceRunId: context.sourceRunId,
        sourceRunAttempt: context.sourceRunAttempt,
        pullRequestNumber: context.pullRequestNumber,
      },
    };
  }

  private async findCompletedLeaseContext(input: {
    readonly leaseId: string;
    readonly providerInstanceId: string;
    readonly now: Date;
    readonly completedLeaseTtlMs?: number | undefined;
  }) {
    const lease = await this.prisma.codexOAuthLease.findFirst({
      where: {
        id: input.leaseId,
        providerInstanceId: input.providerInstanceId,
      },
      select: {
        repository: { select: codexRotatingRepositoryContextSelect },
        workspaceId: true,
        status: true,
        expiresAt: true,
        completedAt: true,
        githubRunId: true,
        githubRunAttempt: true,
        pullRequestNumber: true,
        secretNamespaceId: true,
        secretNamespaceEpoch: true,
        providerInstance: {
          select: {
            activeSecretNamespaceId: true,
            activeSecretNamespaceEpoch: true,
            activeSecretNamespaceName: true,
            activeSecretNamespace: {
              select: {
                secretName: true,
                status: true,
                databaseRecoveryWitness: true,
              },
            },
          },
        },
      },
    });
    if (!lease) {
      return { status: "lease_not_active" as const };
    }
    if (lease.status !== "completed" || !lease.completedAt) {
      if (lease.expiresAt <= input.now) {
        return { status: "lease_not_active" as const };
      }
      return { status: "lease_not_completed" as const };
    }
    if (
      !isCodexRotatingCompletedLeasePostingWindowActive({
        completedAt: lease.completedAt,
        now: input.now,
        ...(input.completedLeaseTtlMs
          ? { ttlMs: input.completedLeaseTtlMs }
          : {}),
      })
    ) {
      return { status: "lease_not_active" as const };
    }
    const repository = requireGitHubRepositoryContext(lease.repository);
    if (repository.workspaceId !== lease.workspaceId) {
      return { status: "lease_not_active" as const };
    }
    const completedNamespace = requireActiveNamespaceBinding(
      lease.providerInstance,
    );
    assertAutomaticRuntimeDatabaseRecoveryWitness(
      lease.providerInstance.activeSecretNamespace?.databaseRecoveryWitness,
      this.options.databaseRecoveryWitness,
    );
    if (
      completedNamespace.id !== null &&
      (lease.secretNamespaceId !== completedNamespace.id ||
        lease.secretNamespaceEpoch !== completedNamespace.epoch)
    ) {
      return { status: "lease_not_active" as const };
    }
    return {
      status: "ready" as const,
      repository,
      secretName: requireActiveSecretNamespace(lease.providerInstance),
      sourceRunId: lease.githubRunId,
      sourceRunAttempt: lease.githubRunAttempt,
      pullRequestNumber: lease.pullRequestNumber,
    };
  }
}

type CodexRotatingRepositoryContextRow = Prisma.RepositoryConnectionGetPayload<{
  select: typeof codexRotatingRepositoryContextSelect;
}>;

type GitHubCodexRotatingRepositoryContextRow =
  CodexRotatingRepositoryContextRow & {
    readonly provider: "github";
    readonly githubRepositoryId: bigint;
    readonly installation: NonNullable<
      CodexRotatingRepositoryContextRow["installation"]
    >;
  };

function requireGitHubRepositoryContext(
  repository: CodexRotatingRepositoryContextRow,
): GitHubCodexRotatingRepositoryContextRow {
  if (
    repository.provider !== "github" ||
    !repository.githubRepositoryId ||
    !repository.installation
  ) {
    throw new Error("codex_rotating_repository_not_github");
  }
  return repository as GitHubCodexRotatingRepositoryContextRow;
}

function toActionRepositoryContext(
  repository: GitHubCodexRotatingRepositoryContextRow,
): ActionRepositoryContext {
  return {
    workspaceId: repository.workspaceId,
    repositoryId: repository.id,
    githubRepositoryId: repository.githubRepositoryId.toString(),
    githubInstallationId:
      repository.installation.githubInstallationId.toString(),
    fullName: repository.fullName,
    owner: repository.owner,
    selected: repository.selected,
    installationStatus: repository.installation.status,
  };
}

function toSecretWriteTarget(
  repository: GitHubCodexRotatingRepositoryContextRow,
  secretName: string,
): CodexRotatingSecretWriteTarget {
  return {
    expectedProviderInstanceId: `codex-rotating:${repository.githubRepositoryId.toString()}`,
    githubInstallationId:
      repository.installation.githubInstallationId.toString(),
    githubRepositoryId: repository.githubRepositoryId.toString(),
    repositoryFullName: repository.fullName,
    owner: repository.owner,
    repo: repository.name,
    secretName,
  };
}

function requireActiveSecretNamespace(provider: {
  readonly activeSecretNamespaceId: string | null;
  readonly activeSecretNamespaceName: string | null;
  readonly activeSecretNamespace: {
    readonly secretName: string;
    readonly status: string;
  } | null;
}): string {
  let validName = false;
  try {
    if (provider.activeSecretNamespace) {
      parseVersionedProviderSecretName(
        provider.activeSecretNamespace.secretName,
      );
      validName = true;
    }
  } catch {
    validName = false;
  }
  if (
    !provider.activeSecretNamespaceId ||
    provider.activeSecretNamespaceName !==
      provider.activeSecretNamespace?.secretName ||
    provider.activeSecretNamespace?.status !== "active" ||
    !validName
  ) {
    throw new Error("codex_rotating_active_secret_namespace_required");
  }
  return provider.activeSecretNamespace.secretName;
}

function requireActiveNamespaceBinding(provider: {
  readonly activeSecretNamespaceId: string | null;
  readonly activeSecretNamespaceEpoch: bigint | null;
  readonly activeSecretNamespaceName: string | null;
  readonly activeSecretNamespace: {
    readonly secretName: string;
    readonly status: string;
  } | null;
}): { readonly id: string | null; readonly epoch: bigint | null } {
  requireActiveSecretNamespace(provider);
  if (!provider.activeSecretNamespaceId) return { id: null, epoch: null };
  if (provider.activeSecretNamespaceEpoch === null) {
    throw new Error("codex_rotating_active_secret_namespace_required");
  }
  return {
    id: provider.activeSecretNamespaceId,
    epoch: provider.activeSecretNamespaceEpoch,
  };
}

type LockedWorkflowAdmissionRow = Readonly<{
  id: string;
  githubRepositoryId: string;
  namespaceEpoch: bigint;
  secretName: string;
  status: string;
  permanentlyRetired: boolean;
  workflowPath: string | null;
  workflowSourceCommitSha: string | null;
  workflowSourceBlobSha: string | null;
  workflowSourceSha256: string | null;
  workflowSemanticSha256: string | null;
  workflowSourceTrust: string | null;
  workflowSchemaVersion: number | null;
  attestedRepositoryId: string | null;
}>;

function assertLockedWorkflowAdmissionMatches(input: {
  readonly persisted: LockedWorkflowAdmissionRow | null;
  readonly activeNamespace: {
    readonly id: string | null;
    readonly epoch: bigint | null;
  };
  readonly verified: VersionedSecretWorkflowSourceAttestation;
}): void {
  const { persisted, activeNamespace, verified } = input;
  if (
    !persisted ||
    persisted.status !== "active" ||
    persisted.permanentlyRetired ||
    activeNamespace.id !== persisted.id ||
    activeNamespace.epoch !== persisted.namespaceEpoch ||
    verified.secretNamespace.namespaceId !== persisted.id ||
    verified.secretNamespace.epoch !== persisted.namespaceEpoch ||
    verified.secretNamespace.name !== persisted.secretName ||
    verified.repositoryId !== persisted.githubRepositoryId ||
    verified.repositoryId !== persisted.attestedRepositoryId ||
    verified.workflowPath !== persisted.workflowPath ||
    !persisted.workflowSourceCommitSha ||
    verified.sourceTrust !== WorkflowSourceTrust.TrustedDefaultBranchRevision ||
    verified.workflowSourceBlobSha !== persisted.workflowSourceBlobSha ||
    verified.workflowSourceSha256 !== persisted.workflowSourceSha256 ||
    verified.workflowSemanticSha256 !== persisted.workflowSemanticSha256 ||
    persisted.workflowSourceTrust !==
      WorkflowSourceTrust.TrustedDefaultBranchRevision ||
    verified.workflowSchemaVersion !== persisted.workflowSchemaVersion
  ) {
    throw new Error("codex_rotating_workflow_attestation_stale");
  }
}

async function lockProviderByInstanceId(
  tx: Prisma.TransactionClient,
  providerInstanceId: string,
): Promise<void> {
  await setBoundedProviderRowWaits(tx);
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "CodexOAuthProviderInstance"
    WHERE "providerInstanceId" = ${providerInstanceId}
    FOR UPDATE
  `);
}

async function setBoundedProviderRowWaits(
  tx: Prisma.TransactionClient,
): Promise<void> {
  await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '2s'");
  await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '5s'");
}

async function readDatabaseIncarnation(
  tx: Prisma.TransactionClient,
): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ databaseIncarnation: string }>>(
    Prisma.sql`SELECT "system_identifier"::text AS "databaseIncarnation" FROM pg_control_system()`,
  );
  const value = rows[0]?.databaseIncarnation;
  if (!value || !/^[1-9][0-9]+$/.test(value)) {
    throw new Error("codex_rotating_database_incarnation_unproven");
  }
  return value;
}

async function assertDatabaseIncarnation(
  tx: Prisma.TransactionClient,
  expected: string | null,
  expectedRecoveryWitness: string | null,
  currentRecoveryWitness: string | undefined,
): Promise<void> {
  let currentWitnessFingerprint: string;
  try {
    currentWitnessFingerprint = fingerprintDatabaseRecoveryWitness(
      currentRecoveryWitness ?? "",
    );
  } catch {
    throw new Error("codex_rotating_database_recovery_witness_unproven");
  }
  if (
    !expected ||
    !expectedRecoveryWitness ||
    (await readDatabaseIncarnation(tx)) !== expected
  ) {
    throw new Error("codex_rotating_database_incarnation_mismatch");
  }
  assertExternalRecoveryWitnessAdmission({
    transition: "automatic_runtime",
    relation: classifyExternalRecoveryWitnessRelation({
      persistedFingerprint: expectedRecoveryWitness,
      currentFingerprint: currentWitnessFingerprint,
    }),
  });
}

function assertAutomaticRuntimeDatabaseRecoveryWitness(
  persistedFingerprint: string | null | undefined,
  currentRecoveryWitness: string | undefined,
): void {
  if (!persistedFingerprint) {
    throw new Error("codex_rotating_database_recovery_witness_unproven");
  }
  let currentFingerprint: string;
  try {
    currentFingerprint = fingerprintDatabaseRecoveryWitness(
      currentRecoveryWitness ?? "",
    );
  } catch {
    throw new Error("codex_rotating_database_recovery_witness_unproven");
  }
  assertExternalRecoveryWitnessAdmission({
    transition: "automatic_runtime",
    relation: classifyExternalRecoveryWitnessRelation({
      persistedFingerprint,
      currentFingerprint,
    }),
  });
}
