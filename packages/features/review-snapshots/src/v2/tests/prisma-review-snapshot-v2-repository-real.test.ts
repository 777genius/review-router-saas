import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPrismaClient,
  type PrismaClient,
} from "@reviewrouter/platform-db";
import {
  CommitReviewSnapshotV2Status,
  LineageHintEvictionReason,
  LineageHintState,
  ReviewSnapshotV2CommitOutcome,
  ReviewSnapshotV2RestoreMode,
  ReviewSnapshotV2RestoreStatus,
  decideReviewSnapshotV2Restore,
  reviewSnapshotV2SchemaVersion,
  type CommitReviewSnapshotV2Command,
} from "../index";
import { PrismaReviewSnapshotV2Repository } from "../infrastructure/prisma/prisma-review-snapshot-v2-repository";

const databaseUrl = process.env.REVIEW_ROUTER_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const hash = (character: string): string => character.repeat(64);

describeWithDatabase("review snapshot v2 Prisma repository contract", () => {
  const prefix = `snapshot-v2-${randomUUID()}`;
  const workspaceId = `${prefix}-workspace`;
  const repositoryConnectionId = `${prefix}-repository`;
  const scmRepositoryIdentityId = `${prefix}-scm`;
  const protocolLimitsProfileId = `${prefix}-limits`;
  const operationalSloProfileId = `${prefix}-slo`;
  const producerReleaseId = `${prefix}-producer`;
  let prisma: PrismaClient;
  let repository: PrismaReviewSnapshotV2Repository;

  beforeAll(async () => {
    assertDisposableDatabaseUrl(databaseUrl!);
    prisma = createPrismaClient({ databaseUrl: databaseUrl!, poolMax: 8 });
    repository = new PrismaReviewSnapshotV2Repository(prisma);
    const seededAt = new Date("2026-07-22T10:00:00.000Z");
    await prisma.reviewProtocolLimitsV2.create({
      data: {
        protocolLimitsProfileId,
        limitsDigest: hash("a"),
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
        registeredAt: seededAt,
      },
    });
    await prisma.reviewOperationalSloProfileV2.create({
      data: {
        operationalSloProfileId,
        sloDigest: hash("b"),
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
        registeredAt: seededAt,
      },
    });
    await prisma.producerRelease.create({
      data: {
        producerReleaseId,
        distributionKind: "hosted_composite",
        actionCommitSha: "a".repeat(40),
        runtimeCommitSha: "b".repeat(40),
        wrapperEntrypointDigest: hash("c"),
        runtimeEntrypointDigest: hash("d"),
        schemaDigest: hash("e"),
        capabilityProfile: "snapshot-v2-test",
        protocolLimitsProfileId,
        operationalSloProfileId,
        registeredAt: seededAt,
      },
    });
    await prisma.workspace.create({
      data: {
        id: workspaceId,
        slug: `${prefix}-slug`,
        name: "Snapshot v2 test",
      },
    });
    await prisma.scmRepositoryIdentity.create({
      data: {
        scmRepositoryIdentityId,
        provider: "github",
        normalizedSourceBaseUrl: "https://github.com",
        externalRepositoryId: `${prefix}-external`,
        createdAt: seededAt,
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
    for (const pullRequestNumber of [42, 43]) {
      await seedAuthorization(pullRequestNumber, seededAt);
    }
    await seedExecution(42, 1, "delayed", seededAt);
    await seedExecution(42, 2, "second", seededAt);
    await seedExecution(43, 1, "race-left", seededAt);
    await seedExecution(43, 2, "race-right", seededAt);
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.reviewSnapshotCommitReceiptV2.deleteMany({
      where: { receiptId: { startsWith: prefix } },
    });
    await prisma.reviewSnapshot.deleteMany({
      where: { workspaceId, repositoryId: repositoryConnectionId },
    });
    await prisma.reviewExecutionV2.deleteMany({ where: { workspaceId } });
    await prisma.reviewRunAuthorization.deleteMany({ where: { workspaceId } });
    await prisma.repositoryConnection.deleteMany({
      where: { id: repositoryConnectionId },
    });
    await prisma.scmRepositoryIdentity.deleteMany({
      where: { scmRepositoryIdentityId },
    });
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.producerRelease.deleteMany({ where: { producerReleaseId } });
    await prisma.reviewOperationalSloProfileV2.deleteMany({
      where: { operationalSloProfileId },
    });
    await prisma.reviewProtocolLimitsV2.deleteMany({
      where: { protocolLimitsProfileId },
    });
    await prisma.$disconnect();
  });

  it("restores replay and fences delayed or conflicting generations", async () => {
    const first = command({ generation: 2, suffix: "second" });
    await expect(repository.commit(first)).resolves.toMatchObject({
      status: CommitReviewSnapshotV2Status.Applied,
      receipt: { outcome: ReviewSnapshotV2CommitOutcome.Committed },
      snapshot: { version: 1, sourceExecutionGeneration: 2 },
    });
    await expect(repository.commit(first)).resolves.toMatchObject({
      status: CommitReviewSnapshotV2Status.Restored,
      receipt: { receiptId: first.receiptId },
    });

    const second = command({
      generation: 1,
      expectedVersion: 1,
      suffix: "delayed",
      artifactHash: hash("4"),
    });
    await expect(repository.commit(second)).resolves.toMatchObject({
      status: CommitReviewSnapshotV2Status.Applied,
      receipt: {
        outcome: ReviewSnapshotV2CommitOutcome.SupersededByHigherGeneration,
        resultingSnapshotGeneration: 2,
      },
      snapshot: { version: 1, sourceExecutionGeneration: 2 },
    });
    await expect(
      repository.findBySource({
        sourceExecutionId: second.candidate.sourceExecutionId,
        sourceArtifactHash: second.candidate.sourceArtifactHash,
      }),
    ).resolves.toMatchObject({
      receiptId: second.receiptId,
      outcome: ReviewSnapshotV2CommitOutcome.SupersededByHigherGeneration,
      resultingSnapshotGeneration: 2,
    });

    await expect(
      repository.commit(
        command({
          generation: 2,
          expectedVersion: 1,
          suffix: "drift",
          executionSuffix: "second",
          artifactHash: hash("6"),
        }),
      ),
    ).resolves.toEqual({
      status: CommitReviewSnapshotV2Status.InvariantConflict,
      currentVersion: 1,
    });
    await expect(
      repository.findCurrent(first.candidate),
    ).resolves.toMatchObject({
      schemaVersion: 2,
      version: 1,
      sourceExecutionId: first.candidate.sourceExecutionId,
      sourceExecutionGeneration: 2,
      sourceBaseSha: first.candidate.sourceBaseSha,
      sourceReviewedHeadSha: first.candidate.sourceReviewedHeadSha,
      sourceCompatibilityKey: first.candidate.sourceCompatibilityKey,
      sourceRunId: first.candidate.sourceRunId,
      sourceRunAttempt: first.candidate.sourceRunAttempt,
      payload: first.candidate.payload,
    });
    await expect(
      prisma.reviewSnapshot.findUniqueOrThrow({
        where: {
          workspaceId_repositoryId_pullRequestNumber: {
            workspaceId,
            repositoryId: repositoryConnectionId,
            pullRequestNumber: 42,
          },
        },
      }),
    ).resolves.toMatchObject({
      baseSha: first.candidate.sourceBaseSha,
      reviewedHeadSha: first.candidate.sourceReviewedHeadSha,
      compatibilityKey: first.candidate.sourceCompatibilityKey,
      sourceRunId: first.candidate.sourceRunId,
      sourceRunAttempt: first.candidate.sourceRunAttempt,
    });
  });

  it("maps v1 storage only as an untrusted legacy identity", async () => {
    await prisma.reviewSnapshot.create({
      data: {
        workspaceId,
        repositoryId: repositoryConnectionId,
        pullRequestNumber: 44,
        schemaVersion: 1,
        reviewedHeadSha: "1".repeat(40),
        baseSha: "2".repeat(40),
        compatibilityKey: hash("3"),
        payload: {},
        payloadHash: hash("4"),
        sourceRunId: "legacy-run",
        sourceRunAttempt: "1",
        reviewedAt: new Date("2026-07-22T12:00:00.000Z"),
        expiresAt: new Date("2026-07-29T12:00:00.000Z"),
      },
    });
    const legacy = await repository.findCurrent(scope(44));
    expect(legacy).toMatchObject({ schemaVersion: 1, version: 1 });
    expect(
      decideReviewSnapshotV2Restore(legacy, {
        now: new Date("2026-07-22T13:00:00.000Z"),
        trustedRepositoryBinding: true,
        reviewRevisionHash: hash("5"),
        mode: ReviewSnapshotV2RestoreMode.ExactProjection,
      }),
    ).toEqual({
      status: ReviewSnapshotV2RestoreStatus.LegacyUntrusted,
      expectedVersion: 1,
    });
  });

  it("rejects malformed v2 provenance instead of downgrading it to legacy", async () => {
    await prisma.reviewSnapshot.create({
      data: {
        workspaceId,
        repositoryId: repositoryConnectionId,
        pullRequestNumber: 45,
        schemaVersion: 2,
        reviewedHeadSha: "1".repeat(40),
        baseSha: "not-a-commit-sha",
        compatibilityKey: hash("3"),
        payload: {
          projectionEnvelopeVersion: 1,
          projectionEnvelope: {},
          projectionHash: hash("4"),
          occurrences: [],
          lineageHints: {
            hints: [],
            eviction: {
              age: 0,
              count: 0,
              bytes: 0,
              evictionWatermark: null,
            },
          },
        },
        payloadHash: hash("4"),
        sourceRunId: "malformed-v2-run",
        sourceRunAttempt: "1",
        scmRepositoryIdentityId,
        sourceExecutionId: `${prefix}-second-execution`,
        sourceExecutionGeneration: 2n,
        sourceArtifactHash: hash("5"),
        sourceReviewRevisionHash: hash("6"),
        publicationReceiptSetHash: hash("7"),
        reviewedAt: new Date("2026-07-22T12:00:00.000Z"),
        expiresAt: new Date("2026-07-29T12:00:00.000Z"),
      },
    });
    await expect(repository.findCurrent(scope(45))).rejects.toThrow(
      "snapshot_source_base_sha_invalid",
    );
  });

  it("allows only one writer for the same expected version", async () => {
    const current = await repository.findCurrent(scope(43));
    const expectedVersion = current?.version ?? 0;
    const [left, right] = await Promise.all([
      repository.commit(
        command({
          generation: 1,
          expectedVersion,
          suffix: "race-left",
          artifactHash: hash("7"),
          pullRequestNumber: 43,
        }),
      ),
      repository.commit(
        command({
          generation: 2,
          expectedVersion,
          suffix: "race-right",
          artifactHash: hash("8"),
          pullRequestNumber: 43,
        }),
      ),
    ]);
    expect([left.status, right.status].sort()).toEqual(
      [
        CommitReviewSnapshotV2Status.Applied,
        CommitReviewSnapshotV2Status.VersionConflict,
      ].sort(),
    );
  });

  function scope(pullRequestNumber = 42) {
    return {
      workspaceId,
      repositoryConnectionId,
      scmRepositoryIdentityId,
      pullRequestNumber,
    };
  }

  function command(input: {
    generation: number;
    expectedVersion?: number;
    suffix?: string;
    executionSuffix?: string;
    artifactHash?: string;
    pullRequestNumber?: number;
  }): CommitReviewSnapshotV2Command {
    const suffix = input.suffix ?? "first";
    const createdAt = new Date("2026-07-22T12:00:00.000Z");
    return {
      receiptId: `${prefix}-${suffix}-receipt`,
      requestHash: hash(
        (
          {
            first: "1",
            second: "2",
            delayed: "3",
            drift: "4",
            "race-left": "5",
            "race-right": "6",
          } as const
        )[suffix as "first"] ?? "9",
      ),
      expectedSnapshotVersion: input.expectedVersion ?? 0,
      publicationReceiptSetHash: hash("3"),
      receiptRetainUntil: new Date("2026-08-22T12:00:00.000Z"),
      candidate: {
        ...scope(input.pullRequestNumber),
        schemaVersion: reviewSnapshotV2SchemaVersion,
        sourceExecutionId: `${prefix}-${input.executionSuffix ?? suffix}-execution`,
        sourceExecutionGeneration: input.generation,
        sourceArtifactHash: input.artifactHash ?? hash("2"),
        sourceReviewRevisionHash: hash("1"),
        sourceBaseSha: "c".repeat(40),
        sourceReviewedHeadSha: "e".repeat(40),
        sourceCompatibilityKey: hash("2"),
        sourceRunId: `${prefix}-run-${input.pullRequestNumber ?? 42}-${input.generation}`,
        sourceRunAttempt: "1",
        payload: {
          projectionEnvelopeVersion: 1,
          projectionEnvelope: { summary: "safe" },
          projectionHash: hash("c"),
          occurrences: [],
          lineageHints: {
            hints: [
              {
                lineageId: "lineage-1",
                fingerprintHash: hash("d"),
                state: LineageHintState.Active,
                lastSeenAt: createdAt,
              },
            ],
            eviction: {
              [LineageHintEvictionReason.Age]: 0,
              [LineageHintEvictionReason.Count]: 0,
              [LineageHintEvictionReason.Bytes]: 0,
              evictionWatermark: null,
            },
          },
        },
        createdAt,
        expiresAt: new Date("2026-07-29T12:00:00.000Z"),
      },
    };
  }

  async function seedAuthorization(
    pullRequestNumber: number,
    createdAt: Date,
  ): Promise<void> {
    await prisma.reviewRunAuthorization.create({
      data: {
        authorizationId: `${prefix}-authorization-${pullRequestNumber}`,
        workspaceId,
        repositoryConnectionId,
        scmRepositoryIdentityId,
        pullRequestNumber,
        sourceRunId: `${prefix}-run-${pullRequestNumber}`,
        sourceRunAttempt: "1",
        workflowIdentityHash: hash("f"),
        baseSha: "c".repeat(40),
        mergeBaseSha: "d".repeat(40),
        headSha: "e".repeat(40),
        reviewRevisionHash: hash("1"),
        trustDomain: "trusted_managed",
        producerReleaseId,
        selectedProtocolVersion: "2.0",
        schemaDigest: hash("e"),
        protocolLimitsProfileId,
        operationalSloProfileId,
        mutationEpoch: 1n,
        providerVoteLanes: [],
        authorizationSafetyDecisionHash: hash("2"),
        protocolOfferHash: hash("3"),
        oidcReplayKeyHash: hash(pullRequestNumber === 42 ? "4" : "5"),
        tokenSigningKeyId: `${prefix}-key`,
        tokenIssuer: "reviewrouter-test",
        tokenAudience: "reviewrouter-test-action",
        expiresAt: new Date(createdAt.getTime() + 3_600_000),
        maxExpiresAt: new Date(createdAt.getTime() + 3_600_000),
        createdAt,
      },
    });
  }

  async function seedExecution(
    pullRequestNumber: number,
    generation: number,
    suffix: string,
    createdAt: Date,
  ): Promise<void> {
    await prisma.reviewExecutionV2.create({
      data: {
        executionId: `${prefix}-${suffix}-execution`,
        workspaceId,
        repositoryConnectionId,
        scmRepositoryIdentityId,
        pullRequestNumber,
        generation: BigInt(generation),
        baseSha: "c".repeat(40),
        mergeBaseSha: "d".repeat(40),
        headSha: "e".repeat(40),
        reviewRevisionHash: hash("1"),
        compatibilityKey: hash("2"),
        planHash: hash("3"),
        startIdentityHash: hash(
          suffix === "delayed" || suffix === "race-left" ? "4" : "5",
        ),
        canonicalStartHash: hash(
          suffix === "delayed" || suffix === "race-left" ? "6" : "7",
        ),
        state: "completed",
        authorizationId: `${prefix}-authorization-${pullRequestNumber}`,
        producerReleaseId,
        mutationEpoch: 1n,
        admissionSafetyDecisionHash: hash("8"),
        protocolLimitsProfileId,
        sourceRunId: `${prefix}-run-${pullRequestNumber}-${generation}`,
        sourceRunAttempt: "1",
        createdAt,
        updatedAt: createdAt,
        admissionDeadlineAt: new Date(createdAt.getTime() + 60_000),
        admissionCheckedAt: createdAt,
        executionDeadlineAt: new Date(createdAt.getTime() + 3_600_000),
        retainUntil: new Date(createdAt.getTime() + 86_400_000),
      },
    });
  }
});

function assertDisposableDatabaseUrl(value: string): void {
  const databaseName = new URL(value).pathname.slice(1);
  if (!/test|disposable|rehearsal/i.test(databaseName)) {
    throw new Error(
      "refusing_to_run_review_snapshot_v2_test_on_non_disposable_database",
    );
  }
}
