import { createHash } from "node:crypto";
import {
  ReviewEvidenceCommitResultStatus,
  ReviewEvidenceLookupResultStatus,
  ReviewExecutionMutationResultStatus,
  ReviewInvocationLeaseResultStatus,
} from "../../packages/protocol-review-action-v2/src/index.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createReviewActionV2E2EHarness,
  resetReviewActionV2E2EDatabase,
  type ReviewActionV2E2EHarness,
} from "./support/review-action-v2-e2e-harness.js";

const databaseUrl = process.env.REVIEW_ROUTER_TEST_DATABASE_URL;
const enabled = process.env.REVIEW_ROUTER_REVIEW_V2_E2E === "1";
if (enabled && !databaseUrl) {
  throw new Error(
    "REVIEW_ROUTER_TEST_DATABASE_URL is required for review-v2:e2e",
  );
}
const describeWithDatabase = databaseUrl && enabled ? describe : describe.skip;

describeWithDatabase.sequential(
  "Review Action v2 production PostgreSQL E2E and fault recovery",
  () => {
    let harness: ReviewActionV2E2EHarness | null = null;

    beforeEach(async () => {
      await resetReviewActionV2E2EDatabase(databaseUrl!);
      harness = await createReviewActionV2E2EHarness(databaseUrl!);
    });

    afterEach(async () => {
      await harness?.close();
      harness = null;
      await resetReviewActionV2E2EDatabase(databaseUrl!);
    });

    it("adopts a committed observation after provider restart without another semantic attempt", async () => {
      const fixture = requiredHarness(harness);
      const flow = await fixture.createCommittedFlow({ attachSlotCount: 0 });

      const released = await fixture.releaseProviderLease(flow);
      expect(released.result.status).toBe(
        ReviewInvocationLeaseResultStatus.Applied,
      );
      await expect(
        fixture.prisma.reviewInvocationLeaseV2.findUniqueOrThrow({
          where: { leaseId: flow.leaseId },
          select: { state: true },
        }),
      ).resolves.toEqual({ state: "released" });

      const replay = await fixture.replayCommit(flow);
      expect(replay.result.status).toBe(
        ReviewEvidenceCommitResultStatus.Idempotent,
      );
      expect(replay.result.observationId).toBe(flow.observationId);

      const lookup = await fixture.lookup(flow);
      expect(lookup.result).toMatchObject({
        status: ReviewEvidenceLookupResultStatus.Shadow,
        observationId: flow.observationId,
        payloadHash: flow.payloadHash,
      });
      const adopted = await fixture.adoptCommittedObservation(flow);
      expect(adopted.response.result.status).toBe(
        ReviewExecutionMutationResultStatus.Applied,
      );
      expect(
        JSON.parse(
          requiredString(adopted.response.result.observationFactsCanonicalJson),
        ),
      ).toMatchObject({ observationId: flow.observationId });

      const adoptionReplay = await fixture.replayObservationAdoption(
        adopted.request,
      );
      expect(adoptionReplay.result.status).toBe(
        ReviewExecutionMutationResultStatus.Restored,
      );
      await expectAdoptedExactlyOnce(fixture, flow);

      const finalized = await fixture.finalize(flow);
      expect(finalized.result.status).toBe(
        ReviewExecutionMutationResultStatus.Applied,
      );
      await expect(fixture.processFinalizedOutbox()).resolves.toMatchObject({
        processed: 1,
        deadLettered: 0,
      });
      await fixture.runWorkerUntilSettled();

      await expectTerminalSuccess(fixture, flow.executionId);
      await expectSnapshot(fixture, flow.executionId, true);
      expect(fixture.fakeGitHub.comments).toHaveLength(1);
      expect(fixture.fakeGitHub.checkRuns).toHaveLength(1);
    }, 60_000);

    it("takes over expired outbox and publication claims with monotonic fencing", async () => {
      const fixture = requiredHarness(harness);
      const flow = await fixture.createCommittedFlow();
      await fixture.finalize(flow);
      await fixture.forceStaleOutboxClaim();

      await expect(
        fixture.processFinalizedOutbox({ takeoverEnabled: true }),
      ).resolves.toMatchObject({
        recoveredStale: 1,
        processed: 1,
        staleClaims: 0,
      });
      const abandoned = await fixture.forceStalePublicationClaim();
      await fixture.runWorkerUntilSettled();

      const claims = await fixture.prisma.reviewPublicationClaimTermV2.findMany(
        {
          where: { publicationAttemptId: abandoned.publicationAttemptId },
          orderBy: { fencingToken: "asc" },
          select: { claimId: true, fencingToken: true, state: true },
        },
      );
      expect(claims).toHaveLength(2);
      expect(claims[0]).toEqual({
        claimId: abandoned.claimId,
        fencingToken: abandoned.fencingToken,
        state: "expired",
      });
      expect(claims[1]!.fencingToken > abandoned.fencingToken).toBe(true);
      await expectTerminalSuccess(fixture, flow.executionId);
      await expectSnapshot(fixture, flow.executionId, true);
    }, 60_000);

    it("rejects every SCM mutation when the persisted current head moves", async () => {
      const fixture = requiredHarness(harness);
      const flow = await fixture.createCommittedFlow();
      await fixture.finalize(flow);
      await fixture.processFinalizedOutbox();
      await fixture.movePersistedCurrentRevision({
        headSha: "f".repeat(40),
        reviewRevisionHash: hash("moved-review-revision"),
      });

      await fixture.runWorkerUntilSettled();

      const publication =
        await fixture.prisma.reviewPublicationAttemptV2.findFirstOrThrow({
          where: { executionId: flow.executionId },
        });
      expect(publication.state).toBe("terminal");
      expect(publication.terminalOutcome).toBe("superseded_no_effect");
      expect(fixture.fakeGitHub.comments).toHaveLength(0);
      expect(fixture.fakeGitHub.checkRuns).toHaveLength(0);
      await expectSnapshot(fixture, flow.executionId, false);
    }, 60_000);

    it("fails closed on a live SCM revision race while persisted current revision stays unchanged", async () => {
      const fixture = requiredHarness(harness);
      const flow = await fixture.createCommittedFlow();
      await fixture.finalize(flow);
      await fixture.processFinalizedOutbox();
      const persistedBefore = await fixture.readPersistedCurrentRevision();
      fixture.setRevision({
        baseSha: persistedBefore.baseSha,
        mergeBaseSha: persistedBefore.mergeBaseSha,
        headSha: "f".repeat(40),
      });

      await fixture.runWorkerUntilSettled();

      await expect(
        fixture.prisma.reviewPublicationAttemptV2.findFirstOrThrow({
          where: { executionId: flow.executionId },
          select: { state: true, terminalOutcome: true },
        }),
      ).resolves.toEqual({
        state: "terminal",
        terminalOutcome: "superseded_no_effect",
      });
      await expect(fixture.readPersistedCurrentRevision()).resolves.toEqual(
        persistedBefore,
      );
      expect(fixture.fakeGitHub.comments).toHaveLength(0);
      expect(fixture.fakeGitHub.checkRuns).toHaveLength(0);
      await expectSnapshot(fixture, flow.executionId, false);
    }, 60_000);

    it("recovers a permanently dead-lettered finalized event and resumes the same process", async () => {
      const fixture = requiredHarness(harness);
      const flow = await fixture.createCommittedFlow();
      await fixture.finalize(flow);

      await fixture.deadLetterAndRecoverFinalizedEvent();
      await fixture.runWorkerUntilSettled();

      const event = await fixture.prisma.outboxEvent.findFirstOrThrow({
        where: {
          workspaceId: fixture.workspaceId,
          aggregateId: flow.executionId,
        },
      });
      expect(event.status).toBe("processed");
      await expectTerminalSuccess(fixture, flow.executionId);
      await expectSnapshot(fixture, flow.executionId, true);
    }, 60_000);

    it("publishes only the partial summary and never commits a reusable snapshot", async () => {
      const fixture = requiredHarness(harness);
      const flow = await fixture.createCommittedFlow({
        slotCount: 2,
        attachSlotCount: 1,
      });
      await fixture.finalize(flow, { allowPartial: true });
      await fixture.processFinalizedOutbox();
      await fixture.runWorkerUntilSettled();

      const artifact =
        await fixture.prisma.finalizedReviewProjectionArtifactV2.findUniqueOrThrow(
          { where: { executionId: flow.executionId } },
        );
      const process =
        await fixture.prisma.reviewCompletionProcess.findUniqueOrThrow({
          where: { executionId: flow.executionId },
        });
      expect(artifact.coverageState).toBe("partial");
      expect(process.state).toBe("blocked_partial");
      expect(fixture.fakeGitHub.comments).toHaveLength(1);
      expect(fixture.fakeGitHub.comments[0]?.body).toContain(
        "## Review incomplete - 0 preliminary findings preserved ⚠️",
      );
      expect(fixture.fakeGitHub.comments[0]?.body).toContain(
        "No preliminary findings were preserved",
      );
      expect(fixture.fakeGitHub.comments[0]?.body).toContain("Partial review");
      expect(fixture.fakeGitHub.checkRuns).toHaveLength(0);
      await expect(
        fixture.prisma.reviewPublicationAttemptV2.findFirstOrThrow({
          where: { executionId: flow.executionId },
          select: { state: true, terminalOutcome: true },
        }),
      ).resolves.toEqual({ state: "terminal", terminalOutcome: "succeeded" });
      await expectSnapshot(fixture, flow.executionId, false);
    }, 60_000);

    it("bounds and completes paginated marker reconciliation before creating one canonical summary", async () => {
      const fixture = requiredHarness(harness);
      fixture.fakeGitHub.seedForeignComments(100);
      const flow = await fixture.createCommittedFlow();
      await fixture.finalize(flow);
      await fixture.processFinalizedOutbox();
      await fixture.runWorkerUntilSettled();

      expect(fixture.fakeGitHub.countCalls("GET", `/issues/42/comments`)).toBe(
        4,
      );
      expect(
        fixture.fakeGitHub.comments.filter(
          (comment) => comment.user.login === "reviewrouter-e2e[bot]",
        ),
      ).toHaveLength(1);
      await expectTerminalSuccess(fixture, flow.executionId);
    }, 60_000);
  },
);

async function expectTerminalSuccess(
  fixture: ReviewActionV2E2EHarness,
  executionId: string,
): Promise<void> {
  await expect(
    fixture.prisma.reviewPublicationAttemptV2.findFirstOrThrow({
      where: { executionId },
      select: { state: true, terminalOutcome: true },
    }),
  ).resolves.toEqual({ state: "terminal", terminalOutcome: "succeeded" });
  await expect(
    fixture.prisma.reviewCompletionProcess.findUniqueOrThrow({
      where: { executionId },
      select: { state: true },
    }),
  ).resolves.toEqual({ state: "completed" });
}

async function expectSnapshot(
  fixture: ReviewActionV2E2EHarness,
  executionId: string,
  expected: boolean,
): Promise<void> {
  const count = await fixture.prisma.reviewSnapshot.count({
    where: { sourceExecutionId: executionId },
  });
  expect(count).toBe(expected ? 1 : 0);
}

async function expectAdoptedExactlyOnce(
  fixture: ReviewActionV2E2EHarness,
  flow: Readonly<{
    executionId: string;
    workSlotId: string;
    observationId: string;
    leaseId: string;
  }>,
): Promise<void> {
  const observations = await fixture.prisma.reviewEvidenceObservation.count({
    where: { sourceExecutionId: flow.executionId },
  });
  const providerLeases = await fixture.prisma.reviewInvocationLeaseV2.count({
    where: {
      executionId: flow.executionId,
      purpose: "provider_execution",
    },
  });
  const semanticAttempts = await fixture.prisma.reviewInvocationLeaseV2.count({
    where: { executionId: flow.executionId, attemptId: { not: null } },
  });
  const adoptionLeases = await fixture.prisma.reviewInvocationLeaseV2.count({
    where: {
      executionId: flow.executionId,
      purpose: "observation_adoption",
    },
  });
  const slot = await fixture.prisma.reviewExecutionWorkSlotV2.findUniqueOrThrow(
    {
      where: {
        executionId_workSlotId: {
          executionId: flow.executionId,
          workSlotId: flow.workSlotId,
        },
      },
      select: {
        state: true,
        nextAttemptOrdinal: true,
        acceptedObservationRefId: true,
      },
    },
  );
  expect({
    observations,
    providerLeases,
    semanticAttempts,
    adoptionLeases,
  }).toEqual({
    observations: 1,
    providerLeases: 1,
    semanticAttempts: 1,
    adoptionLeases: 1,
  });
  expect(slot).toMatchObject({
    state: "satisfied",
    nextAttemptOrdinal: 2,
  });
  await expect(
    fixture.prisma.reviewExecutionObservationRefV2.findFirstOrThrow({
      where: {
        observationRefId: slot.acceptedObservationRefId ?? "missing",
      },
      select: {
        observationId: true,
        attachmentKind: true,
        sourceLeaseId: true,
      },
    }),
  ).resolves.toEqual({
    observationId: flow.observationId,
    attachmentKind: "observation_adoption",
    sourceLeaseId: flow.leaseId,
  });
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("review_v2_e2e_string_expected");
  }
  return value;
}

function requiredHarness(
  value: ReviewActionV2E2EHarness | null,
): ReviewActionV2E2EHarness {
  if (!value) throw new Error("review_v2_e2e_harness_missing");
  return value;
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
