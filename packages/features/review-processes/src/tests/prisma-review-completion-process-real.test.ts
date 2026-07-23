import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPrismaClient,
  type PrismaClient,
} from "@reviewrouter/platform-db";
import { RecoverMissingReviewCompletionProcesses } from "../application/use-cases/recover-missing-review-completion-processes";
import type { CreateReviewCompletionProcessInput } from "../domain/review-completion-process";
import { ReviewCompletionWakeupKind } from "../domain/review-completion-process";
import { PrismaReviewCompletionProcessRepository } from "../infrastructure/prisma/prisma-review-completion-process-repository";
import { PrismaReviewCompletionRecoveryFeed } from "../infrastructure/prisma/prisma-review-completion-recovery-feed";
import { reviewCompletionProcessRepositoryContract } from "./support/review-completion-process-repository-contract";

const databaseUrl = process.env.REVIEW_ROUTER_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase("review completion process Prisma adapters", () => {
  const prefix = `review-process-test-${randomUUID()}`;
  const workspaceId = `${prefix}-workspace`;
  const repositoryConnectionId = `${prefix}-repository`;
  const scmRepositoryIdentityId = `${prefix}-scm`;
  const protocolLimitsProfileId = `${prefix}-limits`;
  const operationalSloProfileId = `${prefix}-slo`;
  const producerReleaseId = `${prefix}-producer`;
  const authorizationId = `${prefix}-authorization`;
  const seededExecutionIds = new Set<string>();
  const seededPublicationAttemptIds = new Set<string>();
  let generation = 0n;
  let prisma: PrismaClient;
  let processes: PrismaReviewCompletionProcessRepository;

  beforeAll(async () => {
    assertDisposableDatabaseUrl(databaseUrl!);
    prisma = createPrismaClient({ databaseUrl: databaseUrl!, poolMax: 10 });
    processes = new PrismaReviewCompletionProcessRepository(prisma);
    await seedScope();
  });

  afterAll(async () => {
    if (!prisma) return;
    await resetSeededExecutions();
    await prisma.reviewRunAuthorization.deleteMany({
      where: { authorizationId },
    });
    await prisma.producerRelease.deleteMany({ where: { producerReleaseId } });
    await prisma.repositoryConnection.deleteMany({
      where: { id: repositoryConnectionId },
    });
    await prisma.scmRepositoryIdentity.deleteMany({
      where: { scmRepositoryIdentityId },
    });
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.reviewOperationalSloProfileV2.deleteMany({
      where: { operationalSloProfileId },
    });
    await prisma.reviewProtocolLimitsV2.deleteMany({
      where: { protocolLimitsProfileId },
    });
    await prisma.$disconnect();
  });

  reviewCompletionProcessRepositoryContract("Prisma", async () => {
    await resetSeededExecutions();
    return {
      repository: processes,
      prepare: seedFinalizedExecution,
      preparePublicationAttempt: seedPublicationAttempt,
    };
  });

  it("restarts a bounded recovery pass and finds a late artifact behind the prior cursor", async () => {
    await resetSeededExecutions();
    const feed = new PrismaReviewCompletionRecoveryFeed(prisma);
    const recovery = new RecoverMissingReviewCompletionProcesses(
      feed,
      processes,
      1,
    );
    const createdAt = new Date("2026-07-22T12:00:00.000Z");
    const first = recoveryInput(`${prefix}-recovery-a`, createdAt);
    const third = recoveryInput(
      `${prefix}-recovery-c`,
      new Date(createdAt.getTime() + 2_000),
    );
    await seedFinalizedExecution(first);
    await seedFinalizedExecution(third);

    await expect(recovery.scanNextPage()).resolves.toMatchObject({
      visited: 1,
      completedPass: false,
    });

    const late = recoveryInput(
      `${prefix}-recovery-late`,
      new Date(createdAt.getTime() - 1_000),
    );
    await seedFinalizedExecution(late);
    await expect(recovery.scanNextPage()).resolves.toMatchObject({
      visited: 1,
      completedPass: false,
    });
    await expect(recovery.scanNextPage()).resolves.toMatchObject({
      visited: 0,
      completedPass: true,
      nextCursor: null,
    });
    await expect(recovery.scanNextPage()).resolves.toMatchObject({
      visited: 1,
      completedPass: false,
    });
    await expect(
      processes.findByExecutionId(late.executionId),
    ).resolves.toMatchObject({
      executionId: late.executionId,
      finalizedArtifactId: late.finalizedArtifactId,
      lastWakeupKind: ReviewCompletionWakeupKind.RecoveryScan,
    });
  });

  async function seedScope(): Promise<void> {
    const now = new Date("2026-07-22T10:00:00.000Z");
    await prisma.reviewProtocolLimitsV2.create({
      data: {
        protocolLimitsProfileId,
        limitsDigest: `${prefix}-limits-digest`,
        maxWorkSlots: 10,
        maxAttemptsPerSlot: 10,
        maxObservationBytes: 1_000_000,
        maxObservationFindings: 1_000,
        maxProjectionBytes: 1_000_000,
        maxProjectionFindings: 1_000,
        maxPublicationOperations: 100,
        maxPublicationChunks: 100,
        maxPublicationBodyBytes: 1_000_000,
        maxRequestBatchSize: 100,
        maxLeaseDurationMs: 60_000,
        maxResultReportDurationMs: 60_000,
        maxReconciliationDurationMs: 3_600_000,
        registeredAt: now,
      },
    });
    await prisma.reviewOperationalSloProfileV2.create({
      data: {
        operationalSloProfileId,
        sloDigest: `${prefix}-slo-digest`,
        integrationEventDeliveryMs: 1_000,
        outboxClaimAgeMs: 1_000,
        missingCompletionProcessMs: 1_000,
        dueCompletionProcessMs: 1_000,
        publicationReconciliationMs: 1_000,
        v1DrainMs: 1_000,
        admissionMs: 1_000,
        pruningBacklogAgeMs: 1_000,
        ownerRefs: ["test-owner"],
        runbookRefs: ["test-runbook"],
        registeredAt: now,
      },
    });
    await prisma.producerRelease.create({
      data: {
        producerReleaseId,
        distributionKind: "hosted_composite",
        actionCommitSha: "a".repeat(40),
        runtimeCommitSha: "b".repeat(40),
        wrapperEntrypointDigest: `${prefix}-wrapper`,
        runtimeEntrypointDigest: `${prefix}-runtime`,
        schemaDigest: `${prefix}-schema`,
        capabilityProfile: "test-capability-profile",
        protocolLimitsProfileId,
        operationalSloProfileId,
        registeredAt: now,
      },
    });
    await prisma.workspace.create({
      data: {
        id: workspaceId,
        slug: `${prefix}-slug`,
        name: "Review process disposable test",
      },
    });
    await prisma.scmRepositoryIdentity.create({
      data: {
        scmRepositoryIdentityId,
        provider: "github",
        normalizedSourceBaseUrl: "https://github.com",
        externalRepositoryId: `${prefix}-external`,
        createdAt: now,
      },
    });
    await prisma.repositoryConnection.create({
      data: {
        id: repositoryConnectionId,
        workspaceId,
        provider: "github",
        sourceBaseUrl: "https://github.com",
        externalRepositoryId: `${prefix}-external`,
        scmRepositoryIdentityId,
        owner: "reviewrouter-test",
        name: prefix,
        fullName: `reviewrouter-test/${prefix}`,
        defaultBranch: "main",
        visibility: "private",
      },
    });
    await prisma.reviewRunAuthorization.create({
      data: {
        authorizationId,
        workspaceId,
        repositoryConnectionId,
        scmRepositoryIdentityId,
        pullRequestNumber: 1,
        sourceRunId: `${prefix}-run`,
        sourceRunAttempt: "1",
        workflowIdentityHash: "f".repeat(64),
        baseSha: "c".repeat(40),
        mergeBaseSha: "d".repeat(40),
        headSha: "e".repeat(40),
        reviewRevisionHash: `${prefix}-revision`,
        trustDomain: "trusted_managed",
        producerReleaseId,
        selectedProtocolVersion: "2.0",
        schemaDigest: `${prefix}-schema`,
        protocolLimitsProfileId,
        operationalSloProfileId,
        mutationEpoch: 1n,
        providerVoteLanes: [],
        authorizationSafetyDecisionHash: `${prefix}-safety`,
        protocolOfferHash: `${prefix}-offer`,
        oidcReplayKeyHash: `${prefix}-oidc`,
        tokenSigningKeyId: `${prefix}-key`,
        tokenIssuer: "reviewrouter-test",
        tokenAudience: "reviewrouter-test-action",
        expiresAt: new Date(now.getTime() + 3_600_000),
        maxExpiresAt: new Date(now.getTime() + 3_600_000),
        createdAt: now,
      },
    });
  }

  async function seedFinalizedExecution(
    input: CreateReviewCompletionProcessInput,
  ): Promise<void> {
    generation += 1n;
    const generationForExecution = generation;
    seededExecutionIds.add(input.executionId);
    await prisma.reviewExecutionV2.create({
      data: {
        executionId: input.executionId,
        workspaceId,
        repositoryConnectionId,
        scmRepositoryIdentityId,
        pullRequestNumber: Number(generationForExecution),
        generation: generationForExecution,
        baseSha: "1".repeat(40),
        mergeBaseSha: "2".repeat(40),
        headSha: "3".repeat(40),
        reviewRevisionHash: `${input.executionId}-revision`,
        compatibilityKey: `${input.executionId}-compatibility`,
        planHash: `${input.executionId}-plan`,
        startIdentityHash: `${input.executionId}-start`,
        canonicalStartHash: `${input.executionId}-canonical`,
        state: "completed",
        authorizationId,
        producerReleaseId,
        mutationEpoch: 1n,
        admissionSafetyDecisionHash: `${input.executionId}-admission`,
        protocolLimitsProfileId,
        sourceRunId: `${input.executionId}-run`,
        sourceRunAttempt: "1",
        finalizedArtifactId: input.finalizedArtifactId,
        createdAt: input.wakeupAt,
        updatedAt: input.wakeupAt,
        admissionDeadlineAt: new Date(input.wakeupAt.getTime() + 60_000),
        admissionCheckedAt: input.wakeupAt,
        executionDeadlineAt: new Date(input.wakeupAt.getTime() + 120_000),
        retainUntil: input.retainUntil,
      },
    });
    await prisma.finalizedReviewProjectionArtifactV2.create({
      data: {
        artifactId: input.finalizedArtifactId,
        artifactHash: `${input.finalizedArtifactId}-hash`,
        executionId: input.executionId,
        generation: generationForExecution,
        reviewedHeadSha: "3".repeat(40),
        reviewRevisionHash: `${input.executionId}-revision`,
        coverageState: "completed",
        projectionEnvelopeVersion: 1,
        projectionEnvelope: { findings: [] },
        projectionEnvelopeCanonicalJson: '{"findings":[]}',
        projectionHash: `${input.executionId}-projection`,
        byteCount: 2,
        findingCount: 0,
        lifecycleStateHash: `${input.executionId}-lifecycle`,
        commandLedgerWatermark: 0n,
        projectionPolicyVersion: "test-v1",
        authorizationId,
        producerReleaseId,
        permitEpoch: 1n,
        publicationSafetyDecisionHash: `${input.executionId}-publication`,
        publicationNotAfter: new Date(input.wakeupAt.getTime() + 3_600_000),
        createdAt: input.wakeupAt,
        retainUntil: input.retainUntil,
      },
    });
  }

  async function seedPublicationAttempt(
    input: CreateReviewCompletionProcessInput,
    publicationAttemptId: string,
  ): Promise<void> {
    const execution = await prisma.reviewExecutionV2.findUniqueOrThrow({
      where: { executionId: input.executionId },
    });
    const artifact =
      await prisma.finalizedReviewProjectionArtifactV2.findUniqueOrThrow({
        where: { artifactId: input.finalizedArtifactId },
      });
    seededPublicationAttemptIds.add(publicationAttemptId);
    await prisma.reviewPublicationAttemptV2.create({
      data: {
        publicationAttemptId,
        requestHash: `${publicationAttemptId}-request`,
        requestFingerprint: `${publicationAttemptId}-fingerprint`,
        workspaceId,
        repositoryConnectionId,
        scmRepositoryIdentityId,
        pullRequestNumber: execution.pullRequestNumber,
        executionId: input.executionId,
        generation: execution.generation,
        reviewedHeadSha: artifact.reviewedHeadSha,
        reviewRevisionHash: artifact.reviewRevisionHash,
        authorizationId,
        producerReleaseId,
        projectionHash: artifact.projectionHash,
        permitEpoch: artifact.permitEpoch,
        publicationSafetyDecisionHash: artifact.publicationSafetyDecisionHash,
        publicationNotAfter: artifact.publicationNotAfter,
        lifecycleStateHash: artifact.lifecycleStateHash,
        commandLedgerWatermark: artifact.commandLedgerWatermark,
        version: 1n,
        state: "pending",
        createdAt: input.wakeupAt,
        retainUntil: input.retainUntil,
      },
    });
  }

  async function resetSeededExecutions(): Promise<void> {
    const executionIds = [...seededExecutionIds];
    if (executionIds.length === 0) return;
    await prisma.reviewCompletionProcess.deleteMany({
      where: { executionId: { in: executionIds } },
    });
    await prisma.reviewPublicationAttemptV2.deleteMany({
      where: {
        publicationAttemptId: { in: [...seededPublicationAttemptIds] },
      },
    });
    await prisma.finalizedReviewProjectionArtifactV2.deleteMany({
      where: { executionId: { in: executionIds } },
    });
    await prisma.reviewExecutionV2.deleteMany({
      where: { executionId: { in: executionIds } },
    });
    seededExecutionIds.clear();
    seededPublicationAttemptIds.clear();
  }
});

function recoveryInput(
  executionId: string,
  createdAt: Date,
): CreateReviewCompletionProcessInput {
  return {
    executionId,
    finalizedArtifactId: `artifact-${executionId}`,
    wakeupKind: ReviewCompletionWakeupKind.ExecutionFinalized,
    wakeupAt: createdAt,
    retainUntil: new Date(createdAt.getTime() + 30 * 24 * 60 * 60 * 1_000),
  };
}

function assertDisposableDatabaseUrl(value: string): void {
  const databaseName = decodeURIComponent(new URL(value).pathname.slice(1));
  if (!databaseName || !databaseName.toLowerCase().includes("test")) {
    throw new Error("review_completion_real_test_requires_disposable_test_db");
  }
}
