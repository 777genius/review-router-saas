import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  ReviewExecutionProviderKind,
  ReviewExecutionState,
  ReviewTaskKind,
  ReviewWorkSlotState,
  type ReviewExecution,
} from "@reviewrouter/features-review-executions";
import { captureReviewProgress } from "../infrastructure/prisma/prisma-review-progress-projection";

describe("Prisma review progress projection", () => {
  it("fails before projection writes when the scope row was not locked", async () => {
    const fixture = transactionFixture({ lockedRows: [] });

    await expect(
      captureReviewProgress(fixture.transaction, execution()),
    ).rejects.toThrow("review_progress_scope_lock_missing");
    expect(fixture.findExecution).not.toHaveBeenCalled();
    expect(fixture.upsertProgress).not.toHaveBeenCalled();
    expect(fixture.createPublication).not.toHaveBeenCalled();
  });

  it("binds hostile scope values instead of interpolating them into SQL", async () => {
    const hostileWorkspaceId = `workspace' OR 1=1 --`;
    const fixture = transactionFixture();

    await captureReviewProgress(
      fixture.transaction,
      execution({ workspaceId: hostileWorkspaceId }),
    );

    const query = fixture.queryRaw.mock.calls[0]?.[0] as Prisma.Sql;
    expect(query.strings.join("?")).not.toContain(hostileWorkspaceId);
    expect(query.values).toContain(hostileWorkspaceId);
  });

  it("rejects a malformed persisted assignment manifest", async () => {
    const fixture = transactionFixture({
      assignmentManifestVersion: 1,
      assignmentManifestJson: { manifestVersion: 1 },
    });

    await expect(
      captureReviewProgress(fixture.transaction, execution()),
    ).rejects.toThrow("review_assignment_manifest_shape_invalid");
    expect(fixture.upsertProgress).not.toHaveBeenCalled();
  });

  it("rejects a malformed persisted progress snapshot with a stable error", async () => {
    const fixture = transactionFixture({
      existingProgress: {
        sourceExecutionVersion: 1n,
        snapshotHash: "a".repeat(64),
        desiredVersion: 1n,
        snapshotJson: { schemaVersion: 1 },
      },
    });

    await expect(
      captureReviewProgress(fixture.transaction, execution()),
    ).rejects.toThrow("review_progress_snapshot_invalid");
    expect(fixture.upsertProgress).not.toHaveBeenCalled();
  });

  it("resets publication failures when a new desired version is captured", async () => {
    const fixture = transactionFixture({
      publication: {
        activeGeneration: 1n,
        desiredVersion: 4n,
        lastPublishedAt: null,
      },
    });

    await captureReviewProgress(fixture.transaction, execution());

    expect(fixture.updatePublication).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          desiredVersion: 5n,
          failureCount: 0,
          lastErrorCode: null,
        }),
      }),
    );
  });

  it("keeps finalized executions assembling until publication settles", async () => {
    const fixture = transactionFixture();

    await captureReviewProgress(
      fixture.transaction,
      execution({ state: ReviewExecutionState.Completed }),
    );

    expect(fixture.upsertProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          phase: "assembling",
          terminalOutcome: null,
          snapshotJson: expect.objectContaining({
            phase: "assembling",
            terminal: "none",
          }),
        }),
      }),
    );
  });
});

function transactionFixture(
  options: Readonly<{
    lockedRows?: readonly { one: number }[];
    assignmentManifestVersion?: number | null;
    assignmentManifestJson?: Prisma.JsonValue | null;
    existingProgress?: Record<string, unknown> | null;
    publication?: Record<string, unknown> | null;
  }> = {},
) {
  const queryRaw = vi
    .fn()
    .mockResolvedValue(options.lockedRows ?? [{ one: 1 }]);
  const findExecution = vi.fn().mockResolvedValue({
    assignmentManifestVersion: options.assignmentManifestVersion ?? null,
    assignmentManifestJson: options.assignmentManifestJson ?? null,
  });
  const upsertProgress = vi.fn().mockResolvedValue(undefined);
  const createPublication = vi.fn().mockResolvedValue(undefined);
  const updatePublication = vi.fn().mockResolvedValue(undefined);
  const transaction = {
    $queryRaw: queryRaw,
    reviewExecutionV2: { findUnique: findExecution },
    reviewInvocationLeaseV2: {
      groupBy: vi.fn().mockResolvedValue([]),
    },
    reviewExecutionProgressV1: {
      findUnique: vi.fn().mockResolvedValue(options.existingProgress ?? null),
      upsert: upsertProgress,
    },
    reviewProgressPublicationV1: {
      findUnique: vi.fn().mockResolvedValue(options.publication ?? null),
      create: createPublication,
      update: updatePublication,
    },
  } as unknown as Prisma.TransactionClient;
  return {
    transaction,
    queryRaw,
    findExecution,
    upsertProgress,
    createPublication,
    updatePublication,
  };
}

function execution(overrides: Partial<ReviewExecution> = {}): ReviewExecution {
  const now = new Date("2026-08-12T12:00:00.000Z");
  return {
    executionId: "execution-1",
    workspaceId: "workspace-1",
    repositoryConnectionId: "repository-1",
    scmRepositoryIdentityId: "scm-repository-1",
    pullRequestNumber: 142,
    version: 1n,
    generation: 1n,
    revision: {
      baseSha: "a".repeat(40),
      mergeBaseSha: "b".repeat(40),
      headSha: "c".repeat(40),
      reviewRevisionHash: "d".repeat(64),
    },
    authorizationId: "authorization-1",
    producerReleaseId: "release-1",
    mutationEpoch: 1n,
    startIdentityHash: "e".repeat(64),
    canonicalStartHash: "f".repeat(64),
    admissionSafetyDecisionHash: "1".repeat(64),
    state: ReviewExecutionState.Running,
    compatibilityKey: "2".repeat(64),
    planHash: "3".repeat(64),
    assignmentManifestVersion: null,
    assignmentManifestHash: null,
    assignmentManifestCanonicalJson: null,
    protocolLimitsProfileId: "limits-1",
    sourceRunId: "run-1",
    sourceRunAttempt: "1",
    workSlots: [
      {
        workSlotId: "slot-1",
        taskKind: ReviewTaskKind.FindingDiscovery,
        providerKind: ReviewExecutionProviderKind.Codex,
        providerVoteIdentityHash: "4".repeat(64),
        shardKey: "shard-1",
        required: true,
        attemptBudget: 2,
        retryPolicyVersion: "retry-v1",
        state: ReviewWorkSlotState.Pending,
        activeLeaseId: null,
        acceptedObservationRefId: null,
        nextAttemptOrdinal: 1,
      },
    ],
    finalizedArtifactId: null,
    supersededByExecutionId: null,
    createdAt: now,
    updatedAt: now,
    admissionDeadlineAt: new Date(now.getTime() + 60_000),
    admissionCheckedAt: now,
    executionDeadlineAt: new Date(now.getTime() + 120_000),
    retainUntil: new Date(now.getTime() + 86_400_000),
    ...overrides,
  };
}
