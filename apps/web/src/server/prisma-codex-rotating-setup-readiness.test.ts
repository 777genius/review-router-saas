import { describe, expect, it, vi } from "vitest";
import {
  allocateVersionedProviderSecretNamespace,
  fingerprintDatabaseRecoveryWitness,
  type CodexRotatingSetupReadinessEvidence,
} from "@reviewrouter/features-provider-setup";
import { PrismaCodexRotatingSetupReadiness } from "./prisma-codex-rotating-setup-readiness";

const databaseRecoveryWitness = "w".repeat(43);
const currentDatabaseRecoveryWitnessFingerprint =
  fingerprintDatabaseRecoveryWitness(databaseRecoveryWitness);

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
  epoch: 11n,
  randomBytes: (size) => new Uint8Array(size).fill(9),
});

describe("Prisma Codex rotating setup readiness", () => {
  it("records configured only after reading the exact locked evidence", async () => {
    const { adapter, tx } = harness(evidence());

    await expect(adapter.confirmConfigured(target)).resolves.toEqual({
      claimId: "codex_claim_ready_1",
      attemptId: "codex_attempt_ready_1",
      namespaceId: namespace.namespaceId,
      namespaceEpoch: namespace.epoch,
    });

    expect(tx.$executeRawUnsafe).toHaveBeenCalledTimes(2);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    const evidenceQuery = Array.from(
      tx.$queryRaw.mock.calls[1]![0] as readonly string[],
    ).join("?");
    expect(evidenceQuery).toContain(
      'LEFT JOIN "CodexOAuthWritebackIntent" runtime_intent',
    );
    expect(evidenceQuery).toContain(
      'JOIN "CodexOAuthSecretNamespace" setup_namespace',
    );
    expect(evidenceQuery).toContain("active_claim.\"status\" = 'active') = 1");
    expect(tx.providerSetupState.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          authMode: "codex_subscription_oauth_rotating",
          state: "configured",
        }),
      }),
    );
  });

  it("does not persist readiness for a same-repository dummy stable secret", async () => {
    const { adapter, tx } = harness(
      evidence({
        namespaceSecretName: "REVIEWROUTER_CODEX_AUTH_JSON",
        providerActiveNamespaceName: "REVIEWROUTER_CODEX_AUTH_JSON",
      }),
    );

    await expect(adapter.confirmConfigured(target)).rejects.toThrow(
      "codex_rotating_setup_not_ready",
    );
    expect(tx.providerSetupState.upsert).not.toHaveBeenCalled();
  });

  it("keeps readiness inspection non-mutating", async () => {
    const { adapter, tx } = harness(evidence());

    await expect(adapter.inspectReady(target)).resolves.toMatchObject({
      namespaceId: namespace.namespaceId,
    });
    expect(tx.providerSetupState.upsert).not.toHaveBeenCalled();
  });

  it("fails closed before reading evidence when the current witness is unavailable", async () => {
    const { tx, prisma } = harnessParts(evidence());
    const adapter = new PrismaCodexRotatingSetupReadiness(
      prisma as never,
      undefined,
    );

    await expect(adapter.inspectReady(target)).rejects.toThrow(
      "codex_rotating_setup_not_ready",
    );
    expect(tx.codexOAuthProviderInstance.findUnique).not.toHaveBeenCalled();
  });
});

function harnessParts(readiness: CodexRotatingSetupReadinessEvidence) {
  const tx = {
    codexOAuthProviderInstance: {
      findUnique: vi.fn().mockResolvedValue({ id: "provider_row_1" }),
    },
    providerSetupState: { upsert: vi.fn().mockResolvedValue({}) },
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
    $queryRaw: vi
      .fn()
      .mockResolvedValueOnce([{ id: "provider_row_1" }])
      .mockResolvedValueOnce([readiness]),
  };
  const prisma = {
    $transaction: vi.fn((callback) => callback(tx)),
  };
  return { tx, prisma };
}

function harness(readiness: CodexRotatingSetupReadinessEvidence) {
  const { tx, prisma } = harnessParts(readiness);
  return {
    tx,
    adapter: new PrismaCodexRotatingSetupReadiness(
      prisma as never,
      databaseRecoveryWitness,
    ),
  };
}

function evidence(
  overrides: Partial<CodexRotatingSetupReadinessEvidence> = {},
): CodexRotatingSetupReadinessEvidence {
  const now = new Date("2026-08-10T00:00:00.000Z");
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
    claimId: "codex_claim_ready_1",
    claimProviderInstanceRowId: "provider_row_1",
    claimWorkspaceId: target.workspaceId,
    claimRepositoryId: target.repositoryId,
    claimGithubRepositoryId: target.githubRepositoryId,
    claimManifestId: "codex_manifest_ready_1",
    claimRecoveryEpoch: 11n,
    claimStatus: "active",
    claimGenerationHash: "g".repeat(43),
    claimAccountIdentityHash: "i".repeat(43),
    claimDatabaseRecoveryWitness: currentDatabaseRecoveryWitnessFingerprint,
    claimConfirmedAttemptId: "codex_attempt_ready_1",
    claimActivatedAt: now,
    attemptId: "codex_attempt_ready_1",
    attemptClaimId: "codex_claim_ready_1",
    attemptNamespaceId: namespace.namespaceId,
    attemptStatus: "confirmed",
    attemptDefiniteResponseCode: 204,
    attemptConfirmedAt: now,
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
    setupNamespaceActivatedAt: now,
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
    namespaceActivatedAt: now,
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
    manifestConsumedAt: now,
    ...overrides,
  };
}
