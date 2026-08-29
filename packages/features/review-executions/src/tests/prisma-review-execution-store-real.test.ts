import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createPrismaClient,
  type PrismaClient,
} from "@reviewrouter/platform-db";
import { PrismaReviewExecutionStore } from "../infrastructure/prisma/prisma-review-execution-store";
import {
  AcquireOrJoinInvocationFlight,
  AcquireOrJoinInvocationFlightStatus,
} from "../application/use-cases/acquire-or-join-invocation-flight";
import { isTransactionConflictError } from "../infrastructure/prisma/prisma-review-execution-utils";
import { PrismaReviewRequestedIntentStore } from "../infrastructure/prisma/prisma-review-requested-intent-store";
import {
  ReviewRequestAdmissionState,
  ReviewRequestedIntentState,
  ReviewRequestedTriggerKind,
} from "../domain/review-requested-intent";
import {
  ReviewExecutionAdmissionStatus,
  ReviewExecutionAdmissionVerdict,
  ReviewExecutionFinalizeStatus,
  ReviewExecutionPrepareStatus,
} from "../application/ports/review-execution-ports";
import {
  ReviewRequestedClaimStatus,
  ReviewRequestedRegisterStatus,
  ReviewRequestedTransitionStatus,
} from "../application/ports/review-requested-intent-ports";
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

      const results = await settleConcurrent([
        harness.executions.prepareExecution(command),
        harness.executions.prepareExecution(command),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual([
        "prepared",
        "restored",
      ]);
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

    it("finalizes the same content-addressed artifact for two executions and restores retries", async () => {
      const harness = await createHarness();
      const suffix = randomUUID();
      const first = await prepareAndAdmit(
        harness,
        `shared-artifact-first-${suffix}`,
      );
      const artifactId = `artifact-shared-${suffix}`;
      const artifactHash = hash(11);
      const projectionEnvelopeJson = '{"findings":[]}';
      const commandFor = (snapshot: typeof first.snapshot) =>
        ({
          scope: harness.scope,
          executionId: snapshot.execution.executionId,
          expectedStreamVersion: snapshot.stream.version,
          expectedExecutionVersion: snapshot.execution.version,
          artifactId,
          artifactHash,
          projectionEnvelopeVersion: 1,
          projectionEnvelopeJson,
          projectionHash: hash(12),
          byteCount: new TextEncoder().encode(projectionEnvelopeJson)
            .byteLength,
          findingCount: 0,
          lifecycleStateHash: hash(13),
          commandLedgerWatermark: 7n,
          projectionPolicyVersion: "projection-v1",
          publicationSafetyDecisionHash: hash(14),
          publicationNotAfter: new Date(Date.now() + 300_000),
          permitEpoch: 1n,
          allowPartial: true,
          limits: {
            profileId: limitsProfileId,
            maxWorkSlots: 16,
            maxAttemptBudget: 4,
            maxProjectionBytes: 1_000_000,
            maxFindingCount: 1_000,
            maxLeaseDurationMs: 120_000,
            maxResultReportDurationMs: 180_000,
          },
          now: new Date(),
          retainUntil: new Date(Date.now() + 86_400_000),
        }) as const;

      const firstCommand = commandFor(first.snapshot);
      const firstFinalized =
        await harness.executions.finalizeExecution(firstCommand);
      expect(firstFinalized.status).toBe(
        ReviewExecutionFinalizeStatus.Finalized,
      );
      await expect(
        harness.executions.finalizeExecution(firstCommand),
      ).resolves.toMatchObject({
        status: ReviewExecutionFinalizeStatus.Restored,
        artifact: { artifactId, executionId: firstCommand.executionId },
      });

      const secondPrepared = await harness.executions.prepareExecution(
        prepareCommand(
          harness,
          `shared-artifact-second-${suffix}`,
          [workSlot(`slot-shared-artifact-second-${suffix}`, 5)],
          firstFinalized.snapshot!.stream.version,
        ),
      );
      expect(secondPrepared.status).toBe(ReviewExecutionPrepareStatus.Prepared);
      const secondRevision = secondPrepared.snapshot!.execution.revision;
      const secondAdmitted = await harness.executions.confirmAdmission({
        scope: harness.scope,
        expectedStreamVersion: secondPrepared.snapshot!.stream.version,
        executionId: secondPrepared.snapshot!.execution.executionId,
        authorizationId: harness.authorizationId,
        mutationEpoch: 1n,
        requestedRevision: secondRevision,
        observedRevision: secondRevision,
        verdict: ReviewExecutionAdmissionVerdict.Current,
        checkedAt: new Date(),
      });
      expect(secondAdmitted.status).toBe(
        ReviewExecutionAdmissionStatus.Admitted,
      );

      const secondCommand = commandFor(secondAdmitted.snapshot!);
      await expect(
        harness.executions.finalizeExecution(secondCommand),
      ).resolves.toMatchObject({
        status: ReviewExecutionFinalizeStatus.Finalized,
        artifact: { artifactId, executionId: secondCommand.executionId },
      });
      await expect(
        prisma.finalizedReviewProjectionArtifactV2.count({
          where: { artifactId },
        }),
      ).resolves.toBe(2);
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

      const results = await settleConcurrent([
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

    it("retries registration when admission wins the supersede compare-and-set", async () => {
      const harness = await createHarness();
      const intentStore =
        harness.requestedIntents as PrismaReviewRequestedIntentStore;
      const now = new Date();
      const oldRequestId = `request-admission-race-old-${randomUUID()}`;
      const oldCandidate = {
        ...harness.scope,
        requestId: oldRequestId,
        revision: {
          baseSha: "a".repeat(40),
          mergeBaseSha: "b".repeat(40),
          headSha: "c".repeat(40),
          reviewRevisionHash: hashFromText(randomUUID()),
        },
        triggerKind: ReviewRequestedTriggerKind.PullRequestSynchronized,
        deliveryIdentityHash: hashFromText(randomUUID()),
        canonicalRequestHash: hashFromText(randomUUID()),
        notBefore: now,
        createdAt: now,
        retainUntil: new Date(now.getTime() + 86_400_000),
      } as const;
      await intentStore.registerIntent({ candidate: oldCandidate });
      const claimed = await intentStore.claimIntent({
        requestId: oldRequestId,
        claimId: `claim-${oldRequestId}`,
        ownerIdHash: `owner-${oldRequestId}`,
        now,
        claimUntil: new Date(now.getTime() + 30_000),
      });
      expect(claimed.status).toBe(ReviewRequestedClaimStatus.Claimed);
      const claim = claimed.intent!.claim!;
      await expect(
        intentStore.beginSubmission({
          requestId: oldRequestId,
          claimId: claim.claimId,
          ownerIdHash: claim.ownerIdHash,
          fencingToken: claim.fencingToken,
          now,
          nextResolutionAt: new Date(now.getTime() + 1_000),
          resolutionDeadlineAt: new Date(now.getTime() + 120_000),
        }),
      ).resolves.toMatchObject({
        status: ReviewRequestedTransitionStatus.Applied,
      });
      const dispatched = await intentStore.recordDispatch({
        requestId: oldRequestId,
        claimId: claim.claimId,
        ownerIdHash: claim.ownerIdHash,
        fencingToken: claim.fencingToken,
        sourceRunId: `run-${oldRequestId}`,
        sourceRunAttempt: "1",
        now,
        nextResolutionAt: new Date(now.getTime() + 1_000),
        resolutionDeadlineAt: new Date(now.getTime() + 120_000),
      });
      expect(dispatched.status).toBe(ReviewRequestedTransitionStatus.Applied);

      let registrationReachedCompareAndSet!: () => void;
      const registrationAtCompareAndSet = new Promise<void>((resolve) => {
        registrationReachedCompareAndSet = resolve;
      });
      let allowRegistrationToContinue!: () => void;
      const registrationMayContinue = new Promise<void>((resolve) => {
        allowRegistrationToContinue = resolve;
      });
      let hookInvocations = 0;
      const racingStore = new PrismaReviewRequestedIntentStore(prisma, {
        beforeSupersedeCompareAndSet: async () => {
          hookInvocations += 1;
          if (hookInvocations === 1) {
            registrationReachedCompareAndSet();
            await registrationMayContinue;
          }
        },
      });
      const newRequestId = `request-admission-race-new-${randomUUID()}`;
      const newCandidate = {
        ...oldCandidate,
        requestId: newRequestId,
        revision: {
          ...oldCandidate.revision,
          headSha: "d".repeat(40),
          reviewRevisionHash: hashFromText(randomUUID()),
        },
        deliveryIdentityHash: hashFromText(randomUUID()),
        canonicalRequestHash: hashFromText(randomUUID()),
      } as const;
      const registration = racingStore.registerIntent({
        candidate: newCandidate,
      });
      const registrationProgress = await waitForRegistrationCompareAndSet(
        registrationAtCompareAndSet,
        registration,
      );
      expect(registrationProgress).toEqual({ status: "compare_and_set" });
      const admission = await intentStore.recordAdmissionDecision({
        requestId: oldRequestId,
        expectedVersion: dispatched.intent!.version,
        changedLines: 100,
        maxChangedLines: 250_000,
        policySnapshotId: "hosted-review-size-v1:admission-race",
        decisionHash: hashFromText(`admission-${oldRequestId}`),
        verdict: ReviewRequestAdmissionState.Admitted,
        now,
      });
      expect(admission.status).toBe(ReviewRequestedTransitionStatus.Applied);
      allowRegistrationToContinue();

      await expect(registration).resolves.toMatchObject({
        status: ReviewRequestedRegisterStatus.Registered,
        intent: {
          requestId: newRequestId,
          state: ReviewRequestedIntentState.PendingDispatch,
        },
      });
      await expect(
        intentStore.findByRequestId(oldRequestId),
      ).resolves.toMatchObject({
        state: ReviewRequestedIntentState.AwaitingAuthorization,
        admission: { state: ReviewRequestAdmissionState.Admitted },
        supersededByRequestId: null,
      });
      expect(hookInvocations).toBe(1);
    });

    it("bounds registration retries under repeated supersede conflicts", async () => {
      const harness = await createHarness();
      const intentStore =
        harness.requestedIntents as PrismaReviewRequestedIntentStore;
      const now = new Date();
      const oldRequestId = `request-retry-bound-old-${randomUUID()}`;
      const oldCandidate = {
        ...harness.scope,
        requestId: oldRequestId,
        revision: {
          baseSha: "a".repeat(40),
          mergeBaseSha: "b".repeat(40),
          headSha: "c".repeat(40),
          reviewRevisionHash: hashFromText(randomUUID()),
        },
        triggerKind: ReviewRequestedTriggerKind.PullRequestSynchronized,
        deliveryIdentityHash: hashFromText(randomUUID()),
        canonicalRequestHash: hashFromText(randomUUID()),
        notBefore: now,
        createdAt: now,
        retainUntil: new Date(now.getTime() + 86_400_000),
      } as const;
      await intentStore.registerIntent({ candidate: oldCandidate });

      let hookInvocations = 0;
      const racingStore = new PrismaReviewRequestedIntentStore(prisma, {
        beforeSupersedeCompareAndSet: async () => {
          hookInvocations += 1;
          await prisma.reviewRequestedIntent.update({
            where: { requestId: oldRequestId },
            data: { version: { increment: 1n } },
          });
        },
      });
      const newRequestId = `request-retry-bound-new-${randomUUID()}`;
      await expect(
        racingStore.registerIntent({
          candidate: {
            ...oldCandidate,
            requestId: newRequestId,
            revision: {
              ...oldCandidate.revision,
              headSha: "d".repeat(40),
              reviewRevisionHash: hashFromText(randomUUID()),
            },
            createdAt: new Date(now.getTime() + 1),
            notBefore: new Date(now.getTime() + 1),
            deliveryIdentityHash: hashFromText(randomUUID()),
            canonicalRequestHash: hashFromText(randomUUID()),
          },
        }),
      ).rejects.toThrow();
      expect(hookInvocations).toBe(3);
      await expect(
        intentStore.findByRequestId(newRequestId),
      ).resolves.toBeNull();
      await expect(
        intentStore.findByRequestId(oldRequestId),
      ).resolves.toMatchObject({
        state: ReviewRequestedIntentState.PendingDispatch,
        supersededByRequestId: null,
      });
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

    it("retains an execution graph until its investigation is pruned and then prunes idempotently", async () => {
      const harness = await createHarness();
      const store = harness.executions as PrismaReviewExecutionStore;
      const now = new Date();
      const executionId = `execution-prune-${randomUUID()}`;
      const protectedExecutionId = `execution-prune-protected-${randomUUID()}`;
      const protectedWorkSlotId = `slot-prune-protected-${randomUUID()}`;
      const leaseId = `lease-prune-${randomUUID()}`;
      const investigationId = `investigation-prune-${randomUUID()}`;
      await prisma.reviewExecutionStreamV2.create({
        data: {
          ...harness.scope,
          version: 2n,
          lastAllocatedGeneration: 2n,
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
      await prisma.reviewExecutionV2.create({
        data: {
          executionId: protectedExecutionId,
          ...harness.scope,
          generation: 2n,
          version: 2n,
          baseSha: "d".repeat(40),
          mergeBaseSha: "e".repeat(40),
          headSha: "f".repeat(40),
          reviewRevisionHash: hashFromText(
            `protected-revision-${protectedExecutionId}`,
          ),
          compatibilityKey: "compatibility-v1",
          planHash: hashFromText(`protected-plan-${protectedExecutionId}`),
          startIdentityHash: hashFromText(
            `protected-start-${protectedExecutionId}`,
          ),
          canonicalStartHash: hashFromText(
            `protected-canonical-${protectedExecutionId}`,
          ),
          state: "superseded",
          authorizationId: harness.authorizationId,
          producerReleaseId: harness.producerReleaseId,
          mutationEpoch: 1n,
          admissionSafetyDecisionHash: hashFromText(
            `protected-safety-${protectedExecutionId}`,
          ),
          protocolLimitsProfileId: limitsProfileId,
          sourceRunId: "run-prune-protected",
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
      await prisma.reviewExecutionWorkSlotV2.create({
        data: {
          executionId: protectedExecutionId,
          workSlotId: protectedWorkSlotId,
          planOrdinal: 0,
          taskKind: "finding_discovery",
          providerKind: "codex",
          providerVoteIdentityHash: hashFromText(
            `protected-vote-${protectedExecutionId}`,
          ),
          shardKey: "shard-prune-protected",
          required: true,
          attemptBudget: 1,
          retryPolicyVersion: "retry-v1",
          state: "cancelled",
          nextAttemptOrdinal: 1,
        },
      });
      await prisma.reviewInvestigation.create({
        data: {
          investigationId: `investigation-prune-protected-${randomUUID()}`,
          naturalIdentityHash: hashFromText(
            `protected-investigation-${protectedExecutionId}`,
          ),
          ...harness.scope,
          trustDomain: "disposable_test",
          baseSha: "d".repeat(40),
          mergeBaseSha: "e".repeat(40),
          headSha: "f".repeat(40),
          reviewRevisionHash: hashFromText(
            `protected-revision-${protectedExecutionId}`,
          ),
          executionId: protectedExecutionId,
          workSlotId: protectedWorkSlotId,
          stableReviewUnitKey: `protected-unit-${protectedExecutionId}`,
          providerVoteLaneId: hashFromText(
            `protected-lane-${protectedExecutionId}`,
          ),
          providerStrategyId: "codex-disposable-test",
          runtimeProfile: "gateway_attested_agent_v1",
          coverageContractVersion: "coverage-prune.v1",
          expansionRulesVersion: "expansion-prune.v1",
          criticPolicyVersion: "critic-prune.v1",
          gatewayPolicyVersion: "gateway-prune.v1",
          probePolicyVersion: "probe-prune.v1",
          producerReleaseId: harness.producerReleaseId,
          runtimeProfileVersion: "runtime-prune.v1",
          searchPolicyVersion: "search-prune.v1",
          policy: {},
          state: "provisional",
          findings: [],
          turnProvenance: [],
          dossierDigest: hashFromText(
            `protected-dossier-${protectedExecutionId}`,
          ),
          createdAt: now,
          updatedAt: now,
          retainUntil: new Date(now.getTime() + 60_000),
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
      await prisma.reviewInvestigation.create({
        data: {
          investigationId,
          naturalIdentityHash: hashFromText(investigationId),
          ...harness.scope,
          trustDomain: "disposable_test",
          authorizationScopeHash: hash(12),
          baseSha: "a".repeat(40),
          mergeBaseSha: "b".repeat(40),
          headSha: "c".repeat(40),
          reviewRevisionHash: hash(1),
          executionId,
          workSlotId: "slot-prune",
          stableReviewUnitKey: "unit-prune",
          providerVoteLaneId: hash(6),
          providerStrategyId: "codex-disposable-test",
          runtimeProfile: "gateway_attested_agent_v1",
          coverageContractVersion: "coverage-prune.v1",
          expansionRulesVersion: "expansion-prune.v1",
          criticPolicyVersion: "critic-prune.v1",
          gatewayPolicyVersion: "gateway-prune.v1",
          producerReleaseId: harness.producerReleaseId,
          runtimeProfileVersion: "runtime-prune.v1",
          policy: {},
          state: "concluded",
          findings: [],
          turnProvenance: [],
          conclusion: "verified_clean",
          dossierDigest: hash(13),
          createdAt: now,
          updatedAt: now,
          retainUntil: new Date(now.getTime() + 60_000),
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

      const retainedResults = await (async () => {
        try {
          return [
            await store.pruneRetainedHistory({ limit: 10 }),
            await store.pruneRetainedHistory({ limit: 10 }),
          ];
        } finally {
          await prisma.reviewInvestigation.delete({
            where: { investigationId },
          });
        }
      })();

      expect(retainedResults).toEqual([
        {
          compactedLeases: 1,
          deletedObservationRefs: 0,
          deletedArtifacts: 0,
          deletedWorkSlots: 0,
          deletedExecutions: 0,
        },
        {
          compactedLeases: 0,
          deletedObservationRefs: 0,
          deletedArtifacts: 0,
          deletedWorkSlots: 0,
          deletedExecutions: 0,
        },
      ]);
      await expect(
        prisma.reviewExecutionWorkSlotV2.findUnique({
          where: {
            executionId_workSlotId: { executionId, workSlotId: "slot-prune" },
          },
        }),
      ).resolves.not.toBeNull();

      const result = await store.pruneRetainedHistory({ limit: 10 });
      expect(result).toMatchObject({
        compactedLeases: 0,
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
      await expect(store.pruneRetainedHistory({ limit: 10 })).resolves.toEqual({
        compactedLeases: 0,
        deletedObservationRefs: 0,
        deletedArtifacts: 0,
        deletedWorkSlots: 0,
        deletedExecutions: 0,
      });
      await expect(
        prisma.reviewExecutionV2.findUnique({
          where: { executionId: protectedExecutionId },
        }),
      ).resolves.not.toBeNull();
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

    it("prepares, admits, then acquires 16 same-vote leases across pull requests in one repository", async () => {
      await expect(
        prisma.$queryRaw<Array<{ postgresMajor: number }>>`
          SELECT current_setting('server_version_num')::integer / 10000 AS "postgresMajor"
        `,
      ).resolves.toEqual([{ postgresMajor: 17 }]);
      await setProviderScopeConcurrency(true);
      const firstHarness = await createHarness(100);
      const harnesses = [
        firstHarness,
        ...(await settleConcurrent(
          Array.from({ length: 15 }, (_, index) =>
            createPullRequestHarness(firstHarness, 101 + index),
          ),
        )),
      ];
      expect(
        new Set(harnesses.map((harness) => harness.scope.workspaceId)),
      ).toEqual(new Set([firstHarness.scope.workspaceId]));
      expect(
        new Set(
          harnesses.map((harness) => harness.scope.repositoryConnectionId),
        ),
      ).toEqual(new Set([firstHarness.scope.repositoryConnectionId]));
      expect(
        harnesses.map((harness) => harness.scope.pullRequestNumber),
      ).toEqual(Array.from({ length: 16 }, (_, index) => 100 + index));

      const identities = harnesses.map((_, index) => `provider-scope-${index}`);
      const prepared = await settleConcurrent(
        harnesses.map((harness, index) =>
          harness.executions.prepareExecution(
            prepareCommand(harness, identities[index]!, [
              workSlot(`slot-${identities[index]}`, 4),
            ]),
          ),
        ),
      );
      expect(prepared.map((result) => result.status)).toEqual(
        Array.from({ length: 16 }, () => ReviewExecutionPrepareStatus.Prepared),
      );

      const admitted = await settleConcurrent(
        harnesses.map((harness, index) => {
          const snapshot = prepared[index]!.snapshot!;
          return harness.executions.confirmAdmission({
            scope: harness.scope,
            expectedStreamVersion: snapshot.stream.version,
            executionId: snapshot.execution.executionId,
            authorizationId: harness.authorizationId,
            mutationEpoch: 1n,
            requestedRevision: snapshot.execution.revision,
            observedRevision: snapshot.execution.revision,
            verdict: ReviewExecutionAdmissionVerdict.Current,
            checkedAt: new Date(),
          });
        }),
      );
      expect(admitted.map((result) => result.status)).toEqual(
        Array.from(
          { length: 16 },
          () => ReviewExecutionAdmissionStatus.Admitted,
        ),
      );

      const commands = harnesses.map((harness, index) =>
        leaseCommand(harness, admitted[index]!.snapshot!, identities[index]!),
      );
      expect(
        new Set(commands.map((command) => command.providerVoteIdentityHash))
          .size,
      ).toBe(1);

      const results = await settleConcurrent(
        harnesses.map((harness, index) =>
          harness.executions.acquireLease(commands[index]!),
        ),
      );

      expect(results.map((result) => result.status)).toEqual(
        Array.from({ length: 16 }, () => "acquired"),
      );
      await expect(
        prisma.reviewInvocationLeaseV2.count({
          where: {
            providerVoteIdentityHash: commands[0]!.providerVoteIdentityHash,
            purpose: "provider_execution",
            state: "active",
          },
        }),
      ).resolves.toBe(16);
    });

    it("keeps old-binary global reads safe after 000079 until activation", async () => {
      await setProviderScopeConcurrency(false);
      const harnesses = await settleConcurrent([
        createHarness(301),
        createHarness(302),
      ]);
      const running = await settleConcurrent(
        harnesses.map((harness, index) =>
          prepareAndAdmit(harness, `mixed-version-${index}`),
        ),
      );
      const commands = harnesses.map((harness, index) =>
        leaseCommand(
          harness,
          running[index]!.snapshot,
          `mixed-version-${index}`,
        ),
      );

      const results = await settleConcurrent(
        harnesses.map((harness, index) =>
          harness.executions.acquireLease(commands[index]!),
        ),
      );
      expect(results.map((result) => result.status).sort()).toEqual([
        "acquired",
        "busy",
      ]);

      // This is the pre-000079 read shape: it is safe only while at most one
      // globally active row exists for a vote identity.
      await expect(
        prisma.reviewInvocationLeaseV2.findMany({
          where: {
            providerVoteIdentityHash: commands[0]!.providerVoteIdentityHash,
            purpose: "provider_execution",
            state: "active",
          },
          take: 2,
        }),
      ).resolves.toHaveLength(1);
    });

    it("drives production flight acquisition through legacy and activated scope observation", async () => {
      await expect(
        prisma.$queryRaw<Array<{ postgresMajor: number }>>`
          SELECT current_setting('server_version_num')::integer / 10000 AS "postgresMajor"
        `,
      ).resolves.toEqual([{ postgresMajor: 17 }]);
      const harnesses = await settleConcurrent([
        createHarness(501),
        createHarness(502),
      ]);
      expect(
        new Set(
          harnesses.map((harness) => harness.scope.repositoryConnectionId),
        ).size,
      ).toBe(2);
      expect(
        new Set(harnesses.map((harness) => harness.scope.pullRequestNumber))
          .size,
      ).toBe(2);
      const running = await settleConcurrent(
        harnesses.map((harness, index) =>
          prepareAndAdmit(harness, `production-flight-${index}`),
        ),
      );
      const useCases = harnesses.map(
        (harness) =>
          new AcquireOrJoinInvocationFlight(
            harness.executions,
            harness.executions,
            harness.executions,
          ),
      );
      const providerInvocationKey = hashFromText(
        "shared-production-provider-account",
      );
      const commandsFor = (phase: string) =>
        harnesses.map((harness, index) => ({
          ...leaseCommand(
            harness,
            running[index]!.snapshot,
            `${phase}-${index}`,
          ),
          providerInvocationKey,
          preparedManifestKey: hashFromText(`manifest-${index}`),
        }));

      try {
        await setProviderScopeConcurrency(false);
        const legacyCommands = commandsFor("legacy-production-flight");
        expect(
          new Set(
            legacyCommands.map((command) => command.providerVoteIdentityHash),
          ).size,
        ).toBe(1);
        const legacy = await settleConcurrent(
          useCases.map((useCase, index) =>
            useCase.execute(legacyCommands[index]!),
          ),
        );
        expect(legacy.map((result) => result.status).sort()).toEqual([
          AcquireOrJoinInvocationFlightStatus.Busy,
          AcquireOrJoinInvocationFlightStatus.OwnerAcquired,
        ]);
        const legacyOwnerIndex = legacy.findIndex(
          (result) =>
            result.status === AcquireOrJoinInvocationFlightStatus.OwnerAcquired,
        );
        const legacyOwner = legacy[legacyOwnerIndex]!;
        const legacyOwnerCommand = legacyCommands[legacyOwnerIndex]!;
        await expect(
          harnesses[legacyOwnerIndex]!.executions.releaseLease({
            leaseId: legacyOwner.flight!.ownerLeaseId,
            ownerIdHash: legacyOwnerCommand.ownerIdHash,
            leaseCapabilityId: legacyOwnerCommand.leaseCapabilityId,
            fencingToken: legacyOwner.flight!.fencingToken,
            now: new Date(),
          }),
        ).resolves.toMatchObject({ status: "applied" });

        await setProviderScopeConcurrency(true);
        const activatedCommands = commandsFor("activated-production-flight");
        const activated = await settleConcurrent(
          useCases.map((useCase, index) =>
            useCase.execute(activatedCommands[index]!),
          ),
        );
        expect(activated.map((result) => result.status)).toEqual([
          AcquireOrJoinInvocationFlightStatus.OwnerAcquired,
          AcquireOrJoinInvocationFlightStatus.OwnerAcquired,
        ]);

        const duplicate = await useCases[0]!.execute({
          ...activatedCommands[0]!,
          leaseId: "lease-activated-production-flight-duplicate",
          attemptId: "attempt-activated-production-flight-duplicate",
          acquireRequestIdHash: hashFromText(
            "activated-production-flight-duplicate-request-id",
          ),
          acquireRequestHash: hashFromText(
            "activated-production-flight-duplicate-request",
          ),
          ownerIdHash: "owner-activated-production-flight-duplicate",
          leaseCapabilityId: "capability-activated-production-flight-duplicate",
        });
        expect(duplicate).toMatchObject({
          status: AcquireOrJoinInvocationFlightStatus.Joined,
          flight: { flightId: activated[0]!.flight!.flightId },
        });
      } finally {
        await setProviderScopeConcurrency(false);
        await prisma.reviewInvocationLeaseV2.updateMany({
          where: {
            workspaceId: {
              in: harnesses.map((item) => item.scope.workspaceId),
            },
            purpose: "provider_execution",
            state: "active",
          },
          data: { state: "released" },
        });
        await restoreLegacyProviderVoteIndex();
      }
    });

    it("requires close then active-lane drain before reverse-order rollback", async () => {
      await setProviderScopeConcurrency(true);
      const harnesses = await settleConcurrent([
        createHarness(401),
        createHarness(402),
      ]);
      const running = await settleConcurrent(
        harnesses.map((harness, index) =>
          prepareAndAdmit(harness, `rollback-${index}`),
        ),
      );
      const commands = harnesses.map((harness, index) =>
        leaseCommand(harness, running[index]!.snapshot, `rollback-${index}`),
      );
      const acquired = await settleConcurrent(
        harnesses.map((harness, index) =>
          harness.executions.acquireLease(commands[index]!),
        ),
      );
      expect(acquired.every((result) => result.status === "acquired")).toBe(
        true,
      );

      await setProviderScopeConcurrency(false);
      await expect(activeVoteLaneDuplicateCount()).resolves.toBe(1);

      await prisma.reviewInvocationLeaseV2.updateMany({
        where: {
          providerVoteIdentityHash: commands[0]!.providerVoteIdentityHash,
          purpose: "provider_execution",
          state: "active",
        },
        data: { state: "released" },
      });
      await expect(activeVoteLaneDuplicateCount()).resolves.toBe(0);
      await restoreLegacyProviderVoteIndex();
      await expect(
        prisma.$queryRaw<Array<{ present: boolean }>>`
          SELECT to_regclass('"ReviewInvocationLeaseV2_one_active_provider_vote_lane"') IS NOT NULL AS present
        `,
      ).resolves.toEqual([{ present: true }]);
    });

    it("joins an exact acquire race and keeps work-slot conflicts busy", async () => {
      const harness = await createHarness();
      const running = await prepareAndAdmit(harness, "exact-race");
      const exact = leaseCommand(harness, running.snapshot, "exact-race");
      const exactResults = await settleConcurrent([
        harness.executions.acquireLease(exact),
        harness.executions.acquireLease(exact),
      ]);
      expect(exactResults.map((result) => result.status).sort()).toEqual([
        "acquired",
        "restored",
      ]);

      const conflict = {
        ...leaseCommand(harness, running.snapshot, "work-slot-conflict"),
        providerInvocationKey: hashFromText("different-provider-invocation"),
      };
      await expect(
        harness.executions.acquireLease(conflict),
      ).resolves.toMatchObject({
        status: "busy",
      });
      await expect(
        prisma.reviewInvocationLeaseV2.count({
          where: {
            executionId: running.snapshot.execution.executionId,
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
      const dispatched = await intentStore.recordDispatch({
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
      await intentStore.recordAdmissionDecision({
        requestId,
        expectedVersion: dispatched.intent!.version,
        changedLines: 100,
        maxChangedLines: 250_000,
        policySnapshotId: "hosted-review-size-v1:test",
        decisionHash: "7".repeat(64),
        verdict: ReviewRequestAdmissionState.Admitted,
        now,
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

async function createHarness(
  pullRequestNumber = 42,
): Promise<ReviewExecutionStoreContractHarness> {
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
      pullRequestNumber,
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
      pullRequestNumber,
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

async function createPullRequestHarness(
  base: ReviewExecutionStoreContractHarness,
  pullRequestNumber: number,
): Promise<ReviewExecutionStoreContractHarness> {
  const source = await prisma.reviewRunAuthorization.findUniqueOrThrow({
    where: { authorizationId: base.authorizationId },
  });
  const suffix = randomUUID();
  const authorizationId = `execution-authorization-${suffix}`;
  await prisma.reviewRunAuthorization.create({
    data: {
      ...source,
      authorizationId,
      pullRequestNumber,
      sourceRunId: `run-${suffix}`,
      oidcReplayKeyHash: hashFromText(`oidc-${suffix}`),
      createdAt: new Date(),
      renewedAt: null,
      revokedAt: null,
    } as Prisma.ReviewRunAuthorizationUncheckedCreateInput,
  });
  return {
    ...base,
    scope: { ...base.scope, pullRequestNumber },
    authorizationId,
  };
}

async function settleConcurrent<T>(
  promises: Iterable<PromiseLike<T>>,
): Promise<T[]> {
  const outcomes = await Promise.allSettled(promises);
  const failure = outcomes.find(
    (outcome): outcome is PromiseRejectedResult =>
      outcome.status === "rejected",
  );
  if (failure !== undefined) throw failure.reason;
  return outcomes.map(
    (outcome) => (outcome as PromiseFulfilledResult<T>).value,
  );
}

async function setProviderScopeConcurrency(activated: boolean): Promise<void> {
  if (activated) {
    await prisma.$executeRawUnsafe(
      'DROP INDEX CONCURRENTLY IF EXISTS "ReviewInvocationLeaseV2_one_active_provider_vote_lane"',
    );
  }
  await serializableFixtureUpdate(
    (transaction) =>
      transaction.$executeRaw`
      UPDATE "ReviewProviderScopeConcurrencyControl"
      SET "activated" = ${activated}, "updatedAt" = statement_timestamp()
      WHERE "singleton" = true
    `,
  );
}

async function serializableFixtureUpdate(
  update: (transaction: Prisma.TransactionClient) => Promise<unknown>,
): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await prisma.$transaction(update, { isolationLevel: "Serializable" });
      return;
    } catch (error) {
      if (attempt === 3 || !isTransactionConflictError(error)) throw error;
    }
  }
}

async function restoreLegacyProviderVoteIndex(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "ReviewInvocationLeaseV2_one_active_provider_vote_lane"
    ON "ReviewInvocationLeaseV2" ("providerVoteIdentityHash")
    WHERE "state" = 'active' AND "purpose" = 'provider_execution'
  `);
}

async function activeVoteLaneDuplicateCount(): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT count(*)::bigint AS count
    FROM (
      SELECT "providerVoteIdentityHash"
      FROM "ReviewInvocationLeaseV2"
      WHERE "purpose" = 'provider_execution' AND "state" = 'active'
      GROUP BY "providerVoteIdentityHash"
      HAVING count(*) > 1
    ) duplicate
  `;
  return Number(rows[0]?.count ?? 0n);
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
  await prisma.reviewInvestigation.deleteMany({ where: { workspaceId } });
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

async function waitForRegistrationCompareAndSet(
  signal: Promise<void>,
  registration: ReturnType<PrismaReviewRequestedIntentStore["registerIntent"]>,
) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      signal.then(() => ({ status: "compare_and_set" as const })),
      registration.then((result) => ({
        status: "completed" as const,
        result,
      })),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error("registration did not reach supersede compare-and-set"),
            ),
          5_000,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
