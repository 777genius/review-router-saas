import { Prisma, type PrismaClient } from "@prisma/client";
import { producerReleaseImmutableKey } from "../../domain/producer-release";
import { reviewRunAuthorizedEvent } from "../../application/integration-events/review-run-authorized-event";
import {
  createReviewRunAuthorization,
  renewReviewRunAuthorization,
  reviewRunAttemptKey,
  reviewRunAuthorizationImmutableKey,
  terminateReviewRunAuthorization,
  type ReviewRunAuthorization,
  type ReviewRunAuthorizationCandidate,
} from "../../domain/review-run-authorization";
import {
  ReviewProtocolVersion,
  ProducerReleaseState,
  ReviewProviderKind,
  ReviewRunAuthorizationState,
  ReviewRunAuthorizationTokenAudience,
  ReviewMutationMode,
  ReviewSafetyCapability,
  ReviewSafetyPolicyScope,
  ReviewTrustDomain,
  canonicalJson,
} from "../../domain/review-run-control-types";
import type {
  ReviewRunAuthorizationAdmissionCommandPort,
  ReviewRunAuthorizationAdmissionFence,
  ReviewRunAuthorizationCommandPort,
  ReviewRunAuthorizationQueryPort,
} from "../../application/ports/review-run-authorization-ports";
import {
  ReviewRunAuthorizationCreateStatus,
  ReviewRunAuthorizationRenewStatus,
  ReviewRunAuthorizationTerminateStatus,
} from "../../application/ports/review-run-authorization-ports";
import {
  producerReleaseToDomain,
  reviewRunAuthorizationToDomain,
} from "./prisma-review-run-control-mappers";
import {
  databaseNow,
  isPrismaTransactionConflictError,
  type ReviewRunControlTransaction,
  lockReviewRunControlKeys,
} from "./prisma-review-run-control-utils";

export class PrismaReviewRunAuthorizationRepository
  implements
    ReviewRunAuthorizationQueryPort,
    ReviewRunAuthorizationCommandPort,
    ReviewRunAuthorizationAdmissionCommandPort
{
  constructor(private readonly prisma: PrismaClient) {}

  async findReviewRunAuthorizationById(
    authorizationId: string,
  ): Promise<ReviewRunAuthorization | null> {
    const row = await this.prisma.reviewRunAuthorization.findUnique({
      where: { authorizationId },
    });
    return row ? reviewRunAuthorizationToDomain(row) : null;
  }

  async createOrRestoreReviewRunAuthorization(
    candidate: ReviewRunAuthorizationCandidate,
  ) {
    return this.prisma.$transaction((transaction) =>
      createOrRestoreWithinTransaction(transaction, candidate, false),
    );
  }

  async createOrRestoreReviewRunAuthorizationAtomically(input: {
    readonly candidate: ReviewRunAuthorizationCandidate;
    readonly fence: ReviewRunAuthorizationAdmissionFence;
  }) {
    try {
      return await this.prisma.$transaction(
        async (transaction) => {
          await lockAuthorizationIdentity(transaction, input.candidate);
          const replay = await findReplayResult(transaction, input.candidate);
          if (replay) {
            if ("authorization" in replay) {
              await assertReviewRunAuthorizedOutbox(
                transaction,
                replay.authorization,
              );
            }
            return replay;
          }
          if (
            !(await admissionFenceMatches(
              transaction,
              input.candidate,
              input.fence,
            ))
          ) {
            return {
              status: ReviewRunAuthorizationCreateStatus.EligibilityChanged,
            };
          }
          return createOrRestoreWithinTransaction(
            transaction,
            input.candidate,
            true,
            true,
          );
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (isPrismaTransactionConflictError(error)) {
        return {
          status: ReviewRunAuthorizationCreateStatus.EligibilityChanged,
        };
      }
      throw error;
    }
  }

  async renewReviewRunAuthorization(input: {
    readonly authorizationId: string;
    readonly expectedVersion: number;
    readonly renewalReplayKeyHash: string;
    readonly renewalProofHash: string;
    readonly renewedAt: Date;
    readonly expiresAt: Date;
  }) {
    return this.prisma.$transaction(async (transaction) => {
      await lockReviewRunControlKeys(transaction, "review-authorization", [
        `id:${input.authorizationId}`,
        `renewal:${input.renewalReplayKeyHash}`,
      ]);
      const receipt =
        await transaction.reviewRunAuthorizationRenewalReceipt.findUnique({
          where: { renewalReplayKeyHash: input.renewalReplayKeyHash },
        });
      const currentRow = await transaction.reviewRunAuthorization.findUnique({
        where: { authorizationId: input.authorizationId },
      });
      if (receipt) {
        if (
          receipt.authorizationId !== input.authorizationId ||
          receipt.renewalProofHash !== input.renewalProofHash ||
          !currentRow
        ) {
          return { status: ReviewRunAuthorizationRenewStatus.Conflict };
        }
        return {
          status: ReviewRunAuthorizationRenewStatus.Restored,
          authorization: authorizationFromRenewalReceipt(
            reviewRunAuthorizationToDomain(currentRow),
            receipt,
          ),
        };
      }
      if (!currentRow) {
        return { status: ReviewRunAuthorizationRenewStatus.Missing };
      }
      const current = reviewRunAuthorizationToDomain(currentRow);
      if (current.state !== ReviewRunAuthorizationState.Active) {
        return {
          status: ReviewRunAuthorizationRenewStatus.Terminal,
          authorization: current,
        };
      }
      if (current.version !== input.expectedVersion) {
        return { status: ReviewRunAuthorizationRenewStatus.Conflict };
      }
      const now = await databaseNow(transaction);
      if (now >= current.expiresAt) {
        const expired = terminateReviewRunAuthorization(current, {
          state: ReviewRunAuthorizationState.Expired,
          at: now,
        });
        await transaction.reviewRunAuthorization.updateMany({
          where: {
            authorizationId: current.authorizationId,
            version: current.version,
            state: "active",
            expiresAt: { lte: now },
          },
          data: {
            version: expired.version,
            state: "expired",
            expiresAt: expired.expiresAt,
          },
        });
        return {
          status: ReviewRunAuthorizationRenewStatus.Terminal,
          authorization: expired,
        };
      }
      const renewed = renewReviewRunAuthorization(current, {
        renewedAt: now,
        expiresAt: input.expiresAt,
      });
      if (renewed.version !== current.version) {
        const updated = await transaction.reviewRunAuthorization.updateMany({
          where: {
            authorizationId: current.authorizationId,
            version: input.expectedVersion,
            state: "active",
            expiresAt: { gt: now },
          },
          data: {
            version: renewed.version,
            expiresAt: renewed.expiresAt,
            renewedAt: renewed.renewedAt,
          },
        });
        if (updated.count !== 1) {
          return { status: ReviewRunAuthorizationRenewStatus.Conflict };
        }
      }
      await transaction.reviewRunAuthorizationRenewalReceipt.create({
        data: {
          renewalReplayKeyHash: input.renewalReplayKeyHash,
          authorizationId: input.authorizationId,
          renewalProofHash: input.renewalProofHash,
          authorizationVersion: renewed.version,
          renewedExpiresAt: renewed.expiresAt,
          renewedAt: renewed.renewedAt,
        },
      });
      return {
        status:
          renewed.version === current.version
            ? ReviewRunAuthorizationRenewStatus.Restored
            : ReviewRunAuthorizationRenewStatus.Renewed,
        authorization: renewed,
      };
    });
  }

  async terminateReviewRunAuthorization(input: {
    readonly authorizationId: string;
    readonly expectedVersion: number;
    readonly state:
      | ReviewRunAuthorizationState.Expired
      | ReviewRunAuthorizationState.Revoked;
    readonly at: Date;
  }) {
    return this.prisma.$transaction(async (transaction) => {
      await lockReviewRunControlKeys(transaction, "review-authorization", [
        `id:${input.authorizationId}`,
      ]);
      const currentRow = await transaction.reviewRunAuthorization.findUnique({
        where: { authorizationId: input.authorizationId },
      });
      if (!currentRow) {
        return { status: ReviewRunAuthorizationTerminateStatus.Missing };
      }
      const current = reviewRunAuthorizationToDomain(currentRow);
      if (current.state === input.state) {
        return {
          status: ReviewRunAuthorizationTerminateStatus.Restored,
          authorization: current,
        };
      }
      if (
        current.version !== input.expectedVersion ||
        current.state !== ReviewRunAuthorizationState.Active
      ) {
        return {
          status: ReviewRunAuthorizationTerminateStatus.Conflict,
          authorization: current,
        };
      }
      const at =
        input.state === ReviewRunAuthorizationState.Expired
          ? await databaseNow(transaction)
          : input.at;
      const terminated = terminateReviewRunAuthorization(current, {
        state: input.state,
        at,
      });
      const updated = await transaction.reviewRunAuthorization.updateMany({
        where: {
          authorizationId: input.authorizationId,
          version: input.expectedVersion,
          state: "active",
        },
        data: {
          version: terminated.version,
          state: authorizationStateToPersistence(terminated.state),
          expiresAt: terminated.expiresAt,
          revokedAt:
            terminated.state === ReviewRunAuthorizationState.Revoked
              ? at
              : null,
        },
      });
      if (updated.count !== 1) {
        return {
          status: ReviewRunAuthorizationTerminateStatus.Conflict,
          authorization: current,
        };
      }
      return {
        status: ReviewRunAuthorizationTerminateStatus.Terminated,
        authorization: terminated,
      };
    });
  }

  async expireDueReviewRunAuthorizations(batchSize: number): Promise<number> {
    assertBatchSize(batchSize);
    return this.prisma.$transaction(async (transaction) => {
      const now = await databaseNow(transaction);
      const due = await transaction.reviewRunAuthorization.findMany({
        where: { state: "active", expiresAt: { lte: now } },
        orderBy: [{ expiresAt: "asc" }, { authorizationId: "asc" }],
        select: { authorizationId: true },
        take: batchSize,
      });
      if (due.length === 0) return 0;
      const updated = await transaction.reviewRunAuthorization.updateMany({
        where: {
          authorizationId: { in: due.map((row) => row.authorizationId) },
          state: "active",
          expiresAt: { lte: now },
        },
        data: { state: "expired", version: { increment: 1 } },
      });
      return updated.count;
    });
  }

  async pruneRenewalReceipts(input: {
    readonly retentionMs: number;
    readonly batchSize: number;
  }): Promise<number> {
    assertBatchSize(input.batchSize);
    if (!Number.isSafeInteger(input.retentionMs) || input.retentionMs < 1) {
      throw new Error("review_authorization_retention_ms_invalid");
    }
    return this.prisma.$transaction(async (transaction) => {
      const now = await databaseNow(transaction);
      const cutoff = new Date(now.getTime() - input.retentionMs);
      const receipts =
        await transaction.reviewRunAuthorizationRenewalReceipt.findMany({
          where: { createdAt: { lt: cutoff } },
          orderBy: [{ createdAt: "asc" }, { renewalReplayKeyHash: "asc" }],
          select: {
            renewalReplayKeyHash: true,
            authorizationId: true,
          },
          take: input.batchSize,
        });
      if (receipts.length === 0) return 0;
      const terminal = await transaction.reviewRunAuthorization.findMany({
        where: {
          authorizationId: {
            in: receipts.map((receipt) => receipt.authorizationId),
          },
          state: { in: ["expired", "revoked"] },
          maxExpiresAt: { lt: cutoff },
        },
        select: { authorizationId: true },
      });
      const terminalIds = new Set(
        terminal.map((authorization) => authorization.authorizationId),
      );
      const keys = receipts
        .filter((receipt) => terminalIds.has(receipt.authorizationId))
        .map((receipt) => receipt.renewalReplayKeyHash);
      if (keys.length === 0) return 0;
      const deleted =
        await transaction.reviewRunAuthorizationRenewalReceipt.deleteMany({
          where: {
            renewalReplayKeyHash: { in: keys },
            createdAt: { lt: cutoff },
          },
        });
      return deleted.count;
    });
  }
}

async function createOrRestoreWithinTransaction(
  transaction: ReviewRunControlTransaction,
  candidate: ReviewRunAuthorizationCandidate,
  appendOutbox: boolean,
  alreadyLocked = false,
) {
  if (!alreadyLocked) {
    await lockAuthorizationIdentity(transaction, candidate);
  }
  const replay = await findReplayResult(transaction, candidate);
  if (replay) return replay;
  const runOwner = await transaction.reviewRunAuthorization.findFirst({
    where: {
      workspaceId: candidate.workspaceId,
      repositoryConnectionId: candidate.repositoryConnectionId,
      scmRepositoryIdentityId: candidate.scmRepositoryIdentityId,
      pullRequestNumber: candidate.pullRequestNumber,
      sourceRunId: candidate.sourceRunId,
      sourceRunAttempt: candidate.sourceRunAttempt,
    },
    select: { authorizationId: true },
  });
  if (runOwner) {
    return { status: ReviewRunAuthorizationCreateStatus.RunAttemptConflict };
  }
  const idOwner = await transaction.reviewRunAuthorization.findUnique({
    where: { authorizationId: candidate.authorizationId },
    select: { authorizationId: true },
  });
  if (idOwner) {
    return { status: ReviewRunAuthorizationCreateStatus.IdentifierConflict };
  }
  const authorization = createReviewRunAuthorization(candidate);
  const created = reviewRunAuthorizationToDomain(
    await transaction.reviewRunAuthorization.create({
      data: authorizationCreateData(authorization),
    }),
  );
  if (appendOutbox) {
    await transaction.outboxEvent.create({
      data: reviewRunAuthorizedOutboxData(created),
    });
  }
  return {
    status: ReviewRunAuthorizationCreateStatus.Created,
    authorization: created,
  };
}

async function lockAuthorizationIdentity(
  transaction: ReviewRunControlTransaction,
  candidate: ReviewRunAuthorizationCandidate,
): Promise<void> {
  await lockReviewRunControlKeys(transaction, "review-authorization", [
    `id:${candidate.authorizationId}`,
    `replay:${candidate.oidcReplayKeyHash}`,
    `run:${reviewRunAttemptKey(candidate)}`,
  ]);
}

async function findReplayResult(
  transaction: ReviewRunControlTransaction,
  candidate: ReviewRunAuthorizationCandidate,
) {
  const replayOwner = await transaction.reviewRunAuthorization.findUnique({
    where: { oidcReplayKeyHash: candidate.oidcReplayKeyHash },
  });
  if (!replayOwner) return null;
  const existing = reviewRunAuthorizationToDomain(replayOwner);
  return reviewRunAuthorizationImmutableKey(existing) ===
    reviewRunAuthorizationImmutableKey(candidate)
    ? {
        status: ReviewRunAuthorizationCreateStatus.Restored,
        authorization: existing,
      }
    : { status: ReviewRunAuthorizationCreateStatus.ReplayConflict };
}

async function admissionFenceMatches(
  transaction: ReviewRunControlTransaction,
  candidate: ReviewRunAuthorizationCandidate,
  fence: ReviewRunAuthorizationAdmissionFence,
): Promise<boolean> {
  if (
    fence.safetyTarget.workspaceId !== candidate.workspaceId ||
    fence.safetyTarget.repositoryConnectionId !==
      candidate.repositoryConnectionId ||
    fence.safetyTarget.scmRepositoryIdentityId !==
      candidate.scmRepositoryIdentityId ||
    !fence.safetySnapshot.effectAllowed ||
    fence.safetySnapshot.safetyDecisionHash !==
      candidate.authorizationSafetyDecisionHash
  ) {
    return false;
  }
  const identity = await transaction.scmRepositoryIdentity.findUnique({
    where: { scmRepositoryIdentityId: candidate.scmRepositoryIdentityId },
  });
  const authority = await transaction.reviewMutationAuthority.findUnique({
    where: {
      scmRepositoryIdentityId_laneKind: {
        scmRepositoryIdentityId: candidate.scmRepositoryIdentityId,
        laneKind: "hosted_reviewrouter_app",
      },
    },
  });
  const releaseRow = await transaction.producerRelease.findUnique({
    where: { producerReleaseId: candidate.producerReleaseId },
  });
  const limits = await transaction.reviewProtocolLimitsV2.findUnique({
    where: {
      protocolLimitsProfileId: candidate.protocolLimitsProfileId,
    },
  });
  const slo = await transaction.reviewOperationalSloProfileV2.findUnique({
    where: {
      operationalSloProfileId: candidate.operationalSloProfileId,
    },
  });
  const policies = await transaction.reviewSafetyPolicy.findMany({
    where: {
      capability: "run_authorization_v2",
      OR: safetyScopePredicates(fence.safetyTarget),
    },
  });
  const controls = await transaction.reviewSafetyEmergencyControl.findMany({
    where: { OR: safetyScopePredicates(fence.safetyTarget) },
  });
  if (!identity || !authority || !releaseRow || !limits || !slo) return false;
  const release = producerReleaseToDomain(releaseRow);
  return (
    identity.version === fence.repositoryIdentityVersion &&
    identity.currentWorkspaceId === candidate.workspaceId &&
    identity.currentRepositoryConnectionId ===
      candidate.repositoryConnectionId &&
    authority.version === fence.mutationAuthorityVersion &&
    authority.mode === ReviewMutationMode.V2Active &&
    authority.epoch === candidate.mutationEpoch &&
    release.state === ProducerReleaseState.Registered &&
    producerReleaseImmutableKey(release) ===
      producerReleaseImmutableKey(fence.producerRelease) &&
    limits.limitsDigest === fence.protocolLimitsDigest &&
    slo.sloDigest === fence.operationalSloDigest &&
    samePolicyVersionVector(policies, fence) &&
    sameEmergencyVersionVector(controls, fence)
  );
}

function safetyScopePredicates(
  target: ReviewRunAuthorizationAdmissionFence["safetyTarget"],
) {
  return [
    {
      policyScope: "global" as const,
      workspaceId: null,
      repositoryConnectionId: null,
      scmRepositoryIdentityId: null,
    },
    {
      policyScope: "workspace" as const,
      workspaceId: target.workspaceId,
      repositoryConnectionId: null,
      scmRepositoryIdentityId: null,
    },
    {
      policyScope: "repository" as const,
      workspaceId: target.workspaceId,
      repositoryConnectionId: target.repositoryConnectionId,
      scmRepositoryIdentityId: target.scmRepositoryIdentityId,
    },
  ];
}

function samePolicyVersionVector(
  policies: readonly {
    readonly policyId: string;
    readonly policyScope: string;
    readonly version: number;
    readonly rolloutMode: string;
  }[],
  fence: ReviewRunAuthorizationAdmissionFence,
): boolean {
  const expected = fence.safetySnapshot.capabilityDecisions.find(
    (decision) =>
      decision.capability === ReviewSafetyCapability.RunAuthorizationV2,
  );
  if (!expected) return false;
  const actual = [...policies]
    .sort(
      (left, right) =>
        safetyScopeRank(left.policyScope) - safetyScopeRank(right.policyScope),
    )
    .map(
      (policy) => `${policy.policyId}:${policy.version}:${policy.rolloutMode}`,
    );
  return (
    canonicalJson(actual) === canonicalJson(expected.contributingPolicyVersions)
  );
}

function sameEmergencyVersionVector(
  controls: readonly {
    readonly emergencyControlId: string;
    readonly policyScope: string;
    readonly workspaceId: string | null;
    readonly repositoryConnectionId: string | null;
    readonly scmRepositoryIdentityId: string | null;
    readonly version: number;
    readonly stopped: boolean;
  }[],
  fence: ReviewRunAuthorizationAdmissionFence,
): boolean {
  const byScope = new Map(
    controls.map((control) => [persistenceSafetyScopeKey(control), control]),
  );
  const target = fence.safetyTarget;
  const scopes = [
    ReviewSafetyPolicyScope.Global,
    `${ReviewSafetyPolicyScope.Workspace}:${target.workspaceId}`,
    [
      ReviewSafetyPolicyScope.Repository,
      target.workspaceId,
      target.repositoryConnectionId,
      target.scmRepositoryIdentityId,
    ].join(":"),
  ];
  const actual = scopes.map((scope) => {
    const control = byScope.get(scope);
    return control
      ? `${control.emergencyControlId}:${control.version}:${control.stopped ? "stopped" : "open"}`
      : `${scope}:missing`;
  });
  return (
    canonicalJson(actual) ===
    canonicalJson(fence.safetySnapshot.emergencyVersionVector)
  );
}

function persistenceSafetyScopeKey(input: {
  readonly policyScope: string;
  readonly workspaceId: string | null;
  readonly repositoryConnectionId: string | null;
  readonly scmRepositoryIdentityId: string | null;
}): string {
  if (input.policyScope === ReviewSafetyPolicyScope.Global) {
    return ReviewSafetyPolicyScope.Global;
  }
  if (input.policyScope === ReviewSafetyPolicyScope.Workspace) {
    return `${ReviewSafetyPolicyScope.Workspace}:${input.workspaceId ?? ""}`;
  }
  return [
    ReviewSafetyPolicyScope.Repository,
    input.workspaceId ?? "",
    input.repositoryConnectionId ?? "",
    input.scmRepositoryIdentityId ?? "",
  ].join(":");
}

function safetyScopeRank(scope: string): number {
  if (scope === ReviewSafetyPolicyScope.Global) return 0;
  if (scope === ReviewSafetyPolicyScope.Workspace) return 1;
  if (scope === ReviewSafetyPolicyScope.Repository) return 2;
  return 3;
}

function reviewRunAuthorizedOutboxData(
  authorization: ReviewRunAuthorization,
): Prisma.OutboxEventUncheckedCreateInput {
  const event = reviewRunAuthorizedEvent(authorization);
  return {
    type: event.type,
    version: event.version,
    idempotencyKey: event.idempotencyKey,
    workspaceId: event.workspaceId,
    repositoryId: event.repositoryId,
    aggregateId: event.aggregateId,
    payload: event.payload,
    occurredAt: event.occurredAt,
  };
}

async function assertReviewRunAuthorizedOutbox(
  transaction: ReviewRunControlTransaction,
  authorization: ReviewRunAuthorization,
): Promise<void> {
  const expected = reviewRunAuthorizedEvent(authorization);
  const actual = await transaction.outboxEvent.findUnique({
    where: { idempotencyKey: expected.idempotencyKey },
  });
  if (
    !actual ||
    actual.type !== expected.type ||
    actual.version !== expected.version ||
    actual.workspaceId !== expected.workspaceId ||
    actual.repositoryId !== expected.repositoryId ||
    actual.aggregateId !== expected.aggregateId ||
    canonicalJson(actual.payload) !== canonicalJson(expected.payload) ||
    actual.occurredAt.getTime() !== expected.occurredAt.getTime()
  ) {
    throw new Error("review_run_authorized_outbox_missing_or_conflicting");
  }
}

function authorizationCreateData(authorization: ReviewRunAuthorization) {
  return {
    ...authorization,
    trustDomain: trustDomainToPersistence(authorization.trustDomain),
    selectedProtocolVersion: protocolVersionToPersistence(
      authorization.selectedProtocolVersion,
    ),
    providerVoteLanes: authorization.providerVoteLanes.map((lane) => ({
      providerKind: providerKindToPersistence(lane.providerKind),
      providerVoteIdentityHash: lane.providerVoteIdentityHash,
    })),
    tokenAudience: tokenAudienceToPersistence(authorization.tokenAudience),
    state: authorizationStateToPersistence(authorization.state),
  };
}

function authorizationFromRenewalReceipt(
  current: ReviewRunAuthorization,
  receipt: {
    readonly authorizationVersion: number;
    readonly renewedExpiresAt: Date;
    readonly renewedAt: Date | null;
  },
): ReviewRunAuthorization {
  return {
    ...current,
    version: receipt.authorizationVersion,
    state: ReviewRunAuthorizationState.Active,
    providerVoteLanes: current.providerVoteLanes.map((lane) => ({ ...lane })),
    expiresAt: new Date(receipt.renewedExpiresAt),
    maxExpiresAt: new Date(current.maxExpiresAt),
    createdAt: new Date(current.createdAt),
    renewedAt: receipt.renewedAt ? new Date(receipt.renewedAt) : null,
  };
}

function trustDomainToPersistence(
  value: ReviewTrustDomain,
): "trusted_managed" | "trusted_local" | "untrusted_contribution" {
  switch (value) {
    case ReviewTrustDomain.TrustedManaged:
      return "trusted_managed";
    case ReviewTrustDomain.TrustedLocal:
      return "trusted_local";
    case ReviewTrustDomain.UntrustedContribution:
      return "untrusted_contribution";
  }
}

function protocolVersionToPersistence(
  value: ReviewProtocolVersion,
): "review_action_v2" {
  switch (value) {
    case ReviewProtocolVersion.V2:
      return "review_action_v2";
  }
}

function providerKindToPersistence(
  value: ReviewProviderKind,
): "codex" | "claude_code" | "openrouter" {
  switch (value) {
    case ReviewProviderKind.Codex:
      return "codex";
    case ReviewProviderKind.ClaudeCode:
      return "claude_code";
    case ReviewProviderKind.OpenRouter:
      return "openrouter";
  }
}

function tokenAudienceToPersistence(
  value: ReviewRunAuthorizationTokenAudience,
): "review_run" {
  switch (value) {
    case ReviewRunAuthorizationTokenAudience.ReviewRun:
      return "review_run";
  }
}

function authorizationStateToPersistence(
  value: ReviewRunAuthorizationState,
): "active" | "expired" | "revoked" {
  switch (value) {
    case ReviewRunAuthorizationState.Active:
      return "active";
    case ReviewRunAuthorizationState.Expired:
      return "expired";
    case ReviewRunAuthorizationState.Revoked:
      return "revoked";
  }
}

function assertBatchSize(batchSize: number): void {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
    throw new Error("review_authorization_batch_size_invalid");
  }
}
