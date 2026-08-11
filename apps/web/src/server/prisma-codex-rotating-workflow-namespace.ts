import type { Prisma, PrismaClient } from "@prisma/client";
import {
  assertCodexRotatingSetupReady,
  assertCodexRotatingWorkflowCandidate,
  codexRotatingAuthMode,
  codexRotatingSetupNotReadyError,
  codexRotatingWorkflowNamespaceNotReadyError,
  fingerprintDatabaseRecoveryWitness,
  type CodexRotatingSetupReadinessTarget,
  type CodexRotatingWorkflowCandidateEvidence,
  type CodexRotatingWorkflowNamespaceInspection,
  type CodexRotatingWorkflowNamespacePort,
} from "@reviewrouter/features-provider-setup";
import { lockCodexRotatingProviderRow } from "./codex-rotating-provider-mutation-fence";
import { findCodexRotatingSetupReadinessEvidence } from "./prisma-codex-rotating-setup-readiness";

const transactionTimeoutMs = 10_000;

/**
 * Resolves only a current-witness setup candidate or fully active namespace.
 * Both reads are made while the canonical provider row is locked.
 */
export class PrismaCodexRotatingWorkflowNamespace implements CodexRotatingWorkflowNamespacePort {
  readonly #currentDatabaseRecoveryWitnessFingerprint: string | null;

  constructor(
    private readonly prisma: PrismaClient,
    configuredDatabaseRecoveryWitness: string | undefined,
    private readonly clock: Readonly<{ now(): Date }> = {
      now: () => new Date(),
    },
  ) {
    try {
      this.#currentDatabaseRecoveryWitnessFingerprint =
        fingerprintDatabaseRecoveryWitness(
          configuredDatabaseRecoveryWitness ?? "",
        );
    } catch {
      this.#currentDatabaseRecoveryWitnessFingerprint = null;
    }
  }

  async inspectWorkflowNamespace(
    target: CodexRotatingSetupReadinessTarget,
  ): Promise<CodexRotatingWorkflowNamespaceInspection> {
    const currentDatabaseRecoveryWitnessFingerprint =
      this.#currentDatabaseRecoveryWitnessFingerprint;
    if (currentDatabaseRecoveryWitnessFingerprint === null) {
      throw new Error(codexRotatingWorkflowNamespaceNotReadyError);
    }

    return this.prisma.$transaction(
      async (tx) => {
        const provider = await tx.codexOAuthProviderInstance.findUnique({
          where: {
            repositoryId_authMode: {
              repositoryId: target.repositoryId,
              authMode: codexRotatingAuthMode,
            },
          },
          select: { id: true },
        });
        if (!provider) {
          throw new Error(codexRotatingWorkflowNamespaceNotReadyError);
        }
        await lockCodexRotatingProviderRow(tx, provider.id);

        const activeEvidence = await findCodexRotatingSetupReadinessEvidence(
          tx,
          target,
          provider.id,
        );
        try {
          const namespace = assertCodexRotatingSetupReady({
            target,
            evidence: activeEvidence,
            currentDatabaseRecoveryWitnessFingerprint,
          });
          return {
            source: "active",
            claimId: activeEvidence!.claimId,
            attemptId: activeEvidence!.attemptId,
            namespace,
          };
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.message !== codexRotatingSetupNotReadyError
          ) {
            throw error;
          }
        }

        const candidateRows = await findWorkflowCandidateEvidence(
          tx,
          provider.id,
        );
        return assertCodexRotatingWorkflowCandidate({
          target,
          evidence: candidateRows.length === 1 ? candidateRows[0]! : null,
          currentDatabaseRecoveryWitnessFingerprint,
          now: this.clock.now(),
        });
      },
      { timeout: transactionTimeoutMs },
    );
  }
}

async function findWorkflowCandidateEvidence(
  tx: Prisma.TransactionClient,
  providerInstanceRowId: string,
): Promise<CodexRotatingWorkflowCandidateEvidence[]> {
  return tx.$queryRaw<CodexRotatingWorkflowCandidateEvidence[]>`
    SELECT
      provider."id" AS "providerInstanceRowId",
      provider."workspaceId" AS "providerWorkspaceId",
      provider."repositoryId" AS "providerRepositoryId",
      provider."providerInstanceId",
      provider."authMode" AS "providerAuthMode",
      provider."state" AS "providerState",
      provider."mutationOwner" AS "providerMutationOwner",
      provider."mutationOwnerId" AS "providerMutationOwnerId",
      provider."mutationEpoch" AS "providerMutationEpoch",
      provider."activeSecretNamespaceId" AS "providerActiveNamespaceId",
      provider."activeSecretNamespaceEpoch" AS "providerActiveNamespaceEpoch",
      provider."activeSecretNamespaceName" AS "providerActiveNamespaceName",
      retained_active_namespace."id" AS "retainedActiveNamespaceId",
      retained_active_namespace."providerInstanceRowId" AS "retainedActiveNamespaceProviderInstanceRowId",
      retained_active_namespace."githubRepositoryId" AS "retainedActiveNamespaceGithubRepositoryId",
      retained_active_namespace."namespaceEpoch" AS "retainedActiveNamespaceEpoch",
      retained_active_namespace."secretName" AS "retainedActiveNamespaceSecretName",
      retained_active_namespace."databaseRecoveryWitness" AS "retainedActiveNamespaceDatabaseRecoveryWitness",
      retained_active_namespace."status" AS "retainedActiveNamespaceStatus",
      retained_active_namespace."permanentlyRetired" AS "retainedActiveNamespacePermanentlyRetired",
      retained_active_namespace."activatedAt" AS "retainedActiveNamespaceActivatedAt",
      retained_active_namespace."retiredAt" AS "retainedActiveNamespaceRetiredAt",
      claim."id" AS "claimId",
      claim."providerInstanceRowId" AS "claimProviderInstanceRowId",
      claim."workspaceId" AS "claimWorkspaceId",
      claim."repositoryId" AS "claimRepositoryId",
      claim."githubRepositoryId" AS "claimGithubRepositoryId",
      claim."manifestId" AS "claimManifestId",
      claim."recoveryEpoch" AS "claimRecoveryEpoch",
      claim."status" AS "claimStatus",
      claim."accountIdentityAlgorithm" AS "claimAccountIdentityAlgorithm",
      claim."databaseRecoveryWitness" AS "claimDatabaseRecoveryWitness",
      claim."confirmedAttemptId" AS "claimConfirmedAttemptId",
      claim."confirmedAt" AS "claimConfirmedAt",
      claim."activatedAt" AS "claimActivatedAt",
      claim."recoveryExpiresAt" AS "claimRecoveryExpiresAt",
      attempt."id" AS "attemptId",
      attempt."claimId" AS "attemptClaimId",
      attempt."namespaceId" AS "attemptNamespaceId",
      attempt."status" AS "attemptStatus",
      attempt."definiteResponseCode" AS "attemptDefiniteResponseCode",
      attempt."confirmedAt" AS "attemptConfirmedAt",
      attempt."dispatchExpiresAt" AS "attemptDispatchExpiresAt",
      namespace."id" AS "namespaceId",
      namespace."providerInstanceRowId" AS "namespaceProviderInstanceRowId",
      namespace."githubRepositoryId" AS "namespaceGithubRepositoryId",
      namespace."namespaceEpoch",
      namespace."secretName" AS "namespaceSecretName",
      namespace."databaseRecoveryWitness" AS "namespaceDatabaseRecoveryWitness",
      namespace."status" AS "namespaceStatus",
      namespace."permanentlyRetired" AS "namespacePermanentlyRetired",
      namespace."confirmedAt" AS "namespaceConfirmedAt",
      namespace."activatedAt" AS "namespaceActivatedAt",
      manifest."id" AS "manifestId",
      manifest."providerInstanceRowId" AS "manifestProviderInstanceRowId",
      manifest."workspaceId" AS "manifestWorkspaceId",
      manifest."repositoryId" AS "manifestRepositoryId",
      manifest."providerInstanceId" AS "manifestProviderInstanceId",
      manifest."status" AS "manifestStatus",
      manifest."mutationEpoch" AS "manifestMutationEpoch",
      manifest."databaseRecoveryWitness" AS "manifestDatabaseRecoveryWitness",
      manifest."recoveryExpiresAt" AS "manifestRecoveryExpiresAt",
      manifest."consumedAt" AS "manifestConsumedAt"
    FROM "CodexOAuthProviderInstance" provider
    LEFT JOIN "CodexOAuthSecretNamespace" retained_active_namespace
      ON retained_active_namespace."id" = provider."activeSecretNamespaceId"
    JOIN "CodexOAuthSetupPayloadClaim" claim
      ON claim."providerInstanceRowId" = provider."id"
     AND claim."status" = 'confirmed_candidate'
    JOIN "CodexOAuthSetupDispatchAttempt" attempt
      ON attempt."id" = claim."confirmedAttemptId"
     AND attempt."claimId" = claim."id"
     AND attempt."status" = 'confirmed'
    JOIN "CodexOAuthSecretNamespace" namespace
      ON namespace."id" = attempt."namespaceId"
     AND namespace."providerInstanceRowId" = provider."id"
     AND namespace."status" = 'confirmed_candidate'
    JOIN "CodexOAuthSetupManifest" manifest
      ON manifest."id" = claim."manifestId"
     AND manifest."providerInstanceRowId" = provider."id"
    WHERE provider."id" = ${providerInstanceRowId}
    ORDER BY claim."recoveryEpoch" DESC, claim."id" DESC
    LIMIT 2
  `;
}
