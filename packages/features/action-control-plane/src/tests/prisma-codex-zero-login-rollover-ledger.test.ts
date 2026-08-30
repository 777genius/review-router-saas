import { describe, expect, it, vi } from "vitest";
import {
  PrismaCodexZeroLoginRolloverLedger,
  selectZeroLoginRolloverCandidateEpoch,
} from "../infrastructure/prisma/prisma-codex-zero-login-rollover-ledger.js";
import type { PrepareZeroLoginRolloverInput } from "../application/ports/codex-zero-login-rollover-port.js";
import { WorkflowSourceTrust } from "@reviewrouter/features-codex-oauth-rotating";

const prepareInput = {
  operationId: "campaign-1:owner/repo",
  repositoryFullName: "owner/repo",
  providerInstanceId: "codex-rotating:123456",
  expectedCandidateEpoch: 2n,
  expectedRerunAttempt: "2",
  schedule: {
    runId: "100",
    runAttempt: "1",
    eventName: "schedule",
    conclusion: "success",
    workflowActionCommitSha: "a".repeat(40),
    workflowSourceCommitSha: "b".repeat(40),
    sourceDefaultHeadSha: "c".repeat(40),
    completedAt: "2026-08-30T12:00:00.000Z",
  },
  release: {
    evidenceId: "release-1",
    actionCommitSha: "d".repeat(40),
    workflowSchemaVersion: 5,
    services: [],
  },
} satisfies PrepareZeroLoginRolloverInput;

describe("Prisma zero-login rollover prepare", () => {
  it("reuses a confirmed candidate, but advances past a retired E+1", () => {
    expect(
      selectZeroLoginRolloverCandidateEpoch({
        reusableConfirmedEpoch: 2n,
        maxNamespaceEpoch: 2n,
      }),
    ).toBe(2n);
    expect(
      selectZeroLoginRolloverCandidateEpoch({
        reusableConfirmedEpoch: null,
        maxNamespaceEpoch: 2n,
      }),
    ).toBe(3n);
  });
  it("rejects operation-id replay with substituted target facts", async () => {
    const tx = {
      $queryRaw: vi.fn(async () => []),
      codexOAuthNamespaceRolloverIntent: {
        findUnique: vi.fn(async () => ({
          repositoryFullName: prepareInput.repositoryFullName,
          providerInstanceId: prepareInput.providerInstanceId,
          sourceRunId: prepareInput.schedule.runId,
          sourceRunAttempt: prepareInput.schedule.runAttempt,
          expectedRerunAttempt: prepareInput.expectedRerunAttempt,
          sourceActionCommitSha: prepareInput.schedule.workflowActionCommitSha,
          sourceWorkflowCommitSha: prepareInput.schedule.workflowSourceCommitSha,
          sourceDefaultHeadSha: prepareInput.schedule.sourceDefaultHeadSha,
          targetActionCommitSha: "e".repeat(40),
          releaseEvidenceDigest: "irrelevant-after-target-conflict",
          candidateNamespaceEpoch: 2n,
          candidateNamespace: { secretName: "candidate-e2" },
        })),
      },
    };
    const ledger = new PrismaCodexZeroLoginRolloverLedger(
      { $transaction: vi.fn(async (callback) => callback(tx)) } as never,
      {} as never,
      { actionOwnerRepo: "777genius/review-router", databaseRecoveryWitness: "witness" },
    );

    await expect(ledger.prepare(prepareInput)).rejects.toThrow(
      "zero_login_rollover_prepare_idempotency_conflict",
    );
  });

  it("rejects a preexisting exact rerun lease while holding the provider lock", async () => {
    const candidateCreate = vi.fn();
    const tx = {
      $queryRaw: vi.fn(async () => []),
      codexOAuthNamespaceRolloverIntent: { findUnique: vi.fn(async () => null) },
      codexOAuthProviderInstance: {
        findFirst: vi.fn(async () => ({
          id: "provider-row-1",
          workspaceId: "workspace-1",
          repositoryId: "repository-1",
          providerInstanceId: prepareInput.providerInstanceId,
          activeSecretNamespaceId: "namespace-e1",
          activeSecretNamespace: { namespaceEpoch: 1n },
          repository: {
            githubRepositoryId: 123456n,
            fullName: "owner/repo",
            installation: { githubInstallationId: 789n },
          },
        })),
      },
      codexOAuthLease: {
        findFirst: vi.fn(async () => ({ id: "already-created-exact-lease" })),
      },
      codexOAuthSecretNamespace: { create: candidateCreate },
    };
    const ledger = new PrismaCodexZeroLoginRolloverLedger(
      { $transaction: vi.fn(async (callback) => callback(tx)) } as never,
      {} as never,
      { actionOwnerRepo: "777genius/review-router", databaseRecoveryWitness: "witness" },
    );

    await expect(ledger.prepare(prepareInput)).rejects.toThrow(
      "zero_login_rollover_exact_rerun_already_exists",
    );
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(candidateCreate).not.toHaveBeenCalled();
  });

  it.each(["other active lease", "pending writeback"])(
    "rejects fresh allocation when the provider has a %s",
    async () => {
      let rawCall = 0;
      const queryRaw = vi.fn(async (_query: unknown) => {
        rawCall += 1;
        return rawCall === 3 ? [{ admitted: false }] : [];
      });
      const tx = {
        $queryRaw: queryRaw,
        codexOAuthNamespaceRolloverIntent: { findUnique: vi.fn(async () => null) },
        codexOAuthProviderInstance: {
          findFirst: vi.fn(async () => ({
            id: "provider-row-1",
            workspaceId: "workspace-1",
            repositoryId: "repository-1",
            providerInstanceId: prepareInput.providerInstanceId,
            state: "active",
            mutationOwner: null,
            mutationOwnerId: null,
            activeLeaseId: null,
            activeSecretNamespaceId: "namespace-e1",
            activeSecretNamespace: { namespaceEpoch: 1n },
            repository: {
              githubRepositoryId: 123456n,
              fullName: "owner/repo",
              installation: { githubInstallationId: 789n },
            },
          })),
          update: vi.fn(),
        },
        codexOAuthLease: { findFirst: vi.fn(async () => null) },
        codexOAuthSecretNamespace: {
          findFirst: vi.fn(async () => null),
          aggregate: vi.fn(async () => ({ _max: { namespaceEpoch: 1n } })),
          findUnique: vi.fn(async () => null),
          create: vi.fn(),
        },
      };
      const ledger = new PrismaCodexZeroLoginRolloverLedger(
        { $transaction: vi.fn(async (callback) => callback(tx)) } as never,
        {} as never,
        { actionOwnerRepo: "777genius/review-router", databaseRecoveryWitness: "witness" },
      );

      await expect(ledger.prepare(prepareInput)).rejects.toThrow(
        "zero_login_rollover_provider_not_exclusive",
      );
      const admissionSql = (
        queryRaw.mock.calls[2]?.[0] as unknown as { strings: readonly string[] }
      ).strings.join("");
      expect(admissionSql).toContain('"CodexOAuthLease"');
      expect(admissionSql).toContain('"CodexOAuthWritebackIntent"');
      expect(tx.codexOAuthProviderInstance.update).not.toHaveBeenCalled();
      expect(tx.codexOAuthSecretNamespace.create).not.toHaveBeenCalled();
    },
  );
});

describe("Prisma zero-login existing setup candidate activation", () => {
  it("delegates to the proven setup claim and then reconciles the global slot", async () => {
    const namespace = {
      id: "candidate-e1",
      namespaceEpoch: 1n,
      secretName: "candidate-name",
      status: "confirmed_candidate",
    };
    const provider: { activeSecretNamespaceId: string | null } = {
      activeSecretNamespaceId: null,
    };
    const rollover = {
      id: "rollover-1",
      operationId: "campaign-1:owner/repo",
      repositoryFullName: "owner/repo",
      providerInstanceId: "codex-rotating:123456",
      providerInstanceRowId: "provider-row-1",
      state: "setup_pr_open",
      activeGlobalSlot: 1,
      sourceRunId: "100",
      sourceRunAttempt: "1",
      expectedRerunAttempt: "2",
      sourceActionCommitSha: "a".repeat(40),
      sourceWorkflowCommitSha: "b".repeat(40),
      sourceDefaultHeadSha: "c".repeat(40),
      targetActionCommitSha: "d".repeat(40),
      candidateNamespaceId: namespace.id,
      candidateNamespaceEpoch: 1n,
      writebackGeneration: null,
      candidateNamespace: namespace,
      providerInstance: provider,
    };
    const activateConfirmedCandidate = vi.fn(async () => {
      namespace.status = "active";
      provider.activeSecretNamespaceId = namespace.id;
    });
    const prisma = {
      codexOAuthNamespaceRolloverIntent: {
        findUniqueOrThrow: vi.fn(async () => rollover),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(rollover, data);
          return rollover;
        }),
      },
      codexOAuthWritebackIntent: { findUnique: vi.fn(async () => null) },
      codexOAuthSetupDispatchAttempt: {
        findFirst: vi.fn(async () => ({
          id: "attempt-1",
          claimId: "claim-1",
          claim: { id: "claim-1" },
        })),
      },
      codexOAuthSecretNamespace: {
        findUniqueOrThrow: vi.fn(async () => ({
          ...namespace,
          activeForProvider: provider,
        })),
      },
    };
    const ledger = new PrismaCodexZeroLoginRolloverLedger(
      prisma as never,
      {} as never,
      {
        actionOwnerRepo: "777genius/review-router",
        databaseRecoveryWitness: "witness",
        existingSetupCandidateActivator: { activateConfirmedCandidate },
      },
    );
    const attestation = {
      repositoryId: "123456",
      workflowPath: ".github/workflows/reviewrouter.yml",
      workflowSourceCommitSha: "e".repeat(40),
      workflowSourceBlobSha: "f".repeat(40),
      workflowSourceSha256: "1".repeat(64),
      workflowSemanticSha256: "2".repeat(64),
      sourceTrust: WorkflowSourceTrust.TrustedDefaultBranchRevision,
      secretNamespace: {
        mode: "versioned",
        scope: {
          repositoryId: "123456",
          providerInstanceId: rollover.providerInstanceId,
        },
        namespaceId: namespace.id,
        name: namespace.secretName,
        epoch: 1n,
      },
    } as const;

    await expect(
      ledger.activateAfterAttestation({
        operationId: rollover.operationId,
        expectedNamespaceEpoch: 1n,
        attestation,
      }),
    ).resolves.toMatchObject({ state: "activated" });
    expect(activateConfirmedCandidate).toHaveBeenCalledWith({
      claimId: "claim-1",
      attemptId: "attempt-1",
      candidateNamespaceId: namespace.id,
      attestation,
    });
    expect(prisma.codexOAuthNamespaceRolloverIntent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ state: "activated", activeGlobalSlot: null }),
      }),
    );
  });
});
