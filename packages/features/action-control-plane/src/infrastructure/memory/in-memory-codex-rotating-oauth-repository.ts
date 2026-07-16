import {
  type CodexRotatingProviderState,
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
};

type WritebackRecord = {
  readonly intentId: string;
  readonly request: CodexRotatingEncryptedWritebackRequest;
  readonly encryptedPayloadDigest: string;
  readonly status: "pending" | "completed" | "failed";
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
      });
    }
  }

  async findProviderBinding(input: {
    readonly repository: ActionRepositoryContext;
    readonly providerInstanceId: string;
    readonly workflowSha: string;
  }): Promise<CodexRotatingProviderBinding | null> {
    const existing = this.providers.get(input.providerInstanceId);
    if (existing) {
      this.providers.set(input.providerInstanceId, {
        ...existing,
        repository: input.repository,
      });
      return existing.binding;
    }

    const binding: CodexRotatingProviderBinding = {
      providerInstanceId: input.providerInstanceId,
      repositoryFullName: input.repository.fullName,
      githubRepositoryId: input.repository.githubRepositoryId,
      actionRef: `${input.repository.owner}/review-router@${input.workflowSha}`,
      workflowPath: ".github/workflows/reviewrouter-codex.yml",
      workflowSchemaVersion: 1,
    };
    this.providers.set(input.providerInstanceId, {
      binding,
      generationHashSalt: testGenerationHashSalt,
      latestGeneration: 1,
      latestGenerationHash: null,
      state: "setup_pending",
      repository: input.repository,
    });
    return binding;
  }

  async acquirePrelease(input: {
    readonly repository: ActionRepositoryContext;
    readonly providerInstanceId: string;
    readonly githubRunId: string;
    readonly githubRunAttempt: string;
    readonly pullRequestNumber?: number | undefined;
    readonly now: Date;
  }): Promise<CodexRotatingPreleaseRecord> {
    const provider = this.providers.get(input.providerInstanceId);
    if (
      provider?.state === "unknown_auth_state" ||
      provider?.state === "needs_reconnect" ||
      provider?.state === "permission_required"
    ) {
      throw new Error(`codex_rotating_provider_${provider.state}`);
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
      this.providers.set(input.providerInstanceId, {
        ...provider,
        repository: input.repository,
        activeLeaseId: lease.leaseId,
      });
    }
    const latest = this.providers.get(input.providerInstanceId) ?? provider;
    return {
      ...lease,
      repository: input.repository,
      generationHashSalt: latest?.generationHashSalt ?? testGenerationHashSalt,
      currentGeneration: latest?.latestGeneration ?? 1,
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
    if (provider?.latestGenerationHash) {
      if (provider.latestGenerationHash !== input.restoredGenerationHash) {
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
    if (!provider?.repository || provider.activeLeaseId !== input.leaseId) {
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
        readonly status: "idempotent_replay" | "writeback_idempotency_conflict";
      }
  > {
    const key = `${input.request.providerInstanceId}:${input.request.idempotencyKey}`;
    const existing = this.writebacks.get(key);
    if (existing) {
      if (existing.status === "pending") {
        const provider = this.providers.get(input.request.providerInstanceId);
        if (
          existing.encryptedPayloadDigest === input.encryptedPayloadDigest &&
          provider?.repository
        ) {
          return {
            status: "ready",
            intentId: existing.intentId,
            writeTarget: toWriteTarget(provider.repository),
          };
        }
      }
      return {
        status:
          existing.encryptedPayloadDigest === input.encryptedPayloadDigest &&
          existing.status === "completed"
            ? "idempotent_replay"
            : "writeback_idempotency_conflict",
      };
    }
    const provider = this.providers.get(input.request.providerInstanceId);
    if (
      !provider?.repository ||
      provider.activeLeaseId !== input.request.leaseId ||
      provider.preflightKeyId !== input.request.keyId
    ) {
      throw new Error("codex_rotating_lease_not_active");
    }
    const intentId = `intent:${key}`;
    this.writebacks.set(key, {
      intentId,
      request: input.request,
      encryptedPayloadDigest: input.encryptedPayloadDigest,
      status: "pending",
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
  }): Promise<void> {
    const recordEntry = [...this.writebacks.entries()].find(
      ([, record]) => record.intentId === input.intentId,
    );
    if (!recordEntry) {
      throw new Error("codex_rotating_writeback_intent_not_found");
    }
    const [key, record] = recordEntry;
    this.writebacks.set(key, {
      ...record,
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
        ...(provider.repository ? { repository: provider.repository } : {}),
      });
    }
    this.leases.complete({ leaseId: record.request.leaseId, now: input.now });
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
    this.writebacks.set(key, { ...record, status: "failed" });
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
      });
    }
  }
}

function toWriteTarget(repository: ActionRepositoryContext) {
  return {
    githubInstallationId: repository.githubInstallationId,
    githubRepositoryId: repository.githubRepositoryId,
    repositoryFullName: repository.fullName,
    owner: repository.owner,
    repo: repository.fullName.slice(repository.owner.length + 1),
    secretName: codexRotatingSecretName,
  };
}

const testGenerationHashSalt = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY";
