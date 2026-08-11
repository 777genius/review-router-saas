import {
  canonicalCodexRotatingProviderId,
  codexRotatingAuthMode,
  createVersionedProviderSecretNamespace,
  classifyExternalRecoveryWitnessRelation,
  ExternalRecoveryWitnessRelation,
  type VersionedProviderSecretNamespace,
} from "@reviewrouter/features-codex-oauth-rotating";
import type {
  CodexRotatingSetupAttemptStatus,
  CodexRotatingSetupClaimStatus,
} from "./codex-rotating-setup-payload-claim";

export const codexRotatingSetupNotReadyError =
  "codex_rotating_setup_not_ready" as const;

/**
 * Durable, non-secret evidence needed to call rotating setup configured.
 * Adapters must read this tuple while holding the provider row lock.
 */
export type CodexRotatingSetupReadinessEvidence = Readonly<{
  providerInstanceRowId: string;
  providerWorkspaceId: string;
  providerRepositoryId: string;
  providerInstanceId: string;
  providerAuthMode: string;
  providerState: string;
  providerMutationEpoch: bigint;
  providerLatestGeneration: number;
  providerActiveNamespaceId: string | null;
  providerActiveNamespaceEpoch: bigint | null;
  providerActiveNamespaceName: string | null;
  providerActiveAccountIdentityHash: string | null;
  providerLatestGenerationHash: string | null;
  claimId: string;
  claimProviderInstanceRowId: string;
  claimWorkspaceId: string;
  claimRepositoryId: string;
  claimGithubRepositoryId: string;
  claimManifestId: string;
  claimRecoveryEpoch: bigint;
  claimStatus: CodexRotatingSetupClaimStatus;
  claimGenerationHash: string;
  claimAccountIdentityHash: string;
  claimDatabaseRecoveryWitness: string;
  claimConfirmedAttemptId: string | null;
  claimActivatedAt: Date | null;
  attemptId: string;
  attemptClaimId: string;
  attemptNamespaceId: string;
  attemptStatus: CodexRotatingSetupAttemptStatus;
  attemptDefiniteResponseCode: number | null;
  attemptConfirmedAt: Date | null;
  setupNamespaceId: string;
  setupNamespaceProviderInstanceRowId: string;
  setupNamespaceGithubRepositoryId: string;
  setupNamespaceEpoch: bigint;
  setupNamespaceSecretName: string;
  setupNamespaceDatabaseRecoveryWitness: string;
  setupNamespaceStatus: string;
  setupNamespacePermanentlyRetired: boolean;
  setupNamespaceWorkflowPath: string | null;
  setupNamespaceWorkflowSourceCommitSha: string | null;
  setupNamespaceWorkflowSourceBlobSha: string | null;
  setupNamespaceWorkflowSourceSha256: string | null;
  setupNamespaceWorkflowSemanticSha256: string | null;
  setupNamespaceWorkflowSourceTrust: string | null;
  setupNamespaceAttestedRepositoryId: string | null;
  setupNamespaceActivatedAt: Date | null;
  namespaceId: string;
  namespaceProviderInstanceRowId: string;
  namespaceGithubRepositoryId: string;
  namespaceEpoch: bigint;
  namespaceSecretName: string;
  namespaceDatabaseRecoveryWitness: string;
  namespaceStatus: string;
  namespacePermanentlyRetired: boolean;
  namespaceWorkflowPath: string | null;
  namespaceWorkflowSourceCommitSha: string | null;
  namespaceWorkflowSourceBlobSha: string | null;
  namespaceWorkflowSourceSha256: string | null;
  namespaceWorkflowSemanticSha256: string | null;
  namespaceWorkflowSourceTrust: string | null;
  namespaceAttestedRepositoryId: string | null;
  namespaceActivatedAt: Date | null;
  runtimeIntentId: string | null;
  runtimeIntentProviderInstanceRowId: string | null;
  runtimeIntentSecretNamespaceId: string | null;
  runtimeIntentDispatchAttemptId: string | null;
  runtimeIntentStatus: string | null;
  runtimeIntentMutationEpoch: bigint | null;
  runtimeIntentGeneration: number | null;
  runtimeIntentLatestGenerationHash: string | null;
  runtimeIntentAccountIdentityHash: string | null;
  runtimeIntentAccountIdentityAlgorithm: string | null;
  runtimeIntentDatabaseRecoveryWitness: string | null;
  runtimeIntentProviderResponseCode: number | null;
  runtimeIntentProviderConfirmedAt: Date | null;
  runtimeIntentCompletedAt: Date | null;
  manifestStatus: string;
  manifestDatabaseRecoveryWitness: string | null;
  manifestConsumedAt: Date | null;
}>;

export type CodexRotatingSetupReadinessTarget = Readonly<{
  workspaceId: string;
  repositoryId: string;
  githubRepositoryId: string;
  providerInstanceId: string;
}>;

/**
 * Proves that the exact server-authorized versioned PUT was definite and that
 * the same claim/attempt/namespace is the provider's activated authority.
 */
export function assertCodexRotatingSetupReady(input: {
  readonly target: CodexRotatingSetupReadinessTarget;
  readonly evidence: CodexRotatingSetupReadinessEvidence | null;
  readonly currentDatabaseRecoveryWitnessFingerprint: string;
}): VersionedProviderSecretNamespace {
  const evidence = input.evidence;
  const expectedProviderInstanceId = canonicalCodexRotatingProviderId(
    input.target.githubRepositoryId,
  );
  const setupNamespaceIsActive =
    evidence !== null && evidence.setupNamespaceId === evidence.namespaceId;
  if (
    !evidence ||
    input.target.providerInstanceId !== expectedProviderInstanceId ||
    evidence.providerInstanceId !== expectedProviderInstanceId ||
    evidence.providerWorkspaceId !== input.target.workspaceId ||
    evidence.providerRepositoryId !== input.target.repositoryId ||
    evidence.providerAuthMode !== codexRotatingAuthMode ||
    evidence.providerState !== "active" ||
    evidence.providerMutationEpoch <= 0n ||
    evidence.claimProviderInstanceRowId !== evidence.providerInstanceRowId ||
    evidence.claimWorkspaceId !== input.target.workspaceId ||
    evidence.claimRepositoryId !== input.target.repositoryId ||
    evidence.claimGithubRepositoryId !== input.target.githubRepositoryId ||
    evidence.claimRecoveryEpoch <= 0n ||
    evidence.claimStatus !== "active" ||
    !isMatchingRecoveryWitness(
      evidence.claimDatabaseRecoveryWitness,
      input.currentDatabaseRecoveryWitnessFingerprint,
    ) ||
    evidence.claimConfirmedAttemptId !== evidence.attemptId ||
    evidence.claimActivatedAt === null ||
    evidence.attemptClaimId !== evidence.claimId ||
    evidence.attemptNamespaceId !== evidence.setupNamespaceId ||
    evidence.attemptStatus !== "confirmed" ||
    (evidence.attemptDefiniteResponseCode !== 201 &&
      evidence.attemptDefiniteResponseCode !== 204) ||
    evidence.attemptConfirmedAt === null ||
    evidence.setupNamespaceProviderInstanceRowId !==
      evidence.providerInstanceRowId ||
    evidence.setupNamespaceGithubRepositoryId !==
      input.target.githubRepositoryId ||
    !isMatchingRecoveryWitness(
      evidence.setupNamespaceDatabaseRecoveryWitness,
      input.currentDatabaseRecoveryWitnessFingerprint,
    ) ||
    evidence.setupNamespaceWorkflowPath !==
      ".github/workflows/reviewrouter-codex.yml" ||
    evidence.setupNamespaceWorkflowSourceCommitSha === null ||
    evidence.setupNamespaceWorkflowSourceBlobSha === null ||
    evidence.setupNamespaceWorkflowSourceSha256 === null ||
    evidence.setupNamespaceWorkflowSemanticSha256 === null ||
    evidence.setupNamespaceWorkflowSourceTrust !==
      "trusted_default_branch_revision" ||
    evidence.setupNamespaceAttestedRepositoryId !==
      input.target.githubRepositoryId ||
    evidence.setupNamespaceActivatedAt === null ||
    evidence.namespaceProviderInstanceRowId !==
      evidence.providerInstanceRowId ||
    evidence.namespaceGithubRepositoryId !== input.target.githubRepositoryId ||
    !isMatchingRecoveryWitness(
      evidence.namespaceDatabaseRecoveryWitness,
      input.currentDatabaseRecoveryWitnessFingerprint,
    ) ||
    evidence.namespaceStatus !== "active" ||
    evidence.namespacePermanentlyRetired ||
    evidence.namespaceWorkflowPath !==
      ".github/workflows/reviewrouter-codex.yml" ||
    evidence.namespaceWorkflowSourceCommitSha === null ||
    evidence.namespaceWorkflowSourceBlobSha === null ||
    evidence.namespaceWorkflowSourceSha256 === null ||
    evidence.namespaceWorkflowSemanticSha256 === null ||
    evidence.namespaceWorkflowSourceTrust !==
      "trusted_default_branch_revision" ||
    evidence.namespaceAttestedRepositoryId !==
      input.target.githubRepositoryId ||
    evidence.namespaceActivatedAt === null ||
    evidence.providerActiveNamespaceId !== evidence.namespaceId ||
    evidence.providerActiveNamespaceEpoch !== evidence.namespaceEpoch ||
    evidence.providerActiveNamespaceName !== evidence.namespaceSecretName ||
    evidence.providerActiveAccountIdentityHash !==
      evidence.claimAccountIdentityHash ||
    evidence.manifestStatus !== "consumed" ||
    !isMatchingRecoveryWitness(
      evidence.manifestDatabaseRecoveryWitness,
      input.currentDatabaseRecoveryWitnessFingerprint,
    ) ||
    evidence.manifestConsumedAt === null ||
    (setupNamespaceIsActive
      ? evidence.setupNamespaceStatus !== "active" ||
        evidence.setupNamespacePermanentlyRetired ||
        evidence.providerMutationEpoch < evidence.claimRecoveryEpoch + 1n ||
        evidence.providerLatestGenerationHash !== evidence.claimGenerationHash
      : evidence.setupNamespaceStatus !== "retired_superseded" ||
        !evidence.setupNamespacePermanentlyRetired ||
        evidence.runtimeIntentId === null ||
        evidence.runtimeIntentProviderInstanceRowId !==
          evidence.providerInstanceRowId ||
        evidence.runtimeIntentSecretNamespaceId !== evidence.namespaceId ||
        evidence.runtimeIntentDispatchAttemptId === null ||
        evidence.runtimeIntentStatus !== "completed" ||
        evidence.runtimeIntentMutationEpoch === null ||
        evidence.providerMutationEpoch <
          evidence.runtimeIntentMutationEpoch + 1n ||
        evidence.runtimeIntentGeneration === null ||
        evidence.providerLatestGeneration < evidence.runtimeIntentGeneration ||
        evidence.runtimeIntentLatestGenerationHash !==
          evidence.providerLatestGenerationHash ||
        evidence.runtimeIntentAccountIdentityHash !==
          evidence.providerActiveAccountIdentityHash ||
        evidence.runtimeIntentAccountIdentityAlgorithm !==
          "provider_issuer_subject_account_v1" ||
        !isMatchingRecoveryWitness(
          evidence.runtimeIntentDatabaseRecoveryWitness,
          input.currentDatabaseRecoveryWitnessFingerprint,
        ) ||
        (evidence.runtimeIntentProviderResponseCode !== 201 &&
          evidence.runtimeIntentProviderResponseCode !== 204) ||
        evidence.runtimeIntentProviderConfirmedAt === null ||
        evidence.runtimeIntentCompletedAt === null)
  ) {
    throw new Error(codexRotatingSetupNotReadyError);
  }

  try {
    createVersionedProviderSecretNamespace({
      scope: {
        repositoryId: input.target.githubRepositoryId,
        providerInstanceId: input.target.providerInstanceId,
      },
      namespaceId: evidence.setupNamespaceId,
      epoch: evidence.setupNamespaceEpoch,
      name: evidence.setupNamespaceSecretName,
    });
    return createVersionedProviderSecretNamespace({
      scope: {
        repositoryId: input.target.githubRepositoryId,
        providerInstanceId: input.target.providerInstanceId,
      },
      namespaceId: evidence.namespaceId,
      epoch: evidence.namespaceEpoch,
      name: evidence.namespaceSecretName,
    });
  } catch (error) {
    throw new Error(codexRotatingSetupNotReadyError, { cause: error });
  }
}

function isMatchingRecoveryWitness(
  persistedFingerprint: string | null,
  currentFingerprint: string,
): boolean {
  return (
    classifyExternalRecoveryWitnessRelation({
      persistedFingerprint,
      currentFingerprint,
    }) === ExternalRecoveryWitnessRelation.Matching
  );
}
