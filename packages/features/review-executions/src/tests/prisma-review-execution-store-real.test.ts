import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createPrismaClient,
  type PrismaClient,
} from "@reviewrouter/platform-db";
import { PrismaReviewExecutionStore } from "../infrastructure/prisma/prisma-review-execution-store";
import { PrismaReviewRequestedIntentStore } from "../infrastructure/prisma/prisma-review-requested-intent-store";
import { ReviewRequestedTriggerKind } from "../domain/review-requested-intent";
import {
  leaseCommand,
  prepareAndAdmit,
  prepareCommand,
  runReviewExecutionStoreContract,
  type ReviewExecutionStoreContractHarness,
  workSlot,
} from "../testing/review-execution-store-contract";

const databaseUrl = process.env.REVIEW_ROUTER_TEST_DATABASE_URL;
let prisma: PrismaClient;
const currentWorkspaceIds = new Set<string>();
const limitsProfileId = "limits-contract";
const sloProfileId = "slo-contract";

if (databaseUrl) {
  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl, poolMax: 8 });
    await seedSharedProfiles();
  });

  afterEach(async () => {
    for (const workspaceId of currentWorkspaceIds) {
      await cleanupScope(workspaceId);
    }
    currentWorkspaceIds.clear();
  });

  afterAll(async () => {
    await prisma.reviewProtocolLimitsV2.deleteMany({
      where: { protocolLimitsProfileId: limitsProfileId },
    });
    await prisma.reviewOperationalSloProfileV2.deleteMany({
      where: { operationalSloProfileId: sloProfileId },
    });
    await prisma.$disconnect();
  });

  runReviewExecutionStoreContract("Prisma", createHarness);

  describe("Prisma review execution PostgreSQL invariants", () => {
    it("serializes concurrent prepare attempts without allocating duplicate executions", async () => {
      const harness = await createHarness();
      const command = prepareCommand(harness, "concurrent-prepare", [
        workSlot("slot-concurrent-prepare", 6),
      ]);

      const results = await Promise.all([
        harness.executions.prepareExecution(command),
        harness.executions.prepareExecution(command),
      ]);
      expect(
        results.filter((result) => result.status === "prepared"),
      ).toHaveLength(1);
      expect(
        results.every((result) =>
          ["prepared", "restored", "concurrency_conflict"].includes(
            result.status,
          ),
        ),
      ).toBe(true);
      await expect(
        prisma.reviewExecutionV2.count({
          where: {
            workspaceId: harness.scope.workspaceId,
            startIdentityHash: command.startIdentityHash,
          },
        }),
      ).resolves.toBe(1);
      await expect(
        prisma.reviewExecutionStreamV2.findFirstOrThrow({
          where: { workspaceId: harness.scope.workspaceId },
          select: { lastAllocatedGeneration: true },
        }),
      ).resolves.toEqual({ lastAllocatedGeneration: 1n });
    });

    it("serializes concurrent requested intents into one pending successor", async () => {
      const harness = await createHarness();
      const intentStore =
        harness.requestedIntents as PrismaReviewRequestedIntentStore;
      const now = new Date();
      const candidate = (identity: string, index: number) => ({
        ...harness.scope,
        requestId: `request-concurrent-${identity}-${randomUUID()}`,
        revision: {
          baseSha: "a".repeat(40),
          mergeBaseSha: "b".repeat(40),
          headSha: "c".repeat(40),
          reviewRevisionHash: hash(1),
        },
        triggerKind: ReviewRequestedTriggerKind.PullRequestSynchronized,
        deliveryIdentityHash: hash(index),
        canonicalRequestHash: hash(index + 1),
        notBefore: now,
        createdAt: now,
        retainUntil: new Date(now.getTime() + 86_400_000),
      });
      const first = candidate("first", 7);
      const second = candidate("second", 10);

      const results = await Promise.all([
        intentStore.registerIntent({ candidate: first }),
        intentStore.registerIntent({ candidate: second }),
      ]);
      expect(results.every((result) => result.status === "registered")).toBe(
        true,
      );
      const records = await prisma.reviewRequestedIntent.findMany({
        where: { workspaceId: harness.scope.workspaceId },
        orderBy: { requestId: "asc" },
      });
      expect(records).toHaveLength(2);
      expect(
        records.filter((record) => record.state === "pending_dispatch"),
      ).toHaveLength(1);
      const superseded = records.find(
        (record) => record.state === "superseded",
      );
      expect(superseded?.supersededByRequestId).toBe(
        records.find((record) => record.state === "pending_dispatch")
          ?.requestId,
      );
    });

    it("fails closed instead of truncating an oversized aggregate", async () => {
      const harness = await createHarness();
      const store = harness.executions as PrismaReviewExecutionStore;
      const now = new Date();
      const executionId = `execution-oversized-${randomUUID()}`;
      await prisma.reviewExecutionV2.create({
        data: {
          executionId,
          ...harness.scope,
          generation: 1n,
          version: 1n,
          baseSha: "a".repeat(40),
          mergeBaseSha: "b".repeat(40),
          headSha: "c".repeat(40),
          reviewRevisionHash: hash(1),
          compatibilityKey: "compatibility-v1",
          planHash: hash(2),
          startIdentityHash: hash(3),
          canonicalStartHash: hash(4),
          state: "failed",
          authorizationId: harness.authorizationId,
          producerReleaseId: harness.producerReleaseId,
          mutationEpoch: 1n,
          admissionSafetyDecisionHash: hash(5),
          protocolLimitsProfileId: limitsProfileId,
          sourceRunId: "run-oversized",
          sourceRunAttempt: "1",
          createdAt: now,
          updatedAt: now,
          admissionDeadlineAt: new Date(now.getTime() + 60_000),
          executionDeadlineAt: new Date(now.getTime() + 600_000),
          retainUntil: new Date(now.getTime() + 86_400_000),
        },
      });
      await prisma.reviewExecutionWorkSlotV2.createMany({
        data: Array.from({ length: 257 }, (_, planOrdinal) => ({
          executionId,
          workSlotId: `slot-oversized-${planOrdinal}`,
          planOrdinal,
          taskKind: "finding_discovery" as const,
          providerKind: "codex" as const,
          providerVoteIdentityHash: hash(6),
          shardKey: `shard-oversized-${planOrdinal}`,
          required: true,
          attemptBudget: 1,
          retryPolicyVersion: "retry-v1",
          state: "cancelled" as const,
          nextAttemptOrdinal: 1,
        })),
      });

      await expect(store.findExecution(executionId)).rejects.toThrow(
        "review_execution_unbounded_work_slots",
      );
    });

    it("compacts terminal lease identities before ordered execution pruning", async () => {
      const harness = await createHarness();
      const store = harness.executions as PrismaReviewExecutionStore;
      const now = new Date();
      const executionId = `execution-prune-${randomUUID()}`;
      const leaseId = `lease-prune-${randomUUID()}`;
      await prisma.reviewExecutionStreamV2.create({
        data: {
          ...harness.scope,
          version: 2n,
          lastAllocatedGeneration: 1n,
          updatedAt: now,
        },
      });
      await prisma.reviewExecutionV2.create({
        data: {
          executionId,
          ...harness.scope,
          generation: 1n,
          version: 2n,
          baseSha: "a".repeat(40),
          mergeBaseSha: "b".repeat(40),
          headSha: "c".repeat(40),
          reviewRevisionHash: hash(1),
          compatibilityKey: "compatibility-v1",
          planHash: hash(2),
          startIdentityHash: hash(3),
          canonicalStartHash: hash(4),
          state: "superseded",
          authorizationId: harness.authorizationId,
          producerReleaseId: harness.producerReleaseId,
          mutationEpoch: 1n,
          admissionSafetyDecisionHash: hash(5),
          protocolLimitsProfileId: limitsProfileId,
          sourceRunId: "run-prune",
          sourceRunAttempt: "1",
          createdAt: new Date(now.getTime() - 120_000),
          updatedAt: new Date(now.getTime() - 90_000),
          admissionDeadlineAt: new Date(now.getTime() - 110_000),
          admissionCheckedAt: new Date(now.getTime() - 100_000),
          executionDeadlineAt: new Date(now.getTime() - 80_000),
          retainUntil: new Date(now.getTime() - 60_000),
        },
      });
      await prisma.reviewExecutionWorkSlotV2.create({
        data: {
          executionId,
          workSlotId: "slot-prune",
          planOrdinal: 0,
          taskKind: "finding_discovery",
          providerKind: "codex",
          providerVoteIdentityHash: hash(6),
          shardKey: "shard-prune",
          required: true,
          attemptBudget: 1,
          retryPolicyVersion: "retry-v1",
          state: "cancelled",
          nextAttemptOrdinal: 2,
        },
      });
      await prisma.reviewInvocationLeaseV2.create({
        data: {
          leaseId,
          ...harness.scope,
          executionId,
          executionGeneration: 1n,
          providerInvocationKey: hash(7),
          preparedManifestCanonicalJson: '{"manifestVersion":1}',
          preparedManifestKey: hash(11),
          providerVoteIdentityHash: hash(6),
          workSlotId: "slot-prune",
          purpose: "provider_execution",
          authorizationId: harness.authorizationId,
          producerReleaseId: harness.producerReleaseId,
          reviewRevisionHash: hash(1),
          mutationEpoch: 1n,
          leaseSafetyDecisionHash: hash(8),
          attemptId: `attempt-prune-${randomUUID()}`,
          attemptOrdinal: 1,
          acquireRequestIdHash: hash(9),
          acquireRequestHash: hash(10),
          ownerIdHash: "owner-prune",
          leaseCapabilityId: `capability-prune-${randomUUID()}`,
          capabilitySigningKeyId: "key-prune",
          state: "released",
          acquiredAt: new Date(now.getTime() - 120_000),
          renewedAt: new Date(now.getTime() - 120_000),
          expiresAt: new Date(now.getTime() - 110_000),
          resultReportUntil: new Date(now.getTime() - 100_000),
          retainUntil: new Date(now.getTime() - 90_000),
        },
      });
      await prisma.reviewRunAuthorization.update({
        where: { authorizationId: harness.authorizationId },
        data: {
          state: "expired",
          createdAt: new Date(now.getTime() - 7_200_000),
          expiresAt: new Date(now.getTime() - 3_600_000),
        },
      });

      const result = await store.pruneRetainedHistory({ limit: 10 });
      expect(result).toMatchObject({
        compactedLeases: 1,
        deletedWorkSlots: 1,
        deletedExecutions: 1,
      });
      await expect(
        prisma.reviewInvocationLeaseTombstoneV2.findUnique({
          where: { leaseId },
        }),
      ).resolves.toMatchObject({
        leaseId,
        terminalState: "released",
      });
      await expect(
        prisma.reviewExecutionV2.findUnique({ where: { executionId } }),
      ).resolves.toBeNull();
    });

    it("uses database time rather than a caller-supplied future claim clock", async () => {
      const harness = await createHarness();
      const intent = harness.requestedIntents;
      const now = new Date();
      const candidate = {
        ...harness.scope,
        requestId: `request-db-time-${randomUUID()}`,
        revision: {
          baseSha: "a".repeat(40),
          mergeBaseSha: "b".repeat(40),
          headSha: "c".repeat(40),
          reviewRevisionHash: hash(1),
        },
        triggerKind: ReviewRequestedTriggerKind.ManualCommand,
        deliveryIdentityHash: hash(11),
        canonicalRequestHash: hash(12),
        notBefore: now,
        createdAt: now,
        retainUntil: new Date(now.getTime() + 60_000),
      };
      await intent.registerIntent({ candidate });
      const callerNow = new Date(now.getTime() + 86_400_000);
      const result = await intent.claimIntent({
        requestId: candidate.requestId,
        claimId: "claim-db-time",
        ownerIdHash: "owner-db-time",
        now: callerNow,
        claimUntil: new Date(callerNow.getTime() + 30_000),
      });
      expect(result.status).toBe("claimed");
      expect(result.intent?.claim?.claimedAt.getTime()).toBeLessThan(
        now.getTime() + 5_000,
      );
    });

    it("anchors lease and report windows to database time", async () => {
      const harness = await createHarness();
      const running = await prepareAndAdmit(harness, "lease-db-time");
      const actualNow = new Date();
      const callerNow = new Date(actualNow.getTime() + 86_400_000);
      const command = {
        ...leaseCommand(harness, running.snapshot, "lease-db-time"),
        now: callerNow,
        expiresAt: new Date(callerNow.getTime() + 30_000),
        resultReportUntil: new Date(callerNow.getTime() + 90_000),
        retainUntil: new Date(callerNow.getTime() + 86_400_000),
      };

      const result = await harness.executions.acquireLease(command);
      expect(result.status).toBe("acquired");
      expect(result.lease?.acquiredAt.getTime()).toBeLessThan(
        actualNow.getTime() + 5_000,
      );
      expect(
        result.lease!.expiresAt.getTime() - result.lease!.acquiredAt.getTime(),
      ).toBe(30_000);
      expect(
        result.lease!.resultReportUntil.getTime() -
          result.lease!.acquiredAt.getTime(),
      ).toBe(90_000);
    });

    it("preserves absolute renewal deadlines across caller clock skew", async () => {
      const harness = await createHarness();
      const running = await prepareAndAdmit(harness, "renew-db-time");
      const command = leaseCommand(harness, running.snapshot, "renew-db-time");
      const acquired = await harness.executions.acquireLease({
        ...command,
        expiresAt: new Date(Date.now() + 30_000),
        resultReportUntil: new Date(Date.now() + 90_000),
      });
      const lease = acquired.lease!;
      const skewedNow = new Date(Date.now() + 5_000);
      const requestedExpiresAt = new Date(lease.expiresAt.getTime() + 10_000);

      const renewed = await harness.executions.renewLease({
        leaseId: lease.leaseId,
        ownerIdHash: lease.ownerIdHash,
        leaseCapabilityId: lease.leaseCapabilityId,
        fencingToken: lease.fencingToken,
        renewRequestIdHash: hash(13),
        renewRequestHash: hash(14),
        now: skewedNow,
        expiresAt: requestedExpiresAt,
        resultReportUntil: lease.resultReportUntil,
        limits: command.limits,
      });

      expect(renewed.status).toBe("applied");
      expect(renewed.lease?.expiresAt).toEqual(requestedExpiresAt);
      expect(renewed.lease?.resultReportUntil).toEqual(lease.resultReportUntil);
    });

    it("serializes one provider lane across concurrent pull-request scopes", async () => {
      const first = await createHarness();
      const second = await createHarness();
      const firstRunning = await prepareAndAdmit(first, "provider-lane-a");
      const secondRunning = await prepareAndAdmit(second, "provider-lane-b");
      const firstCommand = leaseCommand(
        first,
        firstRunning.snapshot,
        "provider-lane-a",
      );
      const secondCommand = leaseCommand(
        second,
        secondRunning.snapshot,
        "provider-lane-b",
      );
      expect(firstCommand.providerVoteIdentityHash).toBe(
        secondCommand.providerVoteIdentityHash,
      );

      const results = await Promise.all([
        first.executions.acquireLease(firstCommand),
        second.executions.acquireLease(secondCommand),
      ]);

      expect(
        results.filter((result) => result.status === "acquired"),
      ).toHaveLength(1);
      expect(results.filter((result) => result.status === "busy")).toHaveLength(
        1,
      );
      await expect(
        prisma.reviewInvocationLeaseV2.count({
          where: {
            providerVoteIdentityHash: firstCommand.providerVoteIdentityHash,
            purpose: "provider_execution",
            state: "active",
          },
        }),
      ).resolves.toBe(1);
    });

    it("prunes terminal requested intents only after retention expires", async () => {
      const harness = await createHarness();
      const intentStore =
        harness.requestedIntents as PrismaReviewRequestedIntentStore;
      const running = await prepareAndAdmit(harness, "intent-prune");
      const now = new Date();
      const requestId = `request-prune-${randomUUID()}`;
      const candidate = {
        ...harness.scope,
        requestId,
        revision: {
          baseSha: "a".repeat(40),
          mergeBaseSha: "b".repeat(40),
          headSha: "c".repeat(40),
          reviewRevisionHash: hash(1),
        },
        triggerKind: ReviewRequestedTriggerKind.ManualCommand,
        deliveryIdentityHash: hashFromText(`delivery-${requestId}`),
        canonicalRequestHash: hashFromText(`request-${requestId}`),
        notBefore: now,
        createdAt: now,
        retainUntil: new Date(now.getTime() + 60_000),
      } as const;
      await intentStore.registerIntent({ candidate });
      const claimed = await intentStore.claimIntent({
        requestId,
        claimId: `claim-${requestId}`,
        ownerIdHash: `owner-${requestId}`,
        now,
        claimUntil: new Date(now.getTime() + 30_000),
      });
      const claim = claimed.intent!.claim!;
      await intentStore.beginSubmission({
        requestId,
        claimId: claim.claimId,
        ownerIdHash: claim.ownerIdHash,
        fencingToken: claim.fencingToken,
        now,
        nextResolutionAt: new Date(now.getTime() + 1_000),
        resolutionDeadlineAt: new Date(now.getTime() + 60_000),
      });
      await intentStore.recordDispatch({
        requestId,
        claimId: claim.claimId,
        ownerIdHash: claim.ownerIdHash,
        fencingToken: claim.fencingToken,
        sourceRunId: `run-${requestId}`,
        sourceRunAttempt: "1",
        now,
        nextResolutionAt: new Date(now.getTime() + 1_000),
        resolutionDeadlineAt: new Date(now.getTime() + 60_000),
      });
      await intentStore.linkAdmission({
        requestId,
        sourceRunId: `run-${requestId}`,
        sourceRunAttempt: "1",
        authorizationId: harness.authorizationId,
        executionId: running.snapshot.execution.executionId,
        revision: candidate.revision,
        now,
      });

      await expect(
        intentStore.pruneRetainedIntents({ limit: 10 }),
      ).resolves.toBe(0);
      await prisma.reviewRequestedIntent.update({
        where: { requestId },
        data: { retainUntil: new Date(now.getTime() - 1_000) },
      });
      await expect(
        intentStore.pruneRetainedIntents({ limit: 10 }),
      ).resolves.toBe(1);
      await expect(intentStore.findByRequestId(requestId)).resolves.toBeNull();
    });
  });
} else {
  describe.skip("Prisma review execution PostgreSQL contracts", () => {
    it("requires REVIEW_ROUTER_TEST_DATABASE_URL", () => undefined);
  });
}

async function createHarness(): Promise<ReviewExecutionStoreContractHarness> {
  const suffix = randomUUID();
  const workspaceId = `execution-workspace-${suffix}`;
  const repositoryConnectionId = `execution-repository-${suffix}`;
  const scmRepositoryIdentityId = `execution-scm-${suffix}`;
  const producerReleaseId = `execution-release-${suffix}`;
  const authorizationId = `execution-authorization-${suffix}`;
  const producerSchemaDigest = hashFromText(`schema-${suffix}`);
  currentWorkspaceIds.add(workspaceId);
  const now = new Date();

  await prisma.workspace.create({
    data: { id: workspaceId, slug: workspaceId, name: workspaceId },
  });
  await prisma.scmRepositoryIdentity.create({
    data: {
      scmRepositoryIdentityId,
      provider: "github",
      normalizedSourceBaseUrl: "https://github.com",
      externalRepositoryId: `external-${suffix}`,
      createdAt: now,
    },
  });
  await prisma.repositoryConnection.create({
    data: {
      id: repositoryConnectionId,
      workspaceId,
      provider: "github",
      sourceBaseUrl: "https://github.com",
      externalRepositoryId: `external-${suffix}`,
      scmRepositoryIdentityId,
      owner: "reviewrouter-test",
      name: `execution-${suffix}`,
      fullName: `reviewrouter-test/execution-${suffix}`,
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
  await prisma.producerRelease.create({
    data: {
      producerReleaseId,
      distributionKind: "hosted_composite",
      actionCommitSha: hashFromText(`action-${suffix}`).slice(0, 40),
      runtimeCommitSha: hashFromText(`runtime-${suffix}`).slice(0, 40),
      wrapperEntrypointDigest: hashFromText(`wrapper-${suffix}`),
      runtimeEntrypointDigest: hashFromText(`entrypoint-${suffix}`),
      schemaDigest: producerSchemaDigest,
      capabilityProfile: "execution-contract",
      protocolLimitsProfileId: limitsProfileId,
      operationalSloProfileId: sloProfileId,
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
      sourceRunId: `run-${suffix}`,
      sourceRunAttempt: "1",
      workflowIdentityHash: hash(0),
      baseSha: "a".repeat(40),
      mergeBaseSha: "b".repeat(40),
      headSha: "c".repeat(40),
      reviewRevisionHash: hash(1),
      trustDomain: "trusted_managed",
      producerReleaseId,
      selectedProtocolVersion: "review-action-v2",
      schemaDigest: producerSchemaDigest,
      protocolLimitsProfileId: limitsProfileId,
      operationalSloProfileId: sloProfileId,
      mutationEpoch: 1n,
      providerVoteLanes: [],
      authorizationSafetyDecisionHash: hash(2),
      protocolOfferHash: hash(3),
      oidcReplayKeyHash: hashFromText(`oidc-${suffix}`),
      tokenSigningKeyId: "contract-key",
      tokenIssuer: "reviewrouter-contract",
      tokenAudience: "review-run",
      state: "active",
      expiresAt: new Date(now.getTime() + 3_600_000),
      maxExpiresAt: new Date(now.getTime() + 7_200_000),
      createdAt: now,
    },
  });

  const executions = new PrismaReviewExecutionStore(prisma);
  const requestedIntents = new PrismaReviewRequestedIntentStore(prisma);
  return {
    executions,
    requestedIntents,
    scope: {
      workspaceId,
      repositoryConnectionId,
      scmRepositoryIdentityId,
      pullRequestNumber: 42,
    },
    authorizationId,
    producerReleaseId,
    ensureObservation: async (input) => {
      await prisma.reviewEvidenceObservation.create({
        data: {
          observationId: input.observationId,
          workspaceId,
          repositoryConnectionId,
          scmRepositoryIdentityId,
          pullRequestNumber: 42,
          manifestKey: hash(4),
          providerInvocationKey: input.providerInvocationKey,
          providerVoteIdentityHash: input.providerVoteIdentityHash,
          manifestVersion: 1,
          providerKind: "codex",
          requestedModel: "gpt-contract",
          actualModel: "gpt-contract",
          providerRuntimeVersion: "contract-v1",
          taskKindSet: ["finding_discovery"],
          producerReleaseId,
          selectedProtocolVersion: "review-action-v2",
          trustedCapabilityProfile: "execution-contract",
          executionProfile: "prompt_only_envelope_v1",
          trustDomain: "trusted_managed",
          authorizationScopeHash: hash(5),
          sourceBaseSha: "a".repeat(40),
          sourceMergeBaseSha: "b".repeat(40),
          sourceHeadSha: "c".repeat(40),
          sourceReviewRevisionHash: hash(1),
          sourcePlanHash: hash(3),
          sourceExecutionId: input.executionId,
          sourceWorkSlotId: input.workSlotId,
          sourceAuthorizationId: authorizationId,
          evidenceWriteSafetyDecisionHash: hash(6),
          sourceRunId: `run-${suffix}`,
          sourceRunAttempt: "1",
          attemptId: input.attemptId,
          sourceLeaseId: input.leaseId,
          sourceFencingToken: input.fencingToken,
          payloadJson: {
            payloadVersion: 2,
            normalizedFindings: [],
            normalizedLifecycleRevalidations: [],
            safeUsage: {
              inputTokens: null,
              outputTokens: null,
              totalTokens: null,
            },
          },
          payloadHash: input.payloadHash,
          byteCount: 2,
          findingCount: 0,
          qualityFlagsJson: [],
          transportAttemptCount: 1,
          createdAt: input.createdAt,
          reuseExpiresAt: new Date(input.createdAt.getTime() + 60_000),
          retainUntil: new Date(input.createdAt.getTime() + 86_400_000),
        },
      });
    },
  };
}

async function seedSharedProfiles(): Promise<void> {
  const now = new Date();
  await prisma.reviewProtocolLimitsV2.upsert({
    where: { protocolLimitsProfileId: limitsProfileId },
    update: {},
    create: {
      protocolLimitsProfileId: limitsProfileId,
      limitsDigest: hashFromText(`limits-${randomUUID()}`),
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
      sloDigest: hashFromText(`slo-${randomUUID()}`),
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
}

async function cleanupScope(workspaceId: string): Promise<void> {
  const executions = await prisma.reviewExecutionV2.findMany({
    where: { workspaceId },
    select: { executionId: true },
  });
  const executionIds = executions.map((entry) => entry.executionId);
  await prisma.reviewRequestedIntent.deleteMany({ where: { workspaceId } });
  if (executionIds.length > 0) {
    await prisma.reviewExecutionObservationRefV2.deleteMany({
      where: { executionId: { in: executionIds } },
    });
    await prisma.finalizedReviewProjectionArtifactV2.deleteMany({
      where: { executionId: { in: executionIds } },
    });
  }
  await prisma.reviewEvidenceObservation.deleteMany({ where: { workspaceId } });
  await prisma.reviewInvocationLeaseV2.deleteMany({ where: { workspaceId } });
  await prisma.reviewInvocationLeaseTombstoneV2.deleteMany({
    where: {
      authorizationId: {
        startsWith: "execution-authorization-",
      },
    },
  });
  if (executionIds.length > 0) {
    await prisma.reviewExecutionWorkSlotV2.deleteMany({
      where: { executionId: { in: executionIds } },
    });
  }
  await prisma.reviewExecutionV2.deleteMany({ where: { workspaceId } });
  await prisma.reviewExecutionStreamV2.deleteMany({ where: { workspaceId } });
  const authorizations = await prisma.reviewRunAuthorization.findMany({
    where: { workspaceId },
    select: { producerReleaseId: true },
  });
  await prisma.reviewRunAuthorization.deleteMany({ where: { workspaceId } });
  await prisma.producerRelease.deleteMany({
    where: {
      producerReleaseId: {
        in: authorizations.map((entry) => entry.producerReleaseId),
      },
    },
  });
  const repository = await prisma.repositoryConnection.findFirst({
    where: { workspaceId },
  });
  if (repository !== null) {
    await prisma.scmRepositoryIdentity.updateMany({
      where: {
        scmRepositoryIdentityId: repository.scmRepositoryIdentityId ?? "",
      },
      data: {
        currentWorkspaceId: null,
        currentRepositoryConnectionId: null,
        unboundAt: new Date(),
      },
    });
    await prisma.repositoryConnection.delete({ where: { id: repository.id } });
    if (repository.scmRepositoryIdentityId !== null) {
      await prisma.scmRepositoryIdentity.delete({
        where: { scmRepositoryIdentityId: repository.scmRepositoryIdentityId },
      });
    }
  }
  await prisma.workspace.delete({ where: { id: workspaceId } });
}

function hash(index: number): string {
  return "0123456789abcdef"[index % 16]!.repeat(64);
}

function hashFromText(value: string): string {
  return Buffer.from(value).toString("hex").slice(0, 64).padEnd(64, "0");
}
