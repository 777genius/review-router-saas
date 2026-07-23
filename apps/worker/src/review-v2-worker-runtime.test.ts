import { describe, expect, it } from "vitest";
import {
  OutboxHandlerError,
  type OutboxEvent,
} from "@reviewrouter/features-outbox";
import {
  ReviewCompletionWakeupKind,
  ReviewExecutionCompletionCoverage,
} from "@reviewrouter/features-review-processes";
import {
  ReviewCompletionSchedulerMode,
  composeReviewCompletionProcesses,
} from "@reviewrouter/features-review-processes/composition";
import {
  InMemoryReviewCompletionExecutionQuery,
  InMemoryReviewCompletionProcessRepository,
  InMemoryReviewCompletionPublicationPort,
  InMemoryReviewCompletionRecoveryFeed,
  InMemoryReviewCompletionSnapshotPort,
  MutableReviewCompletionClock,
  SequentialReviewCompletionIds,
} from "@reviewrouter/features-review-processes/testing";
import {
  createReviewExecutionFinalizedHandler,
  createReviewV2WorkerFeature,
  createReviewV2WorkerOwnerId,
  reviewExecutionFinalizedEventType,
  reviewExecutionFinalizedEventVersion,
  reviewV2WorkerEnabledEnv,
  runReviewV2Maintenance,
  type ReviewV2CompletionRuntime,
} from "./review-v2-worker-runtime";

const now = new Date("2026-07-22T12:00:00.000Z");
const retainUntil = new Date("2026-08-22T12:00:00.000Z");
const ownerIdHash = createReviewV2WorkerOwnerId("worker-test");

describe("review v2 worker runtime", () => {
  it("is inert by default and fails closed when enabled without composition", async () => {
    let composed = false;
    const disabled = createReviewV2WorkerFeature({
      env: {},
      createEnabledRuntime: () => {
        composed = true;
        throw new Error("must_not_compose");
      },
    });
    expect(disabled.enabled).toBe(false);
    expect(disabled.handlers).toEqual([]);
    await expect(disabled.runMaintenance()).resolves.toEqual({
      recovered: 0,
      advanced: 0,
      publicationProcessed: 0,
      publicationManualRequired: 0,
      publicationTerminalUnknown: 0,
    });
    expect(composed).toBe(false);

    expect(() =>
      createReviewV2WorkerFeature({
        env: { [reviewV2WorkerEnabledEnv]: "1" },
      }),
    ).toThrow("review_v2_worker_enabled_composition_missing");
  });

  it("converges duplicate finalized events without duplicate publication requests", async () => {
    const fixture = await createFixture();
    const handler = createReviewExecutionFinalizedHandler({
      runtime: fixture.runtime,
      ownerIdHash,
      wakeups: {
        findFinalizedWakeup: async () => ({
          executionId: "execution-1",
          finalizedArtifactId: "artifact-1",
          finalizedAt: now,
          retainUntil,
        }),
      },
    });

    await handler.handle(finalizedEvent());
    await handler.handle(finalizedEvent());

    expect(fixture.publications.requestCalls).toBe(1);
    await expect(
      fixture.repository.findByExecutionId("execution-1"),
    ).resolves.toMatchObject({
      publicationAttemptId: "publication-1",
    });
  });

  it("runs recovery before due scan so a missing process advances in the same pass", async () => {
    const fixture = await createFixture({ createProcess: false });
    fixture.recoveryFeed.seed({
      executionId: "execution-1",
      finalizedArtifactId: "artifact-1",
      createdAt: now,
      retainUntil,
    });

    await expect(
      runReviewV2Maintenance({
        runtime: fixture.runtime,
        ownerIdHash,
        dueLimit: 10,
        publication: {
          async runMaintenance() {
            return {
              processed: 3,
              manualRequired: 1,
              terminalUnknown: 1,
              settledExecutionIds: ["execution-1", "execution-1"],
            };
          },
        },
      }),
    ).resolves.toEqual({
      recovered: 1,
      advanced: 2,
      publicationProcessed: 3,
      publicationManualRequired: 1,
      publicationTerminalUnknown: 1,
    });
    expect(fixture.publications.requestCalls).toBe(1);
  });

  it("quarantines malformed finalized events and retries temporarily missing facts", async () => {
    const fixture = await createFixture();
    const missing = createReviewExecutionFinalizedHandler({
      runtime: fixture.runtime,
      ownerIdHash,
      wakeups: { findFinalizedWakeup: async () => null },
    });
    await expect(missing.handle(finalizedEvent())).rejects.toMatchObject({
      name: "OutboxHandlerError",
      code: "review_v2_finalized_facts_unavailable",
      retryable: true,
    } satisfies Partial<OutboxHandlerError>);

    await expect(
      missing.handle(
        finalizedEvent({ payload: { executionId: "execution-1" } }),
      ),
    ).rejects.toMatchObject({
      code: "review_v2_finalized_event_invalid",
      retryable: false,
    } satisfies Partial<OutboxHandlerError>);
  });
});

async function createFixture(input: { readonly createProcess?: boolean } = {}) {
  const repository = new InMemoryReviewCompletionProcessRepository();
  const executions = new InMemoryReviewCompletionExecutionQuery();
  const publications = new InMemoryReviewCompletionPublicationPort();
  const snapshots = new InMemoryReviewCompletionSnapshotPort();
  const clock = new MutableReviewCompletionClock(now);
  const ids = new SequentialReviewCompletionIds();
  const recoveryFeed = new InMemoryReviewCompletionRecoveryFeed(repository);
  executions.seed({
    executionId: "execution-1",
    finalizedArtifactId: "artifact-1",
    coverage: ReviewExecutionCompletionCoverage.Completed,
  });
  const runtime = composeReviewCompletionProcesses({
    processes: repository,
    executions,
    publications,
    snapshots,
    clock,
    ids,
    claimDurationMs: 10_000,
    retryDelayMs: () => 1_000,
    schedulerMode: ReviewCompletionSchedulerMode.Enabled,
    recoveryFeed,
    recoveryPageSize: 10,
  });
  const schedulers = runtime.schedulers;
  if (schedulers.mode !== ReviewCompletionSchedulerMode.Enabled) {
    throw new Error("test_scheduler_not_enabled");
  }
  const typedRuntime: ReviewV2CompletionRuntime = {
    wake: runtime.wake,
    advance: {
      execute: async (command: {
        readonly executionId: string;
        readonly ownerIdHash: string;
      }) => runtime.advance.execute(command),
    },
    schedulers: {
      mode: ReviewCompletionSchedulerMode.Enabled,
      due: schedulers.due,
      recovery: schedulers.recovery,
    },
  };
  if (input.createProcess !== false) {
    await runtime.wake.execute({
      executionId: "execution-1",
      finalizedArtifactId: "artifact-1",
      wakeupKind: ReviewCompletionWakeupKind.ExecutionFinalized,
      wakeupAt: now,
      retainUntil,
    });
  }
  return {
    repository,
    publications,
    recoveryFeed,
    runtime: typedRuntime,
  };
}

function finalizedEvent(override: Partial<OutboxEvent> = {}): OutboxEvent {
  return {
    id: "outbox-1",
    type: reviewExecutionFinalizedEventType,
    version: reviewExecutionFinalizedEventVersion,
    idempotencyKey: "review-execution-finalized:v2:execution-1",
    workspaceId: "workspace-1",
    repositoryId: "repository-1",
    aggregateId: "execution-1",
    payload: {
      executionId: "execution-1",
      artifactId: "artifact-1",
      artifactHash: "a".repeat(64),
      generation: "1",
      reviewRevisionHash: "b".repeat(64),
      projectionHash: "c".repeat(64),
    },
    status: "processing",
    attempts: 1,
    maxAttempts: 5,
    nextAttemptAt: null,
    claimId: "claim-1",
    claimVersion: 1n,
    claimOwnerHash: ownerIdHash,
    claimUntil: new Date("2026-07-22T12:01:00.000Z"),
    occurredAt: now,
    ...override,
  };
}
