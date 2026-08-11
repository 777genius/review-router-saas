import { describe, expect, it, vi } from "vitest";
import {
  allocateVersionedProviderSecretNamespace,
  fingerprintDatabaseRecoveryWitness,
  type CodexRotatingSetupReadinessEvidence,
  type CodexRotatingWorkflowCandidateEvidence,
} from "@reviewrouter/features-provider-setup";
import { PrismaCodexRotatingWorkflowNamespace } from "./prisma-codex-rotating-workflow-namespace";

const databaseRecoveryWitness = "w".repeat(43);
const currentDatabaseRecoveryWitnessFingerprint =
  fingerprintDatabaseRecoveryWitness(databaseRecoveryWitness);
const now = new Date("2026-08-10T00:00:00.000Z");
const confirmedAt = new Date("2026-08-10T00:01:00.000Z");
const target = {
  workspaceId: "workspace_1",
  repositoryId: "repository_1",
  githubRepositoryId: "900001",
  providerInstanceId: "codex-rotating:900001",
} as const;
const namespace = allocateVersionedProviderSecretNamespace({
  scope: {
    repositoryId: target.githubRepositoryId,
    providerInstanceId: target.providerInstanceId,
  },
  epoch: 7n,
  randomBytes: (size) => new Uint8Array(size).fill(6),
});
const retainedActiveNamespace = allocateVersionedProviderSecretNamespace({
  scope: {
    repositoryId: target.githubRepositoryId,
    providerInstanceId: target.providerInstanceId,
  },
  epoch: 6n,
  randomBytes: (size) => new Uint8Array(size).fill(5),
});

describe("Prisma Codex rotating workflow namespace", () => {
  it("returns an exact confirmed candidate after taking the provider lock", async () => {
    const { adapter, tx } = harness({
      activeEvidence: [],
      candidateEvidence: [candidate()],
    });

    await expect(adapter.inspectWorkflowNamespace(target)).resolves.toEqual({
      source: "confirmed_setup_candidate",
      claimId: "codex_claim_workflow_1",
      attemptId: "codex_attempt_workflow_1",
      namespace,
    });

    expect(tx.$executeRawUnsafe).toHaveBeenCalledTimes(2);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(3);
    const candidateQuery = Array.from(
      tx.$queryRaw.mock.calls[2]![0] as readonly string[],
    ).join("?");
    expect(candidateQuery).toContain(
      'attempt."id" = claim."confirmedAttemptId"',
    );
    expect(candidateQuery).toContain('attempt."claimId" = claim."id"');
    expect(candidateQuery).toContain('namespace."id" = attempt."namespaceId"');
    expect(candidateQuery).toContain(
      'retained_active_namespace."id" = provider."activeSecretNamespaceId"',
    );
    expect(candidateQuery).toContain("attempt.\"status\" = 'confirmed'");
    expect(candidateQuery).toContain("LIMIT 2");
  });

  it("returns a candidate during same-witness re-onboarding with a proven retained active namespace", async () => {
    const { adapter } = harness({
      activeEvidence: [],
      candidateEvidence: [candidateWithRetainedActiveNamespace()],
    });

    await expect(adapter.inspectWorkflowNamespace(target)).resolves.toEqual({
      source: "confirmed_setup_candidate",
      claimId: "codex_claim_workflow_1",
      attemptId: "codex_attempt_workflow_1",
      namespace,
    });
  });

  it("distinguishes the fully active namespace without reading a candidate", async () => {
    const { adapter, tx } = harness({
      activeEvidence: [active()],
      candidateEvidence: [],
    });

    await expect(adapter.inspectWorkflowNamespace(target)).resolves.toEqual({
      source: "active",
      claimId: "codex_claim_active_1",
      attemptId: "codex_attempt_active_1",
      namespace,
    });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it("fails closed on a prior-witness candidate", async () => {
    const { adapter } = harness({
      activeEvidence: [],
      candidateEvidence: [
        candidate({ claimDatabaseRecoveryWitness: "a".repeat(64) }),
      ],
    });

    await expect(adapter.inspectWorkflowNamespace(target)).rejects.toThrow(
      "codex_rotating_workflow_namespace_not_ready",
    );
  });

  it("fails closed when candidate selection is ambiguous", async () => {
    const evidence = candidate();
    const { adapter } = harness({
      activeEvidence: [],
      candidateEvidence: [evidence, { ...evidence, claimId: "other" }],
    });

    await expect(adapter.inspectWorkflowNamespace(target)).rejects.toThrow(
      "codex_rotating_workflow_namespace_not_ready",
    );
  });

  it("does not touch the database when the current witness is unavailable", async () => {
    const { prisma, tx } = harnessParts({
      activeEvidence: [],
      candidateEvidence: [],
    });
    const adapter = new PrismaCodexRotatingWorkflowNamespace(
      prisma as never,
      undefined,
    );

    await expect(adapter.inspectWorkflowNamespace(target)).rejects.toThrow(
      "codex_rotating_workflow_namespace_not_ready",
    );
    expect(tx.codexOAuthProviderInstance.findUnique).not.toHaveBeenCalled();
  });
});

function harness(input: {
  readonly activeEvidence: readonly CodexRotatingSetupReadinessEvidence[];
  readonly candidateEvidence: readonly CodexRotatingWorkflowCandidateEvidence[];
}) {
  const { prisma, tx } = harnessParts(input);
  return {
    tx,
    adapter: new PrismaCodexRotatingWorkflowNamespace(
      prisma as never,
      databaseRecoveryWitness,
      { now: () => now },
    ),
  };
}

function harnessParts(input: {
  readonly activeEvidence: readonly CodexRotatingSetupReadinessEvidence[];
  readonly candidateEvidence: readonly CodexRotatingWorkflowCandidateEvidence[];
}) {
  const tx = {
    codexOAuthProviderInstance: {
      findUnique: vi.fn().mockResolvedValue({ id: "provider_row_1" }),
    },
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
    $queryRaw: vi
      .fn()
      .mockResolvedValueOnce([{ id: "provider_row_1" }])
      .mockResolvedValueOnce(input.activeEvidence)
      .mockResolvedValueOnce(input.candidateEvidence),
  };
  const prisma = {
    $transaction: vi.fn((callback) => callback(tx)),
  };
  return { prisma, tx };
}

function candidate(
  overrides: Partial<CodexRotatingWorkflowCandidateEvidence> = {},
): CodexRotatingWorkflowCandidateEvidence {
  const recoveryExpiresAt = new Date("2026-08-11T00:00:00.000Z");
  return {
    providerInstanceRowId: "provider_row_1",
    providerWorkspaceId: target.workspaceId,
    providerRepositoryId: target.repositoryId,
    providerInstanceId: target.providerInstanceId,
    providerAuthMode: "codex_subscription_oauth_rotating",
    providerState: "workflow_update_required",
    providerMutationOwner: "setup",
    providerMutationOwnerId: "codex_manifest_workflow_1",
    providerMutationEpoch: 11n,
    providerActiveNamespaceId: null,
    providerActiveNamespaceEpoch: null,
    providerActiveNamespaceName: null,
    retainedActiveNamespaceId: null,
    retainedActiveNamespaceProviderInstanceRowId: null,
    retainedActiveNamespaceGithubRepositoryId: null,
    retainedActiveNamespaceEpoch: null,
    retainedActiveNamespaceSecretName: null,
    retainedActiveNamespaceDatabaseRecoveryWitness: null,
    retainedActiveNamespaceStatus: null,
    retainedActiveNamespacePermanentlyRetired: null,
    retainedActiveNamespaceActivatedAt: null,
    retainedActiveNamespaceRetiredAt: null,
    claimId: "codex_claim_workflow_1",
    claimProviderInstanceRowId: "provider_row_1",
    claimWorkspaceId: target.workspaceId,
    claimRepositoryId: target.repositoryId,
    claimGithubRepositoryId: target.githubRepositoryId,
    claimManifestId: "codex_manifest_workflow_1",
    claimRecoveryEpoch: 11n,
    claimStatus: "confirmed_candidate",
    claimAccountIdentityAlgorithm: "provider_issuer_subject_account_v1",
    claimDatabaseRecoveryWitness: currentDatabaseRecoveryWitnessFingerprint,
    claimConfirmedAttemptId: "codex_attempt_workflow_1",
    claimConfirmedAt: confirmedAt,
    claimActivatedAt: null,
    claimRecoveryExpiresAt: recoveryExpiresAt,
    attemptId: "codex_attempt_workflow_1",
    attemptClaimId: "codex_claim_workflow_1",
    attemptNamespaceId: namespace.namespaceId,
    attemptStatus: "confirmed",
    attemptDefiniteResponseCode: 204,
    attemptConfirmedAt: confirmedAt,
    attemptDispatchExpiresAt: new Date("2026-08-10T00:09:00.000Z"),
    namespaceId: namespace.namespaceId,
    namespaceProviderInstanceRowId: "provider_row_1",
    namespaceGithubRepositoryId: target.githubRepositoryId,
    namespaceEpoch: namespace.epoch,
    namespaceSecretName: namespace.name,
    namespaceDatabaseRecoveryWitness: currentDatabaseRecoveryWitnessFingerprint,
    namespaceStatus: "confirmed_candidate",
    namespacePermanentlyRetired: false,
    namespaceConfirmedAt: confirmedAt,
    namespaceActivatedAt: null,
    manifestId: "codex_manifest_workflow_1",
    manifestProviderInstanceRowId: "provider_row_1",
    manifestWorkspaceId: target.workspaceId,
    manifestRepositoryId: target.repositoryId,
    manifestProviderInstanceId: target.providerInstanceId,
    manifestStatus: "fetched",
    manifestMutationEpoch: 11n,
    manifestDatabaseRecoveryWitness: currentDatabaseRecoveryWitnessFingerprint,
    manifestRecoveryExpiresAt: recoveryExpiresAt,
    manifestConsumedAt: null,
    ...overrides,
  };
}

function candidateWithRetainedActiveNamespace(): CodexRotatingWorkflowCandidateEvidence {
  return candidate({
    providerActiveNamespaceId: retainedActiveNamespace.namespaceId,
    providerActiveNamespaceEpoch: retainedActiveNamespace.epoch,
    providerActiveNamespaceName: retainedActiveNamespace.name,
    retainedActiveNamespaceId: retainedActiveNamespace.namespaceId,
    retainedActiveNamespaceProviderInstanceRowId: "provider_row_1",
    retainedActiveNamespaceGithubRepositoryId: target.githubRepositoryId,
    retainedActiveNamespaceEpoch: retainedActiveNamespace.epoch,
    retainedActiveNamespaceSecretName: retainedActiveNamespace.name,
    retainedActiveNamespaceDatabaseRecoveryWitness:
      currentDatabaseRecoveryWitnessFingerprint,
    retainedActiveNamespaceStatus: "active",
    retainedActiveNamespacePermanentlyRetired: false,
    retainedActiveNamespaceActivatedAt: new Date("2026-08-09T00:00:00.000Z"),
    retainedActiveNamespaceRetiredAt: null,
  });
}

function active(): CodexRotatingSetupReadinessEvidence {
  return {
    providerInstanceRowId: "provider_row_1",
    providerWorkspaceId: target.workspaceId,
    providerRepositoryId: target.repositoryId,
    providerInstanceId: target.providerInstanceId,
    providerAuthMode: "codex_subscription_oauth_rotating",
    providerState: "active",
    providerMutationEpoch: 12n,
    providerLatestGeneration: 1,
    providerActiveNamespaceId: namespace.namespaceId,
    providerActiveNamespaceEpoch: namespace.epoch,
    providerActiveNamespaceName: namespace.name,
    providerActiveAccountIdentityHash: "i".repeat(43),
    providerLatestGenerationHash: "g".repeat(43),
    claimId: "codex_claim_active_1",
    claimProviderInstanceRowId: "provider_row_1",
    claimWorkspaceId: target.workspaceId,
    claimRepositoryId: target.repositoryId,
    claimGithubRepositoryId: target.githubRepositoryId,
    claimManifestId: "codex_manifest_active_1",
    claimRecoveryEpoch: 11n,
    claimStatus: "active",
    claimGenerationHash: "g".repeat(43),
    claimAccountIdentityHash: "i".repeat(43),
    claimDatabaseRecoveryWitness: currentDatabaseRecoveryWitnessFingerprint,
    claimConfirmedAttemptId: "codex_attempt_active_1",
    claimActivatedAt: confirmedAt,
    attemptId: "codex_attempt_active_1",
    attemptClaimId: "codex_claim_active_1",
    attemptNamespaceId: namespace.namespaceId,
    attemptStatus: "confirmed",
    attemptDefiniteResponseCode: 204,
    attemptConfirmedAt: confirmedAt,
    setupNamespaceId: namespace.namespaceId,
    setupNamespaceProviderInstanceRowId: "provider_row_1",
    setupNamespaceGithubRepositoryId: target.githubRepositoryId,
    setupNamespaceEpoch: namespace.epoch,
    setupNamespaceSecretName: namespace.name,
    setupNamespaceDatabaseRecoveryWitness:
      currentDatabaseRecoveryWitnessFingerprint,
    setupNamespaceStatus: "active",
    setupNamespacePermanentlyRetired: false,
    setupNamespaceWorkflowPath: ".github/workflows/reviewrouter-codex.yml",
    setupNamespaceWorkflowSourceCommitSha: "a".repeat(40),
    setupNamespaceWorkflowSourceBlobSha: "b".repeat(40),
    setupNamespaceWorkflowSourceSha256: "c".repeat(64),
    setupNamespaceWorkflowSemanticSha256: "d".repeat(64),
    setupNamespaceWorkflowSourceTrust: "trusted_default_branch_revision",
    setupNamespaceAttestedRepositoryId: target.githubRepositoryId,
    setupNamespaceActivatedAt: confirmedAt,
    namespaceId: namespace.namespaceId,
    namespaceProviderInstanceRowId: "provider_row_1",
    namespaceGithubRepositoryId: target.githubRepositoryId,
    namespaceEpoch: namespace.epoch,
    namespaceSecretName: namespace.name,
    namespaceDatabaseRecoveryWitness: currentDatabaseRecoveryWitnessFingerprint,
    namespaceStatus: "active",
    namespacePermanentlyRetired: false,
    namespaceWorkflowPath: ".github/workflows/reviewrouter-codex.yml",
    namespaceWorkflowSourceCommitSha: "a".repeat(40),
    namespaceWorkflowSourceBlobSha: "b".repeat(40),
    namespaceWorkflowSourceSha256: "c".repeat(64),
    namespaceWorkflowSemanticSha256: "d".repeat(64),
    namespaceWorkflowSourceTrust: "trusted_default_branch_revision",
    namespaceAttestedRepositoryId: target.githubRepositoryId,
    namespaceActivatedAt: confirmedAt,
    runtimeIntentId: null,
    runtimeIntentProviderInstanceRowId: null,
    runtimeIntentSecretNamespaceId: null,
    runtimeIntentDispatchAttemptId: null,
    runtimeIntentStatus: null,
    runtimeIntentMutationEpoch: null,
    runtimeIntentGeneration: null,
    runtimeIntentLatestGenerationHash: null,
    runtimeIntentAccountIdentityHash: null,
    runtimeIntentAccountIdentityAlgorithm: null,
    runtimeIntentDatabaseRecoveryWitness: null,
    runtimeIntentProviderResponseCode: null,
    runtimeIntentProviderConfirmedAt: null,
    runtimeIntentCompletedAt: null,
    manifestStatus: "consumed",
    manifestDatabaseRecoveryWitness: currentDatabaseRecoveryWitnessFingerprint,
    manifestConsumedAt: confirmedAt,
  };
}
