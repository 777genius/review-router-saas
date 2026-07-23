import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPrismaClient,
  type PrismaClient,
} from "@reviewrouter/platform-db";
import { createPrismaReviewRunControlRepositories } from "../composition/prisma-review-run-control";
import { ResolveReviewSafetyPolicy } from "../application/use-cases/resolve-review-safety-policy";
import { reviewRunAuthorizedEvent } from "../application/integration-events/review-run-authorized-event";
import {
  createReviewRunAuthorization,
  type ReviewRunAuthorizationCandidate,
} from "../domain/review-run-authorization";
import {
  ProducerDistributionKind,
  ProducerReleaseState,
  ReviewCapabilityProfile,
  ReviewProtocolVersion,
  ReviewProviderKind,
  ReviewRunAuthorizationTokenAudience,
  ReviewSafetyDecisionKind,
  ReviewTaskKind,
  ReviewTrustDomain,
  ScmProvider,
} from "../domain/review-run-control-types";
import { ReviewRunAuthorizationCreateStatus } from "../application/ports/review-run-authorization-ports";
import { NodeSha256Digest } from "../infrastructure/node-sha256-digest";
import { reviewRunControlRepositoryContract } from "./support/review-run-control-repository-contract";

const databaseUrl = process.env.REVIEW_ROUTER_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase("review-run-control Prisma adapters", () => {
  const prefix = `review-run-control-test-${randomUUID()}`;
  let prisma: PrismaClient;
  let repositories: ReturnType<typeof createPrismaReviewRunControlRepositories>;

  beforeAll(async () => {
    assertDisposableDatabaseUrl(databaseUrl!);
    prisma = createPrismaClient({ databaseUrl: databaseUrl!, poolMax: 10 });
    repositories = createPrismaReviewRunControlRepositories(prisma);
  });

  afterAll(async () => {
    if (!prisma) return;
    await cleanup();
    await prisma.$disconnect();
  });

  it("rolls replay consumption, authorization, and outbox back as one transaction", async () => {
    const seeded = await seedAtomicAdmissionContext(`${prefix}-atomic`);
    try {
      const authorization = createReviewRunAuthorization(seeded.candidate);
      const event = reviewRunAuthorizedEvent(authorization);
      await prisma.outboxEvent.create({
        data: {
          type: event.type,
          version: event.version,
          idempotencyKey: event.idempotencyKey,
          workspaceId: event.workspaceId,
          repositoryId: event.repositoryId,
          aggregateId: event.aggregateId,
          payload: { conflicting: true },
          occurredAt: event.occurredAt,
        },
      });

      await expect(
        repositories.authorizations.createOrRestoreReviewRunAuthorizationAtomically(
          seeded,
        ),
      ).rejects.toMatchObject({ code: "P2002" });
      await expect(
        prisma.reviewRunAuthorization.findUnique({
          where: { authorizationId: seeded.candidate.authorizationId },
        }),
      ).resolves.toBeNull();

      await prisma.outboxEvent.delete({
        where: { idempotencyKey: event.idempotencyKey },
      });
      const created =
        await repositories.authorizations.createOrRestoreReviewRunAuthorizationAtomically(
          seeded,
        );
      expect(created.status).toBe(ReviewRunAuthorizationCreateStatus.Created);
      await expect(
        repositories.authorizations.createOrRestoreReviewRunAuthorizationAtomically(
          seeded,
        ),
      ).resolves.toMatchObject({
        status: ReviewRunAuthorizationCreateStatus.Restored,
        authorization: { authorizationId: seeded.candidate.authorizationId },
      });
      await expect(
        repositories.authorizations.createOrRestoreReviewRunAuthorizationAtomically(
          {
            ...seeded,
            candidate: {
              ...seeded.candidate,
              headSha: "f".repeat(40),
            },
          },
        ),
      ).resolves.toEqual({
        status: ReviewRunAuthorizationCreateStatus.ReplayConflict,
      });
    } finally {
      await seeded.restoreGlobalEmergencyControl();
      await cleanup();
    }
  });

  reviewRunControlRepositoryContract("Prisma", prefix, async () => ({
    releases: repositories.producerReleases,
    identities: repositories.repositoryIdentities,
    authorities: repositories.mutationAuthorities,
    safety: repositories.safetyControls,
    authorizations: repositories.authorizations,
    prepareRepository,
    async readRepositoryBinding(repositoryConnectionId) {
      const repository = await prisma.repositoryConnection.findUnique({
        where: { id: repositoryConnectionId },
        select: { scmRepositoryIdentityId: true },
      });
      return repository?.scmRepositoryIdentityId;
    },
  }));

  it("expires authorizations and prunes only terminal renewal receipts using database time", async () => {
    const maintenanceId = `${prefix}-maintenance`;
    const authorizationId = `${maintenanceId}-authorization`;
    const renewalReplayKeyHash = fixtureDigest(maintenanceId, "renewal-replay");
    const now = new Date();
    await seedMaintenanceAuthorization({
      maintenanceId,
      authorizationId,
      renewalReplayKeyHash,
      now,
    });

    await expect(
      repositories.authorizations.expireDueReviewRunAuthorizations(10),
    ).resolves.toBeGreaterThanOrEqual(1);
    await prisma.reviewRunAuthorizationRenewalReceipt.update({
      where: { renewalReplayKeyHash },
      data: { createdAt: new Date(now.getTime() - 120_000) },
    });
    await expect(
      repositories.authorizations.pruneRenewalReceipts({
        retentionMs: 60_000,
        batchSize: 10,
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.reviewRunAuthorizationRenewalReceipt.findUnique({
        where: { renewalReplayKeyHash },
      }),
    ).resolves.toBeNull();
    await expect(
      prisma.reviewRunAuthorization.findUnique({
        where: { authorizationId },
        select: { authorizationId: true },
      }),
    ).resolves.toEqual({ authorizationId });
  });

  async function prepareRepository(input: {
    readonly workspaceId: string;
    readonly repositoryConnectionId: string;
    readonly provider: ScmProvider;
    readonly sourceBaseUrl: string;
    readonly externalRepositoryId: string;
  }): Promise<void> {
    await prisma.workspace.upsert({
      where: { id: input.workspaceId },
      create: {
        id: input.workspaceId,
        slug: input.workspaceId,
        name: "Disposable review-run-control contract",
      },
      update: {},
    });
    await prisma.repositoryConnection.create({
      data: {
        id: input.repositoryConnectionId,
        workspaceId: input.workspaceId,
        provider: input.provider,
        sourceBaseUrl: input.sourceBaseUrl,
        externalRepositoryId: input.externalRepositoryId,
        owner: "reviewrouter-test",
        name: input.repositoryConnectionId,
        fullName: `reviewrouter-test/${input.repositoryConnectionId}`,
        defaultBranch: "main",
        visibility: "private",
      },
    });
  }

  async function seedMaintenanceAuthorization(input: {
    readonly maintenanceId: string;
    readonly authorizationId: string;
    readonly renewalReplayKeyHash: string;
    readonly now: Date;
  }): Promise<void> {
    const workspaceId = `${input.maintenanceId}-workspace`;
    const repositoryConnectionId = `${input.maintenanceId}-repository`;
    const scmRepositoryIdentityId = `${input.maintenanceId}-scm`;
    const limitsId = `${input.maintenanceId}-limits`;
    const sloId = `${input.maintenanceId}-slo`;
    const releaseId = `${input.maintenanceId}-release`;
    const limitsDigest = fixtureDigest(limitsId, "profile");
    const sloDigest = fixtureDigest(sloId, "profile");
    const runtimeEntrypointDigest = fixtureDigest(
      releaseId,
      "runtime-entrypoint",
    );
    const schemaDigest = fixtureDigest(releaseId, "schema");
    await prisma.reviewProtocolLimitsV2.create({
      data: {
        protocolLimitsProfileId: limitsId,
        limitsDigest,
        maxWorkSlots: 1,
        maxAttemptsPerSlot: 1,
        maxObservationBytes: 1,
        maxObservationFindings: 1,
        maxProjectionBytes: 1,
        maxProjectionFindings: 1,
        maxPublicationOperations: 1,
        maxPublicationChunks: 1,
        maxPublicationBodyBytes: 1,
        maxRequestBatchSize: 1,
        maxLeaseDurationMs: 1,
        maxResultReportDurationMs: 1,
        maxReconciliationDurationMs: 1,
        registeredAt: input.now,
      },
    });
    await prisma.reviewOperationalSloProfileV2.create({
      data: {
        operationalSloProfileId: sloId,
        sloDigest,
        integrationEventDeliveryMs: 1,
        outboxClaimAgeMs: 1,
        missingCompletionProcessMs: 1,
        dueCompletionProcessMs: 1,
        publicationReconciliationMs: 1,
        v1DrainMs: 1,
        admissionMs: 1,
        pruningBacklogAgeMs: 1,
        ownerRefs: ["test-owner"],
        runbookRefs: ["test-runbook"],
        registeredAt: input.now,
      },
    });
    await prisma.producerRelease.create({
      data: {
        producerReleaseId: releaseId,
        distributionKind: "public_reusable",
        actionCommitSha: "1".repeat(40),
        runtimeCommitSha: "2".repeat(40),
        wrapperEntrypointDigest: null,
        runtimeEntrypointDigest,
        schemaDigest,
        capabilityProfile: "exact_revision_v2",
        protocolLimitsProfileId: limitsId,
        operationalSloProfileId: sloId,
        registeredAt: input.now,
      },
    });
    await prisma.workspace.create({
      data: {
        id: workspaceId,
        slug: workspaceId,
        name: "Disposable review-run-control maintenance",
      },
    });
    await prisma.$transaction(async (transaction) => {
      await transaction.scmRepositoryIdentity.create({
        data: {
          scmRepositoryIdentityId,
          provider: "github",
          normalizedSourceBaseUrl: "https://github.com",
          externalRepositoryId: `${input.maintenanceId}-external`,
          currentWorkspaceId: workspaceId,
          currentRepositoryConnectionId: repositoryConnectionId,
          createdAt: input.now,
          boundAt: input.now,
        },
      });
      await transaction.repositoryConnection.create({
        data: {
          id: repositoryConnectionId,
          workspaceId,
          provider: "github",
          sourceBaseUrl: "https://github.com",
          externalRepositoryId: `${input.maintenanceId}-external`,
          scmRepositoryIdentityId,
          owner: "reviewrouter-test",
          name: input.maintenanceId,
          fullName: `reviewrouter-test/${input.maintenanceId}`,
          defaultBranch: "main",
          visibility: "private",
        },
      });
    });
    await prisma.reviewRunAuthorization.create({
      data: {
        authorizationId: input.authorizationId,
        workspaceId,
        repositoryConnectionId,
        scmRepositoryIdentityId,
        pullRequestNumber: 1,
        sourceRunId: `${input.maintenanceId}-run`,
        sourceRunAttempt: "1",
        workflowIdentityHash: fixtureDigest(input.authorizationId, "workflow"),
        baseSha: "a".repeat(40),
        mergeBaseSha: "b".repeat(40),
        headSha: "c".repeat(40),
        reviewRevisionHash: fixtureDigest(input.authorizationId, "revision"),
        trustDomain: "trusted_managed",
        producerReleaseId: releaseId,
        selectedProtocolVersion: "review_action_v2",
        schemaDigest,
        protocolLimitsProfileId: limitsId,
        operationalSloProfileId: sloId,
        mutationEpoch: 1n,
        providerVoteLanes: [
          {
            providerKind: "codex",
            providerVoteIdentityHash: fixtureDigest(
              input.authorizationId,
              "provider-vote",
            ),
          },
        ],
        authorizationSafetyDecisionHash: fixtureDigest(
          input.authorizationId,
          "authorization-safety",
        ),
        protocolOfferHash: fixtureDigest(
          input.authorizationId,
          "protocol-offer",
        ),
        oidcReplayKeyHash: fixtureDigest(input.authorizationId, "oidc-replay"),
        tokenSigningKeyId: "test-key",
        tokenIssuer: "reviewrouter-review-run-control",
        tokenAudience: "review_run",
        expiresAt: new Date(input.now.getTime() - 180_000),
        maxExpiresAt: new Date(input.now.getTime() - 120_000),
        createdAt: new Date(input.now.getTime() - 240_000),
      },
    });
    await prisma.reviewRunAuthorizationRenewalReceipt.create({
      data: {
        renewalReplayKeyHash: input.renewalReplayKeyHash,
        authorizationId: input.authorizationId,
        renewalProofHash: fixtureDigest(input.authorizationId, "renewal-proof"),
        authorizationVersion: 1,
        renewedExpiresAt: new Date(input.now.getTime() - 180_000),
      },
    });
  }

  async function seedAtomicAdmissionContext(id: string) {
    const now = new Date();
    const workspaceId = `${id}-workspace`;
    const repositoryConnectionId = `${id}-repository`;
    const scmRepositoryIdentityId = `${id}-scm`;
    const limitsId = `${id}-limits`;
    const sloId = `${id}-slo`;
    const releaseId = `${id}-release`;
    const policyId = `${id}-policy`;
    const limitsDigest = fixtureDigest(limitsId, "profile");
    const sloDigest = fixtureDigest(sloId, "profile");
    const runtimeEntrypointDigest = fixtureDigest(
      releaseId,
      "runtime-entrypoint",
    );
    const schemaDigest = fixtureDigest(releaseId, "schema");
    await prisma.workspace.create({
      data: { id: workspaceId, slug: workspaceId, name: "Atomic test" },
    });
    await prisma.reviewProtocolLimitsV2.create({
      data: {
        protocolLimitsProfileId: limitsId,
        limitsDigest,
        maxWorkSlots: 1,
        maxAttemptsPerSlot: 1,
        maxObservationBytes: 1,
        maxObservationFindings: 1,
        maxProjectionBytes: 1,
        maxProjectionFindings: 1,
        maxPublicationOperations: 1,
        maxPublicationChunks: 1,
        maxPublicationBodyBytes: 1,
        maxRequestBatchSize: 1,
        maxLeaseDurationMs: 1,
        maxResultReportDurationMs: 1,
        maxReconciliationDurationMs: 1,
        registeredAt: now,
      },
    });
    await prisma.reviewOperationalSloProfileV2.create({
      data: {
        operationalSloProfileId: sloId,
        sloDigest,
        integrationEventDeliveryMs: 1,
        outboxClaimAgeMs: 1,
        missingCompletionProcessMs: 1,
        dueCompletionProcessMs: 1,
        publicationReconciliationMs: 1,
        v1DrainMs: 1,
        admissionMs: 1,
        pruningBacklogAgeMs: 1,
        ownerRefs: ["test"],
        runbookRefs: ["test"],
        registeredAt: now,
      },
    });
    await prisma.producerRelease.create({
      data: {
        producerReleaseId: releaseId,
        distributionKind: "public_reusable",
        actionCommitSha: "a".repeat(40),
        runtimeCommitSha: "b".repeat(40),
        wrapperEntrypointDigest: null,
        runtimeEntrypointDigest,
        schemaDigest,
        capabilityProfile: "exact_revision_v2",
        protocolLimitsProfileId: limitsId,
        operationalSloProfileId: sloId,
        registeredAt: now,
      },
    });
    await prisma.$transaction(async (transaction) => {
      await transaction.scmRepositoryIdentity.create({
        data: {
          scmRepositoryIdentityId,
          provider: "github",
          normalizedSourceBaseUrl: "https://github.com",
          externalRepositoryId: `${id}-external`,
          currentWorkspaceId: workspaceId,
          currentRepositoryConnectionId: repositoryConnectionId,
          createdAt: now,
          boundAt: now,
        },
      });
      await transaction.repositoryConnection.create({
        data: {
          id: repositoryConnectionId,
          workspaceId,
          provider: "github",
          sourceBaseUrl: "https://github.com",
          externalRepositoryId: `${id}-external`,
          scmRepositoryIdentityId,
          owner: "reviewrouter-test",
          name: id,
          fullName: `reviewrouter-test/${id}`,
          defaultBranch: "main",
          visibility: "private",
        },
      });
    });
    await prisma.reviewMutationAuthority.create({
      data: {
        scmRepositoryIdentityId,
        laneKind: "hosted_reviewrouter_app",
        epoch: 1n,
        mode: "v2_active",
        initializedAt: now,
        activatedAt: now,
      },
    });
    await prisma.reviewSafetyPolicy.create({
      data: {
        policyId,
        policyScope: "global",
        capability: "run_authorization_v2",
        workspaceId: null,
        repositoryConnectionId: null,
        scmRepositoryIdentityId: null,
        rolloutMode: "enabled",
        updatedBy: "test",
        updatedAt: now,
      },
    });
    const globalEmergencyControl =
      await prisma.reviewSafetyEmergencyControl.findFirst({
        where: { policyScope: "global" },
      });
    if (!globalEmergencyControl) {
      throw new Error("migration_global_emergency_control_missing");
    }
    const openedEmergencyVersion = globalEmergencyControl.version + 1;
    const opened = await prisma.reviewSafetyEmergencyControl.updateMany({
      where: {
        emergencyControlId: globalEmergencyControl.emergencyControlId,
        version: globalEmergencyControl.version,
      },
      data: {
        version: openedEmergencyVersion,
        stopped: false,
        reason: "atomic-admission-test",
        updatedBy: "review-run-control-real-test",
        updatedAt: now,
      },
    });
    if (opened.count !== 1) {
      throw new Error("migration_global_emergency_control_open_conflict");
    }
    const safetyTarget = {
      workspaceId,
      repositoryConnectionId,
      scmRepositoryIdentityId,
      providerTasks: [
        {
          providerKind: ReviewProviderKind.Codex,
          taskKind: ReviewTaskKind.CodeReview,
        },
      ],
    } as const;
    const safetySnapshot = await new ResolveReviewSafetyPolicy({
      clock: { now: () => now },
      digest: new NodeSha256Digest(),
      policyQueries: repositories.safetyControls,
      emergencyQueries: repositories.safetyControls,
    }).resolveReviewSafetyPolicy({
      decisionKind: ReviewSafetyDecisionKind.RunAuthorization,
      target: safetyTarget,
    });
    const candidate: ReviewRunAuthorizationCandidate = {
      authorizationId: `${id}-authorization`,
      workspaceId,
      repositoryConnectionId,
      scmRepositoryIdentityId,
      pullRequestNumber: 42,
      sourceRunId: `${id}-run`,
      sourceRunAttempt: "1",
      workflowIdentityHash: fixtureDigest(id, "workflow"),
      baseSha: "c".repeat(40),
      mergeBaseSha: "d".repeat(40),
      headSha: "e".repeat(40),
      reviewRevisionHash: fixtureDigest(id, "revision"),
      trustDomain: ReviewTrustDomain.TrustedManaged,
      producerReleaseId: releaseId,
      selectedProtocolVersion: ReviewProtocolVersion.V2,
      schemaDigest,
      protocolLimitsProfileId: limitsId,
      operationalSloProfileId: sloId,
      mutationEpoch: 1n,
      providerVoteLanes: [
        {
          providerKind: ReviewProviderKind.Codex,
          providerVoteIdentityHash: fixtureDigest(id, "provider-vote"),
        },
      ],
      authorizationSafetyDecisionHash: safetySnapshot.safetyDecisionHash,
      protocolOfferHash: fixtureDigest(id, "protocol-offer"),
      oidcReplayKeyHash: fixtureDigest(id, "oidc-replay"),
      tokenSigningKeyId: "test-key",
      tokenIssuer: "reviewrouter-review-run-control",
      tokenAudience: ReviewRunAuthorizationTokenAudience.ReviewRun,
      expiresAt: new Date(now.getTime() + 60_000),
      maxExpiresAt: new Date(now.getTime() + 120_000),
      createdAt: now,
    };
    return {
      candidate,
      fence: {
        repositoryIdentityVersion: 1,
        mutationAuthorityVersion: 1,
        producerRelease: {
          producerReleaseId: releaseId,
          distributionKind: ProducerDistributionKind.PublicReusable,
          actionCommitSha: "a".repeat(40),
          runtimeCommitSha: "b".repeat(40),
          wrapperEntrypointDigest: null,
          runtimeEntrypointDigest,
          schemaDigest,
          capabilityProfile: ReviewCapabilityProfile.ExactRevisionV2,
          protocolLimitsProfileId: limitsId,
          operationalSloProfileId: sloId,
          state: ProducerReleaseState.Registered,
          registeredAt: now,
          revokedAt: null,
        },
        protocolLimitsDigest: limitsDigest,
        operationalSloDigest: sloDigest,
        safetySnapshot,
        safetyTarget,
      },
      async restoreGlobalEmergencyControl() {
        const restored = await prisma.reviewSafetyEmergencyControl.updateMany({
          where: {
            emergencyControlId: globalEmergencyControl.emergencyControlId,
            version: openedEmergencyVersion,
          },
          data: {
            version: globalEmergencyControl.version,
            stopped: globalEmergencyControl.stopped,
            reason: globalEmergencyControl.reason,
            updatedBy: globalEmergencyControl.updatedBy,
            updatedAt: globalEmergencyControl.updatedAt,
          },
        });
        if (restored.count !== 1) {
          throw new Error(
            "migration_global_emergency_control_restore_conflict",
          );
        }
      },
    };
  }

  async function cleanup(): Promise<void> {
    await prisma.outboxEvent.deleteMany({
      where: { aggregateId: { startsWith: prefix } },
    });
    await prisma.reviewRunAuthorizationRenewalReceipt.deleteMany({
      where: { authorizationId: { startsWith: prefix } },
    });
    await prisma.reviewRunAuthorization.deleteMany({
      where: { authorizationId: { startsWith: prefix } },
    });
    await prisma.reviewSafetyPolicySelector.deleteMany({
      where: { policyId: { startsWith: prefix } },
    });
    await prisma.reviewSafetyPolicy.deleteMany({
      where: { policyId: { startsWith: prefix } },
    });
    await prisma.reviewSafetyEmergencyControl.deleteMany({
      where: { emergencyControlId: { startsWith: prefix } },
    });
    await prisma.reviewMutationAuthority.deleteMany({
      where: { scmRepositoryIdentityId: { startsWith: prefix } },
    });
    await prisma.$transaction(async (transaction) => {
      await transaction.scmRepositoryIdentity.updateMany({
        where: { scmRepositoryIdentityId: { startsWith: prefix } },
        data: {
          currentWorkspaceId: null,
          currentRepositoryConnectionId: null,
        },
      });
      await transaction.repositoryConnection.updateMany({
        where: { id: { startsWith: prefix } },
        data: { scmRepositoryIdentityId: null },
      });
    });
    await prisma.repositoryConnection.deleteMany({
      where: { id: { startsWith: prefix } },
    });
    await prisma.scmRepositoryIdentity.deleteMany({
      where: { scmRepositoryIdentityId: { startsWith: prefix } },
    });
    await prisma.workspace.deleteMany({
      where: { id: { startsWith: prefix } },
    });
    await prisma.producerRelease.deleteMany({
      where: { producerReleaseId: { startsWith: prefix } },
    });
    await prisma.reviewOperationalSloProfileV2.deleteMany({
      where: { operationalSloProfileId: { startsWith: prefix } },
    });
    await prisma.reviewProtocolLimitsV2.deleteMany({
      where: { protocolLimitsProfileId: { startsWith: prefix } },
    });
  }
});

function assertDisposableDatabaseUrl(value: string): void {
  const databaseName = decodeURIComponent(new URL(value).pathname.slice(1));
  if (!databaseName || !databaseName.toLowerCase().includes("test")) {
    throw new Error("review_run_control_real_test_requires_disposable_test_db");
  }
}

function fixtureDigest(scope: string, field: string): string {
  return createHash("sha256")
    .update("review-run-control-prisma-fixture\0")
    .update(scope)
    .update("\0")
    .update(field)
    .digest("hex");
}
