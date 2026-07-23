import { describe, expect, it } from "vitest";
import {
  ReviewCompletionSchedulerMode,
  composeReviewCompletionProcesses,
} from "../composition";
import {
  AdvanceReviewCompletionProcess,
  AdvanceReviewCompletionProcessStatus,
  RecoverMissingReviewCompletionProcesses,
  ReviewCompletionProcessCreateStatus,
  ReviewCompletionProcessState,
  ReviewCompletionPublicationOutcome,
  ReviewCompletionPublicationState,
  ReviewCompletionSnapshotOutcome,
  ReviewCompletionWakeupKind,
  ReviewExecutionCompletionCoverage,
  ScanDueReviewCompletionProcesses,
  type ReviewCompletionPublicationFacts,
} from "../index";
import {
  InMemoryReviewCompletionExecutionQuery,
  InMemoryReviewCompletionProcessRepository,
  InMemoryReviewCompletionPublicationPort,
  InMemoryReviewCompletionRecoveryFeed,
  InMemoryReviewCompletionSnapshotPort,
  MutableReviewCompletionClock,
  SequentialReviewCompletionIds,
} from "../testing";

const start = new Date("2026-07-22T12:00:00.000Z");
const retainUntil = new Date("2026-08-22T12:00:00.000Z");

describe("review completion processes", () => {
  it("creates idempotently and ignores duplicate or out-of-order wakeups", async () => {
    const repository = new InMemoryReviewCompletionProcessRepository();
    const first = await repository.createOrWake(createInput("execution-1"));
    const duplicate = await repository.createOrWake(createInput("execution-1"));
    const older = await repository.createOrWake({
      ...createInput("execution-1"),
      wakeupKind: ReviewCompletionWakeupKind.PublicationChanged,
      wakeupAt: new Date(start.getTime() - 1_000),
    });

    expect(first.status).toBe(ReviewCompletionProcessCreateStatus.Created);
    expect(duplicate.status).toBe(ReviewCompletionProcessCreateStatus.Restored);
    expect(older.status).toBe(ReviewCompletionProcessCreateStatus.Restored);
    expect(older.process).toMatchObject({
      processVersion: 1n,
      lastWakeupKind: ReviewCompletionWakeupKind.ExecutionFinalized,
      finalizedArtifactId: "artifact-execution-1",
    });

    const conflict = await repository.createOrWake({
      ...createInput("execution-1"),
      finalizedArtifactId: "different-artifact",
    });
    expect(conflict.status).toBe(
      ReviewCompletionProcessCreateStatus.ArtifactConflict,
    );
  });

  it("publishes partial coverage and completes without advancing snapshot", async () => {
    const fixture = await createFixture(
      "partial",
      ReviewExecutionCompletionCoverage.Partial,
    );
    const requested = await fixture.advance.execute({
      executionId: "partial",
      ownerIdHash: "worker-a",
    });
    expect(requested).toMatchObject({
      status: AdvanceReviewCompletionProcessStatus.RetryDue,
      process: {
        state: ReviewCompletionProcessState.PublicationInProgress,
        publicationAttemptId: "publication-1",
      },
    });

    fixture.publications.seed(
      publication("partial", {
        publicationAttemptId: "publication-1",
        state: ReviewCompletionPublicationState.Terminal,
        effectiveOutcome: ReviewCompletionPublicationOutcome.Succeeded,
      }),
    );
    fixture.clock.advance(1_000);
    const result = await fixture.advance.execute({
      executionId: "partial",
      ownerIdHash: "worker-b",
    });

    expect(result).toMatchObject({
      status: AdvanceReviewCompletionProcessStatus.PartialCompleted,
      process: {
        state: ReviewCompletionProcessState.PartialCompleted,
        publicationAttemptId: "publication-1",
        snapshotCommitReceiptId: null,
        nextActionAt: null,
      },
    });
    expect(fixture.publications.requestCalls).toBe(1);
    expect(fixture.snapshots.commitCalls).toBe(0);
  });

  it("fails closed before publication when coverage facts are ambiguous", async () => {
    const fixture = await createFixture(
      "ambiguous-coverage",
      "unknown" as ReviewExecutionCompletionCoverage,
    );

    await expect(
      fixture.advance.execute({
        executionId: "ambiguous-coverage",
        ownerIdHash: "worker-a",
      }),
    ).resolves.toMatchObject({
      status: AdvanceReviewCompletionProcessStatus.RetryDue,
      process: {
        state: ReviewCompletionProcessState.AwaitingPublication,
      },
    });
    expect(fixture.publications.requestCalls).toBe(0);
    expect(fixture.snapshots.commitCalls).toBe(0);
  });

  it("never advances snapshot when finalized coverage conflicts after publication", async () => {
    const fixture = await createFixture("coverage-conflict");
    fixture.publications.seed(
      publication("coverage-conflict", {
        state: ReviewCompletionPublicationState.Terminal,
        effectiveOutcome: ReviewCompletionPublicationOutcome.Succeeded,
      }),
    );
    await fixture.advance.execute({
      executionId: "coverage-conflict",
      ownerIdHash: "worker-a",
    });
    fixture.executions.seed({
      executionId: "coverage-conflict",
      finalizedArtifactId: "artifact-coverage-conflict",
      coverage: ReviewExecutionCompletionCoverage.Partial,
    });

    await expect(
      fixture.advance.execute({
        executionId: "coverage-conflict",
        ownerIdHash: "worker-b",
      }),
    ).resolves.toMatchObject({
      status: AdvanceReviewCompletionProcessStatus.RetryDue,
      process: { state: ReviewCompletionProcessState.AwaitingSnapshot },
    });
    expect(fixture.snapshots.commitCalls).toBe(0);
  });

  it("advances successful publication to a committed snapshot", async () => {
    const fixture = await createFixture("completed");
    fixture.publications.seed(
      publication("completed", {
        state: ReviewCompletionPublicationState.Terminal,
        effectiveOutcome: ReviewCompletionPublicationOutcome.Succeeded,
      }),
    );

    const publicationResult = await fixture.advance.execute({
      executionId: "completed",
      ownerIdHash: "worker-a",
    });
    expect(publicationResult).toMatchObject({
      status: AdvanceReviewCompletionProcessStatus.Advanced,
      process: {
        state: ReviewCompletionProcessState.AwaitingSnapshot,
        publicationAttemptId: "publication-completed",
      },
    });

    const snapshot = await fixture.advance.execute({
      executionId: "completed",
      ownerIdHash: "worker-a",
    });
    expect(snapshot).toMatchObject({
      status: AdvanceReviewCompletionProcessStatus.Completed,
      process: {
        state: ReviewCompletionProcessState.Completed,
        snapshotCommitReceiptId: "snapshot-receipt-1",
        nextActionAt: null,
      },
    });
  });

  it("maps a lower-generation snapshot receipt to completed_superseded", async () => {
    const fixture = await createFixture("superseded");
    fixture.publications.seed(
      publication("superseded", {
        state: ReviewCompletionPublicationState.Terminal,
        effectiveOutcome: ReviewCompletionPublicationOutcome.Succeeded,
      }),
    );
    await fixture.advance.execute({
      executionId: "superseded",
      ownerIdHash: "worker-a",
    });
    fixture.snapshots.seed({
      snapshotCommitReceiptId: "receipt-superseded",
      executionId: "superseded",
      finalizedArtifactId: "artifact-superseded",
      publicationAttemptId: "publication-superseded",
      outcome: ReviewCompletionSnapshotOutcome.SupersededByHigherGeneration,
    });

    expect(
      await fixture.advance.execute({
        executionId: "superseded",
        ownerIdHash: "worker-a",
      }),
    ).toMatchObject({
      status: AdvanceReviewCompletionProcessStatus.CompletedSuperseded,
      process: { state: ReviewCompletionProcessState.CompletedSuperseded },
    });
  });

  it("blocks terminal_unknown and never attempts snapshot mutation", async () => {
    const fixture = await createFixture("unknown");
    fixture.publications.seed(
      publication("unknown", {
        state: ReviewCompletionPublicationState.Terminal,
        effectiveOutcome: ReviewCompletionPublicationOutcome.TerminalUnknown,
      }),
    );

    expect(
      await fixture.advance.execute({
        executionId: "unknown",
        ownerIdHash: "worker-a",
      }),
    ).toMatchObject({
      status: AdvanceReviewCompletionProcessStatus.BlockedPublicationUnknown,
      process: {
        state: ReviewCompletionProcessState.BlockedPublicationUnknown,
      },
    });
    expect(fixture.snapshots.commitCalls).toBe(0);
  });

  it("restores publication and snapshot IDs after lost acknowledgements", async () => {
    const fixture = await createFixture("lost-ack");
    fixture.publications.failAfterRequestOnce = true;
    const first = await fixture.advance.execute({
      executionId: "lost-ack",
      ownerIdHash: "worker-a",
    });
    expect(first.status).toBe(AdvanceReviewCompletionProcessStatus.RetryDue);

    fixture.clock.advance(1_000);
    const restoredPublication = await fixture.advance.execute({
      executionId: "lost-ack",
      ownerIdHash: "worker-b",
    });
    expect(restoredPublication).toMatchObject({
      process: { publicationAttemptId: "publication-1" },
    });
    expect(fixture.publications.requestCalls).toBe(1);

    fixture.publications.seed(
      publication("lost-ack", {
        publicationAttemptId: "publication-1",
        state: ReviewCompletionPublicationState.Terminal,
        effectiveOutcome: ReviewCompletionPublicationOutcome.Succeeded,
      }),
    );
    await fixture.advance.execute({
      executionId: "lost-ack",
      ownerIdHash: "worker-b",
    });
    fixture.snapshots.failAfterCommitOnce = true;
    expect(
      await fixture.advance.execute({
        executionId: "lost-ack",
        ownerIdHash: "worker-b",
      }),
    ).toMatchObject({ status: AdvanceReviewCompletionProcessStatus.RetryDue });

    fixture.clock.advance(1_000);
    const restoredSnapshot = await fixture.advance.execute({
      executionId: "lost-ack",
      ownerIdHash: "worker-c",
    });
    expect(restoredSnapshot).toMatchObject({
      status: AdvanceReviewCompletionProcessStatus.Completed,
      process: { snapshotCommitReceiptId: "snapshot-receipt-1" },
    });
    expect(fixture.snapshots.commitCalls).toBe(1);
  });

  it("lets only one concurrent due scanner advance a process", async () => {
    const fixture = await createFixture("race");
    const scannerA = new ScanDueReviewCompletionProcesses(
      fixture.repository,
      fixture.advance,
      fixture.clock,
      fixture.ids,
      10_000,
    );
    const scannerB = new ScanDueReviewCompletionProcesses(
      fixture.repository,
      fixture.advance,
      fixture.clock,
      fixture.ids,
      10_000,
    );

    const [left, right] = await Promise.all([
      scannerA.execute({ ownerIdHash: "worker-a", limit: 10 }),
      scannerB.execute({ ownerIdHash: "worker-b", limit: 10 }),
    ]);
    expect(left.length + right.length).toBe(1);
    expect(fixture.publications.requestCalls).toBe(1);
  });

  it("rejects a stale worker transition after claim takeover", async () => {
    const fixture = await createFixture("takeover");
    const oldClaim = await fixture.repository.claimByExecutionId({
      executionId: "takeover",
      claimId: "old-claim",
      ownerIdHash: "worker-old",
      now: fixture.clock.now(),
      claimUntil: new Date(fixture.clock.now().getTime() + 100),
    });
    expect(oldClaim).not.toBeNull();
    fixture.clock.advance(101);
    const newClaim = await fixture.repository.claimByExecutionId({
      executionId: "takeover",
      claimId: "new-claim",
      ownerIdHash: "worker-new",
      now: fixture.clock.now(),
      claimUntil: new Date(fixture.clock.now().getTime() + 100),
    });
    expect(newClaim).not.toBeNull();

    expect(await fixture.advance.executeClaim(oldClaim!)).toMatchObject({
      status: AdvanceReviewCompletionProcessStatus.StaleClaim,
    });
    expect(await fixture.advance.executeClaim(newClaim!)).toMatchObject({
      status: AdvanceReviewCompletionProcessStatus.RetryDue,
    });
    expect(fixture.publications.requestCalls).toBe(1);
  });

  it("recovers a missing row and finds a late commit behind the cursor next pass", async () => {
    const repository = new InMemoryReviewCompletionProcessRepository();
    const feed = new InMemoryReviewCompletionRecoveryFeed(repository);
    feed.seed(recoveryCandidate("a", 1_000));
    feed.seed(recoveryCandidate("c", 3_000));
    const recovery = new RecoverMissingReviewCompletionProcesses(
      feed,
      repository,
      1,
    );

    expect(await recovery.scanNextPage()).toMatchObject({
      visited: 1,
      completedPass: false,
    });
    feed.seed(recoveryCandidate("late", 500));
    expect(await recovery.scanNextPage()).toMatchObject({
      visited: 1,
      completedPass: false,
    });
    expect(await recovery.scanNextPage()).toMatchObject({
      visited: 0,
      completedPass: true,
      nextCursor: null,
    });
    expect(await recovery.scanNextPage()).toMatchObject({
      visited: 1,
      completedPass: false,
    });
    expect(await repository.findByExecutionId("late")).toMatchObject({
      executionId: "late",
      lastWakeupKind: ReviewCompletionWakeupKind.RecoveryScan,
    });
  });

  it("keeps recovery and due schedulers disabled by default", async () => {
    const fixture = await createFixture("composition");
    const composition = composeReviewCompletionProcesses({
      processes: fixture.repository,
      executions: fixture.executions,
      publications: fixture.publications,
      snapshots: fixture.snapshots,
      clock: fixture.clock,
      ids: fixture.ids,
      claimDurationMs: 10_000,
      retryDelayMs: () => 1_000,
    });
    expect(composition.schedulers).toEqual({
      mode: ReviewCompletionSchedulerMode.Disabled,
      due: null,
      recovery: null,
    });
  });
});

async function createFixture(
  executionId: string,
  coverage = ReviewExecutionCompletionCoverage.Completed,
) {
  const repository = new InMemoryReviewCompletionProcessRepository();
  const executions = new InMemoryReviewCompletionExecutionQuery();
  const publications = new InMemoryReviewCompletionPublicationPort();
  const snapshots = new InMemoryReviewCompletionSnapshotPort();
  const clock = new MutableReviewCompletionClock(start);
  const ids = new SequentialReviewCompletionIds();
  executions.seed({
    executionId,
    finalizedArtifactId: `artifact-${executionId}`,
    coverage,
  });
  await repository.createOrWake(createInput(executionId));
  const advance = new AdvanceReviewCompletionProcess(
    repository,
    executions,
    publications,
    snapshots,
    clock,
    ids,
    { claimDurationMs: 10_000, retryDelayMs: () => 1_000 },
  );
  return {
    repository,
    executions,
    publications,
    snapshots,
    clock,
    ids,
    advance,
  };
}

function createInput(executionId: string) {
  return {
    executionId,
    finalizedArtifactId: `artifact-${executionId}`,
    wakeupKind: ReviewCompletionWakeupKind.ExecutionFinalized,
    wakeupAt: start,
    retainUntil,
  };
}

function publication(
  executionId: string,
  overrides: Partial<ReviewCompletionPublicationFacts> = {},
): ReviewCompletionPublicationFacts {
  return {
    publicationAttemptId: `publication-${executionId}`,
    executionId,
    finalizedArtifactId: `artifact-${executionId}`,
    state: ReviewCompletionPublicationState.Pending,
    effectiveOutcome: null,
    nextCheckAt: new Date(start.getTime() + 1_000),
    ...overrides,
  };
}

function recoveryCandidate(executionId: string, offset: number) {
  return {
    executionId,
    finalizedArtifactId: `artifact-${executionId}`,
    createdAt: new Date(start.getTime() + offset),
    retainUntil,
  };
}
