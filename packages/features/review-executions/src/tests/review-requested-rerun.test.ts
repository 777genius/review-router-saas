import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  EnsureReviewRequestedRerunIntent,
  ReviewRequestAdmissionState,
  ReviewRequestedRerunEnsureStatus,
  ReviewRequestedTransitionStatus,
  ReviewRequestedTriggerKind,
} from "../index";
import {
  ReviewRequestedIntentState,
  type ReviewRequestedIntent,
} from "../domain/review-requested-intent";
import { InMemoryReviewRequestedIntentStore } from "../infrastructure/memory/in-memory-review-requested-intent-store";

const now = new Date("2026-07-26T12:00:00.000Z");
const revision = {
  baseSha: "a".repeat(40),
  mergeBaseSha: "b".repeat(40),
  headSha: "c".repeat(40),
  reviewRevisionHash: hash("revision"),
};

describe("EnsureReviewRequestedRerunIntent", () => {
  it("creates, restores, and chains rerun attempts without relinking old authority", async () => {
    const kit = await buildKit();

    const created = await kit.useCase.execute(input("2"));
    expect(created).toMatchObject({
      status: ReviewRequestedRerunEnsureStatus.Created,
      intent: {
        state: ReviewRequestedIntentState.AwaitingAuthorization,
        sourceRunAttempt: "2",
        rerunPredecessorRequestId: kit.predecessor.requestId,
        authorizationId: null,
        executionId: null,
      },
    });

    await expect(kit.useCase.execute(input("2"))).resolves.toMatchObject({
      status: ReviewRequestedRerunEnsureStatus.Restored,
      intent: { requestId: created.intent?.requestId },
    });
    await expect(kit.useCase.execute(input("3"))).resolves.toMatchObject({
      status: ReviewRequestedRerunEnsureStatus.Created,
      intent: {
        sourceRunAttempt: "3",
        rerunPredecessorRequestId: created.intent?.requestId,
      },
    });
  });

  it("persists an oversized rerun as terminal before provider capacity is used", async () => {
    const kit = await buildKit();

    await expect(
      kit.useCase.execute({
        ...input("2"),
        changedLines: 1_001,
        maxChangedLines: 1_000,
      }),
    ).resolves.toMatchObject({
      status: ReviewRequestedRerunEnsureStatus.Created,
      intent: {
        state: ReviewRequestedIntentState.Terminal,
        admission: { state: ReviewRequestAdmissionState.Rejected },
      },
    });
  });

  it("fails closed for a moved revision and future-attempt history", async () => {
    const kit = await buildKit();
    await expect(
      kit.useCase.execute({
        ...input("2"),
        currentRevision: { ...revision, headSha: "9".repeat(40) },
      }),
    ).resolves.toEqual({
      status: ReviewRequestedRerunEnsureStatus.Conflict,
    });

    await kit.useCase.execute(input("2"));
    await kit.useCase.execute(input("3"));
    await expect(kit.useCase.execute(input("2"))).rejects.toThrow(
      "review_requested_rerun_future_attempt_conflict",
    );
  });

  it("does not invent a rerun intent without a durable predecessor", async () => {
    const store = new InMemoryReviewRequestedIntentStore();
    const useCase = createUseCase(store);

    await expect(useCase.execute(input("2"))).resolves.toEqual({
      status: ReviewRequestedRerunEnsureStatus.MissingPredecessor,
    });
  });
});

function input(sourceRunAttempt: string) {
  return {
    repositoryConnectionId: "repo_1",
    sourceRunId: "run_1",
    sourceRunAttempt,
    currentRevision: revision,
    changedLines: 100,
    maxChangedLines: 1_000,
    policySnapshotId: "hosted-review-size-v1:test",
    now,
  } as const;
}

async function buildKit() {
  const store = new InMemoryReviewRequestedIntentStore();
  const predecessor = await seedDispatchedIntent(store);
  return { store, predecessor, useCase: createUseCase(store) };
}

function createUseCase(store: InMemoryReviewRequestedIntentStore) {
  return new EnsureReviewRequestedRerunIntent(store, store, {
    async digestUtf8(value) {
      return hash(value);
    },
  });
}

async function seedDispatchedIntent(
  store: InMemoryReviewRequestedIntentStore,
): Promise<ReviewRequestedIntent> {
  const registered = await store.registerIntent({
    candidate: {
      workspaceId: "workspace_1",
      repositoryConnectionId: "repo_1",
      scmRepositoryIdentityId: "scm_1",
      pullRequestNumber: 393,
      requestId: "review-request-1",
      revision,
      triggerKind: ReviewRequestedTriggerKind.PullRequestSynchronized,
      deliveryIdentityHash: hash("delivery"),
      canonicalRequestHash: hash("canonical"),
      notBefore: now,
      createdAt: now,
      retainUntil: new Date(now.getTime() + 86_400_000),
    },
  });
  const claimed = await store.claimIntent({
    requestId: registered.intent.requestId,
    claimId: "claim_1",
    ownerIdHash: "owner_1",
    now,
    claimUntil: new Date(now.getTime() + 60_000),
  });
  const claim = claimed.intent?.claim;
  if (!claim) throw new Error("test_claim_missing");
  await store.beginSubmission({
    requestId: registered.intent.requestId,
    claimId: claim.claimId,
    ownerIdHash: claim.ownerIdHash,
    fencingToken: claim.fencingToken,
    now,
    nextResolutionAt: new Date(now.getTime() + 1_000),
    resolutionDeadlineAt: new Date(now.getTime() + 60_000),
  });
  const dispatched = await store.recordDispatch({
    requestId: registered.intent.requestId,
    claimId: claim.claimId,
    ownerIdHash: claim.ownerIdHash,
    fencingToken: claim.fencingToken,
    sourceRunId: "run_1",
    sourceRunAttempt: "1",
    now,
    nextResolutionAt: new Date(now.getTime() + 1_000),
    resolutionDeadlineAt: new Date(now.getTime() + 60_000),
  });
  if (
    dispatched.status !== ReviewRequestedTransitionStatus.Applied ||
    !dispatched.intent
  ) {
    throw new Error("test_dispatch_missing");
  }
  const admitted = await store.recordAdmissionDecision({
    requestId: registered.intent.requestId,
    expectedVersion: dispatched.intent.version,
    changedLines: 100,
    maxChangedLines: 1_000,
    policySnapshotId: "hosted-review-size-v1:test",
    decisionHash: hash("admission"),
    verdict: ReviewRequestAdmissionState.Admitted,
    now,
  });
  if (!admitted.intent) throw new Error("test_admission_missing");
  const linked = await store.linkAdmission({
    requestId: registered.intent.requestId,
    sourceRunId: "run_1",
    sourceRunAttempt: "1",
    authorizationId: "authorization_1",
    executionId: "execution_1",
    revision,
    now,
  });
  if (!linked.intent) throw new Error("test_link_missing");
  return linked.intent;
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
