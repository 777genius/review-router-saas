import { describe, expect, it, vi } from "vitest";
import {
  allocateVersionedProviderSecretNamespace,
  assertActiveVersionedSecretWorkflowAttestation,
  createVersionedSecretWorkflowSourceAttestation,
  fingerprintDatabaseRecoveryWitness,
  WorkflowSourceTrust,
} from "@reviewrouter/features-codex-oauth-rotating";
import { PrismaCodexRotatingOAuthRepository } from "../infrastructure/prisma/prisma-codex-rotating-oauth-repository.js";

describe("Prisma Codex rotating new-work barrier", () => {
  const databaseRecoveryWitness = "witness_generation_one_12345678901234567890";
  const databaseRecoveryWitnessFingerprint = fingerprintDatabaseRecoveryWitness(
    databaseRecoveryWitness,
  );
  const activeSecretNamespace = allocateVersionedProviderSecretNamespace({
    scope: {
      repositoryId: "123456",
      providerInstanceId: "codex-rotating:123456",
    },
    epoch: 1n,
    randomBytes: () => new Uint8Array(16).fill(0x44),
  });
  const verifiedWorkflowAttestation =
    createVersionedSecretWorkflowSourceAttestation({
      repositoryId: "123456",
      workflowPath: ".github/workflows/reviewrouter-codex.yml",
      workflowSourceCommitSha: "a".repeat(40),
      workflowSourceBlobSha: "b".repeat(40),
      workflowSourceSha256: "c".repeat(64),
      workflowSemanticSha256: "d".repeat(64),
      workflowSchemaVersion: 4,
      sourceTrust: WorkflowSourceTrust.TrustedDefaultBranchRevision,
      secretNamespace: activeSecretNamespace,
    });
  const persistedWorkflowAttestation = {
    id: activeSecretNamespace.namespaceId,
    githubRepositoryId: "123456",
    namespaceEpoch: 1n,
    secretName: activeSecretNamespace.name,
    workflowPath: verifiedWorkflowAttestation.workflowPath,
    workflowSourceCommitSha:
      verifiedWorkflowAttestation.workflowSourceCommitSha,
    workflowSourceBlobSha: verifiedWorkflowAttestation.workflowSourceBlobSha,
    workflowSourceSha256: verifiedWorkflowAttestation.workflowSourceSha256,
    workflowSemanticSha256: verifiedWorkflowAttestation.workflowSemanticSha256,
    workflowSourceTrust: verifiedWorkflowAttestation.sourceTrust,
    workflowSchemaVersion: verifiedWorkflowAttestation.workflowSchemaVersion,
    attestedRepositoryId: verifiedWorkflowAttestation.repositoryId,
  };
  const lockedWorkflowAdmission = (
    workflow: typeof persistedWorkflowAttestation,
  ) => ({
    ...workflow,
    status: "active",
    permanentlyRetired: false,
  });
  const isNamespaceLock = (query: unknown) =>
    (query as { strings?: readonly string[] }).strings
      ?.join("")
      .includes('FROM "CodexOAuthSecretNamespace" namespace') === true;

  it("fails a stale V4 request after durable V5 re-attestation wins the provider lock", async () => {
    let releaseVerifiedRequest!: () => void;
    let reportVerifiedRequest!: () => void;
    const verifiedRequestPaused = new Promise<void>((resolve) => {
      reportVerifiedRequest = resolve;
    });
    const releaseRequest = new Promise<void>((resolve) => {
      releaseVerifiedRequest = resolve;
    });
    let durableWorkflow = persistedWorkflowAttestation;
    const providerUpdate = vi.fn();
    const leaseUpsert = vi.fn();
    const providerRow = () => ({
      id: "provider-row-1",
      workspaceId: "workspace-1",
      repositoryId: "repository-1",
      providerInstanceId: "codex-rotating:123456",
      authMode: "codex_subscription_oauth_rotating",
      secretName: "REVIEWROUTER_CODEX_AUTH_JSON",
      activeLeaseId: null,
      activeLeaseExpiresAt: null,
      mutationEpoch: 0n,
      mutationOwner: null,
      mutationOwnerId: null,
      activeSecretNamespaceId: activeSecretNamespace.namespaceId,
      activeSecretNamespaceEpoch: activeSecretNamespace.epoch,
      activeSecretNamespaceName: activeSecretNamespace.name,
      activeSecretNamespace: {
        ...durableWorkflow,
        status: "active",
        databaseRecoveryWitness: databaseRecoveryWitnessFingerprint,
      },
      state: "active",
      latestGeneration: 1,
      latestGenerationHash: "generation-hash",
      generationHashSalt: "generation-salt",
      accountFingerprintSalt: "account-salt",
    });
    const queryRaw = vi.fn(async (query: unknown) =>
      isNamespaceLock(query) ? [lockedWorkflowAdmission(durableWorkflow)] : [],
    );
    const tx = {
      $queryRaw: queryRaw,
      $executeRawUnsafe: vi.fn(),
      codexOAuthProviderInstance: {
        findUnique: vi.fn(async () => providerRow()),
        update: providerUpdate,
      },
      codexOAuthWritebackIntent: { findFirst: vi.fn(async () => null) },
      codexOAuthSetupManifest: { findFirst: vi.fn(async () => null) },
      codexOAuthLease: { upsert: leaseUpsert },
    };
    const prisma = {
      codexOAuthProviderInstance: {
        findUnique: vi.fn(async () => providerRow()),
      },
      $transaction: vi.fn(async (callback) => callback(tx)),
    };
    const repository = new PrismaCodexRotatingOAuthRepository(prisma as never, {
      actionOwnerRepo: "reviewrouter/action",
      databaseRecoveryWitness,
      transactionClock: fixedClock("2026-08-09T00:00:00Z"),
    });
    const repositoryContext = {
      workspaceId: "workspace-1",
      repositoryId: "repository-1",
      githubRepositoryId: "123456",
      githubInstallationId: "789",
      fullName: "owner/repo",
      owner: "owner",
      selected: true,
      installationStatus: "active",
    } as const;

    const staleRequest = (async () => {
      const binding = await repository.findProviderBinding({
        repository: repositoryContext,
        providerInstanceId: "codex-rotating:123456",
        workflowSha: verifiedWorkflowAttestation.workflowSourceCommitSha,
        workflowSchemaVersion: 4,
      });
      expect(binding?.activeWorkflowSource).toBeDefined();
      assertActiveVersionedSecretWorkflowAttestation({
        attestation: verifiedWorkflowAttestation,
        repositoryId: repositoryContext.githubRepositoryId,
        workflowPath: binding!.workflowPath,
        workflowSourceCommitSha:
          verifiedWorkflowAttestation.workflowSourceCommitSha,
        activeSecretNamespace: binding!.activeSecretNamespace!,
        expectedWorkflowSource: binding!.activeWorkflowSource!,
      });
      reportVerifiedRequest();
      await releaseRequest;
      return repository.acquirePrelease({
        repository: repositoryContext,
        providerInstanceId: "codex-rotating:123456",
        githubRunId: "race-run",
        githubRunAttempt: "1",
        verifiedWorkflowAttestation,
        newWorkAdmissionBarrier: { assertAdmitted: () => undefined },
      });
    })();

    await verifiedRequestPaused;
    const v5Attestation = createVersionedSecretWorkflowSourceAttestation({
      ...verifiedWorkflowAttestation,
      workflowSourceCommitSha: "e".repeat(40),
      workflowSourceBlobSha: "f".repeat(40),
      workflowSourceSha256: "1".repeat(64),
      workflowSemanticSha256: "2".repeat(64),
      workflowSchemaVersion: 5,
    });
    durableWorkflow = {
      ...persistedWorkflowAttestation,
      workflowSourceCommitSha: v5Attestation.workflowSourceCommitSha,
      workflowSourceBlobSha: v5Attestation.workflowSourceBlobSha,
      workflowSourceSha256: v5Attestation.workflowSourceSha256,
      workflowSemanticSha256: v5Attestation.workflowSemanticSha256,
      workflowSchemaVersion: 5,
    };
    releaseVerifiedRequest();

    await expect(staleRequest).rejects.toThrow(
      "codex_rotating_workflow_attestation_stale",
    );
    expect(queryRaw).toHaveBeenCalledTimes(3);
    expect(providerUpdate).not.toHaveBeenCalled();
    expect(leaseUpsert).not.toHaveBeenCalled();
  });

  it("reasserts the closed fence inside the provider-lock transaction before lease writes", async () => {
    const providerUpdate = vi.fn();
    const leaseUpsert = vi.fn();
    const queryRaw = vi.fn(async (query: unknown) => {
      return isNamespaceLock(query)
        ? [lockedWorkflowAdmission(persistedWorkflowAttestation)]
        : [{ id: "provider-row-1" }];
    });
    const tx = {
      $queryRaw: queryRaw,
      $executeRawUnsafe: vi.fn(),
      codexOAuthProviderInstance: {
        findUnique: vi.fn(async () => ({
          id: "provider-row-1",
          workspaceId: "workspace-1",
          repositoryId: "repository-1",
          providerInstanceId: "codex-rotating:123456",
          authMode: "codex_subscription_oauth_rotating",
          secretName: "REVIEWROUTER_CODEX_AUTH_JSON",
          activeLeaseId: null,
          activeLeaseExpiresAt: null,
          mutationEpoch: 0n,
          mutationOwner: null,
          mutationOwnerId: null,
          activeSecretNamespaceId: activeSecretNamespace.namespaceId,
          activeSecretNamespaceEpoch: 1n,
          activeSecretNamespaceName: activeSecretNamespace.name,
          activeSecretNamespace: {
            ...persistedWorkflowAttestation,
            status: "active",
            databaseRecoveryWitness: databaseRecoveryWitnessFingerprint,
          },
          state: "setup_pending",
          latestGeneration: 1,
          latestGenerationHash: null,
          generationHashSalt: "salt",
        })),
        update: providerUpdate,
      },
      codexOAuthWritebackIntent: { findFirst: vi.fn() },
      codexOAuthSetupManifest: { findFirst: vi.fn() },
      codexOAuthLease: { upsert: leaseUpsert },
    };
    const transaction = vi.fn(async (callback) => callback(tx));
    const repository = new PrismaCodexRotatingOAuthRepository(
      { $transaction: transaction } as never,
      {
        actionOwnerRepo: "reviewrouter/action",
        databaseRecoveryWitness,
        transactionClock: fixedClock("2026-08-09T00:00:00Z"),
      },
    );

    await expect(
      repository.acquirePrelease({
        repository: {
          workspaceId: "workspace-1",
          repositoryId: "repository-1",
          githubRepositoryId: "123456",
          githubInstallationId: "789",
          fullName: "owner/repo",
          owner: "owner",
          selected: true,
          installationStatus: "active",
        },
        providerInstanceId: "codex-rotating:123456",
        githubRunId: "100",
        githubRunAttempt: "1",
        verifiedWorkflowAttestation,
        newWorkAdmissionBarrier: {
          assertAdmitted() {
            throw new Error("codex_rotating_new_work_admission_closed");
          },
        },
      }),
    ).rejects.toThrow("codex_rotating_new_work_admission_closed");
    expect(transaction).toHaveBeenCalledOnce();
    expect(queryRaw).toHaveBeenCalledTimes(3);
    expect(
      (
        queryRaw.mock.calls[0]?.[0] as { strings: readonly string[] }
      ).strings.join(""),
    ).toContain("pg_advisory_xact_lock_shared");
    expect(
      (
        queryRaw.mock.calls[2]?.[0] as { strings: readonly string[] }
      ).strings.join(""),
    ).toMatch(
      /workflowSchemaVersion[\s\S]+CodexOAuthSecretNamespace[\s\S]+FOR UPDATE/u,
    );
    expect(tx.codexOAuthProviderInstance.findUnique).toHaveBeenCalledOnce();
    expect(providerUpdate).not.toHaveBeenCalled();
    expect(leaseUpsert).not.toHaveBeenCalled();
  });

  it.each([
    [4, -24],
    [4, 0],
    [4, 24],
    [5, -24],
    [5, 0],
    [5, 24],
  ] as const)(
    "admits V%d and anchors a new lease to database time under process skew %dh",
    async (workflowSchemaVersion, processSkewHours) => {
      const processNow = new Date(
        new Date("2026-08-09T00:00:00Z").getTime() +
          processSkewHours * 60 * 60 * 1000,
      );
      expect(processNow).toBeInstanceOf(Date);
      const providerUpdate = vi.fn(async () => ({}));
      const leaseUpsert = vi.fn(async () => ({ id: "lease-1" }));
      const activeSecretNamespaceName = activeSecretNamespace.name;
      const requestAttestation = createVersionedSecretWorkflowSourceAttestation(
        {
          ...verifiedWorkflowAttestation,
          workflowSchemaVersion,
          sourceTrust:
            workflowSchemaVersion === 5
              ? WorkflowSourceTrust.TrustedCanonicalBranchMirrorRevision
              : WorkflowSourceTrust.TrustedDefaultBranchRevision,
        },
      );
      const persistedRequestAttestation = {
        ...persistedWorkflowAttestation,
        workflowSchemaVersion,
      };
      const tx = {
        $queryRaw: vi.fn(async (query: unknown) =>
          isNamespaceLock(query)
            ? [lockedWorkflowAdmission(persistedRequestAttestation)]
            : [],
        ),
        $executeRawUnsafe: vi.fn(),
        codexOAuthProviderInstance: {
          findUnique: vi.fn(async () => ({
            id: "provider-row-1",
            workspaceId: "workspace-1",
            repositoryId: "repository-1",
            providerInstanceId: "codex-rotating:123456",
            authMode: "codex_subscription_oauth_rotating",
            secretName: "REVIEWROUTER_CODEX_AUTH_JSON",
            activeLeaseId: null,
            activeLeaseExpiresAt: null,
            mutationEpoch: 3n,
            mutationOwner: null,
            mutationOwnerId: null,
            activeSecretNamespaceId: activeSecretNamespace.namespaceId,
            activeSecretNamespaceEpoch: 1n,
            activeSecretNamespaceName,
            activeSecretNamespace: {
              ...persistedRequestAttestation,
              status: "active",
              databaseRecoveryWitness: databaseRecoveryWitnessFingerprint,
            },
            state: "active",
            latestGeneration: 1,
            latestGenerationHash: "generation-hash",
            generationHashSalt: "generation-salt",
            accountFingerprintSalt: "account-salt",
          })),
          update: providerUpdate,
        },
        codexOAuthWritebackIntent: { findFirst: vi.fn(async () => null) },
        codexOAuthSetupManifest: { findFirst: vi.fn(async () => null) },
        codexOAuthLease: { upsert: leaseUpsert },
      };
      const repository = new PrismaCodexRotatingOAuthRepository(
        { $transaction: vi.fn(async (callback) => callback(tx)) } as never,
        {
          actionOwnerRepo: "reviewrouter/action",
          databaseRecoveryWitness,
          transactionClock: fixedClock("2026-08-09T00:00:00Z"),
        },
      );

      await expect(
        repository.acquirePrelease({
          repository: {
            workspaceId: "workspace-1",
            repositoryId: "repository-1",
            githubRepositoryId: "123456",
            githubInstallationId: "789",
            fullName: "owner/repo",
            owner: "owner",
            selected: true,
            installationStatus: "active",
          },
          providerInstanceId: "codex-rotating:123456",
          githubRunId: "100",
          githubRunAttempt: "1",
          verifiedWorkflowAttestation: requestAttestation,
          newWorkAdmissionBarrier: { assertAdmitted: () => undefined },
        }),
      ).resolves.toMatchObject({
        status: "preleased",
        secretNamespaceId: activeSecretNamespace.namespaceId,
        secretNamespaceEpoch: 1n,
      });

      expect(providerUpdate).toHaveBeenNthCalledWith(1, {
        where: { id: "provider-row-1" },
        data: {
          mutationEpoch: 4n,
          mutationOwner: "runtime",
          mutationOwnerId: "codex-rotating:123456:100:1",
        },
      });
      expect(leaseUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            secretNamespaceId: activeSecretNamespace.namespaceId,
            secretNamespaceEpoch: 1n,
            expiresAt: new Date("2026-08-09T00:15:00Z"),
          }),
        }),
      );
    },
  );

  it("rejects a restored active namespace under a different witness before provider or lease writes", async () => {
    const providerUpdate = vi.fn();
    const leaseUpsert = vi.fn();
    const activeSecretNamespaceName = activeSecretNamespace.name;
    const tx = {
      $queryRaw: vi.fn(async (query: unknown) =>
        isNamespaceLock(query)
          ? [lockedWorkflowAdmission(persistedWorkflowAttestation)]
          : [],
      ),
      $executeRawUnsafe: vi.fn(),
      codexOAuthProviderInstance: {
        findUnique: vi.fn(async () => ({
          id: "provider-row-1",
          workspaceId: "workspace-1",
          repositoryId: "repository-1",
          providerInstanceId: "codex-rotating:123456",
          authMode: "codex_subscription_oauth_rotating",
          secretName: "REVIEWROUTER_CODEX_AUTH_JSON",
          activeLeaseId: null,
          activeLeaseExpiresAt: null,
          mutationEpoch: 3n,
          mutationOwner: null,
          mutationOwnerId: null,
          activeSecretNamespaceId: activeSecretNamespace.namespaceId,
          activeSecretNamespaceEpoch: 1n,
          activeSecretNamespaceName,
          activeSecretNamespace: {
            ...persistedWorkflowAttestation,
            status: "active",
            databaseRecoveryWitness: databaseRecoveryWitnessFingerprint,
          },
          state: "active",
          latestGeneration: 1,
          latestGenerationHash: "generation-hash",
          generationHashSalt: "generation-salt",
          accountFingerprintSalt: "account-salt",
        })),
        update: providerUpdate,
      },
      codexOAuthWritebackIntent: { findFirst: vi.fn(async () => null) },
      codexOAuthSetupManifest: { findFirst: vi.fn(async () => null) },
      codexOAuthLease: { upsert: leaseUpsert },
    };
    const repository = new PrismaCodexRotatingOAuthRepository(
      { $transaction: vi.fn(async (callback) => callback(tx)) } as never,
      {
        actionOwnerRepo: "reviewrouter/action",
        databaseRecoveryWitness: "witness_generation_two_12345678901234567890",
        transactionClock: fixedClock("2026-08-09T00:00:00Z"),
      },
    );

    await expect(
      repository.acquirePrelease({
        repository: {
          workspaceId: "workspace-1",
          repositoryId: "repository-1",
          githubRepositoryId: "123456",
          githubInstallationId: "789",
          fullName: "owner/repo",
          owner: "owner",
          selected: true,
          installationStatus: "active",
        },
        providerInstanceId: "codex-rotating:123456",
        githubRunId: "100",
        githubRunAttempt: "1",
        verifiedWorkflowAttestation,
        newWorkAdmissionBarrier: { assertAdmitted: () => undefined },
      }),
    ).rejects.toThrow("codex_rotating_database_recovery_witness_mismatch");
    expect(providerUpdate).not.toHaveBeenCalled();
    expect(leaseUpsert).not.toHaveBeenCalled();
  });

  it("rejects a witness change before allocating a versioned namespace or writeback intent", async () => {
    const namespaceCreate = vi.fn();
    const intentCreate = vi.fn();
    const activeSecretNamespaceName =
      "REVIEWROUTER_CODEX_AUTH_JSON_R123456_P0123456789abcdef_E1_0123456789abcdef0123456789abcdef";
    const tx = {
      $queryRaw: vi.fn(async () => []),
      $executeRawUnsafe: vi.fn(),
      codexOAuthWritebackIntent: {
        findFirst: vi.fn(async () => null),
        findUnique: vi.fn(async () => null),
        create: intentCreate,
      },
      codexOAuthProviderInstance: {
        findUnique: vi.fn(async () => ({
          id: "provider-row-1",
          providerInstanceId: "codex-rotating:123456",
          activeLeaseId: "lease-1",
          activeLeaseExpiresAt: new Date("2026-08-09T00:10:00Z"),
          mutationEpoch: 4n,
          mutationOwner: "runtime",
          mutationOwnerId: "lease-1",
          latestGeneration: 1,
          latestGenerationHash: "restored-generation-hash",
          activeAccountIdentityHash: "account-identity-hash",
          activeSecretNamespaceId: "namespace-active-1",
          activeSecretNamespaceEpoch: 1n,
          activeSecretNamespaceName,
          activeSecretNamespace: {
            secretName: activeSecretNamespaceName,
            status: "active",
            databaseRecoveryWitness: databaseRecoveryWitnessFingerprint,
          },
          repository: {
            id: "repository-1",
            workspaceId: "workspace-1",
            provider: "github",
            githubRepositoryId: 123456n,
            fullName: "owner/repo",
            owner: "owner",
            name: "repo",
            selected: true,
            installation: {
              githubInstallationId: 789n,
              status: "active",
            },
          },
          leases: [
            {
              id: "lease-1",
              status: "finalized",
              expiresAt: new Date("2026-08-09T00:10:00Z"),
              nextGeneration: 2,
              restoredGenerationHash: "restored-generation-hash",
              writebackPreflightKeyId: "github-key",
              mutationEpoch: 4n,
              secretNamespaceId: "namespace-active-1",
              secretNamespaceEpoch: 1n,
            },
          ],
          secretNamespaces: [{ namespaceEpoch: 1n }],
        })),
      },
      codexOAuthSecretNamespace: { create: namespaceCreate },
    };
    const repository = new PrismaCodexRotatingOAuthRepository(
      { $transaction: vi.fn(async (callback) => callback(tx)) } as never,
      {
        actionOwnerRepo: "reviewrouter/action",
        databaseRecoveryWitness: "witness_generation_two_12345678901234567890",
        transactionClock: fixedClock("2026-08-09T00:00:00Z"),
      },
    );

    await expect(
      repository.prepareVersionedWriteback({
        request: {
          protocolVersion: 1,
          leaseId: "lease-1",
          providerInstanceId: "codex-rotating:123456",
          generation: 2,
          latestGenerationHash: "next-generation-hash",
          accountIdentityHash: "account-identity-hash",
          accountIdentityAlgorithm: "provider_issuer_subject_account_v1",
          encryptedValue: "ZW5jcnlwdGVk",
          keyId: "github-key",
          idempotencyKey: "writeback-witness-proof",
        },
        encryptedPayloadDigest: "encrypted-payload-digest",
      }),
    ).rejects.toThrow("codex_rotating_database_recovery_witness_mismatch");
    expect(namespaceCreate).not.toHaveBeenCalled();
    expect(intentCreate).not.toHaveBeenCalled();
  });
});

function fixedClock(instant: string) {
  return { now: async () => new Date(instant) };
}
