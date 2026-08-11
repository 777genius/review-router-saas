import {
  assertCanonicalCodexRotatingProviderId,
  type CodexRotatingProviderState,
  codexRotatingCanonicalT0WorkflowSchemaVersions,
  codexRotatingSecretName,
  InMemoryCodexRotatingLeaseStore,
  type CodexRotatingEncryptedWritebackRequest,
  type CodexRotatingProviderBinding,
  allocateVersionedProviderSecretNamespace,
  assertSameVersionedProviderSecretNamespace,
  assertProviderSecretTransitionAuthorized,
  assertRuntimeVersionedAmbiguousRetirementAuthorized,
  assertSameRuntimeVersionedWritebackIdentity,
  assertExternalRecoveryWitnessAdmission,
  classifyExternalRecoveryWitnessRelation,
  fingerprintDatabaseRecoveryWitness,
  WorkflowSourceTrust,
  RuntimeVersionedDurableMarker,
  reserveRuntimeVersionedEffectConfirmationWindow,
  type VersionedProviderSecretNamespace,
} from "@reviewrouter/features-codex-oauth-rotating";
import type { ActionRepositoryContext } from "../../domain/action-control-plane.js";
import {
  codexRotatingReviewExecutionCheckpointAccessTtlMs,
  codexRotatingReviewSnapshotAccessTtlMs,
  isCodexRotatingCompletedLeasePostingWindowActive,
} from "../../domain/codex-rotating-oauth-posting-window.js";
import type {
  CodexRotatingOAuthRepositoryPort,
  CodexRotatingPreleaseRecord,
  CodexRotatingVersionedWritebackLedgerPort,
} from "../../application/ports/codex-rotating-oauth-repository-port.js";
import type { CodexRotatingReviewSnapshotAccessPort } from "../../application/ports/codex-rotating-review-snapshot-access-port.js";
import type { CodexRotatingReviewExecutionCheckpointAccessPort } from "../../application/ports/codex-rotating-review-execution-checkpoint-access-port.js";

type ProviderRecord = {
  readonly binding: CodexRotatingProviderBinding;
  readonly generationHashSalt: string;
  readonly accountFingerprintSalt: string;
  readonly latestGeneration: number;
  readonly latestGenerationHash: string | null;
  readonly state: CodexRotatingProviderState;
  readonly repository?: ActionRepositoryContext;
  readonly activeLeaseId?: string;
  readonly preflightKeyId?: string;
  readonly mutationEpoch: bigint;
  readonly mutationOwner?: "runtime" | "setup" | "recovery";
  readonly mutationOwnerId?: string;
  readonly activeNamespace: VersionedProviderSecretNamespace;
  readonly activeDatabaseRecoveryWitness?: string;
  readonly activeAccountIdentityHash?: string;
};

type WritebackRecord = {
  readonly intentId: string;
  readonly request: CodexRotatingEncryptedWritebackRequest;
  readonly encryptedPayloadDigest: string;
  readonly status:
    | "pending"
    | "completed"
    | "failed"
    | "remote_outcome_unknown";
  readonly safeErrorCode?: string;
  readonly completedAt?: Date;
  readonly attemptId?: string;
  readonly executorOwner?: string;
  readonly executorLeaseExpiresAt?: Date;
  readonly namespace?: VersionedProviderSecretNamespace;
  readonly providerConfirmed?: boolean;
  readonly authorizationEpoch?: bigint;
  readonly authorizationExpiresAt?: Date;
  readonly databaseIncarnation: string;
  readonly databaseRecoveryWitness?: string;
};

type CompletedLeaseContext =
  | {
      readonly status: "ready";
      readonly repository: ActionRepositoryContext;
      readonly source: {
        readonly runId: string;
        readonly runAttempt: string;
        readonly pullRequestNumber?: number | undefined;
      };
      readonly namespace: VersionedProviderSecretNamespace;
    }
  | {
      readonly status: "lease_not_completed" | "lease_not_active";
    };

export class InMemoryCodexRotatingOAuthRepository
  implements
    CodexRotatingOAuthRepositoryPort,
    CodexRotatingVersionedWritebackLedgerPort,
    CodexRotatingReviewSnapshotAccessPort,
    CodexRotatingReviewExecutionCheckpointAccessPort
{
  private readonly leases = new InMemoryCodexRotatingLeaseStore();
  private readonly providers = new Map<string, ProviderRecord>();
  private readonly writebacks = new Map<string, WritebackRecord>();
  private readonly permanentlyRetiredNamespaceIds = new Set<string>();
  private readonly leaseExpiresAtById = new Map<string, Date>();
  private readonly leaseEpochById = new Map<string, bigint>();
  private readonly leaseNamespaceById = new Map<
    string,
    VersionedProviderSecretNamespace
  >();
  private readonly restoredGenerationHashByLeaseId = new Map<string, string>();
  private readonly leaseSourceById = new Map<
    string,
    {
      readonly providerInstanceId: string;
      readonly repository: ActionRepositoryContext;
      readonly runId: string;
      readonly runAttempt: string;
      readonly pullRequestNumber?: number | undefined;
    }
  >();

  constructor(
    bindings: readonly CodexRotatingProviderBinding[] = [],
    private readonly options: Readonly<{
      initialDatabaseRecoveryWitness?: string;
      currentDatabaseRecoveryWitness?: () => string | undefined;
      currentDatabaseIncarnation?: () => string | undefined;
    }> = {},
  ) {
    const initialDatabaseRecoveryWitness =
      options.initialDatabaseRecoveryWitness ??
      options.currentDatabaseRecoveryWitness?.();
    const activeDatabaseRecoveryWitness = initialDatabaseRecoveryWitness
      ? fingerprintDatabaseRecoveryWitness(initialDatabaseRecoveryWitness)
      : undefined;
    for (const binding of bindings) {
      this.providers.set(binding.providerInstanceId, {
        binding,
        generationHashSalt: testGenerationHashSalt,
        accountFingerprintSalt: testAccountFingerprintSalt,
        latestGeneration: 1,
        latestGenerationHash: null,
        state: "setup_pending",
        mutationEpoch: 0n,
        activeNamespace: initialNamespace(binding),
        ...(activeDatabaseRecoveryWitness
          ? { activeDatabaseRecoveryWitness }
          : {}),
      });
    }
  }

  async findProviderBinding(input: {
    readonly repository: ActionRepositoryContext;
    readonly providerInstanceId: string;
    readonly workflowSha: string;
    readonly workflowSchemaVersion: number;
  }): Promise<CodexRotatingProviderBinding | null> {
    if (
      !codexRotatingCanonicalT0WorkflowSchemaVersions.includes(
        input.workflowSchemaVersion as (typeof codexRotatingCanonicalT0WorkflowSchemaVersions)[number],
      )
    ) {
      return null;
    }
    const existing = this.providers.get(input.providerInstanceId);
    if (existing) {
      return {
        ...existing.binding,
        workflowSchemaVersion: input.workflowSchemaVersion,
      };
    }

    const binding: CodexRotatingProviderBinding = {
      providerInstanceId: input.providerInstanceId,
      repositoryFullName: input.repository.fullName,
      githubRepositoryId: input.repository.githubRepositoryId,
      actionRef: `${input.repository.owner}/review-router@${input.workflowSha}`,
      workflowPath: ".github/workflows/reviewrouter-codex.yml",
      workflowSchemaVersion: input.workflowSchemaVersion,
    };
    return binding;
  }

  async ensureVerifiedProviderBinding(input: {
    readonly repository: ActionRepositoryContext;
    readonly binding: CodexRotatingProviderBinding;
  }): Promise<void> {
    if (
      input.binding.githubRepositoryId !==
        input.repository.githubRepositoryId ||
      input.binding.repositoryFullName.toLowerCase() !==
        input.repository.fullName.toLowerCase()
    ) {
      throw new Error("codex_rotating_provider_identity_mismatch");
    }
    assertCanonicalCodexRotatingProviderId({
      providerInstanceId: input.binding.providerInstanceId,
      githubRepositoryId: input.repository.githubRepositoryId,
    });
    const existing = this.providers.get(input.binding.providerInstanceId);
    if (existing) {
      this.assertAutomaticRuntimeDatabaseRecoveryWitness(existing);
      if (
        existing.binding.githubRepositoryId !==
          input.repository.githubRepositoryId ||
        (existing.repository &&
          (existing.repository.repositoryId !== input.repository.repositoryId ||
            existing.repository.workspaceId !== input.repository.workspaceId))
      ) {
        throw new Error("codex_rotating_provider_identity_mismatch");
      }
      this.providers.set(input.binding.providerInstanceId, {
        ...existing,
        binding: input.binding,
        repository: input.repository,
      });
      return;
    }
    this.providers.set(input.binding.providerInstanceId, {
      binding: input.binding,
      generationHashSalt: testGenerationHashSalt,
      accountFingerprintSalt: testAccountFingerprintSalt,
      latestGeneration: 1,
      latestGenerationHash: null,
      state: "setup_pending",
      repository: input.repository,
      mutationEpoch: 0n,
      activeNamespace: initialNamespace(input.binding),
      ...this.initialDatabaseRecoveryWitnessFingerprint(),
    });
  }

  async acquirePrelease(input: {
    readonly repository: ActionRepositoryContext;
    readonly providerInstanceId: string;
    readonly githubRunId: string;
    readonly githubRunAttempt: string;
    readonly pullRequestNumber?: number | undefined;
    readonly now: Date;
    readonly newWorkAdmissionBarrier: Readonly<{
      assertAdmitted(): void;
    }>;
  }): Promise<CodexRotatingPreleaseRecord> {
    input.newWorkAdmissionBarrier.assertAdmitted();
    const provider = this.providers.get(input.providerInstanceId);
    this.assertAutomaticRuntimeDatabaseRecoveryWitness(provider);
    if (
      provider?.state === "unknown_auth_state" ||
      provider?.state === "needs_reconnect" ||
      provider?.state === "permission_required"
    ) {
      throw new Error(`codex_rotating_provider_${provider.state}`);
    }
    if (
      provider?.mutationOwner === "recovery" ||
      [...this.writebacks.values()].some(
        (record) =>
          record.request.providerInstanceId === input.providerInstanceId &&
          ["pending", "remote_outcome_unknown"].includes(record.status),
      )
    ) {
      throw new Error("codex_rotating_mutation_fence_conflict");
    }
    const lease = this.leases.acquire({
      providerInstanceId: input.providerInstanceId,
      runId: input.githubRunId,
      runAttempt: input.githubRunAttempt,
      now: input.now,
      ttlSeconds: 15 * 60,
    });
    if (lease.status !== "conflict") {
      this.leaseExpiresAtById.set(lease.leaseId, lease.expiresAt);
      this.leaseSourceById.set(lease.leaseId, {
        providerInstanceId: input.providerInstanceId,
        repository: input.repository,
        runId: input.githubRunId,
        runAttempt: input.githubRunAttempt,
        ...(input.pullRequestNumber
          ? { pullRequestNumber: input.pullRequestNumber }
          : {}),
      });
    }
    if (provider && lease.status !== "conflict") {
      const mutationEpoch =
        this.leaseEpochById.get(lease.leaseId) ?? provider.mutationEpoch + 1n;
      this.leaseEpochById.set(lease.leaseId, mutationEpoch);
      this.leaseNamespaceById.set(lease.leaseId, provider.activeNamespace);
      this.providers.set(input.providerInstanceId, {
        ...provider,
        repository: input.repository,
        activeLeaseId: lease.leaseId,
        mutationEpoch,
        mutationOwner: "runtime",
        mutationOwnerId: lease.leaseId,
      });
    }
    const latest = this.providers.get(input.providerInstanceId) ?? provider;
    return {
      ...lease,
      repository: input.repository,
      generationHashSalt: latest?.generationHashSalt ?? testGenerationHashSalt,
      accountFingerprintSalt:
        latest?.accountFingerprintSalt ?? testAccountFingerprintSalt,
      currentGeneration: latest?.latestGeneration ?? 1,
      mutationEpoch: latest?.mutationEpoch ?? 1n,
      ...(latest?.activeNamespace
        ? {
            secretNamespaceId: latest.activeNamespace.namespaceId,
            secretNamespaceEpoch: latest.activeNamespace.epoch,
          }
        : {}),
      ...(latest?.latestGenerationHash
        ? { currentGenerationHash: latest.latestGenerationHash }
        : {}),
    };
  }

  async finalizeLease(input: {
    readonly leaseId: string;
    readonly providerInstanceId: string;
    readonly restoredGenerationHash: string;
    readonly now: Date;
  }): Promise<{
    readonly leaseId: string;
    readonly nextGeneration: number;
    readonly repository?: ActionRepositoryContext;
    readonly status: "finalized" | "stale_queued_secret";
  }> {
    const provider = this.providers.get(input.providerInstanceId);
    this.assertAutomaticRuntimeDatabaseRecoveryWitness(provider);
    if (
      !provider ||
      provider.mutationOwner !== "runtime" ||
      provider.mutationOwnerId !== input.leaseId ||
      this.leaseEpochById.get(input.leaseId) !== provider.mutationEpoch
    ) {
      throw new Error("codex_rotating_lease_not_active");
    }
    if (provider?.latestGenerationHash) {
      if (provider.latestGenerationHash !== input.restoredGenerationHash) {
        this.providers.set(input.providerInstanceId, {
          ...provider,
          state: "stale_queued_secret",
          mutationEpoch: provider.mutationEpoch + 1n,
          mutationOwner: "recovery",
          mutationOwnerId: input.leaseId,
        });
        const response = {
          leaseId: input.leaseId,
          nextGeneration: provider.latestGeneration + 1,
          status: "stale_queued_secret" as const,
        };
        return provider.repository
          ? { ...response, repository: provider.repository }
          : response;
      }
    }
    const nextGeneration = (provider?.latestGeneration ?? 1) + 1;
    this.leases.finalize({
      leaseId: input.leaseId,
      restoredGenerationHash: input.restoredGenerationHash,
      nextGeneration,
      now: input.now,
    });
    this.restoredGenerationHashByLeaseId.set(
      input.leaseId,
      input.restoredGenerationHash,
    );
    const response = {
      leaseId: input.leaseId,
      nextGeneration,
      status: "finalized" as const,
    };
    return provider?.repository
      ? { ...response, repository: provider.repository }
      : response;
  }

  async abandonLease(input: {
    readonly leaseId: string;
    readonly providerInstanceId: string;
    readonly reason: "needs_reconnect" | "unknown_auth_state";
    readonly now: Date;
  }): Promise<{
    readonly status: "abandoned" | "lease_not_active";
  }> {
    const provider = this.providers.get(input.providerInstanceId);
    this.assertAutomaticRuntimeDatabaseRecoveryWitness(provider);
    if (!provider || provider.activeLeaseId !== input.leaseId) {
      return { status: "lease_not_active" };
    }
    const expiresAt = this.leaseExpiresAtById.get(input.leaseId);
    if (expiresAt && expiresAt <= input.now) {
      return { status: "lease_not_active" };
    }
    this.providers.set(input.providerInstanceId, {
      ...provider,
      state: input.reason,
      mutationEpoch: provider.mutationEpoch + 1n,
      mutationOwner: "recovery",
      mutationOwnerId: input.leaseId,
      ...(provider.repository ? { repository: provider.repository } : {}),
    });
    this.leaseExpiresAtById.set(input.leaseId, input.now);
    return { status: "abandoned" };
  }

  async preflightWriteback(input: {
    readonly leaseId: string;
    readonly providerInstanceId: string;
    readonly githubKeyId: string;
    readonly now: Date;
  }): Promise<
    | {
        readonly status: "ready";
        readonly writeTarget: {
          readonly githubInstallationId: string;
          readonly githubRepositoryId: string;
          readonly repositoryFullName: string;
          readonly owner: string;
          readonly repo: string;
          readonly secretName: string;
        };
      }
    | {
        readonly status:
          | "lease_not_active"
          | "stale_queued_secret"
          | "permission_required";
      }
  > {
    const provider = this.providers.get(input.providerInstanceId);
    this.assertAutomaticRuntimeDatabaseRecoveryWitness(provider);
    if (
      !provider?.repository ||
      provider.activeLeaseId !== input.leaseId ||
      provider.mutationOwner !== "runtime" ||
      provider.mutationOwnerId !== input.leaseId ||
      this.leaseEpochById.get(input.leaseId) !== provider.mutationEpoch
    ) {
      return { status: "lease_not_active" };
    }
    this.providers.set(input.providerInstanceId, {
      ...provider,
      preflightKeyId: input.githubKeyId,
    });
    return {
      status: "ready",
      writeTarget: toWriteTarget(
        provider.repository,
        provider.activeNamespace.name,
      ),
    };
  }

  async prepareVersionedWriteback(input: {
    readonly request: CodexRotatingEncryptedWritebackRequest;
    readonly encryptedPayloadDigest: string;
    readonly now: Date;
  }) {
    const key = `${input.request.providerInstanceId}:${input.request.idempotencyKey}`;
    const existingForLease = [...this.writebacks.entries()].find(
      ([, record]) => record.request.leaseId === input.request.leaseId,
    );
    if (existingForLease && existingForLease[0] !== key) {
      return { status: "writeback_idempotency_conflict" as const };
    }
    const existing = existingForLease?.[1] ?? this.writebacks.get(key);
    if (existing) {
      this.assertWritebackDatabaseGeneration(
        this.providers.get(input.request.providerInstanceId),
        existing,
      );
      if (
        existing.request.accountIdentityHash !==
          input.request.accountIdentityHash ||
        existing.request.accountIdentityAlgorithm !==
          input.request.accountIdentityAlgorithm ||
        existing.request.leaseId !== input.request.leaseId ||
        existing.request.generation !== input.request.generation ||
        existing.request.latestGenerationHash !==
          input.request.latestGenerationHash ||
        existing.request.keyId !== input.request.keyId
      ) {
        return { status: "writeback_idempotency_conflict" as const };
      }
      if (existing.status === "completed") {
        if (existing.encryptedPayloadDigest !== input.encryptedPayloadDigest) {
          return { status: "writeback_idempotency_conflict" as const };
        }
        return {
          status: "idempotent_replay" as const,
          generation: existing.request.generation,
        };
      }
      if (existing.encryptedPayloadDigest !== input.encryptedPayloadDigest) {
        return { status: "writeback_idempotency_conflict" as const };
      }
      if (
        existing.status === "pending" &&
        existing.attemptId &&
        existing.namespace &&
        existing.authorizationEpoch !== undefined
      ) {
        if (
          existing.executorOwner &&
          existing.executorLeaseExpiresAt &&
          existing.executorLeaseExpiresAt > input.now
        ) {
          return {
            status: "in_progress" as const,
            retryAfter: existing.executorLeaseExpiresAt,
          };
        }
        this.permanentlyRetiredNamespaceIds.add(existing.namespace.namespaceId);
        this.writebacks.set(key, {
          ...existing,
          status: "remote_outcome_unknown",
          safeErrorCode:
            RuntimeVersionedDurableMarker.InterruptedAttemptRecoveredV1,
        });
        const provider = this.providers.get(input.request.providerInstanceId);
        if (
          provider?.mutationOwner === "runtime" &&
          provider.mutationOwnerId === existing.request.leaseId
        ) {
          this.providers.set(input.request.providerInstanceId, {
            ...withoutMutationOwnership(provider),
            state: "unknown_auth_state",
            mutationEpoch: provider.mutationEpoch + 1n,
            mutationOwner: "recovery",
            mutationOwnerId: existing.intentId,
          });
          this.leaseExpiresAtById.set(existing.request.leaseId, input.now);
        }
        return { status: "writeback_recovery_required" as const };
      }
      return { status: "writeback_recovery_required" as const };
    }
    const provider = this.providers.get(input.request.providerInstanceId);
    this.assertAutomaticRuntimeDatabaseRecoveryWitness(provider);
    if (
      !provider?.repository ||
      provider.activeLeaseId !== input.request.leaseId ||
      provider.mutationOwner !== "runtime" ||
      provider.mutationOwnerId !== input.request.leaseId ||
      this.leaseEpochById.get(input.request.leaseId) !==
        provider.mutationEpoch ||
      provider.preflightKeyId !== input.request.keyId ||
      !this.leaseExpiresAtById.get(input.request.leaseId) ||
      this.leaseExpiresAtById.get(input.request.leaseId)! <= input.now ||
      (provider.activeAccountIdentityHash !== undefined &&
        provider.activeAccountIdentityHash !==
          input.request.accountIdentityHash)
    ) {
      return { status: "writeback_recovery_required" as const };
    }
    const restoredHash = this.restoredGenerationHashByLeaseId.get(
      input.request.leaseId,
    );
    if (
      provider.latestGenerationHash !== null &&
      restoredHash === provider.latestGenerationHash &&
      input.request.latestGenerationHash === provider.latestGenerationHash
    ) {
      const pendingNoOp: WritebackRecord = {
        intentId: `intent:${key}`,
        request: input.request,
        encryptedPayloadDigest: input.encryptedPayloadDigest,
        status: "pending",
        authorizationEpoch: provider.mutationEpoch,
        authorizationExpiresAt: this.leaseExpiresAtById.get(
          input.request.leaseId,
        )!,
        databaseIncarnation: this.currentDatabaseIncarnation(),
        ...(provider.activeDatabaseRecoveryWitness
          ? { databaseRecoveryWitness: provider.activeDatabaseRecoveryWitness }
          : {}),
      };
      this.writebacks.set(key, pendingNoOp);
      this.providers.set(input.request.providerInstanceId, {
        ...withoutMutationOwnership(provider),
        latestGeneration: input.request.generation,
        mutationEpoch: provider.mutationEpoch + 1n,
      });
      this.leases.complete({ leaseId: input.request.leaseId, now: input.now });
      this.writebacks.set(key, {
        ...pendingNoOp,
        status: "completed",
        safeErrorCode: "unchanged_generation_positive_proof_v1",
        completedAt: input.now,
      });
      return {
        status: "unchanged_generation" as const,
        generation: input.request.generation,
      };
    }
    const namespace = allocateVersionedProviderSecretNamespace({
      scope: provider.activeNamespace.scope,
      epoch: provider.activeNamespace.epoch + 1n,
    });
    const intentId = `intent:${key}`;
    const attemptId = `attempt:${namespace.namespaceId}`;
    const executorOwner = `executor:${attemptId}`;
    const executorLeaseExpiresAt =
      reserveRuntimeVersionedEffectConfirmationWindow({
        now: input.now,
        authorizationExpiresAt: this.leaseExpiresAtById.get(
          input.request.leaseId,
        )!,
      });
    this.writebacks.set(key, {
      intentId,
      attemptId,
      executorOwner,
      executorLeaseExpiresAt,
      namespace,
      request: input.request,
      encryptedPayloadDigest: input.encryptedPayloadDigest,
      status: "pending",
      authorizationEpoch: provider.mutationEpoch,
      authorizationExpiresAt: this.leaseExpiresAtById.get(
        input.request.leaseId,
      )!,
      databaseIncarnation: this.currentDatabaseIncarnation(),
      ...(provider.activeDatabaseRecoveryWitness
        ? { databaseRecoveryWitness: provider.activeDatabaseRecoveryWitness }
        : {}),
    });
    return {
      status: "ready" as const,
      intentId,
      attemptId,
      executorOwner,
      retirementIdentity: {
        providerInstanceId: input.request.providerInstanceId,
        mutationOwner: "runtime" as const,
        mutationOwnerId: input.request.leaseId,
        mutationEpoch: provider.mutationEpoch,
        namespaceId: namespace.namespaceId,
        generation: input.request.generation,
        latestGenerationHash: input.request.latestGenerationHash,
        accountIdentityHash: input.request.accountIdentityHash,
      },
      namespace,
      repository: provider.repository,
      writeTarget: {
        ...toWriteTarget(provider.repository),
        expectedProviderInstanceId: input.request.providerInstanceId,
        secretName: namespace.name,
      },
    };
  }

  async confirmVersionedProviderWrite(input: {
    readonly intentId: string;
    readonly attemptId: string;
    readonly executorOwner: string;
    readonly statusCode: 201 | 204;
    readonly now: Date;
  }): Promise<void> {
    const entry = this.findVersionedWriteback(input);
    if (!entry) throw new Error("codex_rotating_writeback_attempt_not_found");
    const [key, record] = entry;
    this.assertExecutorOwner(record, input.executorOwner, input.now);
    this.assertAutomaticRuntimeDatabaseRecoveryWitness(
      this.providers.get(record.request.providerInstanceId),
      record.databaseRecoveryWitness,
    );
    this.assertVersionedTransitionAuthorized(record, input.now);
    this.writebacks.set(key, { ...record, providerConfirmed: true });
  }

  async retireAmbiguousVersionedWriteback(input: {
    readonly intentId: string;
    readonly attemptId: string;
    readonly executorOwner: string;
    readonly retirementIdentity: import("@reviewrouter/features-codex-oauth-rotating").RuntimeVersionedWritebackIdentity;
    readonly safeErrorCode: string;
    readonly now: Date;
  }): Promise<void> {
    const entry = this.findVersionedWriteback(input);
    if (!entry) return;
    const [key, record] = entry;
    if (record.executorOwner !== input.executorOwner) {
      throw new Error("codex_rotating_versioned_executor_lease_conflict");
    }
    this.assertAutomaticRuntimeDatabaseRecoveryWitness(
      this.providers.get(record.request.providerInstanceId),
      record.databaseRecoveryWitness,
    );
    if (
      record.authorizationEpoch === undefined ||
      !record.namespace ||
      !record.executorLeaseExpiresAt
    ) {
      throw new Error("codex_rotating_versioned_attempt_epoch_missing");
    }
    const persistedRetirementIdentity = {
      providerInstanceId: record.request.providerInstanceId,
      mutationOwner: "runtime" as const,
      mutationOwnerId: record.request.leaseId,
      mutationEpoch: record.authorizationEpoch,
      namespaceId: record.namespace.namespaceId,
      generation: record.request.generation,
      latestGenerationHash: record.request.latestGenerationHash,
      accountIdentityHash: record.request.accountIdentityHash,
    };
    assertSameRuntimeVersionedWritebackIdentity({
      expected: persistedRetirementIdentity,
      actual: input.retirementIdentity,
    });
    if (
      record.status === "completed" ||
      record.status === "remote_outcome_unknown"
    ) {
      return;
    }
    const provider = this.providers.get(record.request.providerInstanceId);
    if (!provider) {
      throw new Error("codex_rotating_versioned_retirement_fence_conflict");
    }
    try {
      assertRuntimeVersionedAmbiguousRetirementAuthorized({
        expected: persistedRetirementIdentity,
        actual: {
          ...persistedRetirementIdentity,
          mutationOwner: provider.mutationOwner ?? null,
          mutationOwnerId: provider.mutationOwnerId ?? null,
          mutationEpoch: provider.mutationEpoch,
          accountIdentityHash:
            provider.activeAccountIdentityHash ??
            persistedRetirementIdentity.accountIdentityHash,
        },
        executorLeaseExpiresAt: record.executorLeaseExpiresAt,
        now: input.now,
      });
    } catch {
      throw new Error("codex_rotating_versioned_retirement_fence_conflict");
    }
    if (
      record.namespace &&
      (this.permanentlyRetiredNamespaceIds.has(record.namespace.namespaceId) ||
        provider.activeNamespace.namespaceId === record.namespace.namespaceId)
    ) {
      throw new Error("codex_rotating_versioned_retirement_namespace_conflict");
    }
    this.writebacks.set(key, {
      ...record,
      status: "remote_outcome_unknown",
      safeErrorCode: input.safeErrorCode,
    });
    if (record.namespace) {
      this.permanentlyRetiredNamespaceIds.add(record.namespace.namespaceId);
    }
    this.providers.set(record.request.providerInstanceId, {
      ...withoutMutationOwnership(provider),
      state: "unknown_auth_state",
      mutationEpoch: provider.mutationEpoch + 1n,
      mutationOwner: "recovery",
      mutationOwnerId: record.intentId,
    });
    this.leaseExpiresAtById.set(record.request.leaseId, input.now);
  }

  async retirePreDispatchVersionedWriteback(input: {
    readonly intentId: string;
    readonly attemptId: string;
    readonly executorOwner: string;
    readonly safeErrorCode: string;
    readonly now: Date;
  }): Promise<void> {
    const entry = this.findVersionedWriteback(input);
    if (!entry) return;
    const [key, record] = entry;
    this.assertExecutorOwner(record, input.executorOwner, input.now);
    if (record.status === "failed") return;
    if (record.status !== "pending" || record.providerConfirmed) {
      throw new Error(
        "codex_rotating_versioned_predispatch_retirement_conflict",
      );
    }
    const provider = this.providers.get(record.request.providerInstanceId);
    this.assertAutomaticRuntimeDatabaseRecoveryWitness(
      provider,
      record.databaseRecoveryWitness,
    );
    if (
      !provider ||
      provider.mutationOwner !== "runtime" ||
      provider.mutationOwnerId !== record.request.leaseId ||
      provider.mutationEpoch !== record.authorizationEpoch
    ) {
      throw new Error("codex_rotating_versioned_retirement_fence_conflict");
    }
    if (record.namespace) {
      this.permanentlyRetiredNamespaceIds.add(record.namespace.namespaceId);
    }
    this.writebacks.set(key, {
      ...record,
      status: "failed",
      safeErrorCode: input.safeErrorCode,
    });
    this.providers.set(record.request.providerInstanceId, {
      ...withoutMutationOwnership(provider),
      state: "active",
      mutationEpoch: provider.mutationEpoch + 1n,
    });
    this.leaseExpiresAtById.set(record.request.leaseId, input.now);
    this.leases.retire({ leaseId: record.request.leaseId, now: input.now });
  }

  async activateVersionedWriteback(input: {
    readonly intentId: string;
    readonly attemptId: string;
    readonly executorOwner: string;
    readonly attestation: import("@reviewrouter/features-codex-oauth-rotating").VersionedSecretWorkflowSourceAttestation;
    readonly now: Date;
  }): Promise<{ readonly generation: number }> {
    const entry = this.findVersionedWriteback(input);
    if (!entry) throw new Error("codex_rotating_writeback_attempt_not_found");
    const [key, record] = entry;
    this.assertExecutorOwner(record, input.executorOwner, input.now);
    this.assertAutomaticRuntimeDatabaseRecoveryWitness(
      this.providers.get(record.request.providerInstanceId),
      record.databaseRecoveryWitness,
    );
    if (!record.providerConfirmed || !record.namespace) {
      throw new Error("codex_rotating_provider_write_not_confirmed");
    }
    if (this.permanentlyRetiredNamespaceIds.has(record.namespace.namespaceId)) {
      throw new Error("codex_rotating_secret_namespace_permanently_retired");
    }
    const provider = this.providers.get(record.request.providerInstanceId);
    this.assertVersionedTransitionAuthorized(record, input.now);
    if (
      !provider ||
      provider.mutationOwner !== "runtime" ||
      provider.mutationOwnerId !== record.request.leaseId ||
      input.attestation.repositoryId !== provider.binding.githubRepositoryId ||
      input.attestation.sourceTrust !==
        WorkflowSourceTrust.TrustedDefaultBranchRevision
    ) {
      throw new Error("codex_rotating_activation_fence_conflict");
    }
    assertSameVersionedProviderSecretNamespace({
      expected: record.namespace,
      actual: input.attestation.secretNamespace,
    });
    this.writebacks.set(key, {
      ...record,
      status: "completed",
      completedAt: input.now,
    });
    this.providers.set(record.request.providerInstanceId, {
      ...withoutMutationOwnership(provider),
      latestGeneration: record.request.generation,
      latestGenerationHash: record.request.latestGenerationHash,
      activeAccountIdentityHash: record.request.accountIdentityHash,
      activeNamespace: record.namespace,
      ...(record.databaseRecoveryWitness
        ? { activeDatabaseRecoveryWitness: record.databaseRecoveryWitness }
        : {}),
      state: "active",
      mutationEpoch: provider.mutationEpoch + 1n,
    });
    this.leaseNamespaceById.set(record.request.leaseId, record.namespace);
    this.leases.complete({ leaseId: record.request.leaseId, now: input.now });
    return { generation: record.request.generation };
  }

  private findVersionedWriteback(input: {
    readonly intentId: string;
    readonly attemptId: string;
  }): [string, WritebackRecord] | undefined {
    return [...this.writebacks.entries()].find(
      ([, record]) =>
        record.intentId === input.intentId &&
        record.attemptId === input.attemptId,
    );
  }

  private assertExecutorOwner(
    record: WritebackRecord,
    executorOwner: string,
    now: Date,
  ): void {
    if (
      record.executorOwner !== executorOwner ||
      !record.executorLeaseExpiresAt ||
      record.executorLeaseExpiresAt <= now
    ) {
      throw new Error("codex_rotating_versioned_executor_lease_conflict");
    }
  }

  private assertVersionedTransitionAuthorized(
    record: WritebackRecord,
    now: Date,
  ): void {
    const provider = this.providers.get(record.request.providerInstanceId);
    if (
      !provider ||
      !record.authorizationEpoch ||
      !record.authorizationExpiresAt
    ) {
      throw new Error("codex_rotating_activation_fence_conflict");
    }
    assertProviderSecretTransitionAuthorized({
      expectedOwner: "runtime",
      expectedOwnerId: record.request.leaseId,
      expectedEpoch: record.authorizationEpoch,
      actualFence: {
        owner: provider.mutationOwner ?? null,
        ownerId: provider.mutationOwnerId ?? null,
        epoch: provider.mutationEpoch,
      },
      authorizationExpiresAt: record.authorizationExpiresAt,
      now,
    });
  }

  async findCompletedLeaseWriteTarget(input: {
    readonly leaseId: string;
    readonly providerInstanceId: string;
    readonly now: Date;
    readonly completedLeaseTtlMs?: number | undefined;
  }): Promise<
    | {
        readonly status: "ready";
        readonly writeTarget: {
          readonly githubInstallationId: string;
          readonly githubRepositoryId: string;
          readonly repositoryFullName: string;
          readonly owner: string;
          readonly repo: string;
          readonly secretName: string;
        };
      }
    | {
        readonly status: "lease_not_completed" | "lease_not_active";
      }
  > {
    const context = this.findCompletedLeaseContext(input);
    if (context.status !== "ready") return context;
    return {
      status: "ready" as const,
      writeTarget: toWriteTarget(context.repository, context.namespace.name),
    };
  }

  async authorizeReviewSnapshotAccess(input: {
    readonly leaseId: string;
    readonly providerInstanceId: string;
    readonly pullRequestNumber: number;
    readonly now: Date;
  }) {
    const context = this.findCompletedLeaseContext({
      ...input,
      completedLeaseTtlMs: codexRotatingReviewSnapshotAccessTtlMs,
    });
    if (
      context.status !== "ready" ||
      context.source.pullRequestNumber !== input.pullRequestNumber
    ) {
      return { status: "lease_not_active" as const };
    }
    return {
      status: "ready" as const,
      scope: {
        workspaceId: context.repository.workspaceId,
        repositoryId: context.repository.repositoryId,
        sourceRunId: context.source.runId,
        sourceRunAttempt: context.source.runAttempt,
        pullRequestNumber: context.source.pullRequestNumber,
      },
    };
  }

  async authorizeReviewExecutionCheckpointAccess(input: {
    readonly leaseId: string;
    readonly providerInstanceId: string;
    readonly pullRequestNumber: number;
    readonly now: Date;
  }) {
    const context = this.findCompletedLeaseContext({
      ...input,
      completedLeaseTtlMs: codexRotatingReviewExecutionCheckpointAccessTtlMs,
    });
    if (
      context.status !== "ready" ||
      context.source.pullRequestNumber !== input.pullRequestNumber
    ) {
      return { status: "lease_not_active" as const };
    }
    return {
      status: "ready" as const,
      scope: {
        workspaceId: context.repository.workspaceId,
        repositoryId: context.repository.repositoryId,
        sourceRunId: context.source.runId,
        sourceRunAttempt: context.source.runAttempt,
        pullRequestNumber: context.source.pullRequestNumber,
      },
    };
  }

  private findCompletedLeaseContext(input: {
    readonly leaseId: string;
    readonly providerInstanceId: string;
    readonly now: Date;
    readonly completedLeaseTtlMs?: number | undefined;
  }): CompletedLeaseContext {
    const source = this.leaseSourceById.get(input.leaseId);
    if (!source || source.providerInstanceId !== input.providerInstanceId) {
      return { status: "lease_not_active" as const };
    }
    const writeback = [...this.writebacks.values()].find(
      (record) =>
        record.request.leaseId === input.leaseId &&
        record.request.providerInstanceId === input.providerInstanceId,
    );
    if (
      !writeback ||
      writeback.status !== "completed" ||
      !writeback.completedAt
    ) {
      const expiresAt = this.leaseExpiresAtById.get(input.leaseId);
      if (expiresAt && expiresAt <= input.now) {
        return { status: "lease_not_active" as const };
      }
      return { status: "lease_not_completed" as const };
    }
    if (
      !isCodexRotatingCompletedLeasePostingWindowActive({
        completedAt: writeback.completedAt,
        now: input.now,
        ...(input.completedLeaseTtlMs
          ? { ttlMs: input.completedLeaseTtlMs }
          : {}),
      })
    ) {
      return { status: "lease_not_active" as const };
    }
    const provider = this.providers.get(input.providerInstanceId);
    this.assertAutomaticRuntimeDatabaseRecoveryWitness(provider);
    const leaseNamespace = this.leaseNamespaceById.get(input.leaseId);
    if (
      !provider ||
      !leaseNamespace ||
      leaseNamespace.namespaceId !== provider.activeNamespace.namespaceId ||
      leaseNamespace.epoch !== provider.activeNamespace.epoch
    ) {
      return { status: "lease_not_active" as const };
    }
    return {
      status: "ready" as const,
      repository: source.repository,
      source,
      namespace: leaseNamespace,
    };
  }

  private initialDatabaseRecoveryWitnessFingerprint(): Readonly<{
    activeDatabaseRecoveryWitness?: string;
  }> {
    const witness =
      this.options.initialDatabaseRecoveryWitness ??
      this.options.currentDatabaseRecoveryWitness?.();
    return witness
      ? {
          activeDatabaseRecoveryWitness:
            fingerprintDatabaseRecoveryWitness(witness),
        }
      : {};
  }

  private assertAutomaticRuntimeDatabaseRecoveryWitness(
    provider: ProviderRecord | undefined,
    persistedFingerprint = provider?.activeDatabaseRecoveryWitness,
  ): void {
    if (!persistedFingerprint) return;
    let currentFingerprint: string;
    try {
      currentFingerprint = fingerprintDatabaseRecoveryWitness(
        this.options.currentDatabaseRecoveryWitness?.() ?? "",
      );
    } catch {
      throw new Error("codex_rotating_database_recovery_witness_unproven");
    }
    assertExternalRecoveryWitnessAdmission({
      transition: "automatic_runtime",
      relation: classifyExternalRecoveryWitnessRelation({
        persistedFingerprint,
        currentFingerprint,
      }),
    });
  }

  private currentDatabaseIncarnation(): string {
    const incarnation =
      this.options.currentDatabaseIncarnation?.() ?? "in_memory_writer";
    if (!incarnation) {
      throw new Error("codex_rotating_database_incarnation_unproven");
    }
    return incarnation;
  }

  private assertWritebackDatabaseGeneration(
    provider: ProviderRecord | undefined,
    record: WritebackRecord,
  ): void {
    if (record.databaseIncarnation !== this.currentDatabaseIncarnation()) {
      throw new Error("codex_rotating_database_incarnation_mismatch");
    }
    this.assertAutomaticRuntimeDatabaseRecoveryWitness(
      provider,
      record.databaseRecoveryWitness,
    );
  }
}

function toWriteTarget(
  repository: ActionRepositoryContext,
  secretName: string = codexRotatingSecretName,
) {
  return {
    expectedProviderInstanceId: `codex-rotating:${repository.githubRepositoryId}`,
    githubInstallationId: repository.githubInstallationId,
    githubRepositoryId: repository.githubRepositoryId,
    repositoryFullName: repository.fullName,
    owner: repository.owner,
    repo: repository.fullName.slice(repository.owner.length + 1),
    secretName,
  };
}

const testGenerationHashSalt = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY";
const testAccountFingerprintSalt =
  "YWJjZGVmMDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY";

function initialNamespace(
  binding: CodexRotatingProviderBinding,
): VersionedProviderSecretNamespace {
  return allocateVersionedProviderSecretNamespace({
    scope: {
      repositoryId: binding.githubRepositoryId,
      providerInstanceId: binding.providerInstanceId,
    },
    epoch: 1n,
    randomBytes: () => new Uint8Array(16),
  });
}

function withoutMutationOwnership(provider: ProviderRecord): ProviderRecord {
  return {
    binding: provider.binding,
    generationHashSalt: provider.generationHashSalt,
    accountFingerprintSalt: provider.accountFingerprintSalt,
    latestGeneration: provider.latestGeneration,
    latestGenerationHash: provider.latestGenerationHash,
    state: provider.state,
    mutationEpoch: provider.mutationEpoch,
    activeNamespace: provider.activeNamespace,
    ...(provider.activeDatabaseRecoveryWitness
      ? {
          activeDatabaseRecoveryWitness: provider.activeDatabaseRecoveryWitness,
        }
      : {}),
    ...(provider.repository ? { repository: provider.repository } : {}),
    ...(provider.preflightKeyId
      ? { preflightKeyId: provider.preflightKeyId }
      : {}),
    ...(provider.activeAccountIdentityHash
      ? { activeAccountIdentityHash: provider.activeAccountIdentityHash }
      : {}),
  };
}
