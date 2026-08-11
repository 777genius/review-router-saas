import { describe, expect, it } from "vitest";
import {
  allocateVersionedProviderSecretNamespace,
  assertCodexRotatingSetupReady,
  fingerprintDatabaseRecoveryWitness,
  type CodexRotatingSetupReadinessEvidence,
} from "../index";

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
  epoch: 9n,
  randomBytes: (size) => new Uint8Array(size).fill(7),
});
const refreshedNamespace = allocateVersionedProviderSecretNamespace({
  scope: {
    repositoryId: target.githubRepositoryId,
    providerInstanceId: target.providerInstanceId,
  },
  epoch: 10n,
  randomBytes: (size) => new Uint8Array(size).fill(8),
});

function readyEvidence(
  overrides: Partial<CodexRotatingSetupReadinessEvidence> = {},
): CodexRotatingSetupReadinessEvidence {
  const activatedAt = new Date("2026-08-10T00:00:00.000Z");
  return {
    providerInstanceRowId: "provider_row_1",
    providerWorkspaceId: target.workspaceId,
    providerRepositoryId: target.repositoryId,
    providerInstanceId: target.providerInstanceId,
    providerAuthMode: "codex_subscription_oauth_rotating",
    providerState: "active",
    providerMutationEpoch: 10n,
    providerLatestGeneration: 1,
    providerActiveNamespaceId: namespace.namespaceId,
    providerActiveNamespaceEpoch: namespace.epoch,
    providerActiveNamespaceName: namespace.name,
    providerActiveAccountIdentityHash: "i".repeat(43),
    providerLatestGenerationHash: "g".repeat(43),
    claimId: "codex_claim_exact_1",
    claimProviderInstanceRowId: "provider_row_1",
    claimWorkspaceId: target.workspaceId,
    claimRepositoryId: target.repositoryId,
    claimGithubRepositoryId: target.githubRepositoryId,
    claimManifestId: "codex_manifest_exact_1",
    claimRecoveryEpoch: 9n,
    claimStatus: "active",
    claimGenerationHash: "g".repeat(43),
    claimAccountIdentityHash: "i".repeat(43),
    claimDatabaseRecoveryWitness: currentDatabaseRecoveryWitnessFingerprint,
    claimConfirmedAttemptId: "codex_attempt_exact_1",
    claimActivatedAt: activatedAt,
    attemptId: "codex_attempt_exact_1",
    attemptClaimId: "codex_claim_exact_1",
    attemptNamespaceId: namespace.namespaceId,
    attemptStatus: "confirmed",
    attemptDefiniteResponseCode: 204,
    attemptConfirmedAt: activatedAt,
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
    setupNamespaceActivatedAt: activatedAt,
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
    namespaceActivatedAt: activatedAt,
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
    manifestConsumedAt: activatedAt,
    ...overrides,
  };
}

function assertReady(evidence: CodexRotatingSetupReadinessEvidence | null) {
  return assertCodexRotatingSetupReady({
    target,
    evidence,
    currentDatabaseRecoveryWitnessFingerprint,
  });
}

describe("Codex rotating setup readiness", () => {
  it("accepts only the exact definite and activated evidence chain", () => {
    expect(assertReady(readyEvidence())).toEqual(namespace);
  });

  it("keeps setup ready after an exact completed runtime namespace rotation", () => {
    const activatedAt = new Date("2026-08-10T00:10:00.000Z");
    const evidence = readyEvidence({
      providerMutationEpoch: 12n,
      providerLatestGeneration: 2,
      providerActiveNamespaceId: refreshedNamespace.namespaceId,
      providerActiveNamespaceEpoch: refreshedNamespace.epoch,
      providerActiveNamespaceName: refreshedNamespace.name,
      providerLatestGenerationHash: "r".repeat(43),
      setupNamespaceStatus: "retired_superseded",
      setupNamespacePermanentlyRetired: true,
      namespaceId: refreshedNamespace.namespaceId,
      namespaceEpoch: refreshedNamespace.epoch,
      namespaceSecretName: refreshedNamespace.name,
      namespaceActivatedAt: activatedAt,
      runtimeIntentId: "runtime_intent_exact_1",
      runtimeIntentProviderInstanceRowId: "provider_row_1",
      runtimeIntentSecretNamespaceId: refreshedNamespace.namespaceId,
      runtimeIntentDispatchAttemptId: "runtime_attempt_exact_1",
      runtimeIntentStatus: "completed",
      runtimeIntentMutationEpoch: 11n,
      runtimeIntentGeneration: 2,
      runtimeIntentLatestGenerationHash: "r".repeat(43),
      runtimeIntentAccountIdentityHash: "i".repeat(43),
      runtimeIntentAccountIdentityAlgorithm:
        "provider_issuer_subject_account_v1",
      runtimeIntentDatabaseRecoveryWitness:
        currentDatabaseRecoveryWitnessFingerprint,
      runtimeIntentProviderResponseCode: 204,
      runtimeIntentProviderConfirmedAt: activatedAt,
      runtimeIntentCompletedAt: activatedAt,
    });

    expect(assertReady(evidence)).toEqual(refreshedNamespace);
    expect(
      assertReady({
        ...evidence,
        providerMutationEpoch: 99n,
        providerLatestGeneration: 4,
      }),
    ).toEqual(refreshedNamespace);
    expect(() =>
      assertReady({ ...evidence, runtimeIntentStatus: "pending" }),
    ).toThrow("codex_rotating_setup_not_ready");
  });

  it.each([
    ["missing evidence", null],
    [
      "unactivated claim",
      readyEvidence({ claimStatus: "confirmed_candidate" }),
    ],
    [
      "missing definite outcome",
      readyEvidence({ attemptDefiniteResponseCode: null }),
    ],
    ["wrong attempt", readyEvidence({ attemptClaimId: "codex_claim_other" })],
    [
      "unactivated namespace",
      readyEvidence({ namespaceStatus: "confirmed_candidate" }),
    ],
    ["retired namespace", readyEvidence({ namespacePermanentlyRetired: true })],
    [
      "wrong provider outcome",
      readyEvidence({ providerState: "workflow_update_required" }),
    ],
    [
      "wrong active namespace",
      readyEvidence({ providerActiveNamespaceId: "sns_other" }),
    ],
    ["unconsumed manifest", readyEvidence({ manifestStatus: "fetched" })],
    [
      "prior database recovery witness",
      readyEvidence({ claimDatabaseRecoveryWitness: "a".repeat(64) }),
    ],
  ] as const)("rejects %s", (_label, evidence) => {
    expect(() => assertReady(evidence)).toThrow(
      "codex_rotating_setup_not_ready",
    );
  });

  it("never treats a dummy stable secret as rotating readiness", () => {
    expect(() =>
      assertReady(
        readyEvidence({
          namespaceSecretName: "REVIEWROUTER_CODEX_AUTH_JSON",
          providerActiveNamespaceName: "REVIEWROUTER_CODEX_AUTH_JSON",
        }),
      ),
    ).toThrow("codex_rotating_setup_not_ready");
  });
});
