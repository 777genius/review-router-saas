import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  conflictReviewAttemptExchangeTtlMs,
  conflictReviewDispatchEventType,
  hashConflictReviewDispatchNonce,
  type ConflictReviewAttempt,
  type ConflictReviewRepository,
  type NewConflictReviewAttempt,
} from "../../domain/conflict-review";
import type { ConflictReviewRepositoryPort } from "../../application/ports/conflict-review-repository-port";

export class PrismaConflictReviewRepository implements ConflictReviewRepositoryPort {
  constructor(private readonly prisma: PrismaClient) {}

  async findRepositoryByGitHubIdentity(input: {
    readonly githubRepositoryId: string;
    readonly githubInstallationId: string;
  }): Promise<ConflictReviewRepository | null> {
    const repository = await this.prisma.repositoryConnection.findFirst({
      where: {
        provider: "github",
        githubRepositoryId: BigInt(input.githubRepositoryId),
        installation: {
          githubInstallationId: BigInt(input.githubInstallationId),
        },
      },
      select: {
        id: true,
        workspaceId: true,
        githubRepositoryId: true,
        owner: true,
        name: true,
        fullName: true,
        defaultBranch: true,
        selected: true,
        installation: {
          select: {
            githubInstallationId: true,
            status: true,
          },
        },
      },
    });
    if (
      !repository ||
      !repository.githubRepositoryId ||
      !repository.installation
    ) {
      return null;
    }
    return {
      workspaceId: repository.workspaceId,
      repositoryId: repository.id,
      githubRepositoryId: repository.githubRepositoryId.toString(),
      githubInstallationId:
        repository.installation.githubInstallationId.toString(),
      owner: repository.owner,
      name: repository.name,
      fullName: repository.fullName,
      defaultBranch: repository.defaultBranch,
      selected: repository.selected,
      installationStatus: repository.installation.status,
    };
  }

  async tryCreateAttempt(
    attempt: NewConflictReviewAttempt,
  ): Promise<
    | { readonly created: true; readonly attempt: ConflictReviewAttempt }
    | { readonly created: false; readonly attempt: ConflictReviewAttempt }
  > {
    try {
      const created = await this.prisma.conflictReviewAttempt.create({
        data: {
          workspaceId: attempt.workspaceId,
          repositoryId: attempt.repositoryId,
          githubRepositoryId: BigInt(attempt.githubRepositoryId),
          githubInstallationId: BigInt(attempt.githubInstallationId),
          pullRequestNumber: attempt.pullRequestNumber,
          headSha: attempt.headSha,
          baseRef: attempt.baseRef,
          baseSha: attempt.baseSha,
          fallbackVersion: attempt.fallbackVersion,
          dispatchId: attempt.dispatchId,
          dispatchNonceHash: attempt.dispatchNonceHash,
          dispatchEventType: attempt.dispatchEventType,
          createdAt: attempt.createdAt,
        },
      });
      return { created: true, attempt: toConflictReviewAttempt(created) };
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
      const existing = await this.prisma.conflictReviewAttempt.findUnique({
        where: {
          repositoryId_pullRequestNumber_headSha_baseRef_baseSha_fallbackVersion:
            {
              repositoryId: attempt.repositoryId,
              pullRequestNumber: attempt.pullRequestNumber,
              headSha: attempt.headSha,
              baseRef: attempt.baseRef,
              baseSha: attempt.baseSha,
              fallbackVersion: attempt.fallbackVersion,
            },
        },
      });
      if (!existing) {
        throw error;
      }
      return { created: false, attempt: toConflictReviewAttempt(existing) };
    }
  }

  async markAttemptDispatched(input: {
    readonly attemptId: string;
    readonly dispatchedAt: Date;
  }): Promise<void> {
    await this.prisma.conflictReviewAttempt.updateMany({
      where: {
        id: input.attemptId,
        status: "recorded",
      },
      data: {
        status: "dispatched",
        dispatchedAt: input.dispatchedAt,
        safeErrorCode: null,
        safeErrorSummary: null,
      },
    });
  }

  async refreshAttemptDispatch(input: {
    readonly attemptId: string;
    readonly previousDispatchId: string;
    readonly dispatchId: string;
    readonly dispatchNonceHash: string;
    readonly dispatchEventType: string;
    readonly refreshedAt: Date;
  }): Promise<ConflictReviewAttempt | null> {
    const updated = await this.prisma.conflictReviewAttempt.updateMany({
      where: {
        id: input.attemptId,
        dispatchId: input.previousDispatchId,
        status: { in: ["recorded", "failed"] },
      },
      data: {
        dispatchId: input.dispatchId,
        dispatchNonceHash: input.dispatchNonceHash,
        dispatchEventType: input.dispatchEventType,
        status: "recorded",
        createdAt: input.refreshedAt,
        dispatchedAt: null,
        completedAt: null,
        safeErrorCode: null,
        safeErrorSummary: null,
        githubRunId: null,
        githubRunAttempt: null,
        configSnapshotId: null,
        startedAt: null,
      },
    });
    if (updated.count !== 1) {
      return null;
    }

    const refreshed = await this.prisma.conflictReviewAttempt.findUnique({
      where: { id: input.attemptId },
    });
    return refreshed ? toConflictReviewAttempt(refreshed) : null;
  }

  async markAttemptSkipped(input: {
    readonly attemptId: string;
    readonly reason: string;
    readonly skippedAt: Date;
  }): Promise<void> {
    await this.prisma.conflictReviewAttempt.update({
      where: { id: input.attemptId },
      data: {
        status: "skipped",
        completedAt: input.skippedAt,
        safeErrorCode: input.reason,
      },
    });
  }

  async markAttemptFailed(input: {
    readonly attemptId: string;
    readonly errorCode: string;
    readonly safeErrorSummary: string;
    readonly failedAt: Date;
  }): Promise<void> {
    await this.prisma.conflictReviewAttempt.updateMany({
      where: {
        id: input.attemptId,
        status: { in: ["recorded", "dispatched"] },
      },
      data: {
        status: "failed",
        completedAt: input.failedAt,
        safeErrorCode: input.errorCode,
        safeErrorSummary: input.safeErrorSummary.slice(0, 500),
      },
    });
  }

  async verifyConflictReviewExchange(input: {
    readonly claims: {
      readonly repository_id: string;
      readonly run_id: string;
      readonly run_attempt: string;
    };
    readonly dispatchPayload: {
      readonly protocolVersion: 1;
      readonly dispatchEventType: typeof conflictReviewDispatchEventType;
      readonly dispatchId: string;
      readonly nonce: string;
      readonly repositoryId: string;
      readonly pullRequestNumber: number;
      readonly headSha: string;
      readonly baseRef: string;
      readonly baseSha: string;
      readonly fallbackVersion: 1;
    };
    readonly configSnapshotId: string;
    readonly exchangedAt: Date;
  }): Promise<{
    readonly reviewKind: "conflict-head";
    readonly dispatchId: string;
    readonly pullRequestNumber: number;
    readonly headSha: string;
    readonly baseRef: string;
    readonly baseSha: string;
  }> {
    const payload = input.dispatchPayload;
    if (input.claims.repository_id !== payload.repositoryId) {
      throw new Error("conflict_review_repository_mismatch");
    }
    const attempt = await this.prisma.conflictReviewAttempt.findUnique({
      where: { dispatchId: payload.dispatchId },
    });
    if (!attempt) {
      throw new Error("conflict_review_attempt_not_found");
    }
    if (attempt.githubRepositoryId.toString() !== payload.repositoryId) {
      throw new Error("conflict_review_repository_mismatch");
    }
    if (attempt.dispatchEventType !== conflictReviewDispatchEventType) {
      throw new Error("conflict_review_event_type_mismatch");
    }
    if (payload.dispatchEventType !== attempt.dispatchEventType) {
      throw new Error("conflict_review_event_type_mismatch");
    }
    if (
      attempt.dispatchNonceHash !==
      hashConflictReviewDispatchNonce(payload.nonce)
    ) {
      throw new Error("conflict_review_nonce_mismatch");
    }
    if (
      attempt.pullRequestNumber !== payload.pullRequestNumber ||
      attempt.headSha.toLowerCase() !== payload.headSha.toLowerCase() ||
      attempt.baseRef !== payload.baseRef ||
      attempt.baseSha.toLowerCase() !== payload.baseSha.toLowerCase() ||
      attempt.fallbackVersion !== payload.fallbackVersion
    ) {
      throw new Error("conflict_review_payload_mismatch");
    }
    if (!["recorded", "dispatched", "started"].includes(attempt.status)) {
      throw new Error("conflict_review_attempt_not_active");
    }
    if (
      input.exchangedAt.getTime() - attempt.createdAt.getTime() >
      conflictReviewAttemptExchangeTtlMs
    ) {
      throw new Error("conflict_review_attempt_expired");
    }
    if (
      attempt.githubRunId !== null &&
      attempt.githubRunId !== input.claims.run_id
    ) {
      throw new Error("conflict_review_run_mismatch");
    }
    if (
      attempt.githubRunAttempt !== null &&
      isStaleRunAttempt(input.claims.run_attempt, attempt.githubRunAttempt)
    ) {
      throw new Error("conflict_review_run_attempt_stale");
    }
    if (
      attempt.configSnapshotId !== null &&
      attempt.configSnapshotId !== input.configSnapshotId
    ) {
      throw new Error("conflict_review_config_snapshot_mismatch");
    }

    const updated = await this.prisma.conflictReviewAttempt.updateMany({
      where: {
        id: attempt.id,
        status: { in: ["recorded", "dispatched", "started"] },
        OR: [{ githubRunId: null }, { githubRunId: input.claims.run_id }],
        AND: [
          {
            OR: [
              { configSnapshotId: null },
              { configSnapshotId: input.configSnapshotId },
            ],
          },
        ],
      },
      data: {
        status: "started",
        githubRunId: input.claims.run_id,
        githubRunAttempt: input.claims.run_attempt,
        configSnapshotId: input.configSnapshotId,
        startedAt: input.exchangedAt,
      },
    });
    if (updated.count !== 1) {
      throw new Error("conflict_review_run_mismatch");
    }

    return {
      reviewKind: "conflict-head",
      dispatchId: attempt.dispatchId,
      pullRequestNumber: attempt.pullRequestNumber,
      headSha: attempt.headSha,
      baseRef: attempt.baseRef,
      baseSha: attempt.baseSha,
    };
  }

  async issueConflictReviewPostingSession(input: {
    readonly session: {
      readonly workspaceId: string;
      readonly repositoryId: string;
      readonly githubRepositoryId: string;
      readonly repository: string;
      readonly githubRunId: string;
      readonly githubRunAttempt: string;
      readonly reviewKind?: "normal" | "conflict-head";
      readonly conflictDispatchId?: string;
      readonly pullRequestNumber?: number;
      readonly headSha?: string;
      readonly baseRef?: string;
      readonly baseSha?: string;
      readonly configSnapshotId?: string;
    };
    readonly manifestHash: string;
    readonly issuedAt: Date;
  }): Promise<{
    readonly purpose: "conflict-review-posting";
    readonly attemptId: string;
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly githubRepositoryId: string;
    readonly githubInstallationId: string;
    readonly repository: string;
    readonly githubRunId: string;
    readonly githubRunAttempt: string;
    readonly dispatchId: string;
    readonly pullRequestNumber: number;
    readonly headSha: string;
    readonly baseRef: string;
    readonly baseSha: string;
    readonly configSnapshotId: string;
    readonly manifestHash: string;
    readonly operationScopeHash: string;
    readonly protocolVersion: 1;
  }> {
    const session = input.session;
    if (
      session.reviewKind !== "conflict-head" ||
      !session.conflictDispatchId ||
      !session.pullRequestNumber ||
      !session.headSha ||
      !session.baseRef ||
      !session.baseSha ||
      !session.configSnapshotId
    ) {
      throw new Error("conflict_review_session_required");
    }
    const attempt = await this.prisma.conflictReviewAttempt.findUnique({
      where: { dispatchId: session.conflictDispatchId },
    });
    if (!attempt) {
      throw new Error("conflict_review_attempt_not_found");
    }
    if (
      attempt.workspaceId !== session.workspaceId ||
      attempt.repositoryId !== session.repositoryId ||
      attempt.githubRepositoryId.toString() !== session.githubRepositoryId
    ) {
      throw new Error("conflict_review_repository_mismatch");
    }
    if (
      attempt.githubRunId !== session.githubRunId ||
      attempt.githubRunAttempt !== session.githubRunAttempt
    ) {
      throw new Error("conflict_review_run_mismatch");
    }
    if (attempt.configSnapshotId !== session.configSnapshotId) {
      throw new Error("conflict_review_config_snapshot_mismatch");
    }
    if (
      attempt.pullRequestNumber !== session.pullRequestNumber ||
      attempt.headSha.toLowerCase() !== session.headSha.toLowerCase() ||
      attempt.baseRef !== session.baseRef ||
      attempt.baseSha.toLowerCase() !== session.baseSha.toLowerCase()
    ) {
      throw new Error("conflict_review_payload_mismatch");
    }
    if (
      attempt.postingManifestHash !== null &&
      attempt.postingManifestHash !== input.manifestHash
    ) {
      throw new Error("conflict_review_posting_manifest_mismatch");
    }
    if (
      !(postingSessionIssuableStatuses as readonly string[]).includes(
        attempt.status,
      )
    ) {
      throw new Error("conflict_review_attempt_not_active");
    }

    const nextStatus = ["started", "model_running"].includes(attempt.status)
      ? "posting_started"
      : attempt.status;
    const updated = await this.prisma.conflictReviewAttempt.updateMany({
      where: {
        id: attempt.id,
        status: { in: [...postingSessionIssuableStatuses] },
        githubRunId: session.githubRunId,
        githubRunAttempt: session.githubRunAttempt,
        configSnapshotId: session.configSnapshotId,
        OR: [
          { postingManifestHash: null },
          { postingManifestHash: input.manifestHash },
        ],
      },
      data: {
        status: nextStatus,
        postingManifestHash: input.manifestHash,
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) {
      throw new Error("conflict_review_posting_session_race");
    }

    return {
      purpose: "conflict-review-posting",
      attemptId: attempt.id,
      workspaceId: attempt.workspaceId,
      repositoryId: attempt.repositoryId,
      githubRepositoryId: attempt.githubRepositoryId.toString(),
      githubInstallationId: attempt.githubInstallationId.toString(),
      repository: session.repository,
      githubRunId: session.githubRunId,
      githubRunAttempt: session.githubRunAttempt,
      dispatchId: attempt.dispatchId,
      pullRequestNumber: attempt.pullRequestNumber,
      headSha: attempt.headSha,
      baseRef: attempt.baseRef,
      baseSha: attempt.baseSha,
      configSnapshotId: session.configSnapshotId,
      manifestHash: input.manifestHash,
      operationScopeHash: conflictReviewPostingOperationScopeHash({
        attemptId: attempt.id,
        dispatchId: attempt.dispatchId,
        githubRunId: session.githubRunId,
        githubRunAttempt: session.githubRunAttempt,
        manifestHash: input.manifestHash,
        headSha: attempt.headSha,
        baseRef: attempt.baseRef,
        baseSha: attempt.baseSha,
      }),
      protocolVersion: 1,
    };
  }

  async reserveConflictReviewPostingIntent(input: {
    readonly scope: {
      readonly attemptId: string;
      readonly manifestHash: string;
      readonly dispatchId: string;
      readonly githubRunId: string;
      readonly githubRunAttempt: string;
    };
    readonly operationKind: "summary_comment" | "advisory_status";
    readonly operationFingerprint: string;
    readonly bodyHash: string;
    readonly requestedAt: Date;
  }): Promise<
    | { readonly status: "reserved"; readonly intentId: string }
    | {
        readonly status: "completed";
        readonly intentId: string;
        readonly githubExternalId: string;
        readonly githubUrl: string | null;
      }
    | { readonly status: "pending"; readonly intentId: string }
  > {
    await this.assertPostingScopeActive(input.scope);
    try {
      const created = await this.prisma.conflictReviewPostingIntent.create({
        data: {
          attemptId: input.scope.attemptId,
          operationKind: input.operationKind,
          operationFingerprint: input.operationFingerprint,
          manifestHash: input.scope.manifestHash,
          bodyHash: input.bodyHash,
          createdAt: input.requestedAt,
        },
      });
      return { status: "reserved", intentId: created.id };
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
      const existing = await this.prisma.conflictReviewPostingIntent.findUnique(
        {
          where: {
            attemptId_operationKind_operationFingerprint: {
              attemptId: input.scope.attemptId,
              operationKind: input.operationKind,
              operationFingerprint: input.operationFingerprint,
            },
          },
        },
      );
      if (!existing) {
        throw error;
      }
      if (
        existing.status === "completed" &&
        existing.githubExternalId !== null
      ) {
        return {
          status: "completed",
          intentId: existing.id,
          githubExternalId: existing.githubExternalId,
          githubUrl: existing.githubUrl,
        };
      }
      if (existing.status === "ambiguous") {
        const recovered =
          await this.prisma.conflictReviewPostingIntent.updateMany({
            where: {
              id: existing.id,
              attemptId: input.scope.attemptId,
              operationKind: input.operationKind,
              operationFingerprint: input.operationFingerprint,
              manifestHash: input.scope.manifestHash,
              status: "ambiguous",
            },
            data: {
              status: "pending",
              bodyHash: input.bodyHash,
              safeErrorCode: null,
              safeErrorSummary: null,
              completedAt: null,
            },
          });
        if (recovered.count === 1) {
          return { status: "reserved", intentId: existing.id };
        }
      }
      return { status: "pending", intentId: existing.id };
    }
  }

  async commitConflictReviewPostingIntent(input: {
    readonly scope: {
      readonly attemptId: string;
      readonly manifestHash: string;
      readonly dispatchId: string;
      readonly githubRunId: string;
      readonly githubRunAttempt: string;
    };
    readonly intentId: string;
    readonly operationKind: "summary_comment" | "advisory_status";
    readonly githubExternalId: string;
    readonly githubUrl?: string | undefined;
    readonly bodyHash: string;
    readonly completedAt: Date;
  }): Promise<void> {
    await this.assertPostingScopeActive(input.scope);
    const updated = await this.prisma.conflictReviewPostingIntent.updateMany({
      where: {
        id: input.intentId,
        attemptId: input.scope.attemptId,
        operationKind: input.operationKind,
        manifestHash: input.scope.manifestHash,
        status: "pending",
      },
      data: {
        status: "completed",
        githubExternalId: input.githubExternalId,
        githubUrl: input.githubUrl ?? null,
        bodyHash: input.bodyHash,
        completedAt: input.completedAt,
        safeErrorCode: null,
        safeErrorSummary: null,
      },
    });
    if (updated.count !== 1) {
      throw new Error("conflict_review_posting_intent_commit_race");
    }
    await this.advancePostingStateAfterCommit({
      attemptId: input.scope.attemptId,
      operationKind: input.operationKind,
      completedAt: input.completedAt,
    });
  }

  async markConflictReviewPostingIntentAmbiguous(input: {
    readonly scope: {
      readonly attemptId: string;
      readonly manifestHash: string;
    };
    readonly intentId: string;
    readonly operationKind: "summary_comment" | "advisory_status";
    readonly safeErrorCode: string;
    readonly safeErrorSummary: string;
    readonly failedAt: Date;
  }): Promise<void> {
    await this.prisma.conflictReviewPostingIntent.updateMany({
      where: {
        id: input.intentId,
        attemptId: input.scope.attemptId,
        operationKind: input.operationKind,
        manifestHash: input.scope.manifestHash,
        status: "pending",
      },
      data: {
        status: "ambiguous",
        safeErrorCode: input.safeErrorCode,
        safeErrorSummary: input.safeErrorSummary.slice(0, 500),
        completedAt: input.failedAt,
      },
    });
  }

  private async assertPostingScopeActive(input: {
    readonly attemptId: string;
    readonly manifestHash: string;
    readonly dispatchId: string;
    readonly githubRunId: string;
    readonly githubRunAttempt: string;
  }): Promise<void> {
    const attempt = await this.prisma.conflictReviewAttempt.findUnique({
      where: { id: input.attemptId },
    });
    if (!attempt) {
      throw new Error("conflict_review_attempt_not_found");
    }
    if (
      attempt.dispatchId !== input.dispatchId ||
      attempt.githubRunId !== input.githubRunId ||
      attempt.githubRunAttempt !== input.githubRunAttempt ||
      attempt.postingManifestHash !== input.manifestHash
    ) {
      throw new Error("conflict_review_posting_scope_mismatch");
    }
    if (
      !(postingIntentAllowedStatuses as readonly string[]).includes(
        attempt.status,
      )
    ) {
      throw new Error("conflict_review_attempt_not_active");
    }
  }

  private async advancePostingStateAfterCommit(input: {
    readonly attemptId: string;
    readonly operationKind: "summary_comment" | "advisory_status";
    readonly completedAt: Date;
  }): Promise<void> {
    const status =
      input.operationKind === "summary_comment"
        ? "summary_posted"
        : "status_posted";
    await this.prisma.conflictReviewAttempt.updateMany({
      where: {
        id: input.attemptId,
        status: { in: [...postingIntentAllowedStatuses] },
      },
      data: {
        status,
        ...(status === "status_posted"
          ? { completedAt: input.completedAt, normalReviewRecheckNeeded: true }
          : {}),
        version: { increment: 1 },
      },
    });
  }
}

const postingSessionIssuableStatuses = [
  "started",
  "model_running",
  "posting_started",
  "summary_posted",
  "inline_posting_completed",
  "status_posted",
] as const;

const postingIntentAllowedStatuses = [
  "posting_started",
  "summary_posted",
  "inline_posting_completed",
  "status_posted",
] as const;

function toConflictReviewAttempt(record: {
  readonly id: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly githubRepositoryId: bigint;
  readonly githubInstallationId: bigint;
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly fallbackVersion: number;
  readonly dispatchId: string;
  readonly dispatchNonceHash: string;
  readonly dispatchEventType: string;
  readonly status: string;
  readonly version?: number;
  readonly postingManifestHash?: string | null;
  readonly createdAt: Date;
}): ConflictReviewAttempt {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    repositoryId: record.repositoryId,
    githubRepositoryId: record.githubRepositoryId.toString(),
    githubInstallationId: record.githubInstallationId.toString(),
    pullRequestNumber: record.pullRequestNumber,
    headSha: record.headSha,
    baseRef: record.baseRef,
    baseSha: record.baseSha,
    fallbackVersion: record.fallbackVersion,
    dispatchId: record.dispatchId,
    dispatchNonceHash: record.dispatchNonceHash,
    dispatchEventType: conflictReviewDispatchEventType,
    status: record.status as ConflictReviewAttempt["status"],
    version: record.version ?? 1,
    postingManifestHash: record.postingManifestHash ?? null,
    createdAt: record.createdAt,
  };
}

function conflictReviewPostingOperationScopeHash(input: {
  readonly attemptId: string;
  readonly dispatchId: string;
  readonly githubRunId: string;
  readonly githubRunAttempt: string;
  readonly manifestHash: string;
  readonly headSha: string;
  readonly baseRef: string;
  readonly baseSha: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        attemptId: input.attemptId,
        baseRef: input.baseRef,
        baseSha: input.baseSha,
        dispatchId: input.dispatchId,
        githubRunAttempt: input.githubRunAttempt,
        githubRunId: input.githubRunId,
        headSha: input.headSha,
        manifestHash: input.manifestHash,
      }),
      "utf8",
    )
    .digest("hex");
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "P2002"
  );
}

function isStaleRunAttempt(incoming: string, existing: string): boolean {
  if (/^\d+$/.test(incoming) && /^\d+$/.test(existing)) {
    const incomingNumber = Number.parseInt(incoming, 10);
    const existingNumber = Number.parseInt(existing, 10);
    return incomingNumber < existingNumber;
  }
  return incoming !== existing;
}
