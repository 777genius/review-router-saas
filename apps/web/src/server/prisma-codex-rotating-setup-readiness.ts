import type { Prisma, PrismaClient } from "@prisma/client";
import {
  assertCodexRotatingSetupReady,
  codexRotatingAuthMode,
  codexRotatingSetupNotReadyError,
  fingerprintDatabaseRecoveryWitness,
  type CodexRotatingSetupReadinessPort,
  type CodexRotatingSetupReadinessEvidence,
  type CodexRotatingSetupReadinessTarget,
  type ConfirmedCodexRotatingSetupReadiness,
} from "@reviewrouter/features-provider-setup";
import { lockCodexRotatingProviderRow } from "./codex-rotating-provider-mutation-fence";

const transactionTimeoutMs = 10_000;

/** Prisma adapter for the exact rotating readiness evidence transaction. */
export class PrismaCodexRotatingSetupReadiness implements CodexRotatingSetupReadinessPort {
  readonly #currentDatabaseRecoveryWitnessFingerprint: string | null;

  constructor(
    private readonly prisma: PrismaClient,
    configuredDatabaseRecoveryWitness: string | undefined,
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

  async inspectReady(
    target: CodexRotatingSetupReadinessTarget,
  ): Promise<ConfirmedCodexRotatingSetupReadiness> {
    return this.#readExactEvidence(target, false);
  }

  async confirmConfigured(
    target: CodexRotatingSetupReadinessTarget,
  ): Promise<ConfirmedCodexRotatingSetupReadiness> {
    return this.#readExactEvidence(target, true);
  }

  async #readExactEvidence(
    target: CodexRotatingSetupReadinessTarget,
    recordConfigured: boolean,
  ): Promise<ConfirmedCodexRotatingSetupReadiness> {
    const currentDatabaseRecoveryWitnessFingerprint =
      this.#currentDatabaseRecoveryWitnessFingerprint;
    if (currentDatabaseRecoveryWitnessFingerprint === null) {
      throw new Error(codexRotatingSetupNotReadyError);
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
          throw new Error("codex_rotating_setup_not_ready");
        }
        await lockCodexRotatingProviderRow(tx, provider.id);
        const evidence = await findCodexRotatingSetupReadinessEvidence(
          tx,
          target,
          provider.id,
        );
        const namespace = assertCodexRotatingSetupReady({
          target,
          evidence,
          currentDatabaseRecoveryWitnessFingerprint,
        });

        if (recordConfigured) {
          await tx.providerSetupState.upsert({
            where: {
              workspaceId_targetKey_providerKind_authMode: {
                workspaceId: target.workspaceId,
                targetKey: `repo:${target.repositoryId}`,
                providerKind: "codex",
                authMode: codexRotatingAuthMode,
              },
            },
            update: {
              repositoryId: target.repositoryId,
              state: "configured",
            },
            create: {
              workspaceId: target.workspaceId,
              repositoryId: target.repositoryId,
              targetKey: `repo:${target.repositoryId}`,
              providerKind: "codex",
              authMode: codexRotatingAuthMode,
              state: "configured",
            },
          });
        }

        return {
          claimId: evidence!.claimId,
          attemptId: evidence!.attemptId,
          namespaceId: namespace.namespaceId,
          namespaceEpoch: namespace.epoch,
        };
      },
      { timeout: transactionTimeoutMs },
    );
  }
}

export async function findCodexRotatingSetupReadinessEvidence(
  tx: Prisma.TransactionClient,
  target: CodexRotatingSetupReadinessTarget,
  providerInstanceRowId: string,
): Promise<CodexRotatingSetupReadinessEvidence | null> {
  const rows = await tx.$queryRaw<CodexRotatingSetupReadinessEvidence[]>`
    SELECT
      provider."id" AS "providerInstanceRowId",
      provider."workspaceId" AS "providerWorkspaceId",
      provider."repositoryId" AS "providerRepositoryId",
      provider."providerInstanceId",
      provider."authMode" AS "providerAuthMode",
      provider."state" AS "providerState",
      provider."mutationEpoch" AS "providerMutationEpoch",
      provider."latestGeneration" AS "providerLatestGeneration",
      provider."activeSecretNamespaceId" AS "providerActiveNamespaceId",
      provider."activeSecretNamespaceEpoch" AS "providerActiveNamespaceEpoch",
      provider."activeSecretNamespaceName" AS "providerActiveNamespaceName",
      provider."activeAccountIdentityHash" AS "providerActiveAccountIdentityHash",
      provider."latestGenerationHash" AS "providerLatestGenerationHash",
      claim."id" AS "claimId",
      claim."providerInstanceRowId" AS "claimProviderInstanceRowId",
      claim."workspaceId" AS "claimWorkspaceId",
      claim."repositoryId" AS "claimRepositoryId",
      claim."githubRepositoryId" AS "claimGithubRepositoryId",
      claim."manifestId" AS "claimManifestId",
      claim."recoveryEpoch" AS "claimRecoveryEpoch",
      claim."status" AS "claimStatus",
      claim."generationHash" AS "claimGenerationHash",
      claim."accountIdentityHash" AS "claimAccountIdentityHash",
      claim."databaseRecoveryWitness" AS "claimDatabaseRecoveryWitness",
      claim."confirmedAttemptId" AS "claimConfirmedAttemptId",
      claim."activatedAt" AS "claimActivatedAt",
      attempt."id" AS "attemptId",
      attempt."claimId" AS "attemptClaimId",
      attempt."namespaceId" AS "attemptNamespaceId",
      attempt."status" AS "attemptStatus",
      attempt."definiteResponseCode" AS "attemptDefiniteResponseCode",
      attempt."confirmedAt" AS "attemptConfirmedAt",
      setup_namespace."id" AS "setupNamespaceId",
      setup_namespace."providerInstanceRowId" AS "setupNamespaceProviderInstanceRowId",
      setup_namespace."githubRepositoryId" AS "setupNamespaceGithubRepositoryId",
      setup_namespace."namespaceEpoch" AS "setupNamespaceEpoch",
      setup_namespace."secretName" AS "setupNamespaceSecretName",
      setup_namespace."databaseRecoveryWitness" AS "setupNamespaceDatabaseRecoveryWitness",
      setup_namespace."status" AS "setupNamespaceStatus",
      setup_namespace."permanentlyRetired" AS "setupNamespacePermanentlyRetired",
      setup_namespace."workflowPath" AS "setupNamespaceWorkflowPath",
      setup_namespace."workflowSourceCommitSha" AS "setupNamespaceWorkflowSourceCommitSha",
      setup_namespace."workflowSourceBlobSha" AS "setupNamespaceWorkflowSourceBlobSha",
      setup_namespace."workflowSourceSha256" AS "setupNamespaceWorkflowSourceSha256",
      setup_namespace."workflowSemanticSha256" AS "setupNamespaceWorkflowSemanticSha256",
      setup_namespace."workflowSourceTrust" AS "setupNamespaceWorkflowSourceTrust",
      setup_namespace."attestedRepositoryId" AS "setupNamespaceAttestedRepositoryId",
      setup_namespace."activatedAt" AS "setupNamespaceActivatedAt",
      namespace."id" AS "namespaceId",
      namespace."providerInstanceRowId" AS "namespaceProviderInstanceRowId",
      namespace."githubRepositoryId" AS "namespaceGithubRepositoryId",
      namespace."namespaceEpoch",
      namespace."secretName" AS "namespaceSecretName",
      namespace."databaseRecoveryWitness" AS "namespaceDatabaseRecoveryWitness",
      namespace."status" AS "namespaceStatus",
      namespace."permanentlyRetired" AS "namespacePermanentlyRetired",
      namespace."workflowPath" AS "namespaceWorkflowPath",
      namespace."workflowSourceCommitSha" AS "namespaceWorkflowSourceCommitSha",
      namespace."workflowSourceBlobSha" AS "namespaceWorkflowSourceBlobSha",
      namespace."workflowSourceSha256" AS "namespaceWorkflowSourceSha256",
      namespace."workflowSemanticSha256" AS "namespaceWorkflowSemanticSha256",
      namespace."workflowSourceTrust" AS "namespaceWorkflowSourceTrust",
      namespace."attestedRepositoryId" AS "namespaceAttestedRepositoryId",
      namespace."activatedAt" AS "namespaceActivatedAt",
      runtime_intent."id" AS "runtimeIntentId",
      runtime_intent."providerInstanceRowId" AS "runtimeIntentProviderInstanceRowId",
      runtime_intent."secretNamespaceId" AS "runtimeIntentSecretNamespaceId",
      runtime_intent."dispatchAttemptId" AS "runtimeIntentDispatchAttemptId",
      runtime_intent."status" AS "runtimeIntentStatus",
      runtime_intent."mutationEpoch" AS "runtimeIntentMutationEpoch",
      runtime_intent."generation" AS "runtimeIntentGeneration",
      runtime_intent."latestGenerationHash" AS "runtimeIntentLatestGenerationHash",
      runtime_intent."accountIdentityHash" AS "runtimeIntentAccountIdentityHash",
      runtime_intent."accountIdentityAlgorithm" AS "runtimeIntentAccountIdentityAlgorithm",
      runtime_intent."databaseRecoveryWitness" AS "runtimeIntentDatabaseRecoveryWitness",
      runtime_intent."providerResponseCode" AS "runtimeIntentProviderResponseCode",
      runtime_intent."providerConfirmedAt" AS "runtimeIntentProviderConfirmedAt",
      runtime_intent."completedAt" AS "runtimeIntentCompletedAt",
      manifest."status" AS "manifestStatus",
      manifest."databaseRecoveryWitness" AS "manifestDatabaseRecoveryWitness",
      manifest."consumedAt" AS "manifestConsumedAt"
    FROM "CodexOAuthProviderInstance" provider
    JOIN "CodexOAuthSecretNamespace" namespace
      ON namespace."id" = provider."activeSecretNamespaceId"
    JOIN "CodexOAuthSetupPayloadClaim" claim
      ON claim."providerInstanceRowId" = provider."id"
     AND claim."status" = 'active'
    JOIN "CodexOAuthSetupDispatchAttempt" attempt
      ON attempt."id" = claim."confirmedAttemptId"
     AND attempt."claimId" = claim."id"
    JOIN "CodexOAuthSecretNamespace" setup_namespace
      ON setup_namespace."id" = attempt."namespaceId"
    JOIN "CodexOAuthSetupManifest" manifest
      ON manifest."id" = claim."manifestId"
    LEFT JOIN "CodexOAuthWritebackIntent" runtime_intent
      ON runtime_intent."secretNamespaceId" = namespace."id"
    WHERE provider."id" = ${providerInstanceRowId}
      AND provider."workspaceId" = ${target.workspaceId}
      AND provider."repositoryId" = ${target.repositoryId}
      AND provider."providerInstanceId" = ${target.providerInstanceId}
      AND (SELECT count(*) FROM "CodexOAuthSetupPayloadClaim" active_claim
           WHERE active_claim."providerInstanceRowId" = provider."id"
             AND active_claim."status" = 'active') = 1
      AND (SELECT count(*) FROM "CodexOAuthSecretNamespace" active_namespace
           WHERE active_namespace."providerInstanceRowId" = provider."id"
             AND active_namespace."status" = 'active') = 1
    LIMIT 1
  `;
  return rows[0] ?? null;
}
