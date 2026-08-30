import { describe, expect, it, vi } from "vitest";
import { fingerprintDatabaseRecoveryWitness } from "@reviewrouter/features-codex-oauth-rotating";
import { PrismaCodexRotatingOAuthRepository } from "../infrastructure/prisma/prisma-codex-rotating-oauth-repository.js";

describe("Prisma Codex rotating new-work barrier", () => {
  const databaseRecoveryWitness = "witness_generation_one_12345678901234567890";
  const databaseRecoveryWitnessFingerprint = fingerprintDatabaseRecoveryWitness(
    databaseRecoveryWitness,
  );

  it("reasserts the closed fence inside the provider-lock transaction before lease writes", async () => {
    const providerUpdate = vi.fn();
    const leaseUpsert = vi.fn();
    const queryRaw = vi.fn(async (query: unknown) => {
      void query;
      return [{ id: "provider-row-1" }];
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
          activeSecretNamespaceId: "namespace-active-1",
          activeSecretNamespaceEpoch: 1n,
          activeSecretNamespaceName:
            "REVIEWROUTER_CODEX_AUTH_JSON_R900001_P0123456789abcdef_E1_0123456789abcdef0123456789abcdef",
          activeSecretNamespace: {
            secretName:
              "REVIEWROUTER_CODEX_AUTH_JSON_R900001_P0123456789abcdef_E1_0123456789abcdef0123456789abcdef",
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
      codexOAuthNamespaceRolloverIntent: { findFirst: vi.fn() },
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
    expect(tx.codexOAuthProviderInstance.findUnique).toHaveBeenCalledOnce();
    expect(providerUpdate).not.toHaveBeenCalled();
    expect(leaseUpsert).not.toHaveBeenCalled();
  });

  it.each([-24, 0, 24])(
    "anchors a new lease to database time under process skew %dh",
    async (processSkewHours) => {
      const processNow = new Date(
        new Date("2026-08-09T00:00:00Z").getTime() +
          processSkewHours * 60 * 60 * 1000,
      );
      expect(processNow).toBeInstanceOf(Date);
      const providerUpdate = vi.fn(async () => ({}));
      const leaseUpsert = vi.fn(async () => ({ id: "lease-1" }));
      const activeSecretNamespaceName =
        "REVIEWROUTER_CODEX_AUTH_JSON_R123456_P0123456789abcdef_E1_0123456789abcdef0123456789abcdef";
      const tx = {
        $queryRaw: vi.fn(async () => []),
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
            activeSecretNamespaceId: "namespace-active-1",
            activeSecretNamespaceEpoch: 1n,
            activeSecretNamespaceName,
            activeSecretNamespace: {
              secretName: activeSecretNamespaceName,
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
        codexOAuthNamespaceRolloverIntent: {
          findFirst: vi.fn(async () => null),
        },
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
          newWorkAdmissionBarrier: { assertAdmitted: () => undefined },
        }),
      ).resolves.toMatchObject({
        status: "preleased",
        secretNamespaceId: "namespace-active-1",
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
            secretNamespaceId: "namespace-active-1",
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
    const activeSecretNamespaceName =
      "REVIEWROUTER_CODEX_AUTH_JSON_R123456_P0123456789abcdef_E1_0123456789abcdef0123456789abcdef";
    const tx = {
      $queryRaw: vi.fn(async () => []),
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
          activeSecretNamespaceId: "namespace-active-1",
          activeSecretNamespaceEpoch: 1n,
          activeSecretNamespaceName,
          activeSecretNamespace: {
            secretName: activeSecretNamespaceName,
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
      codexOAuthNamespaceRolloverIntent: { findFirst: vi.fn(async () => null) },
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
