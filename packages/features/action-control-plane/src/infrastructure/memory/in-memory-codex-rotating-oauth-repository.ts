import {
  assertCanonicalCodexRotatingProviderId,
  type CodexRotatingProviderState,
  codexRotatingCanonicalT0WorkflowSchemaVersions,
  codexRotatingSecretName,
  InMemoryCodexRotatingLeaseStore,
  type CodexRotatingEncryptedWritebackRequest,
  type CodexRotatingProviderBinding,
} from "@reviewrouter/features-codex-oauth-rotating";
import type { ActionRepositoryContext } from "../../domain/action-control-plane.js";
import {
  codexRotatingReviewExecutionCheckpointAccessTtlMs,
  codexRotatingReviewSnapshotAccessTtlMs,
  isCodexRotatingCompletedLeasePostingWindowActive,
} from "../../domain/codex-rotating-oauth-posting-window.js";
import {
  blocksCodexRotatingProviderMutation,
  codexRotatingWritebackClaimMarker,
  decideCodexRotatingWritebackConfirmation,
  decideCodexRotatingWritebackPreparation,
  mayFailCodexRotatingWritebackClaim,
  type CodexRotatingWritebackIntentStatus,
} from "../../domain/codex-rotating-writeback-policy.js";
import type {
  CodexRotatingOAuthRepositoryPort,
  CodexRotatingPreleaseRecord,
} from "../../application/ports/codex-rotating-oauth-repository-port.js";
import type { CodexRotatingReviewSnapshotAccessPort } from "../../application/ports/codex-rotating-review-snapshot-access-port.js";
import type { CodexRotatingReviewExecutionCheckpointAccessPort } from "../../application/ports/codex-rotating-review-execution-checkpoint-access-port.js";

type ProviderRecord = {
  readonly binding: CodexRotatingProviderBinding;
  readonly generationHashSalt: string;
  readonly latestGeneration: number;
  readonly latestGenerationHash: string | null;
  readonly state: CodexRotatingProviderState;
  readonly repository?: ActionRepositoryContext;
  readonly activeLeaseId?: string;
  readonly preflightKeyId?: string;
  readonly mutationEpoch: bigint;
  readonly mutationOwner?: "runtime" | "setup" | "recovery";
  readonly mutationOwnerId?: string;
};

type WritebackRecord = {
  readonly intentId: string;
  readonly request: CodexRotatingEncryptedWritebackRequest;
  readonly encryptedPayloadDigest: string;
  readonly status: CodexRotatingWritebackIntentStatus;
  readonly safeErrorCode?: string;
  readonly completedAt?: Date;
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
    }
  | {
      readonly status: "lease_not_completed" | "lease_not_active";
    };

export class InMemoryCodexRotatingOAuthRepository
  implements
    CodexRotatingOAuthRepositoryPort,
    CodexRotatingReviewSnapshotAccessPort,
    CodexRotatingReviewExecutionCheckpointAccessPort
{
  private readonly leases = new InMemoryCodexRotatingLeaseStore();
  private readonly providers = new Map<string, ProviderRecord>();
  private readonly writebacks = new Map<string, WritebackRecord>();
  private readonly leaseExpiresAtById = new Map<string, Date>();
  private readonly leaseEpochById = new Map<string, bigint>();
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

  constructor(bindings: readonly CodexRotatingProviderBinding[] = []) {
    for (const binding of bindings) {
      this.providers.set(binding.providerInstanceId, {
        binding,
        generationHashSalt: testGenerationHashSalt,
        latestGeneration: 1,
        latestGenerationHash: null,
        state: "setup_pending",
        mutationEpoch: 0n,
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
      latestGeneration: 1,
      latestGenerationHash: null,
      state: "setup_pending",
      repository: input.repository,
      mutationEpoch: 0n,
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
          blocksCodexRotatingProviderMutation(record.status),
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
      currentGeneration: latest?.latestGeneration ?? 1,
      mutationEpoch: latest?.mutationEpoch ?? 1n,
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
    if (!provider || provider.activeLeaseId !== input.leaseId) {
      return { status: "lease_not_active" };
    }
    const expiresAt = this.leaseExpiresAtById.get(input.leaseId);
    if (expiresAt && expiresAt <= input.now) {
      return { status: "lease_not_active" };
    }
    this.providers.set(input.providerInstanceId, {
      binding: provider.binding,
      generationHashSalt: provider.generationHashSalt,
      latestGeneration: provider.latestGeneration,
      latestGenerationHash: provider.latestGenerationHash,
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
      writeTarget: toWriteTarget(provider.repository),
    };
  }

  async prepareEncryptedWriteback(input: {
    readonly request: CodexRotatingEncryptedWritebackRequest;
    readonly encryptedPayloadDigest: string;
    readonly now: Date;
  }): Promise<
    | {
        readonly status: "ready";
        readonly intentId: string;
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
          | "idempotent_replay"
          | "writeback_recovery_required"
          | "writeback_idempotency_conflict";
      }
  > {
    const key = `${input.request.providerInstanceId}:${input.request.idempotencyKey}`;
    const existing = this.writebacks.get(key);
    const decision = decideCodexRotatingWritebackPreparation({
      existing,
      encryptedPayloadDigest: input.encryptedPayloadDigest,
    });
    if (decision.status !== "claim") return decision;
    const provider = this.providers.get(input.request.providerInstanceId);
    if (
      !provider?.repository ||
      provider.activeLeaseId !== input.request.leaseId ||
      provider.mutationOwner !== "runtime" ||
      provider.mutationOwnerId !== input.request.leaseId ||
      this.leaseEpochById.get(input.request.leaseId) !==
        provider.mutationEpoch ||
      provider.preflightKeyId !== input.request.keyId
    ) {
      throw new Error("codex_rotating_lease_not_active");
    }
    if (
      [...this.writebacks.values()].some(
        (record) =>
          record.request.providerInstanceId ===
            input.request.providerInstanceId &&
          blocksCodexRotatingProviderMutation(record.status),
      )
    ) {
      return { status: "writeback_recovery_required" };
    }
    const intentId = `intent:${key}`;
    this.writebacks.set(key, {
      intentId,
      request: input.request,
      encryptedPayloadDigest: input.encryptedPayloadDigest,
      status: "pending",
      safeErrorCode: codexRotatingWritebackClaimMarker,
    });
    return {
      status: "ready",
      intentId,
      writeTarget: toWriteTarget(provider.repository),
    };
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
      writeTarget: toWriteTarget(context.repository),
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
    return {
      status: "ready" as const,
      repository: source.repository,
      source,
    };
  }

  async confirmEncryptedWriteback(input: {
    readonly intentId: string;
    readonly now: Date;
  }) {
    const recordEntry = [...this.writebacks.entries()].find(
      ([, record]) => record.intentId === input.intentId,
    );
    if (!recordEntry) {
      throw new Error("codex_rotating_writeback_intent_not_found");
    }
    const [key, record] = recordEntry;
    const confirmationDecision =
      decideCodexRotatingWritebackConfirmation(record);
    if (confirmationDecision === "idempotent") {
      return {
        status: "idempotent" as const,
        generation: record.request.generation,
      };
    }
    if (confirmationDecision === "recovery_required") {
      const fencedProvider = this.providers.get(
        record.request.providerInstanceId,
      );
      if (fencedProvider) {
        this.providers.set(record.request.providerInstanceId, {
          ...fencedProvider,
          state: "unknown_auth_state",
          mutationEpoch: fencedProvider.mutationEpoch + 1n,
          mutationOwner: "recovery",
          mutationOwnerId: record.intentId,
        });
      }
      return {
        status: "recovery_required" as const,
        reason: "owner_mismatch" as const,
      };
    }
    const fencedProvider = this.providers.get(
      record.request.providerInstanceId,
    );
    if (
      !fencedProvider ||
      fencedProvider.mutationOwner !== "runtime" ||
      fencedProvider.mutationOwnerId !== record.request.leaseId ||
      this.leaseEpochById.get(record.request.leaseId) !==
        fencedProvider.mutationEpoch
    ) {
      if (fencedProvider) {
        this.providers.set(record.request.providerInstanceId, {
          ...fencedProvider,
          state: "unknown_auth_state",
          mutationEpoch: fencedProvider.mutationEpoch + 1n,
          mutationOwner: "recovery",
          mutationOwnerId: record.intentId,
        });
      }
      return {
        status: "recovery_required" as const,
        reason: "owner_mismatch" as const,
      };
    }
    this.writebacks.set(key, {
      intentId: record.intentId,
      request: record.request,
      encryptedPayloadDigest: record.encryptedPayloadDigest,
      status: "completed",
      completedAt: input.now,
    });
    const provider = this.providers.get(record.request.providerInstanceId);
    if (provider) {
      this.providers.set(record.request.providerInstanceId, {
        binding: provider.binding,
        generationHashSalt: provider.generationHashSalt,
        latestGeneration: record.request.generation,
        latestGenerationHash: record.request.latestGenerationHash,
        state: "active",
        mutationEpoch: provider.mutationEpoch,
        ...(provider.repository ? { repository: provider.repository } : {}),
      });
    }
    this.leases.complete({ leaseId: record.request.leaseId, now: input.now });
    return {
      status: "confirmed" as const,
      generation: record.request.generation,
    };
  }

  async markEncryptedWritebackFailed(input: {
    readonly intentId: string;
    readonly safeErrorCode: string;
    readonly now: Date;
  }): Promise<void> {
    const recordEntry = [...this.writebacks.entries()].find(
      ([, record]) => record.intentId === input.intentId,
    );
    if (!recordEntry) return;
    const [key, record] = recordEntry;
    if (!mayFailCodexRotatingWritebackClaim(record)) return;
    this.writebacks.set(key, {
      ...record,
      status: "failed",
      safeErrorCode: input.safeErrorCode,
    });
    const provider = this.providers.get(record.request.providerInstanceId);
    if (provider) {
      this.providers.set(record.request.providerInstanceId, {
        binding: provider.binding,
        generationHashSalt: provider.generationHashSalt,
        latestGeneration: provider.latestGeneration,
        latestGenerationHash: provider.latestGenerationHash,
        ...(provider.repository ? { repository: provider.repository } : {}),
        ...(provider.preflightKeyId
          ? { preflightKeyId: provider.preflightKeyId }
          : {}),
        state: "unknown_auth_state",
        mutationEpoch: provider.mutationEpoch + 1n,
        mutationOwner: "recovery",
        mutationOwnerId: record.intentId,
      });
    }
  }
}

function toWriteTarget(repository: ActionRepositoryContext) {
  return {
    expectedProviderInstanceId: `codex-rotating:${repository.githubRepositoryId}`,
    githubInstallationId: repository.githubInstallationId,
    githubRepositoryId: repository.githubRepositoryId,
    repositoryFullName: repository.fullName,
    owner: repository.owner,
    repo: repository.fullName.slice(repository.owner.length + 1),
    secretName: codexRotatingSecretName,
  };
}

const testGenerationHashSalt = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY";
