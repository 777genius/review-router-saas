import { describe, expect, it } from "vitest";
import {
  allocateVersionedProviderSecretNamespace,
  assertCodexRotatingWorkflowCandidate,
  fingerprintDatabaseRecoveryWitness,
  type CodexRotatingWorkflowCandidateEvidence,
} from "../index";

const databaseRecoveryWitness = "w".repeat(43);
const currentDatabaseRecoveryWitnessFingerprint =
  fingerprintDatabaseRecoveryWitness(databaseRecoveryWitness);
const now = new Date("2026-08-10T00:05:00.000Z");
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

describe("Codex rotating workflow namespace candidate", () => {
  it.each([201, 204] as const)(
    "accepts an exact current-witness definite %s candidate",
    (responseCode) => {
      expect(
        assertCandidate(
          candidateEvidence({
            attemptDefiniteResponseCode: responseCode,
          }),
        ),
      ).toEqual({
        source: "confirmed_setup_candidate",
        claimId: "codex_claim_workflow_1",
        attemptId: "codex_attempt_workflow_1",
        namespace,
      });
    },
  );

  it("remains provisionable after the dispatch deadline once confirmation was definite", () => {
    expect(
      assertCandidate(
        candidateEvidence(),
        new Date("2026-08-10T00:10:00.000Z"),
      ),
    ).toMatchObject({ source: "confirmed_setup_candidate", namespace });
  });

  it("accepts a definite confirmation exactly at its dispatch deadline", () => {
    expect(
      assertCandidate(
        candidateEvidence({ attemptDispatchExpiresAt: confirmedAt }),
      ),
    ).toMatchObject({ source: "confirmed_setup_candidate", namespace });
  });

  it("accepts same-witness re-onboarding while the prior active namespace remains live", () => {
    expect(
      assertCandidate(candidateWithRetainedActiveNamespace()),
    ).toMatchObject({ source: "confirmed_setup_candidate", namespace });
  });

  it.each([
    ["missing evidence", null],
    [
      "wrong witness claim",
      candidateEvidence({ claimDatabaseRecoveryWitness: "a".repeat(64) }),
    ],
    [
      "wrong witness namespace",
      candidateEvidence({ namespaceDatabaseRecoveryWitness: "a".repeat(64) }),
    ],
    [
      "wrong witness manifest",
      candidateEvidence({ manifestDatabaseRecoveryWitness: "a".repeat(64) }),
    ],
    [
      "non-definite provider outcome",
      candidateEvidence({ attemptDefiniteResponseCode: null }),
    ],
    [
      "cross-claim attempt",
      candidateEvidence({ attemptClaimId: "codex_claim_other" }),
    ],
    [
      "cross-namespace attempt",
      candidateEvidence({ attemptNamespaceId: "codex_namespace_other" }),
    ],
    [
      "wrong setup fence",
      candidateEvidence({ providerMutationOwnerId: "codex_manifest_other" }),
    ],
    [
      "prior-witness retained active namespace",
      candidateWithRetainedActiveNamespace({
        retainedActiveNamespaceDatabaseRecoveryWitness: "a".repeat(64),
      }),
    ],
    [
      "retired retained active namespace",
      candidateWithRetainedActiveNamespace({
        retainedActiveNamespaceStatus: "retired_superseded",
        retainedActiveNamespacePermanentlyRetired: true,
        retainedActiveNamespaceRetiredAt: now,
      }),
    ],
    [
      "retired namespace",
      candidateEvidence({ namespacePermanentlyRetired: true }),
    ],
    [
      "late provider confirmation",
      candidateEvidence({
        attemptDispatchExpiresAt: new Date("2026-08-10T00:00:59.000Z"),
      }),
    ],
    [
      "expired recovery window",
      candidateEvidence({
        claimRecoveryExpiresAt: new Date("2026-08-10T00:04:59.000Z"),
        manifestRecoveryExpiresAt: new Date("2026-08-10T00:04:59.000Z"),
      }),
    ],
  ] as const)("rejects %s", (_label, evidence) => {
    expect(() => assertCandidate(evidence)).toThrow(
      "codex_rotating_workflow_namespace_not_ready",
    );
  });

  it("never treats the retired stable name as a workflow candidate", () => {
    expect(() =>
      assertCandidate(
        candidateEvidence({
          namespaceSecretName: "REVIEWROUTER_CODEX_AUTH_JSON",
        }),
      ),
    ).toThrow("codex_rotating_workflow_namespace_not_ready");
  });
});

function assertCandidate(
  evidence: CodexRotatingWorkflowCandidateEvidence | null,
  at: Date = now,
) {
  return assertCodexRotatingWorkflowCandidate({
    target,
    evidence,
    currentDatabaseRecoveryWitnessFingerprint,
    now: at,
  });
}

function candidateEvidence(
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

function candidateWithRetainedActiveNamespace(
  overrides: Partial<CodexRotatingWorkflowCandidateEvidence> = {},
): CodexRotatingWorkflowCandidateEvidence {
  return candidateEvidence({
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
    ...overrides,
  });
}
