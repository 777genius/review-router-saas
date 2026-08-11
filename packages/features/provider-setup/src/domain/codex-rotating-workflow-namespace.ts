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
import type { CodexRotatingSetupReadinessTarget } from "./codex-rotating-setup-readiness";

export const codexRotatingWorkflowNamespaceNotReadyError =
  "codex_rotating_workflow_namespace_not_ready" as const;

/**
 * Durable pre-activation evidence for the exact namespace that may be written
 * into a setup workflow. Adapters must read this tuple under the provider lock.
 */
export type CodexRotatingWorkflowCandidateEvidence = Readonly<{
  providerInstanceRowId: string;
  providerWorkspaceId: string;
  providerRepositoryId: string;
  providerInstanceId: string;
  providerAuthMode: string;
  providerState: string;
  providerMutationOwner: string | null;
  providerMutationOwnerId: string | null;
  providerMutationEpoch: bigint;
  providerActiveNamespaceId: string | null;
  providerActiveNamespaceEpoch: bigint | null;
  providerActiveNamespaceName: string | null;
  retainedActiveNamespaceId: string | null;
  retainedActiveNamespaceProviderInstanceRowId: string | null;
  retainedActiveNamespaceGithubRepositoryId: string | null;
  retainedActiveNamespaceEpoch: bigint | null;
  retainedActiveNamespaceSecretName: string | null;
  retainedActiveNamespaceDatabaseRecoveryWitness: string | null;
  retainedActiveNamespaceStatus: string | null;
  retainedActiveNamespacePermanentlyRetired: boolean | null;
  retainedActiveNamespaceActivatedAt: Date | null;
  retainedActiveNamespaceRetiredAt: Date | null;
  claimId: string;
  claimProviderInstanceRowId: string;
  claimWorkspaceId: string;
  claimRepositoryId: string;
  claimGithubRepositoryId: string;
  claimManifestId: string;
  claimRecoveryEpoch: bigint;
  claimStatus: CodexRotatingSetupClaimStatus;
  claimAccountIdentityAlgorithm: string;
  claimDatabaseRecoveryWitness: string;
  claimConfirmedAttemptId: string | null;
  claimConfirmedAt: Date | null;
  claimActivatedAt: Date | null;
  claimRecoveryExpiresAt: Date;
  attemptId: string;
  attemptClaimId: string;
  attemptNamespaceId: string;
  attemptStatus: CodexRotatingSetupAttemptStatus;
  attemptDefiniteResponseCode: number | null;
  attemptConfirmedAt: Date | null;
  attemptDispatchExpiresAt: Date;
  namespaceId: string;
  namespaceProviderInstanceRowId: string;
  namespaceGithubRepositoryId: string;
  namespaceEpoch: bigint;
  namespaceSecretName: string;
  namespaceDatabaseRecoveryWitness: string;
  namespaceStatus: string;
  namespacePermanentlyRetired: boolean;
  namespaceConfirmedAt: Date | null;
  namespaceActivatedAt: Date | null;
  manifestId: string;
  manifestProviderInstanceRowId: string;
  manifestWorkspaceId: string;
  manifestRepositoryId: string;
  manifestProviderInstanceId: string;
  manifestStatus: string;
  manifestMutationEpoch: bigint | null;
  manifestDatabaseRecoveryWitness: string | null;
  manifestRecoveryExpiresAt: Date | null;
  manifestConsumedAt: Date | null;
}>;

export type CodexRotatingWorkflowNamespaceInspection = Readonly<{
  source: "confirmed_setup_candidate" | "active";
  claimId: string;
  attemptId: string;
  namespace: VersionedProviderSecretNamespace;
}>;

/**
 * Proves that a provider-confirmed setup candidate is still the exact current
 * setup-fence owner and is therefore safe to embed in the pending workflow.
 */
export function assertCodexRotatingWorkflowCandidate(input: {
  readonly target: CodexRotatingSetupReadinessTarget;
  readonly evidence: CodexRotatingWorkflowCandidateEvidence | null;
  readonly currentDatabaseRecoveryWitnessFingerprint: string;
  readonly now: Date;
}): CodexRotatingWorkflowNamespaceInspection {
  const evidence = input.evidence;
  const expectedProviderInstanceId = canonicalCodexRotatingProviderId(
    input.target.githubRepositoryId,
  );
  const confirmedAt = evidence?.claimConfirmedAt?.getTime() ?? Number.NaN;
  const retainedActiveNamespaceIsValid = evidence
    ? isValidRetainedActiveNamespace({
        target: input.target,
        evidence,
        currentDatabaseRecoveryWitnessFingerprint:
          input.currentDatabaseRecoveryWitnessFingerprint,
      })
    : false;
  if (
    !Number.isFinite(input.now.getTime()) ||
    !evidence ||
    input.target.providerInstanceId !== expectedProviderInstanceId ||
    evidence.providerInstanceId !== expectedProviderInstanceId ||
    evidence.providerWorkspaceId !== input.target.workspaceId ||
    evidence.providerRepositoryId !== input.target.repositoryId ||
    evidence.providerAuthMode !== codexRotatingAuthMode ||
    evidence.providerState !== "workflow_update_required" ||
    evidence.providerMutationOwner !== "setup" ||
    evidence.providerMutationOwnerId !== evidence.claimManifestId ||
    evidence.providerMutationEpoch !== evidence.claimRecoveryEpoch ||
    evidence.providerMutationEpoch <= 0n ||
    !retainedActiveNamespaceIsValid ||
    evidence.claimProviderInstanceRowId !== evidence.providerInstanceRowId ||
    evidence.claimWorkspaceId !== input.target.workspaceId ||
    evidence.claimRepositoryId !== input.target.repositoryId ||
    evidence.claimGithubRepositoryId !== input.target.githubRepositoryId ||
    evidence.claimRecoveryEpoch <= 0n ||
    evidence.claimStatus !== "confirmed_candidate" ||
    evidence.claimAccountIdentityAlgorithm !==
      "provider_issuer_subject_account_v1" ||
    !isMatchingRecoveryWitness(
      evidence.claimDatabaseRecoveryWitness,
      input.currentDatabaseRecoveryWitnessFingerprint,
    ) ||
    evidence.claimConfirmedAttemptId !== evidence.attemptId ||
    !Number.isFinite(confirmedAt) ||
    evidence.claimActivatedAt !== null ||
    evidence.claimRecoveryExpiresAt <= input.now ||
    evidence.attemptClaimId !== evidence.claimId ||
    evidence.attemptNamespaceId !== evidence.namespaceId ||
    evidence.attemptStatus !== "confirmed" ||
    (evidence.attemptDefiniteResponseCode !== 201 &&
      evidence.attemptDefiniteResponseCode !== 204) ||
    evidence.attemptConfirmedAt?.getTime() !== confirmedAt ||
    !Number.isFinite(evidence.attemptDispatchExpiresAt.getTime()) ||
    confirmedAt > evidence.attemptDispatchExpiresAt.getTime() ||
    evidence.namespaceProviderInstanceRowId !==
      evidence.providerInstanceRowId ||
    evidence.namespaceGithubRepositoryId !== input.target.githubRepositoryId ||
    evidence.namespaceEpoch <= 0n ||
    !isMatchingRecoveryWitness(
      evidence.namespaceDatabaseRecoveryWitness,
      input.currentDatabaseRecoveryWitnessFingerprint,
    ) ||
    evidence.namespaceStatus !== "confirmed_candidate" ||
    evidence.namespacePermanentlyRetired ||
    evidence.namespaceConfirmedAt?.getTime() !== confirmedAt ||
    evidence.namespaceActivatedAt !== null ||
    evidence.manifestId !== evidence.claimManifestId ||
    evidence.manifestProviderInstanceRowId !== evidence.providerInstanceRowId ||
    evidence.manifestWorkspaceId !== input.target.workspaceId ||
    evidence.manifestRepositoryId !== input.target.repositoryId ||
    evidence.manifestProviderInstanceId !== expectedProviderInstanceId ||
    evidence.manifestStatus !== "fetched" ||
    evidence.manifestMutationEpoch !== evidence.claimRecoveryEpoch ||
    !isMatchingRecoveryWitness(
      evidence.manifestDatabaseRecoveryWitness,
      input.currentDatabaseRecoveryWitnessFingerprint,
    ) ||
    evidence.manifestRecoveryExpiresAt?.getTime() !==
      evidence.claimRecoveryExpiresAt.getTime() ||
    evidence.manifestConsumedAt !== null
  ) {
    throw new Error(codexRotatingWorkflowNamespaceNotReadyError);
  }

  try {
    return {
      source: "confirmed_setup_candidate",
      claimId: evidence.claimId,
      attemptId: evidence.attemptId,
      namespace: createVersionedProviderSecretNamespace({
        scope: {
          repositoryId: input.target.githubRepositoryId,
          providerInstanceId: input.target.providerInstanceId,
        },
        namespaceId: evidence.namespaceId,
        epoch: evidence.namespaceEpoch,
        name: evidence.namespaceSecretName,
      }),
    };
  } catch (error) {
    throw new Error(codexRotatingWorkflowNamespaceNotReadyError, {
      cause: error,
    });
  }
}

function isValidRetainedActiveNamespace(input: {
  readonly target: CodexRotatingSetupReadinessTarget;
  readonly evidence: CodexRotatingWorkflowCandidateEvidence;
  readonly currentDatabaseRecoveryWitnessFingerprint: string;
}): boolean {
  const evidence = input.evidence;
  if (evidence.providerActiveNamespaceId === null) {
    return (
      evidence.providerActiveNamespaceEpoch === null &&
      evidence.providerActiveNamespaceName === null &&
      evidence.retainedActiveNamespaceId === null &&
      evidence.retainedActiveNamespaceProviderInstanceRowId === null &&
      evidence.retainedActiveNamespaceGithubRepositoryId === null &&
      evidence.retainedActiveNamespaceEpoch === null &&
      evidence.retainedActiveNamespaceSecretName === null &&
      evidence.retainedActiveNamespaceDatabaseRecoveryWitness === null &&
      evidence.retainedActiveNamespaceStatus === null &&
      evidence.retainedActiveNamespacePermanentlyRetired === null &&
      evidence.retainedActiveNamespaceActivatedAt === null &&
      evidence.retainedActiveNamespaceRetiredAt === null
    );
  }

  if (
    evidence.retainedActiveNamespaceId !== evidence.providerActiveNamespaceId ||
    evidence.retainedActiveNamespaceId === evidence.namespaceId ||
    evidence.retainedActiveNamespaceProviderInstanceRowId !==
      evidence.providerInstanceRowId ||
    evidence.retainedActiveNamespaceGithubRepositoryId !==
      input.target.githubRepositoryId ||
    evidence.retainedActiveNamespaceEpoch === null ||
    evidence.retainedActiveNamespaceEpoch <= 0n ||
    evidence.retainedActiveNamespaceSecretName === null ||
    evidence.providerActiveNamespaceEpoch !==
      evidence.retainedActiveNamespaceEpoch ||
    evidence.providerActiveNamespaceName !==
      evidence.retainedActiveNamespaceSecretName ||
    !isMatchingRecoveryWitness(
      evidence.retainedActiveNamespaceDatabaseRecoveryWitness,
      input.currentDatabaseRecoveryWitnessFingerprint,
    ) ||
    evidence.retainedActiveNamespaceStatus !== "active" ||
    evidence.retainedActiveNamespacePermanentlyRetired !== false ||
    !Number.isFinite(
      evidence.retainedActiveNamespaceActivatedAt?.getTime() ?? Number.NaN,
    ) ||
    evidence.retainedActiveNamespaceRetiredAt !== null
  ) {
    return false;
  }

  try {
    createVersionedProviderSecretNamespace({
      scope: {
        repositoryId: input.target.githubRepositoryId,
        providerInstanceId: input.target.providerInstanceId,
      },
      namespaceId: evidence.retainedActiveNamespaceId,
      epoch: evidence.retainedActiveNamespaceEpoch,
      name: evidence.retainedActiveNamespaceSecretName,
    });
    return true;
  } catch {
    return false;
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
