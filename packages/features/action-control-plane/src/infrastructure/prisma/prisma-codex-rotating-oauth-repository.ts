import type { Prisma, PrismaClient } from "@prisma/client";
import {
  codexRotatingAuthMode,
  codexRotatingSecretName,
  codexRotatingWorkflowSchemaVersion,
  createCodexRotatingSalt,
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
  CodexRotatingSecretWriteTarget,
} from "../../application/ports/codex-rotating-oauth-repository-port.js";
import type { CodexRotatingReviewSnapshotAccessPort } from "../../application/ports/codex-rotating-review-snapshot-access-port.js";
import type { CodexRotatingReviewExecutionCheckpointAccessPort } from "../../application/ports/codex-rotating-review-execution-checkpoint-access-port.js";

const codexRotatingRepositoryContextSelect = {
  id: true,
  workspaceId: true,
  provider: true,
  githubRepositoryId: true,
  fullName: true,
  owner: true,
  name: true,
  selected: true,
  installation: {
    select: {
      githubInstallationId: true,
      status: true,
    },
  },
} as const;

export class PrismaCodexRotatingOAuthRepository
  implements
    CodexRotatingOAuthRepositoryPort,
    CodexRotatingReviewSnapshotAccessPort,
    CodexRotatingReviewExecutionCheckpointAccessPort
{
  constructor(
    private readonly prisma: PrismaClient,
    private readonly options: {
      readonly actionRef?: string;
      readonly allowedActionRefs?: readonly string[] | undefined;
      readonly actionOwnerRepo: string;
      readonly workflowPath?: string;
    },
  ) {}

  async findProviderBinding(input: {
    readonly repository: ActionRepositoryContext;
    readonly providerInstanceId: string;
    readonly workflowSha: string;
  }): Promise<CodexRotatingProviderBinding | null> {
    await this.prisma.codexOAuthProviderInstance.upsert({
      where: { providerInstanceId: input.providerInstanceId },
      update: {
        workspaceId: input.repository.workspaceId,
        repositoryId: input.repository.repositoryId,
        authMode: codexRotatingAuthMode,
        secretName: codexRotatingSecretName,
      },
      create: {
        workspaceId: input.repository.workspaceId,
        repositoryId: input.repository.repositoryId,
        providerInstanceId: input.providerInstanceId,
        authMode: codexRotatingAuthMode,
        secretName: codexRotatingSecretName,
        generationHashSalt: createCodexRotatingSalt(),
        accountFingerprintSalt: createCodexRotatingSalt(),
      },
    });

    return {
      providerInstanceId: input.providerInstanceId,
      repositoryFullName: input.repository.fullName,
      githubRepositoryId: input.repository.githubRepositoryId,
      actionRef:
        this.options.actionRef ??
        `${this.options.actionOwnerRepo}@${input.workflowSha}`,
      ...(this.options.allowedActionRefs?.length
        ? { allowedActionRefs: this.options.allowedActionRefs }
        : {}),
      workflowPath:
        this.options.workflowPath ?? ".github/workflows/reviewrouter-codex.yml",
      workflowSchemaVersion: codexRotatingWorkflowSchemaVersion,
    };
  }

  async acquirePrelease(input: {
    readonly repository: ActionRepositoryContext;
    readonly providerInstanceId: string;
    readonly githubRunId: string;
    readonly githubRunAttempt: string;
    readonly pullRequestNumber?: number | undefined;
    readonly now: Date;
  }): Promise<CodexRotatingPreleaseRecord> {
    const expiresAt = new Date(input.now.getTime() + 15 * 60 * 1000);
    const leaseKey = `${input.providerInstanceId}:${input.githubRunId}:${input.githubRunAttempt}`;

    return this.prisma.$transaction(async (tx) => {
      const provider = await tx.codexOAuthProviderInstance.findUnique({
        where: { providerInstanceId: input.providerInstanceId },
        select: {
          id: true,
          activeLeaseId: true,
          activeLeaseExpiresAt: true,
          state: true,
          latestGeneration: true,
          latestGenerationHash: true,
          generationHashSalt: true,
        },
      });
      if (!provider) {
        throw new Error("codex_rotating_provider_not_found");
      }
      if (
        provider.state === "unknown_auth_state" ||
        provider.state === "needs_reconnect" ||
        provider.state === "permission_required"
      ) {
        throw new Error(`codex_rotating_provider_${provider.state}`);
      }
      if (
        provider.activeLeaseId &&
        provider.activeLeaseExpiresAt &&
        provider.activeLeaseExpiresAt > input.now
      ) {
        const activeLease = await tx.codexOAuthLease.findUnique({
          where: { id: provider.activeLeaseId },
          select: {
            id: true,
            githubRunId: true,
            githubRunAttempt: true,
            pullRequestNumber: true,
            status: true,
            expiresAt: true,
          },
        });
        if (
          activeLease &&
          activeLease.status !== "completed" &&
          activeLease.expiresAt > input.now
        ) {
          if (
            activeLease.githubRunId === input.githubRunId &&
            activeLease.githubRunAttempt === input.githubRunAttempt &&
            activeLease.status === "preleased"
          ) {
            return {
              leaseId: activeLease.id,
              providerInstanceId: input.providerInstanceId,
              runId: input.githubRunId,
              runAttempt: input.githubRunAttempt,
              status: "preleased" as const,
              expiresAt: activeLease.expiresAt,
              repository: input.repository,
              generationHashSalt: provider.generationHashSalt,
              currentGeneration: provider.latestGeneration,
              ...(provider.latestGenerationHash
                ? { currentGenerationHash: provider.latestGenerationHash }
                : {}),
            };
          }
          if (
            activeLease.githubRunId === input.githubRunId &&
            activeLease.githubRunAttempt !== input.githubRunAttempt
          ) {
            await tx.codexOAuthLease.update({
              where: { id: activeLease.id },
              data: {
                status: "expired",
                expiresAt: input.now,
              },
            });
          } else {
            return {
              leaseId: activeLease.id,
              providerInstanceId: input.providerInstanceId,
              runId: activeLease.githubRunId,
              runAttempt: activeLease.githubRunAttempt,
              status: "conflict" as const,
              expiresAt: activeLease.expiresAt,
              repository: input.repository,
              generationHashSalt: provider.generationHashSalt,
              currentGeneration: provider.latestGeneration,
              ...(provider.latestGenerationHash
                ? { currentGenerationHash: provider.latestGenerationHash }
                : {}),
            };
          }
        }
      }

      const lease = await tx.codexOAuthLease.upsert({
        where: { leaseKey },
        update: {
          status: "preleased",
          expiresAt,
          ...(input.pullRequestNumber
            ? { pullRequestNumber: input.pullRequestNumber }
            : {}),
        },
        create: {
          providerInstanceRowId: provider.id,
          providerInstanceId: input.providerInstanceId,
          workspaceId: input.repository.workspaceId,
          repositoryId: input.repository.repositoryId,
          githubRunId: input.githubRunId,
          githubRunAttempt: input.githubRunAttempt,
          ...(input.pullRequestNumber
            ? { pullRequestNumber: input.pullRequestNumber }
            : {}),
          leaseKey,
          status: "preleased",
          expiresAt,
        },
      });
      await tx.codexOAuthProviderInstance.update({
        where: { id: provider.id },
        data: {
          activeLeaseId: lease.id,
          activeLeaseExpiresAt: expiresAt,
          state: "setup_pending",
        },
      });

      return {
        leaseId: lease.id,
        providerInstanceId: input.providerInstanceId,
        runId: input.githubRunId,
        runAttempt: input.githubRunAttempt,
        status: "preleased" as const,
        expiresAt,
        repository: input.repository,
        generationHashSalt: provider.generationHashSalt,
        currentGeneration: provider.latestGeneration,
        ...(provider.latestGenerationHash
          ? { currentGenerationHash: provider.latestGenerationHash }
          : {}),
      };
    });
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
    return this.prisma.$transaction(async (tx) => {
      const provider = await tx.codexOAuthProviderInstance.findUnique({
        where: { providerInstanceId: input.providerInstanceId },
        select: {
          id: true,
          activeLeaseId: true,
          activeLeaseExpiresAt: true,
          latestGeneration: true,
          latestGenerationHash: true,
          repository: {
            select: codexRotatingRepositoryContextSelect,
          },
        },
      });
      if (
        !provider ||
        provider.activeLeaseId !== input.leaseId ||
        !provider.activeLeaseExpiresAt ||
        provider.activeLeaseExpiresAt <= input.now
      ) {
        throw new Error("codex_rotating_lease_not_active");
      }

      const nextGeneration = provider.latestGeneration + 1;
      if (
        provider.latestGenerationHash &&
        provider.latestGenerationHash !== input.restoredGenerationHash
      ) {
        await tx.codexOAuthLease.update({
          where: { id: input.leaseId },
          data: {
            status: "stale_queued_secret",
            restoredGenerationHash: input.restoredGenerationHash,
            nextGeneration,
            finalizedAt: input.now,
          },
        });
        await tx.codexOAuthProviderInstance.update({
          where: { id: provider.id },
          data: {
            state: "stale_queued_secret",
            activeLeaseId: null,
            activeLeaseExpiresAt: null,
          },
        });
        return {
          leaseId: input.leaseId,
          nextGeneration,
          repository: toActionRepositoryContext(
            requireGitHubRepositoryContext(provider.repository),
          ),
          status: "stale_queued_secret" as const,
        };
      }

      await tx.codexOAuthLease.update({
        where: { id: input.leaseId },
        data: {
          status: "finalized",
          restoredGenerationHash: input.restoredGenerationHash,
          nextGeneration,
          finalizedAt: input.now,
        },
      });
      return {
        leaseId: input.leaseId,
        nextGeneration,
        repository: toActionRepositoryContext(
          requireGitHubRepositoryContext(provider.repository),
        ),
        status: "finalized" as const,
      };
    });
  }

  async abandonLease(input: {
    readonly leaseId: string;
    readonly providerInstanceId: string;
    readonly reason: "needs_reconnect" | "unknown_auth_state";
    readonly now: Date;
  }): Promise<{
    readonly status: "abandoned" | "lease_not_active";
  }> {
    return this.prisma.$transaction(async (tx) => {
      const provider = await tx.codexOAuthProviderInstance.findUnique({
        where: { providerInstanceId: input.providerInstanceId },
        select: {
          id: true,
          activeLeaseId: true,
          activeLeaseExpiresAt: true,
          leases: {
            where: { id: input.leaseId },
            take: 1,
            select: {
              id: true,
              status: true,
              expiresAt: true,
            },
          },
        },
      });
      const lease = provider?.leases[0];
      if (
        !provider ||
        !lease ||
        provider.activeLeaseId !== input.leaseId ||
        !provider.activeLeaseExpiresAt ||
        provider.activeLeaseExpiresAt <= input.now ||
        lease.expiresAt <= input.now ||
        lease.status === "completed"
      ) {
        return { status: "lease_not_active" as const };
      }

      await tx.codexOAuthLease.update({
        where: { id: input.leaseId },
        data: {
          status: input.reason,
          expiresAt: input.now,
        },
      });
      await tx.codexOAuthProviderInstance.update({
        where: { id: provider.id },
        data: {
          state: input.reason,
          activeLeaseId: null,
          activeLeaseExpiresAt: null,
        },
      });
      return { status: "abandoned" as const };
    });
  }

  async preflightWriteback(input: {
    readonly leaseId: string;
    readonly providerInstanceId: string;
    readonly githubKeyId: string;
    readonly now: Date;
  }): Promise<
    | {
        readonly status: "ready";
        readonly writeTarget: CodexRotatingSecretWriteTarget;
      }
    | {
        readonly status:
          | "lease_not_active"
          | "stale_queued_secret"
          | "permission_required";
      }
  > {
    return this.prisma.$transaction(async (tx) => {
      const provider = await tx.codexOAuthProviderInstance.findUnique({
        where: { providerInstanceId: input.providerInstanceId },
        select: {
          id: true,
          activeLeaseId: true,
          activeLeaseExpiresAt: true,
          repository: { select: codexRotatingRepositoryContextSelect },
          leases: {
            where: { id: input.leaseId },
            take: 1,
            select: {
              id: true,
              status: true,
              expiresAt: true,
              nextGeneration: true,
            },
          },
        },
      });
      const lease = provider?.leases[0];
      if (
        !provider ||
        !lease ||
        provider.activeLeaseId !== input.leaseId ||
        !provider.activeLeaseExpiresAt ||
        provider.activeLeaseExpiresAt <= input.now ||
        lease.expiresAt <= input.now
      ) {
        return { status: "lease_not_active" as const };
      }
      if (lease.status === "stale_queued_secret") {
        return { status: "stale_queued_secret" as const };
      }
      if (lease.status !== "finalized" || !lease.nextGeneration) {
        return { status: "lease_not_active" as const };
      }

      await tx.codexOAuthLease.update({
        where: { id: input.leaseId },
        data: {
          writebackPreflightKeyId: input.githubKeyId,
          writebackPreflightedAt: input.now,
        },
      });

      return {
        status: "ready" as const,
        writeTarget: toSecretWriteTarget(
          requireGitHubRepositoryContext(provider.repository),
        ),
      };
    });
  }

  async prepareEncryptedWriteback(input: {
    readonly request: CodexRotatingEncryptedWritebackRequest;
    readonly encryptedPayloadDigest: string;
    readonly now: Date;
  }): Promise<
    | {
        readonly status: "ready";
        readonly intentId: string;
        readonly writeTarget: CodexRotatingSecretWriteTarget;
      }
    | {
        readonly status: "idempotent_replay" | "writeback_idempotency_conflict";
      }
  > {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.codexOAuthWritebackIntent.findUnique({
        where: {
          providerInstanceId_idempotencyKey: {
            providerInstanceId: input.request.providerInstanceId,
            idempotencyKey: input.request.idempotencyKey,
          },
        },
        select: {
          id: true,
          encryptedPayloadDigest: true,
          status: true,
          providerInstance: {
            select: {
              repository: { select: codexRotatingRepositoryContextSelect },
            },
          },
        },
      });
      if (existing) {
        if (
          existing.encryptedPayloadDigest === input.encryptedPayloadDigest &&
          existing.status === "pending"
        ) {
          return {
            status: "ready" as const,
            intentId: existing.id,
            writeTarget: toSecretWriteTarget(
              requireGitHubRepositoryContext(
                existing.providerInstance.repository,
              ),
            ),
          };
        }
        return {
          status:
            existing.encryptedPayloadDigest === input.encryptedPayloadDigest &&
            existing.status === "completed"
              ? "idempotent_replay"
              : "writeback_idempotency_conflict",
        };
      }

      const provider = await tx.codexOAuthProviderInstance.findUnique({
        where: { providerInstanceId: input.request.providerInstanceId },
        select: {
          id: true,
          activeLeaseId: true,
          activeLeaseExpiresAt: true,
          repository: { select: codexRotatingRepositoryContextSelect },
          leases: {
            where: { id: input.request.leaseId },
            take: 1,
            select: {
              id: true,
              status: true,
              expiresAt: true,
              nextGeneration: true,
              writebackPreflightKeyId: true,
            },
          },
        },
      });
      const lease = provider?.leases[0];
      if (
        !provider ||
        !lease ||
        provider.activeLeaseId !== input.request.leaseId ||
        !provider.activeLeaseExpiresAt ||
        provider.activeLeaseExpiresAt <= input.now ||
        lease.status !== "finalized" ||
        lease.expiresAt <= input.now ||
        lease.nextGeneration !== input.request.generation ||
        lease.writebackPreflightKeyId !== input.request.keyId
      ) {
        throw new Error("codex_rotating_lease_not_active");
      }

      const intent = await tx.codexOAuthWritebackIntent.create({
        data: {
          providerInstanceRowId: provider.id,
          leaseId: input.request.leaseId,
          providerInstanceId: input.request.providerInstanceId,
          idempotencyKey: input.request.idempotencyKey,
          generation: input.request.generation,
          latestGenerationHash: input.request.latestGenerationHash,
          encryptedPayloadDigest: input.encryptedPayloadDigest,
          keyId: input.request.keyId,
          status: "pending",
        },
        select: { id: true },
      });
      return {
        status: "ready" as const,
        intentId: intent.id,
        writeTarget: toSecretWriteTarget(
          requireGitHubRepositoryContext(provider.repository),
        ),
      };
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
        readonly writeTarget: CodexRotatingSecretWriteTarget;
      }
    | {
        readonly status: "lease_not_completed" | "lease_not_active";
      }
  > {
    const context = await this.findCompletedLeaseContext(input);
    if (context.status !== "ready") return context;
    return {
      status: "ready" as const,
      writeTarget: toSecretWriteTarget(context.repository),
    };
  }

  async authorizeReviewSnapshotAccess(input: {
    readonly leaseId: string;
    readonly providerInstanceId: string;
    readonly pullRequestNumber: number;
    readonly now: Date;
  }) {
    const context = await this.findCompletedLeaseContext({
      ...input,
      completedLeaseTtlMs: codexRotatingReviewSnapshotAccessTtlMs,
    });
    if (
      context.status !== "ready" ||
      context.pullRequestNumber !== input.pullRequestNumber
    ) {
      return { status: "lease_not_active" as const };
    }
    return {
      status: "ready" as const,
      scope: {
        workspaceId: context.repository.workspaceId,
        repositoryId: context.repository.id,
        sourceRunId: context.sourceRunId,
        sourceRunAttempt: context.sourceRunAttempt,
        pullRequestNumber: context.pullRequestNumber,
      },
    };
  }

  async authorizeReviewExecutionCheckpointAccess(input: {
    readonly leaseId: string;
    readonly providerInstanceId: string;
    readonly pullRequestNumber: number;
    readonly now: Date;
  }) {
    const context = await this.findCompletedLeaseContext({
      ...input,
      completedLeaseTtlMs: codexRotatingReviewExecutionCheckpointAccessTtlMs,
    });
    if (
      context.status !== "ready" ||
      context.pullRequestNumber !== input.pullRequestNumber
    ) {
      return { status: "lease_not_active" as const };
    }
    return {
      status: "ready" as const,
      scope: {
        workspaceId: context.repository.workspaceId,
        repositoryId: context.repository.id,
        sourceRunId: context.sourceRunId,
        sourceRunAttempt: context.sourceRunAttempt,
        pullRequestNumber: context.pullRequestNumber,
      },
    };
  }

  private async findCompletedLeaseContext(input: {
    readonly leaseId: string;
    readonly providerInstanceId: string;
    readonly now: Date;
    readonly completedLeaseTtlMs?: number | undefined;
  }) {
    const lease = await this.prisma.codexOAuthLease.findFirst({
      where: {
        id: input.leaseId,
        providerInstanceId: input.providerInstanceId,
      },
      select: {
        repository: { select: codexRotatingRepositoryContextSelect },
        workspaceId: true,
        status: true,
        expiresAt: true,
        completedAt: true,
        githubRunId: true,
        githubRunAttempt: true,
        pullRequestNumber: true,
      },
    });
    if (!lease) {
      return { status: "lease_not_active" as const };
    }
    if (lease.status !== "completed" || !lease.completedAt) {
      if (lease.expiresAt <= input.now) {
        return { status: "lease_not_active" as const };
      }
      return { status: "lease_not_completed" as const };
    }
    if (
      !isCodexRotatingCompletedLeasePostingWindowActive({
        completedAt: lease.completedAt,
        now: input.now,
        ...(input.completedLeaseTtlMs
          ? { ttlMs: input.completedLeaseTtlMs }
          : {}),
      })
    ) {
      return { status: "lease_not_active" as const };
    }
    const repository = requireGitHubRepositoryContext(lease.repository);
    if (repository.workspaceId !== lease.workspaceId) {
      return { status: "lease_not_active" as const };
    }
    return {
      status: "ready" as const,
      repository,
      sourceRunId: lease.githubRunId,
      sourceRunAttempt: lease.githubRunAttempt,
      pullRequestNumber: lease.pullRequestNumber,
    };
  }

  async confirmEncryptedWriteback(input: {
    readonly intentId: string;
    readonly now: Date;
  }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const intent = await tx.codexOAuthWritebackIntent.findUnique({
        where: { id: input.intentId },
        select: {
          id: true,
          leaseId: true,
          providerInstanceId: true,
          generation: true,
          latestGenerationHash: true,
          status: true,
          providerInstance: {
            select: {
              id: true,
              activeLeaseId: true,
            },
          },
        },
      });
      if (!intent) {
        throw new Error("codex_rotating_writeback_intent_not_found");
      }
      if (intent.status === "completed") return;
      if (
        intent.status !== "pending" ||
        intent.providerInstance.activeLeaseId !== intent.leaseId
      ) {
        throw new Error("codex_rotating_writeback_intent_not_confirmable");
      }
      await tx.codexOAuthLease.update({
        where: { id: intent.leaseId },
        data: {
          status: "completed",
          completedAt: input.now,
        },
      });
      await tx.codexOAuthProviderInstance.update({
        where: { id: intent.providerInstance.id },
        data: {
          state: "active",
          latestGeneration: intent.generation,
          latestGenerationHash: intent.latestGenerationHash,
          activeLeaseId: null,
          activeLeaseExpiresAt: null,
        },
      });
      await tx.codexOAuthWritebackIntent.update({
        where: { id: intent.id },
        data: {
          status: "completed",
          completedAt: input.now,
        },
      });
    });
  }

  async markEncryptedWritebackFailed(input: {
    readonly intentId: string;
    readonly safeErrorCode: string;
    readonly now: Date;
  }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const intent = await tx.codexOAuthWritebackIntent.findUnique({
        where: { id: input.intentId },
        select: {
          id: true,
          leaseId: true,
          status: true,
          providerInstance: {
            select: {
              id: true,
              activeLeaseId: true,
            },
          },
        },
      });
      if (!intent || intent.status !== "pending") {
        return;
      }

      await tx.codexOAuthWritebackIntent.update({
        where: { id: intent.id },
        data: {
          status: "failed",
          safeErrorCode: input.safeErrorCode,
        },
      });
      await tx.codexOAuthLease.updateMany({
        where: { id: intent.leaseId },
        data: {
          status: "unknown_auth_state",
        },
      });
      await tx.codexOAuthProviderInstance.update({
        where: { id: intent.providerInstance.id },
        data: {
          state: "unknown_auth_state",
          ...(intent.providerInstance.activeLeaseId === intent.leaseId
            ? { activeLeaseId: null, activeLeaseExpiresAt: null }
            : {}),
        },
      });
    });
  }
}

type CodexRotatingRepositoryContextRow = Prisma.RepositoryConnectionGetPayload<{
  select: typeof codexRotatingRepositoryContextSelect;
}>;

type GitHubCodexRotatingRepositoryContextRow =
  CodexRotatingRepositoryContextRow & {
    readonly provider: "github";
    readonly githubRepositoryId: bigint;
    readonly installation: NonNullable<
      CodexRotatingRepositoryContextRow["installation"]
    >;
  };

function requireGitHubRepositoryContext(
  repository: CodexRotatingRepositoryContextRow,
): GitHubCodexRotatingRepositoryContextRow {
  if (
    repository.provider !== "github" ||
    !repository.githubRepositoryId ||
    !repository.installation
  ) {
    throw new Error("codex_rotating_repository_not_github");
  }
  return repository as GitHubCodexRotatingRepositoryContextRow;
}

function toActionRepositoryContext(
  repository: GitHubCodexRotatingRepositoryContextRow,
): ActionRepositoryContext {
  return {
    workspaceId: repository.workspaceId,
    repositoryId: repository.id,
    githubRepositoryId: repository.githubRepositoryId.toString(),
    githubInstallationId:
      repository.installation.githubInstallationId.toString(),
    fullName: repository.fullName,
    owner: repository.owner,
    selected: repository.selected,
    installationStatus: repository.installation.status,
  };
}

function toSecretWriteTarget(
  repository: GitHubCodexRotatingRepositoryContextRow,
): CodexRotatingSecretWriteTarget {
  return {
    githubInstallationId:
      repository.installation.githubInstallationId.toString(),
    githubRepositoryId: repository.githubRepositoryId.toString(),
    repositoryFullName: repository.fullName,
    owner: repository.owner,
    repo: repository.name,
    secretName: codexRotatingSecretName,
  };
}
