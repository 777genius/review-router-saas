import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPrismaClient,
  type PrismaClient,
} from "@reviewrouter/platform-db";
import {
  AdjudicateReviewPublicationOutcomeStatus,
  BeginReviewPublicationOperationStatus,
  ClaimReviewPublicationStatus,
  CompleteReviewPublicationOperationStatus,
  RecordReviewExternalEffectStatus,
  RequestReviewPublicationStatus,
  ReviewPublicationCorrectionReason,
  ReviewPublicationEffectStrategy,
  ReviewPublicationExternalEffectKind,
  ReviewPublicationKind,
  ReviewPublicationOperationRole,
  ReviewPublicationTerminalOutcome,
  TerminalizeUnknownReviewPublicationStatus,
  type ReviewPublicationOperationPlan,
  type ReviewPublicationOperationCapabilityFacts,
  type ReviewPublicationPermitIdentity,
} from "../index";
import { PrismaReviewPublicationRepository } from "../infrastructure/prisma/prisma-review-publication-repository";

const databaseUrl = process.env.REVIEW_ROUTER_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase("PrismaReviewPublicationRepository real database", () => {
  let prisma: PrismaClient;
  let repository: PrismaReviewPublicationRepository;
  let fixture: Awaited<ReturnType<typeof seedFixture>>;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: databaseUrl!, poolMax: 8 });
    fixture = await seedFixture(prisma);
    repository = new PrismaReviewPublicationRepository(prisma);
  });

  afterAll(async () => {
    if (prisma && fixture) await cleanupFixture(prisma, fixture);
    await prisma?.$disconnect();
  });

  it("persists request aliases and restores only the exact immutable envelope", async () => {
    const command = requestCommand(fixture, "request-alias");
    await expect(repository.request(command)).resolves.toMatchObject({
      status: RequestReviewPublicationStatus.Applied,
      attempt: { version: 1n },
    });
    const aliasRequestIdHash = digest("alias-two");
    await expect(
      repository.request({ ...command, requestIdHash: aliasRequestIdHash }),
    ).resolves.toMatchObject({
      status: RequestReviewPublicationStatus.Restored,
    });
    expect(
      await prisma.reviewPublicationRequestReceiptV2.count({
        where: { publicationAttemptId: command.publicationAttemptId },
      }),
    ).toBe(2);
    await expect(
      repository.request({
        ...command,
        requestIdHash: aliasRequestIdHash,
        requestHash: digest("alias-drift"),
      }),
    ).resolves.toEqual({
      status: RequestReviewPublicationStatus.RequestConflict,
    });
    await expect(
      repository.request({ ...command, requestHash: digest("request-drift") }),
    ).resolves.toEqual({
      status: RequestReviewPublicationStatus.RequestConflict,
    });
  });

  it("persists rerun attempts that share a projection with attempt-scoped operation identities", async () => {
    const first = requestCommand(fixture, `same-projection-a-${randomUUID()}`);
    const secondBase = requestCommand(
      fixture,
      `same-projection-b-${randomUUID()}`,
    );
    const second = {
      ...secondBase,
      permit: {
        ...secondBase.permit,
        executionId: fixture.rerunExecutionId,
        generation: 2n,
        projectionHash: first.permit.projectionHash,
      },
      operations: secondBase.operations.map((operation) => ({
        ...operation,
        publicationOperationId: `${secondBase.publicationAttemptId}:${operation.publicationKind}:${operation.chunkIndex}`,
      })),
    };

    await expect(repository.request(first)).resolves.toMatchObject({
      status: RequestReviewPublicationStatus.Applied,
    });
    await expect(repository.request(second)).resolves.toMatchObject({
      status: RequestReviewPublicationStatus.Applied,
    });
  });

  it("serializes competing claims, enforces the active-owner index, and fences takeover", async () => {
    const command = requestCommand(fixture, "claim-race");
    await repository.request(command);
    const expiresAt = new Date(Date.now() + 60_000);
    const base = claimCommand(command.publicationAttemptId, {
      expiresAt,
      reportUntil: new Date(Date.now() + 60_000),
    });
    const [left, right] = await Promise.all([
      repository.claim(base),
      repository.claim({
        ...base,
        claimId: `${base.claimId}-competitor`,
        acquireRequestIdHash: digest("claim-race-competitor-request"),
        requestHash: digest("claim-race-competitor-hash"),
        claimCapabilityId: `${base.claimCapabilityId}-competitor`,
      }),
    ]);
    expect([left.status, right.status].sort()).toEqual(
      [
        ClaimReviewPublicationStatus.Acquired,
        ClaimReviewPublicationStatus.VersionConflict,
      ].sort(),
    );
    const acquired =
      left.status === ClaimReviewPublicationStatus.Acquired ? left : right;
    if (acquired.status !== ClaimReviewPublicationStatus.Acquired) {
      throw new Error("publication_claim_not_acquired");
    }
    expect(
      await prisma.reviewPublicationClaimTermV2.count({
        where: {
          publicationAttemptId: command.publicationAttemptId,
          state: "active",
        },
      }),
    ).toBe(1);
    await expect(
      prisma.reviewPublicationClaimTermV2.create({
        data: {
          claimId: `${base.claimId}-illegal-active-owner`,
          publicationAttemptId: command.publicationAttemptId,
          ownerIdHash: digest("illegal-owner"),
          acquireRequestIdHash: digest("illegal-request-id"),
          acquireRequestHash: digest("illegal-request"),
          commandFingerprint: "illegal-active-owner",
          claimCapabilityId: `${base.claimCapabilityId}-illegal`,
          capabilitySigningKeyId: "test-signing-key",
          state: "active",
          acquiredAt: new Date(),
          renewedAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
          reportUntil: new Date(Date.now() + 120_000),
          retainUntil: new Date(Date.now() + 180_000),
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });

    await prisma.reviewPublicationClaimTermV2.update({
      where: { claimId: acquired.claim.claimId },
      data: {
        acquiredAt: new Date(Date.now() - 60_000),
        renewedAt: new Date(Date.now() - 60_000),
        expiresAt: new Date(Date.now() - 1_000),
      },
    });
    const current = await repository.findById(command.publicationAttemptId);
    if (!current) throw new Error("publication_attempt_missing");
    const takeover = await repository.claim(
      claimCommand(command.publicationAttemptId, {
        expectedAttemptVersion: current.attempt.version,
        claimId: "claim-takeover",
        acquireRequestIdHash: digest("claim-takeover-request-id"),
        requestHash: digest("claim-takeover-request"),
        claimCapabilityId: "claim-takeover-capability",
      }),
    );
    expect(takeover.status).toBe(ClaimReviewPublicationStatus.Acquired);
    if (takeover.status !== ClaimReviewPublicationStatus.Acquired) return;
    expect(takeover.claim.fencingToken > acquired.claim.fencingToken).toBe(
      true,
    );
    await expect(
      repository.begin(
        beginCommand(
          command.publicationAttemptId,
          command.operations[0]!.publicationOperationId,
          {
            expectedAttemptVersion: takeover.attempt.version,
            claimId: acquired.claim.claimId,
            claimFencingToken: acquired.claim.fencingToken,
          },
        ),
      ),
    ).resolves.toEqual({
      status: BeginReviewPublicationOperationStatus.StaleClaim,
    });
  });

  it("keeps operation, effect, and canonical receipt idempotency across terminal completion", async () => {
    const command = requestCommand(fixture, "completion");
    await repository.request(command);
    const claim = await repository.claim(
      claimCommand(command.publicationAttemptId),
    );
    if (claim.status !== ClaimReviewPublicationStatus.Acquired) {
      throw new Error("publication_claim_not_acquired");
    }
    const begin = await repository.begin(
      beginCommand(
        command.publicationAttemptId,
        command.operations[0]!.publicationOperationId,
        {
          expectedAttemptVersion: claim.attempt.version,
          claimId: claim.claim.claimId,
          claimFencingToken: claim.claim.fencingToken,
        },
      ),
    );
    if (begin.status !== BeginReviewPublicationOperationStatus.Begun) {
      throw new Error("publication_operation_not_begun");
    }
    const effect = effectCommand(begin.capability);
    await expect(repository.record(effect)).resolves.toMatchObject({
      status: RecordReviewExternalEffectStatus.Recorded,
    });
    await expect(repository.record(effect)).resolves.toMatchObject({
      status: RecordReviewExternalEffectStatus.Restored,
    });
    await expect(
      repository.record({
        ...effect,
        reportRequestHash: digest("effect-drift"),
      }),
    ).resolves.toEqual({
      status: RecordReviewExternalEffectStatus.RequestConflict,
    });

    const completion = completeCommand(
      command.publicationAttemptId,
      command.operations[0]!.publicationOperationId,
      {
        expectedAttemptVersion: begin.attempt.version,
        claimId: claim.claim.claimId,
        claimFencingToken: claim.claim.fencingToken,
        canonicalEffectId: effect.effectId,
      },
    );
    await expect(repository.complete(completion)).resolves.toMatchObject({
      status: CompleteReviewPublicationOperationStatus.Completed,
      attempt: {
        terminalOutcome: ReviewPublicationTerminalOutcome.Succeeded,
      },
    });
    await expect(repository.complete(completion)).resolves.toMatchObject({
      status: CompleteReviewPublicationOperationStatus.Restored,
    });
    await expect(
      repository.complete({
        ...completion,
        requestHash: digest("completion-drift"),
      }),
    ).resolves.toEqual({
      status: CompleteReviewPublicationOperationStatus.RequestConflict,
    });
    expect(
      await prisma.reviewPublicationExternalEffectV2.count({
        where: { publicationAttemptId: command.publicationAttemptId },
      }),
    ).toBe(1);
    expect(
      await prisma.reviewPublicationReceiptV2.count({
        where: { publicationAttemptId: command.publicationAttemptId },
      }),
    ).toBe(1);
    await expect(
      prisma.reviewExecutionV2.findUniqueOrThrow({
        where: { executionId: fixture.executionId },
        select: { version: true, state: true },
      }),
    ).resolves.toEqual({ version: 1n, state: "completed" });
    await expect(
      prisma.reviewRunAuthorization.findUniqueOrThrow({
        where: { authorizationId: fixture.authorizationId },
        select: { version: true, state: true },
      }),
    ).resolves.toEqual({ version: 1, state: "active" });
  });

  it("terminalizes unknown once and records an immutable adjudication", async () => {
    const command = requestCommand(fixture, "adjudication", {
      publicationNotAfter: new Date(Date.now() - 2_000),
      reconcileUntil: new Date(Date.now() - 1_000),
    });
    await repository.request(command);
    const claim = await repository.claim(
      claimCommand(command.publicationAttemptId),
    );
    if (claim.status !== ClaimReviewPublicationStatus.Acquired) {
      throw new Error("publication_claim_not_acquired");
    }
    const terminalCommand = {
      publicationAttemptId: command.publicationAttemptId,
      publicationOperationId: command.operations[0]!.publicationOperationId,
      expectedAttemptVersion: claim.attempt.version,
      claimId: claim.claim.claimId,
      claimFencingToken: claim.claim.fencingToken,
      tombstoneId: "tombstone-adjudication",
      finalReason: "provider_outcome_unprovable",
      lastErrorCode: "provider_timeout",
      terminalizedBy: "real-db-test",
      terminalizedAt: new Date(),
      retainUntil: new Date(Date.now() + 86_400_000),
    };
    const terminal = await repository.terminalizeUnknown(terminalCommand);
    expect(terminal.status).toBe(
      TerminalizeUnknownReviewPublicationStatus.Terminalized,
    );
    if (
      terminal.status !== TerminalizeUnknownReviewPublicationStatus.Terminalized
    ) {
      return;
    }
    await expect(
      repository.terminalizeUnknown(terminalCommand),
    ).resolves.toMatchObject({
      status: TerminalizeUnknownReviewPublicationStatus.Restored,
    });
    const correction = {
      publicationAttemptId: command.publicationAttemptId,
      expectedAttemptVersion: terminal.attempt.version,
      correctionId: "correction-adjudication",
      correctionOrdinal: 1,
      correctedOutcome: ReviewPublicationTerminalOutcome.StaleVisible,
      evidenceHash: digest("adjudication-evidence"),
      safeReason: ReviewPublicationCorrectionReason.StaleEffectVisible,
      correctedBy: "real-db-test",
      correctedAt: new Date(),
      retainUntil: new Date(Date.now() + 86_400_000),
      provenReceipts: [],
    } as const;
    await expect(repository.adjudicate(correction)).resolves.toMatchObject({
      status: AdjudicateReviewPublicationOutcomeStatus.Corrected,
    });
    await expect(repository.adjudicate(correction)).resolves.toMatchObject({
      status: AdjudicateReviewPublicationOutcomeStatus.Restored,
    });
  });
});

function requestCommand(
  fixture: Awaited<ReturnType<typeof seedFixture>>,
  key: string,
  timing: { publicationNotAfter?: Date; reconcileUntil?: Date } = {},
) {
  const publicationNotAfter =
    timing.publicationNotAfter ?? new Date(Date.now() + 3_600_000);
  const permit: ReviewPublicationPermitIdentity = {
    workspaceId: fixture.workspaceId,
    repositoryConnectionId: fixture.repositoryConnectionId,
    scmRepositoryIdentityId: fixture.scmRepositoryIdentityId,
    pullRequestNumber: 240,
    executionId: fixture.executionId,
    generation: 1n,
    authorizationId: fixture.authorizationId,
    producerReleaseId: fixture.producerReleaseId,
    reviewedHeadSha: digest("head"),
    reviewRevisionHash: digest("revision"),
    projectionHash: digest(`projection-${key}`),
    lifecycleStateHash: digest("lifecycle"),
    commandLedgerWatermark: 7n,
    permitEpoch: 3n,
    publicationSafetyDecisionHash: digest("publication-safety"),
    publicationNotAfter,
  };
  const operation: ReviewPublicationOperationPlan = {
    publicationOperationId: `operation-${key}`,
    publicationKind: ReviewPublicationKind.Summary,
    chunkIndex: 0,
    effectStrategy: ReviewPublicationEffectStrategy.MutableSingleton,
    role: ReviewPublicationOperationRole.Standalone,
    markerHash: digest("marker"),
    bodyHash: digest("body"),
    renderPolicyVersion: 1,
    targetCommitId: digest("target"),
    reviewRevisionHash: permit.reviewRevisionHash,
    required: true,
    dependsOnOperationId: null,
    reconcileUntil:
      timing.reconcileUntil ??
      new Date(publicationNotAfter.getTime() + 3_600_000),
  };
  return {
    publicationAttemptId: `publication-${key}-${randomUUID()}`,
    requestIdHash: digest(`request-id-${key}`),
    requestHash: digest(`request-${key}`),
    permit,
    operations: [operation],
    createdAt: new Date(Date.now() - 10_000),
    retainUntil: new Date(Date.now() + 86_400_000),
  };
}

function claimCommand(
  publicationAttemptId: string,
  input: Partial<{
    expectedAttemptVersion: bigint;
    claimId: string;
    acquireRequestIdHash: string;
    requestHash: string;
    claimCapabilityId: string;
    expiresAt: Date;
    reportUntil: Date;
  }> = {},
) {
  const claimId = input.claimId ?? `claim-${randomUUID()}`;
  const now = Date.now();
  return {
    publicationAttemptId,
    expectedAttemptVersion: input.expectedAttemptVersion ?? 1n,
    claimId,
    ownerIdHash: digest(`owner-${claimId}`),
    acquireRequestIdHash:
      input.acquireRequestIdHash ?? digest(`claim-request-id-${claimId}`),
    requestHash: input.requestHash ?? digest(`claim-request-${claimId}`),
    claimCapabilityId: input.claimCapabilityId ?? `${claimId}-capability`,
    capabilitySigningKeyId: "test-signing-key",
    acquiredAt: new Date(now),
    expiresAt: input.expiresAt ?? new Date(now + 60_000),
    reportUntil: input.reportUntil ?? new Date(now + 120_000),
    retainUntil: new Date(now + 86_400_000),
  };
}

function beginCommand(
  publicationAttemptId: string,
  publicationOperationId: string,
  input: {
    expectedAttemptVersion: bigint;
    claimId: string;
    claimFencingToken: bigint;
  },
) {
  const id = randomUUID();
  return {
    publicationAttemptId,
    publicationOperationId,
    expectedAttemptVersion: input.expectedAttemptVersion,
    claimId: input.claimId,
    claimFencingToken: input.claimFencingToken,
    acquireRequestIdHash: digest(`begin-request-id-${id}`),
    requestHash: digest(`begin-request-${id}`),
    operationAttemptId: `operation-attempt-${id}`,
    operationCapabilityId: `operation-capability-${id}`,
    capabilitySigningKeyId: "test-signing-key",
    effectReportId: `effect-report-${id}`,
    startedAt: new Date(),
    effectReportUntil: new Date(Date.now() + 120_000),
    retainUntil: new Date(Date.now() + 86_400_000),
  };
}

function effectCommand(capability: ReviewPublicationOperationCapabilityFacts) {
  return {
    capability,
    effectId: `effect-${randomUUID()}`,
    reportRequestHash: digest("effect-report-request"),
    externalObjectId: `external-${randomUUID()}`,
    observedObjectHash: digest("observed-object"),
    effectKind: ReviewPublicationExternalEffectKind.MutationAcknowledged,
    observedAt: new Date(),
  };
}

function completeCommand(
  publicationAttemptId: string,
  publicationOperationId: string,
  input: {
    expectedAttemptVersion: bigint;
    claimId: string;
    claimFencingToken: bigint;
    canonicalEffectId: string;
  },
) {
  const id = randomUUID();
  return {
    publicationAttemptId,
    publicationOperationId,
    expectedAttemptVersion: input.expectedAttemptVersion,
    claimId: input.claimId,
    claimFencingToken: input.claimFencingToken,
    completionRequestIdHash: digest(`completion-request-id-${id}`),
    requestHash: digest(`completion-request-${id}`),
    receiptId: `receipt-${id}`,
    canonicalEffectId: input.canonicalEffectId,
    receiptHash: digest(`receipt-${id}`),
    completedAt: new Date(),
  };
}

async function seedFixture(prisma: PrismaClient) {
  const id = randomUUID();
  const workspaceId = `workspace-${id}`;
  const repositoryConnectionId = `repository-${id}`;
  const scmRepositoryIdentityId = `scm-${id}`;
  const protocolLimitsProfileId = `limits-${id}`;
  const operationalSloProfileId = `slo-${id}`;
  const producerReleaseId = `producer-${id}`;
  const authorizationId = `authorization-${id}`;
  const executionId = `execution-${id}`;
  const rerunExecutionId = `execution-rerun-${id}`;
  const now = new Date();
  await prisma.workspace.create({
    data: {
      id: workspaceId,
      slug: `publishing-${id}`,
      name: "Publishing test",
    },
  });
  await prisma.scmRepositoryIdentity.create({
    data: {
      scmRepositoryIdentityId,
      provider: "github",
      normalizedSourceBaseUrl: "https://github.com",
      externalRepositoryId: `external-${id}`,
      createdAt: now,
    },
  });
  await prisma.repositoryConnection.create({
    data: {
      id: repositoryConnectionId,
      workspaceId,
      provider: "github",
      sourceBaseUrl: "https://github.com",
      externalRepositoryId: `external-${id}`,
      scmRepositoryIdentityId,
      owner: "reviewrouter-test",
      name: `repo-${id}`,
      fullName: `reviewrouter-test/repo-${id}`,
      defaultBranch: "main",
      visibility: "private",
    },
  });
  await prisma.scmRepositoryIdentity.update({
    where: { scmRepositoryIdentityId },
    data: {
      currentWorkspaceId: workspaceId,
      currentRepositoryConnectionId: repositoryConnectionId,
      boundAt: now,
    },
  });
  await prisma.reviewProtocolLimitsV2.create({
    data: {
      protocolLimitsProfileId,
      limitsDigest: digest(`limits-${id}`),
      maxWorkSlots: 10,
      maxAttemptsPerSlot: 3,
      maxObservationBytes: 1_000_000,
      maxObservationFindings: 1_000,
      maxProjectionBytes: 1_000_000,
      maxProjectionFindings: 1_000,
      maxPublicationOperations: 100,
      maxPublicationChunks: 100,
      maxPublicationBodyBytes: 100_000,
      maxRequestBatchSize: 100,
      maxLeaseDurationMs: 60_000,
      maxResultReportDurationMs: 120_000,
      maxReconciliationDurationMs: 120_000,
      registeredAt: now,
    },
  });
  await prisma.reviewOperationalSloProfileV2.create({
    data: {
      operationalSloProfileId,
      sloDigest: digest(`slo-${id}`),
      integrationEventDeliveryMs: 1_000,
      outboxClaimAgeMs: 1_000,
      missingCompletionProcessMs: 1_000,
      dueCompletionProcessMs: 1_000,
      publicationReconciliationMs: 1_000,
      v1DrainMs: 1_000,
      admissionMs: 1_000,
      pruningBacklogAgeMs: 1_000,
      ownerRefs: ["reviewrouter-test"],
      runbookRefs: ["reviewrouter-test"],
      registeredAt: now,
    },
  });
  await prisma.producerRelease.create({
    data: {
      producerReleaseId,
      distributionKind: "hosted_composite",
      actionCommitSha: digest(`action-${id}`),
      runtimeCommitSha: digest(`runtime-${id}`),
      runtimeEntrypointDigest: digest(`entrypoint-${id}`),
      schemaDigest: digest(`schema-${id}`),
      capabilityProfile: "publishing-test",
      protocolLimitsProfileId,
      operationalSloProfileId,
      state: "registered",
      registeredAt: now,
    },
  });
  await prisma.reviewRunAuthorization.create({
    data: {
      authorizationId,
      workspaceId,
      repositoryConnectionId,
      scmRepositoryIdentityId,
      pullRequestNumber: 240,
      sourceRunId: `run-${id}`,
      sourceRunAttempt: "1",
      workflowIdentityHash: digest(`workflow-${id}`),
      baseSha: digest("base"),
      mergeBaseSha: digest("merge-base"),
      headSha: digest("head"),
      reviewRevisionHash: digest("revision"),
      trustDomain: "trusted_managed",
      producerReleaseId,
      selectedProtocolVersion: "2",
      schemaDigest: digest(`schema-${id}`),
      protocolLimitsProfileId,
      operationalSloProfileId,
      mutationEpoch: 3n,
      providerVoteLanes: [],
      authorizationSafetyDecisionHash: digest(`authorization-safety-${id}`),
      protocolOfferHash: digest(`protocol-offer-${id}`),
      oidcReplayKeyHash: digest(`oidc-${id}`),
      tokenSigningKeyId: "test-signing-key",
      tokenIssuer: "reviewrouter-test",
      tokenAudience: "reviewrouter-test",
      state: "active",
      expiresAt: new Date(Date.now() + 3_600_000),
      maxExpiresAt: new Date(Date.now() + 7_200_000),
      createdAt: now,
    },
  });
  await prisma.reviewExecutionV2.create({
    data: {
      executionId,
      workspaceId,
      repositoryConnectionId,
      scmRepositoryIdentityId,
      pullRequestNumber: 240,
      generation: 1n,
      baseSha: digest("base"),
      mergeBaseSha: digest("merge-base"),
      headSha: digest("head"),
      reviewRevisionHash: digest("revision"),
      compatibilityKey: digest(`compatibility-${id}`),
      planHash: digest(`plan-${id}`),
      startIdentityHash: digest(`start-${id}`),
      canonicalStartHash: digest(`canonical-start-${id}`),
      state: "completed",
      authorizationId,
      producerReleaseId,
      mutationEpoch: 3n,
      admissionSafetyDecisionHash: digest(`admission-${id}`),
      protocolLimitsProfileId,
      sourceRunId: `run-${id}`,
      sourceRunAttempt: "1",
      createdAt: now,
      updatedAt: now,
      admissionDeadlineAt: new Date(Date.now() + 60_000),
      executionDeadlineAt: new Date(Date.now() + 120_000),
      retainUntil: new Date(Date.now() + 86_400_000),
    },
  });
  await prisma.reviewExecutionV2.create({
    data: {
      executionId: rerunExecutionId,
      workspaceId,
      repositoryConnectionId,
      scmRepositoryIdentityId,
      pullRequestNumber: 240,
      generation: 2n,
      baseSha: digest("base"),
      mergeBaseSha: digest("merge-base"),
      headSha: digest("head"),
      reviewRevisionHash: digest("revision"),
      compatibilityKey: digest(`compatibility-rerun-${id}`),
      planHash: digest(`plan-rerun-${id}`),
      startIdentityHash: digest(`start-rerun-${id}`),
      canonicalStartHash: digest(`canonical-start-rerun-${id}`),
      state: "completed",
      authorizationId,
      producerReleaseId,
      mutationEpoch: 3n,
      admissionSafetyDecisionHash: digest(`admission-rerun-${id}`),
      protocolLimitsProfileId,
      sourceRunId: `run-${id}`,
      sourceRunAttempt: "2",
      createdAt: now,
      updatedAt: now,
      admissionDeadlineAt: new Date(Date.now() + 60_000),
      executionDeadlineAt: new Date(Date.now() + 120_000),
      retainUntil: new Date(Date.now() + 86_400_000),
    },
  });
  return {
    workspaceId,
    repositoryConnectionId,
    scmRepositoryIdentityId,
    protocolLimitsProfileId,
    operationalSloProfileId,
    producerReleaseId,
    authorizationId,
    executionId,
    rerunExecutionId,
  };
}

async function cleanupFixture(
  prisma: PrismaClient,
  fixture: Awaited<ReturnType<typeof seedFixture>>,
): Promise<void> {
  const attempts = await prisma.reviewPublicationAttemptV2.findMany({
    where: {
      executionId: { in: [fixture.executionId, fixture.rerunExecutionId] },
    },
    select: { publicationAttemptId: true },
  });
  const attemptIds = attempts.map(
    ({ publicationAttemptId }) => publicationAttemptId,
  );
  await prisma.reviewPublicationOutcomeCorrectionV2.deleteMany({
    where: { publicationAttemptId: { in: attemptIds } },
  });
  await prisma.reviewPublicationAuditTombstoneV2.deleteMany({
    where: { publicationAttemptId: { in: attemptIds } },
  });
  await prisma.reviewPublicationReceiptV2.deleteMany({
    where: { publicationAttemptId: { in: attemptIds } },
  });
  await prisma.reviewPublicationExternalEffectV2.deleteMany({
    where: { publicationAttemptId: { in: attemptIds } },
  });
  await prisma.reviewPublicationOperationAttemptV2.deleteMany({
    where: { publicationAttemptId: { in: attemptIds } },
  });
  await prisma.reviewPublicationOperationV2.deleteMany({
    where: { publicationAttemptId: { in: attemptIds } },
  });
  await prisma.reviewPublicationClaimTermV2.deleteMany({
    where: { publicationAttemptId: { in: attemptIds } },
  });
  await prisma.reviewPublicationRequestReceiptV2.deleteMany({
    where: { publicationAttemptId: { in: attemptIds } },
  });
  await prisma.reviewPublicationAttemptV2.deleteMany({
    where: { publicationAttemptId: { in: attemptIds } },
  });
  await prisma.reviewExecutionV2.deleteMany({
    where: {
      executionId: { in: [fixture.executionId, fixture.rerunExecutionId] },
    },
  });
  await prisma.reviewRunAuthorization.delete({
    where: { authorizationId: fixture.authorizationId },
  });
  await prisma.producerRelease.delete({
    where: { producerReleaseId: fixture.producerReleaseId },
  });
  await prisma.reviewOperationalSloProfileV2.delete({
    where: { operationalSloProfileId: fixture.operationalSloProfileId },
  });
  await prisma.reviewProtocolLimitsV2.delete({
    where: { protocolLimitsProfileId: fixture.protocolLimitsProfileId },
  });
  await prisma.scmRepositoryIdentity.update({
    where: { scmRepositoryIdentityId: fixture.scmRepositoryIdentityId },
    data: {
      currentWorkspaceId: null,
      currentRepositoryConnectionId: null,
      unboundAt: new Date(),
    },
  });
  await prisma.repositoryConnection.delete({
    where: { id: fixture.repositoryConnectionId },
  });
  await prisma.scmRepositoryIdentity.delete({
    where: { scmRepositoryIdentityId: fixture.scmRepositoryIdentityId },
  });
  await prisma.workspace.delete({ where: { id: fixture.workspaceId } });
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
