import { createHash } from "node:crypto";
import {
  ReviewProviderKindV2,
  ReviewTaskKindV2,
  type PrismaClient,
} from "@prisma/client";
import { createPrismaClient } from "@reviewrouter/platform-db";
import type { ReviewInvestigation } from "../domain/review-investigation";
import { PrismaInvestigationStore } from "../infrastructure/prisma/prisma-investigation-store";
import type { InvestigationStoreContractHarness } from "./investigation-store-contract";

const databaseUrl = process.env.REVIEW_ROUTER_TEST_DATABASE_URL;

// Persisted fixture values intentionally use the database contract. Cross-context
// behavior and production authority composition belong in the integration suite.
type PrismaInvestigationStoreHarness = InvestigationStoreContractHarness &
  Readonly<{ prisma: PrismaClient }>;

export async function createPrismaInvestigationStoreHarness(
  seed: ReviewInvestigation,
  operationalRetentionMs = 86_400_000,
  poolMax = 6,
): Promise<PrismaInvestigationStoreHarness> {
  const prisma = createPrismaClient({ databaseUrl: databaseUrl!, poolMax });
  await seedExecution(prisma, seed);
  const store = new PrismaInvestigationStore(prisma, {
    operationalRetentionMs,
  });
  return {
    prisma,
    store,
    async restart() {
      return new PrismaInvestigationStore(prisma, { operationalRetentionMs });
    },
    async dispose() {
      await cleanup(prisma, seed);
      await prisma.$disconnect();
    },
  };
}

export async function seedExecution(
  prisma: PrismaClient,
  seed: ReviewInvestigation,
): Promise<void> {
  const now = new Date(seed.createdAt);
  const limitsProfileId = "investigation-test-limits-v1";
  const sloProfileId = "investigation-test-slo-v1";
  const producerReleaseId = `producer-${seed.investigationId}`;
  const authorizationId = `authorization-${seed.investigationId}`;
  const producerDigest = createHash("sha256")
    .update(seed.investigationId)
    .digest("hex");
  await prisma.reviewProtocolLimitsV2.upsert({
    where: { protocolLimitsProfileId: limitsProfileId },
    update: {},
    create: {
      protocolLimitsProfileId: limitsProfileId,
      limitsDigest: "a".repeat(64),
      maxWorkSlots: 16,
      maxAttemptsPerSlot: 4,
      maxObservationBytes: 1_000_000,
      maxObservationFindings: 1_000,
      maxProjectionBytes: 1_000_000,
      maxProjectionFindings: 1_000,
      maxPublicationOperations: 100,
      maxPublicationChunks: 100,
      maxPublicationBodyBytes: 1_000_000,
      maxRequestBatchSize: 100,
      maxLeaseDurationMs: 120_000,
      maxResultReportDurationMs: 180_000,
      maxReconciliationDurationMs: 3_600_000,
      registeredAt: now,
    },
  });
  await prisma.reviewOperationalSloProfileV2.upsert({
    where: { operationalSloProfileId: sloProfileId },
    update: {},
    create: {
      operationalSloProfileId: sloProfileId,
      sloDigest: "b".repeat(64),
      integrationEventDeliveryMs: 1_000,
      outboxClaimAgeMs: 1_000,
      missingCompletionProcessMs: 1_000,
      dueCompletionProcessMs: 1_000,
      publicationReconciliationMs: 1_000,
      v1DrainMs: 1_000,
      admissionMs: 1_000,
      pruningBacklogAgeMs: 1_000,
      registeredAt: now,
    },
  });
  await prisma.workspace.create({
    data: {
      id: seed.scope.workspaceId,
      slug: seed.scope.workspaceId,
      name: seed.scope.workspaceId,
    },
  });
  await prisma.scmRepositoryIdentity.create({
    data: {
      scmRepositoryIdentityId: seed.scope.scmRepositoryIdentityId,
      provider: "github",
      normalizedSourceBaseUrl: "https://github.com",
      externalRepositoryId: `external-${seed.investigationId}`,
      createdAt: now,
    },
  });
  await prisma.repositoryConnection.create({
    data: {
      id: seed.scope.repositoryConnectionId,
      workspaceId: seed.scope.workspaceId,
      provider: "github",
      sourceBaseUrl: "https://github.com",
      externalRepositoryId: `external-${seed.investigationId}`,
      scmRepositoryIdentityId: seed.scope.scmRepositoryIdentityId,
      owner: "reviewrouter-test",
      name: seed.investigationId,
      fullName: `reviewrouter-test/${seed.investigationId}`,
      defaultBranch: "main",
      visibility: "private",
    },
  });
  await prisma.scmRepositoryIdentity.update({
    where: { scmRepositoryIdentityId: seed.scope.scmRepositoryIdentityId },
    data: {
      currentWorkspaceId: seed.scope.workspaceId,
      currentRepositoryConnectionId: seed.scope.repositoryConnectionId,
      boundAt: now,
    },
  });
  await prisma.producerRelease.create({
    data: {
      producerReleaseId,
      distributionKind: "hosted_composite",
      actionCommitSha: producerDigest.slice(0, 40),
      runtimeCommitSha: producerDigest.slice(24, 64),
      wrapperEntrypointDigest: producerDigest,
      runtimeEntrypointDigest: createHash("sha256")
        .update(producerDigest)
        .digest("hex"),
      schemaDigest: createHash("sha256")
        .update(`schema-${producerDigest}`)
        .digest("hex"),
      capabilityProfile: "context_gateway_v2",
      protocolLimitsProfileId: limitsProfileId,
      operationalSloProfileId: sloProfileId,
      state: "registered",
      registeredAt: now,
    },
  });
  await prisma.reviewRunAuthorization.create({
    data: {
      authorizationId,
      workspaceId: seed.scope.workspaceId,
      repositoryConnectionId: seed.scope.repositoryConnectionId,
      scmRepositoryIdentityId: seed.scope.scmRepositoryIdentityId,
      pullRequestNumber: seed.scope.pullRequestNumber,
      sourceRunId: `run-${seed.investigationId}`,
      sourceRunAttempt: "1",
      workflowIdentityHash: "f".repeat(64),
      baseSha: seed.revision.baseSha,
      mergeBaseSha: seed.revision.mergeBaseSha,
      headSha: seed.revision.headSha,
      reviewRevisionHash: seed.revision.reviewRevisionHash,
      trustDomain: "trusted_local",
      producerReleaseId,
      selectedProtocolVersion: "review_action_v2",
      schemaDigest: createHash("sha256")
        .update(`schema-${producerDigest}`)
        .digest("hex"),
      protocolLimitsProfileId: limitsProfileId,
      operationalSloProfileId: sloProfileId,
      mutationEpoch: 1n,
      providerVoteLanes: [
        {
          providerKind: "codex",
          providerVoteIdentityHash: seed.providerVoteLaneId,
        },
      ],
      authorizationSafetyDecisionHash: "1".repeat(64),
      protocolOfferHash: "2".repeat(64),
      oidcReplayKeyHash: createHash("sha256")
        .update(`oidc-${seed.investigationId}`)
        .digest("hex"),
      tokenSigningKeyId: "test-key",
      tokenIssuer: "reviewrouter-review-run-control",
      tokenAudience: "review_run",
      state: "active",
      expiresAt: new Date(Date.now() + 3_600_000),
      maxExpiresAt: new Date(Date.now() + 7_200_000),
      createdAt: now,
    },
  });
  await prisma.reviewExecutionV2.create({
    data: {
      executionId: seed.executionId,
      workspaceId: seed.scope.workspaceId,
      repositoryConnectionId: seed.scope.repositoryConnectionId,
      scmRepositoryIdentityId: seed.scope.scmRepositoryIdentityId,
      pullRequestNumber: seed.scope.pullRequestNumber,
      generation: 1n,
      version: 1n,
      baseSha: seed.revision.baseSha,
      mergeBaseSha: seed.revision.mergeBaseSha,
      headSha: seed.revision.headSha,
      reviewRevisionHash: seed.revision.reviewRevisionHash,
      compatibilityKey: `compatibility-${seed.investigationId}`,
      planHash: "1".repeat(64),
      startIdentityHash: "2".repeat(64),
      canonicalStartHash: "3".repeat(64),
      state: "running",
      authorizationId,
      producerReleaseId,
      mutationEpoch: 1n,
      admissionSafetyDecisionHash: "4".repeat(64),
      protocolLimitsProfileId: limitsProfileId,
      sourceRunId: `run-${seed.investigationId}`,
      sourceRunAttempt: "1",
      createdAt: now,
      updatedAt: now,
      admissionDeadlineAt: new Date(now.getTime() + 60_000),
      executionDeadlineAt: new Date(now.getTime() + 120_000),
      retainUntil: new Date(now.getTime() + 86_400_000),
    },
  });
  await prisma.reviewExecutionWorkSlotV2.create({
    data: {
      executionId: seed.executionId,
      workSlotId: seed.workSlotId,
      planOrdinal: 1,
      taskKind: ReviewTaskKindV2.finding_discovery,
      providerKind: ReviewProviderKindV2.codex,
      providerVoteIdentityHash: seed.providerVoteLaneId,
      shardKey: seed.stableReviewUnitKey,
      required: true,
      attemptBudget: 3,
      retryPolicyVersion: "retry-v1",
    },
  });
  await prisma.reviewExecutionStreamV2.create({
    data: {
      workspaceId: seed.scope.workspaceId,
      repositoryConnectionId: seed.scope.repositoryConnectionId,
      scmRepositoryIdentityId: seed.scope.scmRepositoryIdentityId,
      pullRequestNumber: seed.scope.pullRequestNumber,
      version: 1n,
      activeExecutionId: seed.executionId,
      preparedExecutionId: null,
      lastAllocatedGeneration: 1n,
      currentBaseSha: seed.revision.baseSha,
      currentMergeBaseSha: seed.revision.mergeBaseSha,
      currentHeadSha: seed.revision.headSha,
      currentReviewRevisionHash: seed.revision.reviewRevisionHash,
      updatedAt: now,
    },
  });
}

export async function cleanup(
  prisma: PrismaClient,
  seed: ReviewInvestigation,
): Promise<void> {
  await prisma.reviewInvestigation.updateMany({
    where: { investigationId: seed.investigationId },
    data: {
      activeTurnId: null,
      certificateId: null,
      replayEvidenceCheckpointId: null,
    },
  });
  await prisma.reviewInvestigationCommandReceipt.deleteMany({
    where: { investigationId: seed.investigationId },
  });
  await prisma.reviewInvestigationPrivateMaterial.deleteMany({
    where: { investigationId: seed.investigationId },
  });
  await prisma.reviewInvestigationObligation.updateMany({
    where: { investigationId: seed.investigationId },
    data: { receiptId: null, state: "open", unresolvableReason: null },
  });
  await prisma.reviewInvestigationReceipt.deleteMany({
    where: { investigationId: seed.investigationId },
  });
  await prisma.reviewInvestigationLease.deleteMany({
    where: { investigationId: seed.investigationId },
  });
  await prisma.reviewInvestigationTurn.deleteMany({
    where: { investigationId: seed.investigationId },
  });
  await prisma.reviewInvestigationCertificate.deleteMany({
    where: { investigationId: seed.investigationId },
  });
  await prisma.reviewInvestigationReplayEvidenceCheckpoint.deleteMany({
    where: { sourceInvestigationId: seed.investigationId },
  });
  await prisma.reviewInvestigationObligation.deleteMany({
    where: { investigationId: seed.investigationId },
  });
  await prisma.reviewInvestigation.deleteMany({
    where: { investigationId: seed.investigationId },
  });
  await prisma.reviewExecutionWorkSlotV2.deleteMany({
    where: { executionId: seed.executionId },
  });
  await prisma.reviewExecutionStreamV2.deleteMany({
    where: {
      workspaceId: seed.scope.workspaceId,
      repositoryConnectionId: seed.scope.repositoryConnectionId,
      scmRepositoryIdentityId: seed.scope.scmRepositoryIdentityId,
      pullRequestNumber: seed.scope.pullRequestNumber,
    },
  });
  await prisma.reviewExecutionV2.deleteMany({
    where: { executionId: seed.executionId },
  });
  await prisma.reviewRunAuthorization.deleteMany({
    where: { authorizationId: `authorization-${seed.investigationId}` },
  });
  await prisma.producerRelease.deleteMany({
    where: { producerReleaseId: `producer-${seed.investigationId}` },
  });
  await prisma.scmRepositoryIdentity.updateMany({
    where: { scmRepositoryIdentityId: seed.scope.scmRepositoryIdentityId },
    data: {
      currentWorkspaceId: null,
      currentRepositoryConnectionId: null,
      unboundAt: new Date(),
    },
  });
  await prisma.repositoryConnection.deleteMany({
    where: { id: seed.scope.repositoryConnectionId },
  });
  await prisma.scmRepositoryIdentity.deleteMany({
    where: { scmRepositoryIdentityId: seed.scope.scmRepositoryIdentityId },
  });
  await prisma.workspace.deleteMany({ where: { id: seed.scope.workspaceId } });
}
