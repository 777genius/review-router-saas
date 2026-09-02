import type { PrismaClient } from "@prisma/client";
import {
  allocateVersionedProviderSecretNamespace,
  createVersionedSecretWorkflowSourceAttestation,
  fingerprintDatabaseRecoveryWitness,
  WorkflowSourceTrust,
} from "@reviewrouter/features-codex-oauth-rotating";
import { describe, expect, it, vi } from "vitest";
import {
  codexRotatingCommentTokenRefreshTtlMs,
  codexRotatingReviewExecutionCheckpointAccessTtlMs,
  codexRotatingReviewSnapshotAccessTtlMs,
} from "../domain/codex-rotating-oauth-posting-window.js";
import {
  orgRulesetTargetsRepository,
  PrismaActionControlPlaneRepository,
} from "../infrastructure/prisma/prisma-action-control-plane-repository.js";
import { PrismaCodexRotatingOAuthRepository } from "../infrastructure/prisma/prisma-codex-rotating-oauth-repository.js";

const databaseRecoveryWitness = "witness_generation_one_12345678901234567890";

describe("persisted workflow schema admission", () => {
  it.each([4, 5] as const)(
    "admits V%s only when the subsequent request equals the persisted version",
    async (workflowSchemaVersion) => {
      const namespace = allocateVersionedProviderSecretNamespace({
        scope: {
          repositoryId: "123456",
          providerInstanceId: "codex-rotating:123456",
        },
        epoch: 2n,
        randomBytes: () => new Uint8Array(16).fill(workflowSchemaVersion),
      });
      const provider = {
        id: "provider-row-1",
        workspaceId: "workspace-1",
        repositoryId: "repository-1",
        authMode: "codex_subscription_oauth_rotating",
        activeSecretNamespaceId: namespace.namespaceId,
        activeSecretNamespaceEpoch: namespace.epoch,
        activeSecretNamespace: {
          id: namespace.namespaceId,
          githubRepositoryId: "123456",
          namespaceEpoch: namespace.epoch,
          secretName: namespace.name,
          status: "active",
          workflowPath: ".github/workflows/reviewrouter-codex.yml",
          workflowSourceCommitSha: "a".repeat(40),
          workflowSourceBlobSha: "b".repeat(40),
          workflowSourceSha256: "c".repeat(64),
          workflowSemanticSha256: "d".repeat(64),
          workflowSourceTrust: "trusted_default_branch_revision",
          workflowSchemaVersion,
          attestedRepositoryId: "123456",
        },
      };
      const prisma = {
        $queryRaw: vi.fn(async () => []),
        codexOAuthProviderInstance: {
          findUnique: vi.fn(async () => provider),
        },
      };
      const repository = new PrismaCodexRotatingOAuthRepository(
        prisma as never,
        { actionOwnerRepo: "777genius/review-router" },
      );
      const request = {
        repository: {
          workspaceId: "workspace-1",
          repositoryId: "repository-1",
          githubRepositoryId: "123456",
          githubInstallationId: "789",
          fullName: "777genius/example",
          owner: "777genius",
          selected: true,
          installationStatus: "active",
        },
        providerInstanceId: "codex-rotating:123456",
        workflowSha: "e".repeat(40),
      } as const;

      await expect(
        repository.findProviderBinding({
          ...request,
          workflowSchemaVersion,
        }),
      ).resolves.toMatchObject({ workflowSchemaVersion });
      await expect(
        repository.findProviderBinding({
          ...request,
          workflowSchemaVersion: workflowSchemaVersion === 4 ? 5 : 4,
        }),
      ).resolves.toBeNull();
    },
  );
});

describe("completed versioned writeback replay fencing", () => {
  it("fails restored W1 terminal evidence closed under W2 without mutating it", async () => {
    const databaseIncarnation = "7612345678901234567";
    const completedIntent = {
      id: "intent:completed-replay",
      providerInstanceRowId: "provider:completed-replay",
      leaseId: "lease:completed-replay",
      providerInstanceId: "codex-rotating:123456",
      idempotencyKey: "idem:completed-replay",
      encryptedPayloadDigest: "encrypted-digest",
      keyId: "github-key",
      latestGenerationHash: "latest-generation-hash",
      generation: 2,
      status: "completed",
      mutationEpoch: 4n,
      dispatchAttemptId: "attempt:completed-replay",
      secretNamespaceId: "namespace:completed-replay",
      databaseIncarnation,
      databaseRecoveryWitness: fingerprintDatabaseRecoveryWitness(
        databaseRecoveryWitness,
      ),
      executorOwner: "executor:lock-order",
      executorLeaseExpiresAt: new Date("2026-08-10T00:05:00.000Z"),
      accountIdentityHash: "account-identity-hash",
      accountIdentityAlgorithm: "provider_issuer_subject_account_v1",
    };
    const tx = {
      $executeRawUnsafe: vi.fn(async () => 0),
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ id: completedIntent.providerInstanceRowId }])
        .mockResolvedValueOnce([{ databaseIncarnation }]),
      codexOAuthWritebackIntent: {
        findFirst: vi.fn(async () => completedIntent),
        findUnique: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) =>
        operation(tx),
      ),
    };
    const repository = new PrismaCodexRotatingOAuthRepository(prisma as never, {
      actionOwnerRepo: "777genius/review-router",
      databaseRecoveryWitness: "witness_generation_two_12345678901234567890",
      transactionClock: fixedClock("2026-08-10T00:00:00.000Z"),
    });

    await expect(
      repository.prepareVersionedWriteback({
        request: {
          protocolVersion: 1,
          leaseId: completedIntent.leaseId,
          providerInstanceId: completedIntent.providerInstanceId,
          generation: completedIntent.generation,
          latestGenerationHash: completedIntent.latestGenerationHash,
          accountIdentityHash: completedIntent.accountIdentityHash,
          accountIdentityAlgorithm: "provider_issuer_subject_account_v1",
          encryptedValue: "Y2lwaGVydGV4dA==",
          keyId: completedIntent.keyId,
          idempotencyKey: completedIntent.idempotencyKey,
        },
        encryptedPayloadDigest: completedIntent.encryptedPayloadDigest,
      }),
    ).rejects.toThrow("codex_rotating_database_recovery_witness_mismatch");

    expect(tx.codexOAuthWritebackIntent.update).not.toHaveBeenCalled();
    expect(tx.codexOAuthWritebackIntent.updateMany).not.toHaveBeenCalled();
  });

  it("validates the current database incarnation before replaying completed evidence", async () => {
    const completedIntent = {
      id: "intent:completed-incarnation",
      providerInstanceRowId: "provider:completed-incarnation",
      leaseId: "lease:completed-incarnation",
      providerInstanceId: "codex-rotating:123456",
      idempotencyKey: "idem:completed-incarnation",
      encryptedPayloadDigest: "encrypted-digest",
      keyId: "github-key",
      latestGenerationHash: "latest-generation-hash",
      generation: 2,
      status: "completed",
      mutationEpoch: 4n,
      dispatchAttemptId: "attempt:completed-incarnation",
      secretNamespaceId: "namespace:completed-incarnation",
      databaseIncarnation: "7612345678901234567",
      databaseRecoveryWitness: fingerprintDatabaseRecoveryWitness(
        databaseRecoveryWitness,
      ),
      accountIdentityHash: "account-identity-hash",
      accountIdentityAlgorithm: "provider_issuer_subject_account_v1",
    };
    const tx = {
      $executeRawUnsafe: vi.fn(async () => 0),
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ id: completedIntent.providerInstanceRowId }])
        .mockResolvedValueOnce([
          { databaseIncarnation: "7999999999999999999" },
        ]),
      codexOAuthWritebackIntent: {
        findFirst: vi.fn(async () => completedIntent),
        findUnique: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) =>
        operation(tx),
      ),
    };
    const repository = new PrismaCodexRotatingOAuthRepository(prisma as never, {
      actionOwnerRepo: "777genius/review-router",
      databaseRecoveryWitness,
      transactionClock: fixedClock("2026-08-10T00:00:00.000Z"),
    });

    await expect(
      repository.prepareVersionedWriteback({
        request: {
          protocolVersion: 1,
          leaseId: completedIntent.leaseId,
          providerInstanceId: completedIntent.providerInstanceId,
          generation: completedIntent.generation,
          latestGenerationHash: completedIntent.latestGenerationHash,
          accountIdentityHash: completedIntent.accountIdentityHash,
          accountIdentityAlgorithm: "provider_issuer_subject_account_v1",
          encryptedValue: "Y2lwaGVydGV4dA==",
          keyId: completedIntent.keyId,
          idempotencyKey: completedIntent.idempotencyKey,
        },
        encryptedPayloadDigest: completedIntent.encryptedPayloadDigest,
      }),
    ).rejects.toThrow("codex_rotating_database_incarnation_mismatch");

    expect(tx.codexOAuthWritebackIntent.update).not.toHaveBeenCalled();
    expect(tx.codexOAuthWritebackIntent.updateMany).not.toHaveBeenCalled();
  });
});

describe("ambiguous versioned writeback lock ordering", () => {
  it("locks the provider before reading and retiring namespace children", async () => {
    const order: string[] = [];
    const intent = {
      providerInstanceRowId: "provider:lock-order",
      providerInstanceId: "codex-rotating:123456",
      leaseId: "lease:lock-order",
      dispatchAttemptId: "attempt:lock-order",
      secretNamespaceId: "namespace:lock-order",
      status: "pending",
      mutationEpoch: 7n,
      generation: 2,
      latestGenerationHash: "generation-hash-lock-order",
      accountIdentityHash: "account-identity-hash-lock-order",
      databaseIncarnation: "7612345678901234567",
      databaseRecoveryWitness: fingerprintDatabaseRecoveryWitness(
        databaseRecoveryWitness,
      ),
      executorOwner: "executor:lock-order",
      executorLeaseExpiresAt: new Date("2026-08-10T00:05:00.000Z"),
      providerInstance: {
        mutationOwner: "runtime",
        mutationOwnerId: "lease:lock-order",
        mutationEpoch: 7n,
        activeAccountIdentityHash: "account-identity-hash-lock-order",
      },
    };
    const tx = {
      codexOAuthWritebackIntent: {
        findUnique: vi
          .fn()
          .mockImplementationOnce(async () => {
            order.push("intent_locator");
            return {
              providerInstanceRowId: intent.providerInstanceRowId,
              dispatchAttemptId: intent.dispatchAttemptId,
            };
          })
          .mockImplementationOnce(async () => {
            order.push("intent_locked_read");
            return intent;
          }),
        updateMany: vi.fn(async () => {
          order.push("intent_update");
          return { count: 1 };
        }),
      },
      codexOAuthSecretNamespace: {
        updateMany: vi.fn(async () => {
          order.push("namespace_update");
          return { count: 1 };
        }),
      },
      codexOAuthProviderInstance: {
        updateMany: vi.fn(async () => {
          order.push("provider_cas");
          return { count: 1 };
        }),
      },
      codexOAuthLease: {
        updateMany: vi.fn(async () => {
          order.push("lease_update");
          return { count: 1 };
        }),
      },
      $queryRaw: vi
        .fn()
        .mockImplementationOnce(async () => {
          order.push("provider_lock");
          return [{ id: intent.providerInstanceRowId }];
        })
        .mockImplementationOnce(async () => {
          order.push("database_incarnation_read");
          return [{ databaseIncarnation: intent.databaseIncarnation }];
        }),
    };
    const prisma = {
      $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) =>
        operation(tx),
      ),
    };
    const repository = new PrismaCodexRotatingOAuthRepository(prisma as never, {
      actionOwnerRepo: "777genius/review-router",
      databaseRecoveryWitness,
      transactionClock: fixedClock(intent.executorLeaseExpiresAt),
    });

    await repository.retireAmbiguousVersionedWriteback({
      intentId: "intent:lock-order",
      attemptId: intent.dispatchAttemptId,
      executorOwner: intent.executorOwner,
      retirementIdentity: {
        providerInstanceId: intent.providerInstanceId,
        mutationOwner: "runtime",
        mutationOwnerId: intent.leaseId,
        mutationEpoch: intent.mutationEpoch,
        namespaceId: intent.secretNamespaceId,
        generation: intent.generation,
        latestGenerationHash: intent.latestGenerationHash,
        accountIdentityHash: intent.accountIdentityHash,
      },
      safeErrorCode: "provider_response_unknown",
    });

    expect(order).toEqual([
      "intent_locator",
      "provider_lock",
      "intent_locked_read",
      "database_incarnation_read",
      "namespace_update",
      "intent_update",
      "provider_cas",
      "lease_update",
    ]);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("accepts an exact repeated retirement idempotently long after executor expiry", async () => {
    const executorLeaseExpiresAt = new Date("2026-08-10T00:05:00.000Z");
    const intent = {
      providerInstanceRowId: "provider:retired",
      providerInstanceId: "codex-rotating:123456",
      leaseId: "lease:retired",
      dispatchAttemptId: "attempt:retired",
      secretNamespaceId: "namespace:retired",
      status: "remote_outcome_unknown",
      mutationEpoch: 7n,
      generation: 2,
      latestGenerationHash: "generation-hash-retired",
      accountIdentityHash: "account-identity-hash-retired",
      databaseIncarnation: "7612345678901234567",
      databaseRecoveryWitness: fingerprintDatabaseRecoveryWitness(
        databaseRecoveryWitness,
      ),
      executorOwner: "executor:retired",
      executorLeaseExpiresAt,
      providerInstance: {
        mutationOwner: "recovery",
        mutationOwnerId: "intent:retired",
        mutationEpoch: 8n,
        activeAccountIdentityHash: "account-identity-hash-retired",
      },
    };
    const tx = {
      codexOAuthWritebackIntent: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce({
            providerInstanceRowId: intent.providerInstanceRowId,
            dispatchAttemptId: intent.dispatchAttemptId,
          })
          .mockResolvedValueOnce(intent),
        updateMany: vi.fn(),
      },
      codexOAuthSecretNamespace: { updateMany: vi.fn() },
      codexOAuthProviderInstance: { updateMany: vi.fn() },
      codexOAuthLease: { updateMany: vi.fn() },
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ id: intent.providerInstanceRowId }])
        .mockResolvedValueOnce([
          { databaseIncarnation: intent.databaseIncarnation },
        ]),
    };
    const prisma = {
      $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) =>
        operation(tx),
      ),
    };
    const repository = new PrismaCodexRotatingOAuthRepository(prisma as never, {
      actionOwnerRepo: "777genius/review-router",
      databaseRecoveryWitness,
      transactionClock: fixedClock("2026-08-10T01:00:00.000Z"),
    });

    await expect(
      repository.retireAmbiguousVersionedWriteback({
        intentId: "intent:retired",
        attemptId: intent.dispatchAttemptId,
        executorOwner: intent.executorOwner,
        retirementIdentity: {
          providerInstanceId: intent.providerInstanceId,
          mutationOwner: "runtime",
          mutationOwnerId: intent.leaseId,
          mutationEpoch: intent.mutationEpoch,
          namespaceId: intent.secretNamespaceId,
          generation: intent.generation,
          latestGenerationHash: intent.latestGenerationHash,
          accountIdentityHash: intent.accountIdentityHash,
        },
        safeErrorCode: "versioned_provider_put_outcome_unknown",
      }),
    ).resolves.toBeUndefined();
    expect(tx.codexOAuthSecretNamespace.updateMany).not.toHaveBeenCalled();
    expect(tx.codexOAuthWritebackIntent.updateMany).not.toHaveBeenCalled();
    expect(tx.codexOAuthProviderInstance.updateMany).not.toHaveBeenCalled();
    expect(tx.codexOAuthLease.updateMany).not.toHaveBeenCalled();
  });

  it("retires a definite pre-dispatch failure without unknown-outcome evidence", async () => {
    const now = new Date("2026-08-10T00:00:00.000Z");
    const intent = {
      providerInstanceRowId: "provider:predispatch",
      leaseId: "lease:predispatch",
      dispatchAttemptId: "attempt:predispatch",
      secretNamespaceId: "namespace:predispatch",
      status: "pending",
      providerConfirmedAt: null,
      mutationEpoch: 7n,
      databaseIncarnation: "7612345678901234567",
      databaseRecoveryWitness: fingerprintDatabaseRecoveryWitness(
        databaseRecoveryWitness,
      ),
      executorOwner: "executor:predispatch",
      executorLeaseExpiresAt: new Date(now.getTime() + 60_000),
      providerInstance: {
        activeSecretNamespaceId: "namespace:active",
      },
    };
    const tx = {
      codexOAuthWritebackIntent: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce({
            providerInstanceRowId: intent.providerInstanceRowId,
            dispatchAttemptId: intent.dispatchAttemptId,
          })
          .mockResolvedValueOnce(intent),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      codexOAuthSecretNamespace: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      codexOAuthProviderInstance: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      codexOAuthLease: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ id: intent.providerInstanceRowId }])
        .mockResolvedValueOnce([
          { databaseIncarnation: intent.databaseIncarnation },
        ]),
    };
    const prisma = {
      $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) =>
        operation(tx),
      ),
    };
    const repository = new PrismaCodexRotatingOAuthRepository(prisma as never, {
      actionOwnerRepo: "777genius/review-router",
      databaseRecoveryWitness,
      transactionClock: fixedClock(now),
    });

    await repository.retirePreDispatchVersionedWriteback({
      intentId: "intent:predispatch",
      attemptId: intent.dispatchAttemptId,
      executorOwner: intent.executorOwner,
      safeErrorCode: "versioned_provider_pre_dispatch_failed_v1",
    });

    expect(tx.codexOAuthSecretNamespace.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "retired_predispatch" }),
      }),
    );
    expect(tx.codexOAuthWritebackIntent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "failed",
          safeErrorCode: "versioned_provider_pre_dispatch_failed_v1",
        }),
      }),
    );
    expect(tx.codexOAuthWritebackIntent.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "remote_outcome_unknown" }),
      }),
    );
    expect(tx.codexOAuthProviderInstance.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({ state: "active" }),
      }),
    );
    expect(tx.codexOAuthLease.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: "failed", expiresAt: now },
      }),
    );
  });
});

describe("PrismaActionControlPlaneRepository helpers", () => {
  it("does not trust org ruleset workflows for the source repository itself", () => {
    expect(
      orgRulesetTargetsRepository({
        scope: "all_repositories",
        sourceGithubRepositoryId: "1999",
        targetRepositoryIds: ["1001", "1002"],
        githubRepositoryId: "1999",
      }),
    ).toBe(false);
  });

  it("trusts org ruleset workflows for selected target repositories only", () => {
    expect(
      orgRulesetTargetsRepository({
        scope: "selected_repositories",
        sourceGithubRepositoryId: "1999",
        targetRepositoryIds: ["1001", "1002"],
        githubRepositoryId: "1001",
      }),
    ).toBe(true);
    expect(
      orgRulesetTargetsRepository({
        scope: "selected_repositories",
        sourceGithubRepositoryId: "1999",
        targetRepositoryIds: ["1001", "1002"],
        githubRepositoryId: "1003",
      }),
    ).toBe(false);
  });

  it.each(["max", "ultra"] as const)(
    "hydrates stored %s effort without downgrading it",
    async (reasoningEffort) => {
      const prisma = {
        reviewConfiguration: {
          findUnique: vi.fn().mockResolvedValue({
            versions: [
              {
                version: 11,
                schemaVersion: 2,
                providerKind: "codex",
                providerAuthMode: "codex_subscription_oauth",
                model: "gpt-5.5",
                reasoningEffort,
                agenticContext: true,
                fastMode: false,
                failOnSeverity: "critical",
                inlineMaxComments: 5,
                providerLimit: 1,
                providerMaxParallel: 1,
                inlineMinAgreement: 1,
                targetTokensPerBatch: 50000,
                reviewLanguage: "Russian",
                investigationRecordingEnabled: true,
                investigationShadowEnabled: true,
                investigationContextCriticEnabled: true,
                investigationVerifiedCleanEnabled: true,
                investigationCrossRevisionReplayEnabled: true,
                investigationProductionEffectsEnabled: true,
                providers: [
                  {
                    providerKind: "claude",
                    providerAuthMode: "claude_code_oauth",
                    model: "sonnet",
                    reasoningEffort,
                    agenticContext: true,
                    fastMode: false,
                    requiredHealthy: true,
                  },
                ],
              },
            ],
          }),
        },
      } as unknown as PrismaClient;
      const repository = new PrismaActionControlPlaneRepository(prisma);

      const record = await repository.findRuntimeReviewConfiguration({
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
      });

      expect(record?.config.provider).toMatchObject({
        kind: "claude",
        authMode: "claude_code_oauth",
        model: "sonnet",
        reasoningEffort,
      });
      expect(record?.config.reviewLanguage).toBe("Russian");
      expect(record?.config.providers).toHaveLength(1);
      expect(record?.config.providers[0]?.requiredHealthy).toBe(true);
      expect(record?.config.investigationRollout).toEqual({
        recordingEnabled: true,
        shadowEnabled: true,
        contextCriticEnabled: true,
        verifiedCleanEnabled: true,
        crossRevisionReplayEnabled: true,
        productionEffectsEnabled: true,
      });
    },
  );
});

describe("PrismaCodexRotatingOAuthRepository", () => {
  const now = new Date("2026-05-25T12:00:00.000Z");

  it("allows completed leases to refresh comment tokens after auth lease expiry inside the posting window", async () => {
    const { repository } = buildCodexRotatingRepository({
      status: "completed",
      expiresAt: new Date(now.getTime() - 5 * 60 * 1000),
      completedAt: new Date(now.getTime() - (5 * 60 + 55) * 60 * 1000),
    });

    await expect(
      repository.findCompletedLeaseWriteTarget({
        leaseId: "lease_1",
        providerInstanceId: "codex-rotating:123456",
        now,
      }),
    ).resolves.toMatchObject({
      status: "ready",
      writeTarget: {
        repositoryFullName: "777genius/example",
        owner: "777genius",
        repo: "example",
        secretName:
          "REVIEWROUTER_CODEX_AUTH_JSON_R123456_P0123456789abcdef_E1_0123456789abcdef0123456789abcdef",
      },
    });
    await expect(
      repository.authorizeReviewSnapshotAccess({
        leaseId: "lease_1",
        providerInstanceId: "codex-rotating:123456",
        pullRequestNumber: 240,
        now,
      }),
    ).resolves.toMatchObject({
      status: "ready",
      scope: {
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
        sourceRunId: "9001",
        sourceRunAttempt: "2",
      },
    });
  });

  it("closes completed leases after the posting window expires", async () => {
    const { repository } = buildCodexRotatingRepository({
      status: "completed",
      expiresAt: new Date(now.getTime() - 5 * 60 * 1000),
      completedAt: new Date(
        now.getTime() - codexRotatingCommentTokenRefreshTtlMs - 1,
      ),
    });

    await expect(
      repository.findCompletedLeaseWriteTarget({
        leaseId: "lease_1",
        providerInstanceId: "codex-rotating:123456",
        now,
      }),
    ).resolves.toEqual({ status: "lease_not_active" });
  });

  it("keeps snapshot access active for long reviews without extending writeback access", async () => {
    const { repository } = buildCodexRotatingRepository({
      status: "completed",
      expiresAt: new Date(now.getTime() - 5 * 60 * 1000),
      completedAt: new Date(
        now.getTime() - codexRotatingCommentTokenRefreshTtlMs - 1,
      ),
    });

    await expect(
      repository.findCompletedLeaseWriteTarget({
        leaseId: "lease_1",
        providerInstanceId: "codex-rotating:123456",
        now,
      }),
    ).resolves.toEqual({ status: "lease_not_active" });
    await expect(
      repository.authorizeReviewSnapshotAccess({
        leaseId: "lease_1",
        providerInstanceId: "codex-rotating:123456",
        pullRequestNumber: 240,
        now,
      }),
    ).resolves.toMatchObject({ status: "ready" });
    await expect(
      repository.findCompletedLeaseWriteTarget({
        leaseId: "lease_1",
        providerInstanceId: "codex-rotating:123456",
        now,
        completedLeaseTtlMs: codexRotatingReviewSnapshotAccessTtlMs,
      }),
    ).resolves.toMatchObject({
      status: "ready",
      writeTarget: { repositoryFullName: "777genius/example" },
    });

    const expired = buildCodexRotatingRepository({
      status: "completed",
      expiresAt: new Date(now.getTime() - 5 * 60 * 1000),
      completedAt: new Date(
        now.getTime() - codexRotatingReviewSnapshotAccessTtlMs - 1,
      ),
    });
    await expect(
      expired.repository.authorizeReviewSnapshotAccess({
        leaseId: "lease_1",
        providerInstanceId: "codex-rotating:123456",
        pullRequestNumber: 240,
        now,
      }),
    ).resolves.toEqual({ status: "lease_not_active" });
  });

  it("keeps checkpoint access open for eight hours without widening other access", async () => {
    const completedAt = new Date(
      now.getTime() - codexRotatingReviewSnapshotAccessTtlMs - 1,
    );
    const { repository } = buildCodexRotatingRepository({
      status: "completed",
      expiresAt: new Date(now.getTime() - 5 * 60 * 1000),
      completedAt,
    });

    await expect(
      repository.findCompletedLeaseWriteTarget({
        leaseId: "lease_1",
        providerInstanceId: "codex-rotating:123456",
        now,
      }),
    ).resolves.toEqual({ status: "lease_not_active" });
    await expect(
      repository.authorizeReviewSnapshotAccess({
        leaseId: "lease_1",
        providerInstanceId: "codex-rotating:123456",
        pullRequestNumber: 240,
        now,
      }),
    ).resolves.toEqual({ status: "lease_not_active" });
    await expect(
      repository.authorizeReviewExecutionCheckpointAccess({
        leaseId: "lease_1",
        providerInstanceId: "codex-rotating:123456",
        pullRequestNumber: 240,
        now,
      }),
    ).resolves.toMatchObject({
      status: "ready",
      scope: { workspaceId: "workspace_1", repositoryId: "repo_1" },
    });
    await expect(
      repository.authorizeReviewExecutionCheckpointAccess({
        leaseId: "lease_1",
        providerInstanceId: "codex-rotating:123456",
        pullRequestNumber: 241,
        now,
      }),
    ).resolves.toEqual({ status: "lease_not_active" });

    const expired = buildCodexRotatingRepository({
      status: "completed",
      expiresAt: new Date(now.getTime() - 5 * 60 * 1000),
      completedAt: new Date(
        now.getTime() - codexRotatingReviewExecutionCheckpointAccessTtlMs - 1,
      ),
    });
    await expect(
      expired.repository.authorizeReviewExecutionCheckpointAccess({
        leaseId: "lease_1",
        providerInstanceId: "codex-rotating:123456",
        pullRequestNumber: 240,
        now,
      }),
    ).resolves.toEqual({ status: "lease_not_active" });
  });

  it("keeps expired unfinished leases closed for comment token refresh", async () => {
    const { repository } = buildCodexRotatingRepository({
      status: "finalized",
      expiresAt: new Date(now.getTime() - 1),
      completedAt: null,
    });

    await expect(
      repository.findCompletedLeaseWriteTarget({
        leaseId: "lease_1",
        providerInstanceId: "codex-rotating:123456",
        now,
      }),
    ).resolves.toEqual({ status: "lease_not_active" });
    await expect(
      repository.authorizeReviewExecutionCheckpointAccess({
        leaseId: "lease_1",
        providerInstanceId: "codex-rotating:123456",
        pullRequestNumber: 240,
        now,
      }),
    ).resolves.toEqual({ status: "lease_not_active" });
  });

  it("uses the immutable lease repository after the provider is rebound", async () => {
    const { prisma, repository } = buildCodexRotatingRepository({
      status: "completed",
      expiresAt: new Date(now.getTime() - 5 * 60 * 1000),
      completedAt: new Date(now.getTime() - 20 * 60 * 1000),
    });

    await expect(
      repository.authorizeReviewSnapshotAccess({
        leaseId: "lease_1",
        providerInstanceId: "codex-rotating:123456",
        pullRequestNumber: 240,
        now,
      }),
    ).resolves.toMatchObject({
      status: "ready",
      scope: { workspaceId: "workspace_1", repositoryId: "repo_1" },
    });
    await expect(
      repository.authorizeReviewExecutionCheckpointAccess({
        leaseId: "lease_1",
        providerInstanceId: "codex-rotating:123456",
        pullRequestNumber: 240,
        now,
      }),
    ).resolves.toMatchObject({
      status: "ready",
      scope: { workspaceId: "workspace_1", repositoryId: "repo_1" },
    });
    expect(prisma.codexOAuthProviderInstance).toBeUndefined();
  });

  it("fails closed for provider rebinding and cross-workspace lease scope", async () => {
    const rebound = buildCodexRotatingRepository({
      status: "completed",
      expiresAt: new Date(now.getTime() - 5 * 60 * 1000),
      completedAt: new Date(now.getTime() - 20 * 60 * 1000),
    });
    await expect(
      rebound.repository.authorizeReviewExecutionCheckpointAccess({
        leaseId: "lease_1",
        providerInstanceId: "codex-rotating:rebound",
        pullRequestNumber: 240,
        now,
      }),
    ).resolves.toEqual({ status: "lease_not_active" });

    const mismatchedWorkspace = buildCodexRotatingRepository({
      status: "completed",
      expiresAt: new Date(now.getTime() - 5 * 60 * 1000),
      completedAt: new Date(now.getTime() - 20 * 60 * 1000),
      leaseWorkspaceId: "workspace_other",
    });
    await expect(
      mismatchedWorkspace.repository.authorizeReviewExecutionCheckpointAccess({
        leaseId: "lease_1",
        providerInstanceId: "codex-rotating:123456",
        pullRequestNumber: 240,
        now,
      }),
    ).resolves.toEqual({ status: "lease_not_active" });
  });

  it("rejects an old completed lease after a later activation advances the provider namespace", async () => {
    const { repository } = buildCodexRotatingRepository({
      status: "completed",
      expiresAt: new Date(now.getTime() - 5 * 60 * 1000),
      completedAt: new Date(now.getTime() - 20 * 60 * 1000),
      leaseSecretNamespaceEpoch: 2n,
    });

    await expect(
      repository.findCompletedLeaseWriteTarget({
        leaseId: "lease_1",
        providerInstanceId: "codex-rotating:123456",
        now,
      }),
    ).resolves.toEqual({ status: "lease_not_active" });
  });

  it.each([
    ["V4 promoted candidate", "confirmed_candidate", null, true, 4],
    ["V5 promoted candidate", "confirmed_candidate", null, true, 5],
    ["reused active namespace", "active", "active", false, 5],
  ] as const)(
    "completes a changed-generation lease with a %s inside the activation transaction",
    async (
      _,
      namespaceStatus,
      activeNamespaceMarker,
      mutatesNamespace,
      workflowSchemaVersion,
    ) => {
      const allocatedNamespace = allocateVersionedProviderSecretNamespace({
        scope: {
          repositoryId: "123456",
          providerInstanceId: "codex-rotating:123456",
        },
        epoch: 2n,
        randomBytes: () => new Uint8Array(16).fill(17),
      });
      const namespace = {
        id: allocatedNamespace.namespaceId,
        githubRepositoryId: "123456",
        namespaceEpoch: allocatedNamespace.epoch,
        secretName: allocatedNamespace.name,
        status: namespaceStatus,
      };
      const leaseUpdate = vi.fn(async () => ({ count: 1 }));
      const tx = {
        $executeRaw: vi.fn(async (query: unknown) => {
          void query;
          return 1;
        }),
        $queryRaw: vi.fn(async (query: { strings?: readonly string[] }) =>
          (Array.isArray(query)
            ? Array.from(query).join("")
            : query.strings?.join("")
          )?.includes("codex_oauth_database_authority_challenge")
            ? [{ challenge: '["reviewrouter_api",1,2,"effect","owner",0]' }]
            : query.strings?.join("").includes("pg_control_system")
              ? [{ databaseIncarnation: "7777777777777777777" }]
              : [],
        ),
        codexOAuthWritebackIntent: {
          findUniqueOrThrow: vi
            .fn()
            .mockResolvedValueOnce({ providerInstanceRowId: "provider-row-1" })
            .mockResolvedValueOnce({
              id: "intent-1",
              leaseId: "lease-1",
              generation: 2,
              latestGenerationHash: "generation-hash-2",
              accountIdentityHash: "account-identity-hash",
              accountIdentityAlgorithm: "provider_issuer_subject_account_v1",
              mutationEpoch: 4n,
              dispatchAttemptId: "attempt-1",
              providerResponseCode: 204,
              providerConfirmedAt: new Date(now.getTime() - 1_000),
              databaseIncarnation: "7777777777777777777",
              databaseRecoveryWitness: fingerprintDatabaseRecoveryWitness(
                databaseRecoveryWitness,
              ),
              executorOwner: "executor-1",
              executorLeaseExpiresAt: new Date(now.getTime() + 60_000),
              secretNamespace: namespace,
              providerInstance: {
                id: "provider-row-1",
                providerInstanceId: "codex-rotating:123456",
                activeSecretNamespaceId: activeNamespaceMarker
                  ? namespace.id
                  : null,
                activeLeaseId: "lease-1",
                activeLeaseExpiresAt: new Date(now.getTime() + 60_000),
                mutationEpoch: 4n,
                mutationOwner: "runtime",
                mutationOwnerId: "lease-1",
              },
              lease: {
                status: "finalized",
                expiresAt: new Date(now.getTime() + 60_000),
              },
            }),
          update: vi.fn(async () => ({})),
        },
        codexOAuthSecretNamespace: {
          updateMany: vi.fn(async () => ({ count: 1 })),
          update: vi.fn(async () => ({})),
        },
        codexOAuthProviderInstance: {
          update: vi.fn(async () => ({})),
          updateMany: vi.fn(async () => ({ count: 1 })),
        },
        codexOAuthLease: { updateMany: leaseUpdate },
      };
      const prisma = {
        $queryRaw: vi.fn(async () => [{ signature: "a".repeat(64) }]),
        $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
          callback(tx),
        ),
      } as unknown as PrismaClient;
      const repository = new PrismaCodexRotatingOAuthRepository(prisma, {
        actionOwnerRepo: "777genius/review-router",
        databaseRecoveryWitness,
        transactionClock: fixedClock(now),
        databaseEffectAuthority: prisma,
      });
      const attestation = createVersionedSecretWorkflowSourceAttestation({
        repositoryId: "123456",
        workflowPath: ".github/workflows/reviewrouter-codex.yml",
        workflowSourceCommitSha: "a".repeat(40),
        workflowSourceBlobSha: "b".repeat(40),
        workflowSourceSha256: "c".repeat(64),
        workflowSemanticSha256: "d".repeat(64),
        workflowSchemaVersion,
        sourceTrust: WorkflowSourceTrust.TrustedDefaultBranchRevision,
        secretNamespace: allocatedNamespace,
      });

      await expect(
        repository.activateVersionedWriteback({
          intentId: "intent-1",
          attemptId: "attempt-1",
          executorOwner: "executor-1",
          attestation,
        }),
      ).resolves.toEqual({ generation: 2 });
      expect(leaseUpdate).toHaveBeenCalledWith({
        where: { id: "lease-1", status: "finalized", mutationEpoch: 4n },
        data: {
          status: "completed",
          completedAt: now,
          secretNamespaceId: namespace.id,
          secretNamespaceEpoch: namespace.namespaceEpoch,
        },
      });
      expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
      expect(
        Array.from(tx.$executeRaw.mock.calls[0]?.[0] as readonly string[]).join(
          "?",
        ),
      ).toContain("codex_oauth_authorize_runtime_completion");
      expect(tx.codexOAuthSecretNamespace.update).toHaveBeenCalledTimes(
        mutatesNamespace ? 1 : 0,
      );
      expect(tx.codexOAuthSecretNamespace.updateMany).toHaveBeenCalledTimes(
        mutatesNamespace ? 1 : 0,
      );
      if (mutatesNamespace) {
        expect(tx.codexOAuthSecretNamespace.update).toHaveBeenCalledWith({
          where: { id: namespace.id },
          data: expect.objectContaining({ workflowSchemaVersion }),
        });
      }
    },
  );
});

function buildCodexRotatingRepository(lease: {
  readonly status: string;
  readonly expiresAt: Date;
  readonly completedAt: Date | null;
  readonly leaseWorkspaceId?: string;
  readonly leaseSecretNamespaceEpoch?: bigint;
}) {
  const namespaceId = "namespace_1";
  const namespaceEpoch = 1n;
  const namespaceName =
    "REVIEWROUTER_CODEX_AUTH_JSON_R123456_P0123456789abcdef_E1_0123456789abcdef0123456789abcdef";
  const leaseRecord = {
    workspaceId: lease.leaseWorkspaceId ?? "workspace_1",
    repository: {
      id: "repo_1",
      workspaceId: "workspace_1",
      provider: "github",
      githubRepositoryId: 123456n,
      fullName: "777genius/example",
      owner: "777genius",
      name: "example",
      selected: true,
      installation: {
        githubInstallationId: 789n,
        status: "active",
      },
    },
    ...lease,
    githubRunId: "9001",
    githubRunAttempt: "2",
    pullRequestNumber: 240,
    secretNamespaceId: namespaceId,
    secretNamespaceEpoch: lease.leaseSecretNamespaceEpoch ?? namespaceEpoch,
    providerInstance: {
      activeSecretNamespaceId: namespaceId,
      activeSecretNamespaceEpoch: namespaceEpoch,
      activeSecretNamespaceName: namespaceName,
      activeSecretNamespace: {
        secretName: namespaceName,
        status: "active",
        databaseRecoveryWitness: fingerprintDatabaseRecoveryWitness(
          databaseRecoveryWitness,
        ),
      },
    },
  };
  const prisma = {
    codexOAuthLease: {
      findFirst: vi.fn(
        async (input: {
          readonly where: {
            readonly id: string;
            readonly providerInstanceId: string;
          };
        }) =>
          input.where.id === "lease_1" &&
          input.where.providerInstanceId === "codex-rotating:123456"
            ? leaseRecord
            : null,
      ),
    },
  } as unknown as PrismaClient;

  return {
    prisma,
    repository: new PrismaCodexRotatingOAuthRepository(prisma, {
      actionOwnerRepo: "777genius/review-router",
      databaseRecoveryWitness,
    }),
  };
}

describe("durable runtime database clock", () => {
  it("prepares a runtime refresh against the active namespace without allocating a new one", async () => {
    const now = new Date("2026-08-10T00:00:00.000Z");
    const activeNamespace = allocateVersionedProviderSecretNamespace({
      scope: {
        repositoryId: "123456",
        providerInstanceId: "codex-rotating:123456",
      },
      epoch: 3n,
      randomBytes: () => new Uint8Array(16).fill(0x33),
    });
    const request = {
      protocolVersion: 1 as const,
      leaseId: "lease:active-refresh",
      providerInstanceId: "codex-rotating:123456",
      generation: 4,
      latestGenerationHash: "generation-hash-active-refresh",
      accountIdentityHash: "account-identity-active-refresh",
      accountIdentityAlgorithm: "provider_issuer_subject_account_v1" as const,
      encryptedValue: "Y2lwaGVydGV4dA==",
      keyId: "key-active-refresh",
      idempotencyKey: "writeback:active-refresh",
    };
    const namespaceCreate = vi.fn();
    const intentCreate = vi.fn().mockResolvedValue({
      id: "intent:active-refresh",
    });
    const tx = {
      $executeRawUnsafe: vi.fn().mockResolvedValue(0),
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ id: "provider:active-refresh" }])
        .mockResolvedValueOnce([
          { databaseIncarnation: "7612345678901234567" },
        ]),
      codexOAuthWritebackIntent: {
        findFirst: vi.fn().mockResolvedValue(null),
        findUnique: vi.fn().mockResolvedValue(null),
        create: intentCreate,
      },
      codexOAuthProviderInstance: {
        findUnique: vi.fn().mockResolvedValue({
          id: "provider:active-refresh",
          providerInstanceId: request.providerInstanceId,
          activeLeaseId: request.leaseId,
          activeLeaseExpiresAt: new Date(now.getTime() + 5 * 60_000),
          mutationEpoch: 7n,
          mutationOwner: "runtime",
          mutationOwnerId: request.leaseId,
          latestGeneration: 3,
          latestGenerationHash: "generation-hash-before-refresh",
          activeAccountIdentityHash: request.accountIdentityHash,
          activeSecretNamespaceId: activeNamespace.namespaceId,
          activeSecretNamespaceEpoch: activeNamespace.epoch,
          activeSecretNamespaceName: activeNamespace.name,
          activeSecretNamespace: {
            id: activeNamespace.namespaceId,
            githubRepositoryId: "123456",
            namespaceEpoch: activeNamespace.epoch,
            secretName: activeNamespace.name,
            status: "active",
            databaseRecoveryWitness: fingerprintDatabaseRecoveryWitness(
              databaseRecoveryWitness,
            ),
          },
          repository: {
            id: "repository:active-refresh",
            workspaceId: "workspace:active-refresh",
            provider: "github",
            githubRepositoryId: 123456n,
            fullName: "777genius/example",
            owner: "777genius",
            name: "example",
            selected: true,
            installation: {
              githubInstallationId: 789n,
              status: "active",
            },
          },
          leases: [
            {
              id: request.leaseId,
              status: "finalized",
              expiresAt: new Date(now.getTime() + 5 * 60_000),
              nextGeneration: request.generation,
              restoredGenerationHash: "generation-hash-before-refresh",
              writebackPreflightKeyId: request.keyId,
              mutationEpoch: 7n,
              secretNamespaceId: activeNamespace.namespaceId,
              secretNamespaceEpoch: activeNamespace.epoch,
            },
          ],
        }),
      },
      codexOAuthSecretNamespace: { create: namespaceCreate },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
        callback(tx),
      ),
    };
    const repository = new PrismaCodexRotatingOAuthRepository(prisma as never, {
      actionOwnerRepo: "777genius/review-router",
      databaseRecoveryWitness,
      transactionClock: fixedClock(now),
    });

    await expect(
      repository.prepareVersionedWriteback({
        request,
        encryptedPayloadDigest: "digest-active-refresh",
      }),
    ).resolves.toMatchObject({
      status: "ready",
      intentId: "intent:active-refresh",
      namespace: activeNamespace,
      writeTarget: { secretName: activeNamespace.name },
      retirementIdentity: { namespaceId: activeNamespace.namespaceId },
    });
    expect(namespaceCreate).not.toHaveBeenCalled();
    expect(intentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        secretNamespaceId: activeNamespace.namespaceId,
        safeErrorCode: "runtime_versioned_dispatch_authorized_v1",
      }),
    });
  });

  it("writes nothing when the authoritative clock query fails", async () => {
    const namespaceCreate = vi.fn();
    const intentCreate = vi.fn();
    const tx = {
      $executeRawUnsafe: vi.fn().mockResolvedValue(0),
      $queryRaw: vi.fn().mockResolvedValue([{ id: "provider-row-1" }]),
      codexOAuthSecretNamespace: { create: namespaceCreate },
      codexOAuthWritebackIntent: { create: intentCreate },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
        callback(tx),
      ),
    };
    const repository = new PrismaCodexRotatingOAuthRepository(prisma as never, {
      actionOwnerRepo: "777genius/review-router",
      databaseRecoveryWitness,
      transactionClock: {
        now: async () => {
          throw new Error("database_clock_unavailable");
        },
      },
    });

    await expect(
      repository.prepareVersionedWriteback({
        request: {
          protocolVersion: 1,
          leaseId: "lease:clock-failure",
          providerInstanceId: "codex-rotating:123456",
          generation: 2,
          latestGenerationHash: "generation-hash-clock-failure",
          accountIdentityHash: "account-identity-clock-failure",
          accountIdentityAlgorithm: "provider_issuer_subject_account_v1",
          encryptedValue: "Y2lwaGVydGV4dA==",
          keyId: "key-clock-failure",
          idempotencyKey: "writeback:clock-failure",
        },
        encryptedPayloadDigest: "digest-clock-failure",
      }),
    ).rejects.toThrow("database_clock_unavailable");
    expect(namespaceCreate).not.toHaveBeenCalled();
    expect(intentCreate).not.toHaveBeenCalled();
  });
});

function fixedClock(instant: Date | string) {
  return { now: async () => new Date(instant) };
}
