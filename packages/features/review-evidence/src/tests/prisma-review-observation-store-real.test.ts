import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPrismaClient,
  type PrismaClient,
} from "@reviewrouter/platform-db";
import { ReviewObservationAcceptPersistenceStatus } from "../application/ports/review-observation-ports";
import {
  normalizeQualityFlags,
  ReviewObservationQualityFlag,
} from "../domain/review-evidence-primitives";
import { PrismaReviewObservationStore } from "../infrastructure/prisma/prisma-review-observation-store";
import { hash, observation } from "./fixtures";

const databaseUrl = process.env.REVIEW_ROUTER_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase("Prisma review evidence observations", () => {
  let prisma: PrismaClient;
  let store: PrismaReviewObservationStore;
  const suffix = randomUUID();
  const workspaceId = `evidence-workspace-${suffix}`;
  const repositoryConnectionId = `evidence-repository-${suffix}`;
  const scmRepositoryIdentityId = `evidence-scm-${suffix}`;
  const producerReleaseId = `evidence-release-${suffix}`;
  const authorizationId = `evidence-authorization-${suffix}`;
  const protocolLimitsProfileId = `evidence-limits-${suffix}`;
  const operationalSloProfileId = `evidence-slo-${suffix}`;

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: databaseUrl!, poolMax: 4 });
    store = new PrismaReviewObservationStore(prisma);
    await seedScope();
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.reviewEvidenceObservation.deleteMany({
      where: { workspaceId },
    });
    await prisma.reviewRunAuthorization.deleteMany({
      where: { workspaceId },
    });
    await prisma.producerRelease.deleteMany({
      where: { producerReleaseId },
    });
    await prisma.reviewProtocolLimitsV2.deleteMany({
      where: { protocolLimitsProfileId },
    });
    await prisma.reviewOperationalSloProfileV2.deleteMany({
      where: { operationalSloProfileId },
    });
    await prisma.$transaction(async (transaction) => {
      await transaction.scmRepositoryIdentity.updateMany({
        where: { scmRepositoryIdentityId },
        data: {
          currentWorkspaceId: null,
          currentRepositoryConnectionId: null,
          unboundAt: new Date(),
        },
      });
      await transaction.repositoryConnection.updateMany({
        where: { id: repositoryConnectionId },
        data: { scmRepositoryIdentityId: null },
      });
      await transaction.scmRepositoryIdentity.deleteMany({
        where: { scmRepositoryIdentityId },
      });
      await transaction.repositoryConnection.deleteMany({
        where: { id: repositoryConnectionId },
      });
      await transaction.workspace.deleteMany({ where: { id: workspaceId } });
    });
    await prisma.$disconnect();
  });

  it("restores identical acceptance and rejects conflicting attempt payload", async () => {
    const first = candidate("evidence-observation-1");
    await expect(store.acceptObservation(first)).resolves.toMatchObject({
      status: ReviewObservationAcceptPersistenceStatus.Accepted,
    });
    await expect(store.findById(first.observationId)).resolves.toMatchObject({
      observationId: first.observationId,
      payloadHash: first.payloadHash,
    });
    await expect(
      store.findById("evidence-observation-missing"),
    ).resolves.toBeNull();
    await expect(
      store.acceptObservation(
        candidate("evidence-observation-retry", { payloadHash: hash("e") }),
      ),
    ).resolves.toMatchObject({
      status: ReviewObservationAcceptPersistenceStatus.Idempotent,
      observation: { observationId: first.observationId },
    });
    await expect(
      store.acceptObservation(
        candidate("evidence-observation-conflict", { payloadHash: hash("f") }),
      ),
    ).resolves.toEqual({
      status: ReviewObservationAcceptPersistenceStatus.Conflict,
    });
  });

  it("queries only exact scope/trust/key and prunes deterministically", async () => {
    const current = candidate("evidence-observation-current", {
      attemptId: "attempt-current",
      createdAtMs: Date.UTC(2026, 6, 22, 13, 0, 0),
      reuseExpiresAtMs: Date.UTC(2026, 6, 29, 13, 0, 0),
      retainUntilMs: Date.UTC(2026, 7, 22, 13, 0, 0),
    });
    await store.acceptObservation(current);
    await expect(
      store.findCandidates({
        scope: current.scope,
        trustDomain: current.trustDomain,
        providerInvocationKey: current.providerInvocationKey,
        reusableAfterMs: current.createdAtMs,
        limit: 10,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ observationId: current.observationId }),
      ]),
    );

    await expect(
      store.pruneRetainedObservations({
        retainUntilOrBeforeMs: Date.UTC(2026, 8, 1),
        limit: 100,
      }),
    ).resolves.toBeGreaterThanOrEqual(2);
    await expect(
      prisma.reviewEvidenceObservation.count({ where: { workspaceId } }),
    ).resolves.toBe(0);
  });

  it("round-trips every supported observation quality flag", async () => {
    const qualityFlags = [
      ReviewObservationQualityFlag.ModelFallback,
      ReviewObservationQualityFlag.LowConfidence,
      ReviewObservationQualityFlag.ProviderWarning,
      ReviewObservationQualityFlag.ContextInspectionIncomplete,
      ReviewObservationQualityFlag.ContextAttestationUnavailable,
      ReviewObservationQualityFlag.CrossRevisionReuseDisabled,
    ] as const;
    const current = candidate("evidence-observation-quality-flags", {
      attemptId: "attempt-quality-flags",
      qualityFlags,
    });
    const normalizedQualityFlags = normalizeQualityFlags(qualityFlags);

    await expect(store.acceptObservation(current)).resolves.toMatchObject({
      status: ReviewObservationAcceptPersistenceStatus.Accepted,
      observation: { qualityFlags: normalizedQualityFlags },
    });
    await expect(store.findById(current.observationId)).resolves.toMatchObject({
      qualityFlags: normalizedQualityFlags,
    });
  });

  function candidate(
    observationId: string,
    overrides: Parameters<typeof observation>[0] = {},
  ) {
    return observation({
      observationId,
      scope: {
        workspaceId,
        repositoryConnectionId,
        scmRepositoryIdentityId,
        pullRequestNumber: 42,
        authorizationScopeHash: hash("a"),
      },
      sourceAuthorizationId: authorizationId,
      producerReleaseId,
      ...overrides,
    });
  }

  async function seedScope(): Promise<void> {
    const now = new Date("2026-07-22T12:00:00.000Z");
    await prisma.workspace.create({
      data: { id: workspaceId, slug: workspaceId, name: workspaceId },
    });
    await prisma.repositoryConnection.create({
      data: {
        id: repositoryConnectionId,
        workspaceId,
        provider: "github",
        sourceBaseUrl: "https://github.com",
        externalRepositoryId: `external-${suffix}`,
        owner: "reviewrouter-test",
        name: `evidence-${suffix}`,
        fullName: `reviewrouter-test/evidence-${suffix}`,
        defaultBranch: "main",
        visibility: "private",
        setupStatus: "not_configured",
      },
    });
    await prisma.$transaction(async (transaction) => {
      await transaction.scmRepositoryIdentity.create({
        data: {
          scmRepositoryIdentityId,
          provider: "github",
          normalizedSourceBaseUrl: "https://github.com",
          externalRepositoryId: `external-${suffix}`,
          currentWorkspaceId: workspaceId,
          currentRepositoryConnectionId: repositoryConnectionId,
          createdAt: now,
          boundAt: now,
        },
      });
      await transaction.repositoryConnection.update({
        where: { id: repositoryConnectionId },
        data: { scmRepositoryIdentityId },
      });
    });
    await prisma.reviewProtocolLimitsV2.create({
      data: {
        protocolLimitsProfileId,
        limitsDigest: hash("1"),
        maxWorkSlots: 100,
        maxAttemptsPerSlot: 3,
        maxObservationBytes: 500_000,
        maxObservationFindings: 100,
        maxProjectionBytes: 1_000_000,
        maxProjectionFindings: 200,
        maxPublicationOperations: 100,
        maxPublicationChunks: 100,
        maxPublicationBodyBytes: 500_000,
        maxRequestBatchSize: 50,
        maxLeaseDurationMs: 60_000,
        maxResultReportDurationMs: 120_000,
        maxReconciliationDurationMs: 3_600_000,
        registeredAt: now,
      },
    });
    await prisma.reviewOperationalSloProfileV2.create({
      data: {
        operationalSloProfileId,
        sloDigest: hash("2"),
        integrationEventDeliveryMs: 60_000,
        outboxClaimAgeMs: 60_000,
        missingCompletionProcessMs: 60_000,
        dueCompletionProcessMs: 60_000,
        publicationReconciliationMs: 60_000,
        v1DrainMs: 60_000,
        admissionMs: 60_000,
        pruningBacklogAgeMs: 60_000,
        ownerRefs: ["reviewrouter"],
        runbookRefs: ["runbook"],
        registeredAt: now,
      },
    });
    await prisma.producerRelease.create({
      data: {
        producerReleaseId,
        distributionKind: "hosted_composite",
        actionCommitSha: "a".repeat(40),
        runtimeCommitSha: "b".repeat(40),
        wrapperEntrypointDigest: hash("3"),
        runtimeEntrypointDigest: hash("4"),
        schemaDigest: hash("5"),
        capabilityProfile: "exact_revision_v2",
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
        pullRequestNumber: 42,
        sourceRunId: "run-1",
        sourceRunAttempt: "1",
        workflowIdentityHash: hash("0"),
        baseSha: "a".repeat(40),
        mergeBaseSha: "b".repeat(40),
        headSha: "c".repeat(40),
        reviewRevisionHash: hash("b"),
        trustDomain: "trusted_managed",
        producerReleaseId,
        selectedProtocolVersion: "review-action-v2",
        schemaDigest: hash("5"),
        protocolLimitsProfileId,
        operationalSloProfileId,
        mutationEpoch: 1n,
        providerVoteLanes: [],
        authorizationSafetyDecisionHash: hash("6"),
        protocolOfferHash: hash("7"),
        oidcReplayKeyHash: hash("8"),
        tokenSigningKeyId: "test-key",
        tokenIssuer: "reviewrouter-review-run-control",
        tokenAudience: "review_run",
        state: "active",
        expiresAt: new Date(now.getTime() + 30 * 60_000),
        maxExpiresAt: new Date(now.getTime() + 60 * 60_000),
        createdAt: now,
      },
    });
  }
});
