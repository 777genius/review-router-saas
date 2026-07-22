import { describe, expect, it } from "vitest";
import {
  CommitReviewSnapshotV2Status,
  LineageHintEvictionReason,
  LineageHintState,
  ReviewSnapshotCommitRejectedError,
  ReviewSnapshotCommitRejectionReason,
  ReviewSnapshotV2CommitOutcome,
  ReviewSnapshotV2RestoreMode,
  ReviewSnapshotV2RestoreStatus,
  SnapshotEffectivePublicationOutcome,
  SnapshotSourceCoverageState,
  buildBoundedLineageHintIndex,
  commitReviewSnapshotV2,
  decideReviewSnapshotV2Restore,
  reviewSnapshotV2SchemaVersion,
  type CommitReviewSnapshotV2Command,
  type ReviewSnapshotCommitEligibilityPort,
} from "../index";
import { InMemoryReviewSnapshotV2Repository } from "../testing";

const hash = (character: string): string => character.repeat(64);
const now = new Date("2026-07-22T12:00:00.000Z");

describe("review snapshot v2 memory repository contract", () => {
  it("fails closed for v1 rows and exposes hints-only without projection content", async () => {
    const command = commitCommand({ generation: 1 });
    const repository = new InMemoryReviewSnapshotV2Repository();
    const legacy = {
      workspaceId: command.candidate.workspaceId,
      repositoryConnectionId: command.candidate.repositoryConnectionId,
      scmRepositoryIdentityId: command.candidate.scmRepositoryIdentityId,
      pullRequestNumber: command.candidate.pullRequestNumber,
      version: 7,
      schemaVersion: 1 as const,
    };
    repository.seedLegacy(legacy);
    expect(
      decideReviewSnapshotV2Restore(
        await repository.findCurrent(command.candidate),
        {
          now,
          trustedRepositoryBinding: true,
          reviewRevisionHash: hash("b"),
          mode: ReviewSnapshotV2RestoreMode.ExactProjection,
        },
      ),
    ).toEqual({
      status: ReviewSnapshotV2RestoreStatus.LegacyUntrusted,
      expectedVersion: 7,
    });

    const current = { ...command.candidate, version: 1 };
    const restored = decideReviewSnapshotV2Restore(current, {
      now,
      trustedRepositoryBinding: true,
      reviewRevisionHash: hash("f"),
      mode: ReviewSnapshotV2RestoreMode.LineageHintsOnly,
    });
    expect(restored).toMatchObject({
      status: ReviewSnapshotV2RestoreStatus.Found,
      payload: null,
      lineageHints: command.candidate.payload.lineageHints,
    });
  });

  it("evicts lineage hints deterministically by age, state/count, then bytes", () => {
    const hints = [
      hint("old", LineageHintState.Active, "2026-07-01T00:00:00.000Z"),
      hint("active", LineageHintState.Active, "2026-07-22T10:00:00.000Z"),
      hint("resolved", LineageHintState.Resolved, "2026-07-22T11:00:00.000Z"),
      hint("absent", LineageHintState.Absent, "2026-07-22T11:30:00.000Z"),
    ];
    const countBounded = buildBoundedLineageHintIndex({
      hints,
      now,
      retentionMs: 7 * 24 * 60 * 60 * 1000,
      maximumCount: 2,
      maximumBytes: 10_000,
    });
    expect(countBounded.hints.map((item) => item.lineageId)).toEqual([
      "active",
      "resolved",
    ]);
    expect(countBounded.eviction).toMatchObject({
      [LineageHintEvictionReason.Age]: 1,
      [LineageHintEvictionReason.Count]: 1,
      [LineageHintEvictionReason.Bytes]: 0,
    });

    const byteBounded = buildBoundedLineageHintIndex({
      hints: hints.slice(1),
      now,
      retentionMs: 7 * 24 * 60 * 60 * 1000,
      maximumCount: 3,
      maximumBytes: 220,
    });
    expect(byteBounded.hints[0]?.lineageId).toBe("active");
    expect(
      byteBounded.eviction[LineageHintEvictionReason.Bytes],
    ).toBeGreaterThan(0);
  });

  it("commits only completed successfully published artifacts", async () => {
    const repository = new InMemoryReviewSnapshotV2Repository();
    const command = commitCommand({ generation: 1 });
    const partialEligibility = eligibility({
      coverageState: SnapshotSourceCoverageState.Partial,
    });

    await expect(
      commitReviewSnapshotV2(command, {
        commands: repository,
        eligibility: partialEligibility,
      }),
    ).rejects.toEqual(
      new ReviewSnapshotCommitRejectedError(
        ReviewSnapshotCommitRejectionReason.PartialCoverage,
      ),
    );
    await expect(
      commitReviewSnapshotV2(command, {
        commands: repository,
        eligibility: eligibility({ sourceBaseSha: "a".repeat(40) }),
      }),
    ).rejects.toEqual(
      new ReviewSnapshotCommitRejectedError(
        ReviewSnapshotCommitRejectionReason.SourceMismatch,
      ),
    );

    const result = await commitReviewSnapshotV2(command, {
      commands: repository,
      eligibility: eligibility(),
    });
    expect(result).toMatchObject({
      status: CommitReviewSnapshotV2Status.Applied,
      receipt: { outcome: ReviewSnapshotV2CommitOutcome.Committed },
      snapshot: { version: 1, sourceExecutionGeneration: 1 },
    });
  });

  it("restores lost acknowledgements and records a delayed lower generation without mutation", async () => {
    const repository = new InMemoryReviewSnapshotV2Repository();
    const first = commitCommand({ generation: 1 });
    const firstResult = await repository.commit(first);
    const retry = await repository.commit(first);
    expect(firstResult).toMatchObject({
      status: CommitReviewSnapshotV2Status.Applied,
    });
    expect(retry).toMatchObject({
      status: CommitReviewSnapshotV2Status.Restored,
      receipt: { receiptId: first.receiptId },
    });

    const second = commitCommand({
      generation: 2,
      expectedVersion: 1,
      executionId: "execution-2",
      artifactHash: hash("d"),
      receiptId: "receipt-2",
      requestHash: hash("e"),
    });
    await repository.commit(second);

    const delayed = commitCommand({
      generation: 1,
      expectedVersion: 2,
      executionId: "execution-delayed",
      artifactHash: hash("f"),
      receiptId: "receipt-delayed",
      requestHash: hash("1"),
    });
    const delayedResult = await repository.commit(delayed);
    expect(delayedResult).toMatchObject({
      status: CommitReviewSnapshotV2Status.Applied,
      receipt: {
        outcome: ReviewSnapshotV2CommitOutcome.SupersededByHigherGeneration,
        resultingSnapshotGeneration: 2,
      },
      snapshot: { sourceExecutionGeneration: 2, version: 2 },
    });
    const source = {
      sourceExecutionId: delayed.candidate.sourceExecutionId,
      sourceArtifactHash: delayed.candidate.sourceArtifactHash,
    };
    const receipt = await repository.findBySource(source);
    expect(receipt).toMatchObject({
      receiptId: delayed.receiptId,
      outcome: ReviewSnapshotV2CommitOutcome.SupersededByHigherGeneration,
      resultingSnapshotGeneration: 2,
    });
    receipt?.createdAt.setTime(0);
    expect((await repository.findBySource(source))?.createdAt).toEqual(now);
  });

  it("round-trips truthful execution provenance and rejects malformed values", async () => {
    const repository = new InMemoryReviewSnapshotV2Repository();
    const command = commitCommand({ generation: 1 });
    await repository.commit(command);
    await expect(
      repository.findCurrent(command.candidate),
    ).resolves.toMatchObject({
      sourceBaseSha: command.candidate.sourceBaseSha,
      sourceReviewedHeadSha: command.candidate.sourceReviewedHeadSha,
      sourceCompatibilityKey: command.candidate.sourceCompatibilityKey,
      sourceRunId: command.candidate.sourceRunId,
      sourceRunAttempt: command.candidate.sourceRunAttempt,
    });

    const invalidProvenance = [
      ["sourceBaseSha", "a".repeat(39), "snapshot_source_base_sha_invalid"],
      [
        "sourceReviewedHeadSha",
        "abc",
        "snapshot_source_reviewed_head_sha_invalid",
      ],
      [
        "sourceCompatibilityKey",
        "f".repeat(40),
        "snapshot_source_compatibility_key_invalid",
      ],
      ["sourceRunId", "run\n2", "snapshot_source_run_id_invalid"],
      ["sourceRunAttempt", "", "snapshot_source_run_attempt_invalid"],
    ] as const;
    for (const [field, value, error] of invalidProvenance) {
      const next = commitCommand({ generation: 2, expectedVersion: 1 });
      await expect(
        repository.commit({
          ...next,
          candidate: { ...next.candidate, [field]: value },
        }),
      ).rejects.toThrow(error);
    }
  });

  it("rejects equal-generation artifact drift and stale snapshot versions", async () => {
    const repository = new InMemoryReviewSnapshotV2Repository();
    await repository.commit(commitCommand({ generation: 1 }));
    const drift = commitCommand({
      generation: 1,
      expectedVersion: 1,
      executionId: "execution-drift",
      artifactHash: hash("9"),
      receiptId: "receipt-drift",
      requestHash: hash("8"),
    });
    expect(await repository.commit(drift)).toEqual({
      status: CommitReviewSnapshotV2Status.InvariantConflict,
      currentVersion: 1,
    });
    expect(
      await repository.commit(
        commitCommand({
          generation: 2,
          expectedVersion: 0,
          executionId: "execution-2",
          artifactHash: hash("7"),
          receiptId: "receipt-2",
          requestHash: hash("6"),
        }),
      ),
    ).toEqual({
      status: CommitReviewSnapshotV2Status.VersionConflict,
      currentVersion: 1,
    });
  });
});

function hint(lineageId: string, state: LineageHintState, lastSeenAt: string) {
  return {
    lineageId,
    state,
    fingerprintHash: hash(
      ({ old: "a", active: "b", resolved: "c", absent: "d" } as const)[
        lineageId as "old" | "active" | "resolved" | "absent"
      ],
    ),
    lastSeenAt: new Date(lastSeenAt),
  };
}

function commitCommand(input: {
  readonly generation: number;
  readonly expectedVersion?: number;
  readonly executionId?: string;
  readonly artifactHash?: string;
  readonly receiptId?: string;
  readonly requestHash?: string;
}): CommitReviewSnapshotV2Command {
  return {
    receiptId: input.receiptId ?? "receipt-1",
    requestHash: input.requestHash ?? hash("a"),
    expectedSnapshotVersion: input.expectedVersion ?? 0,
    publicationReceiptSetHash: hash("c"),
    receiptRetainUntil: new Date("2026-08-22T12:00:00.000Z"),
    candidate: {
      workspaceId: "workspace-1",
      repositoryConnectionId: "connection-1",
      scmRepositoryIdentityId: "scm-identity-1",
      pullRequestNumber: 42,
      schemaVersion: reviewSnapshotV2SchemaVersion,
      sourceExecutionId: input.executionId ?? "execution-1",
      sourceExecutionGeneration: input.generation,
      sourceArtifactHash: input.artifactHash ?? hash("2"),
      sourceReviewRevisionHash: hash("b"),
      sourceBaseSha: "c".repeat(40),
      sourceReviewedHeadSha: "d".repeat(40),
      sourceCompatibilityKey: hash("e"),
      sourceRunId: "run-1",
      sourceRunAttempt: "1",
      payload: {
        projectionEnvelopeVersion: 1,
        projectionEnvelope: { summary: "safe" },
        projectionHash: hash("3"),
        occurrences: [],
        lineageHints: buildBoundedLineageHintIndex({
          hints: [
            hint("active", LineageHintState.Active, "2026-07-22T10:00:00.000Z"),
          ],
          now,
          retentionMs: 86_400_000,
          maximumCount: 10,
          maximumBytes: 10_000,
        }),
      },
      createdAt: now,
      expiresAt: new Date("2026-07-29T12:00:00.000Z"),
    },
  };
}

function eligibility(
  overrides: Partial<
    Awaited<ReturnType<ReviewSnapshotCommitEligibilityPort["resolve"]>> & {}
  > = {},
): ReviewSnapshotCommitEligibilityPort {
  return {
    async resolve(input) {
      return {
        sourceExecutionId: input.sourceExecutionId,
        sourceArtifactHash: input.sourceArtifactHash,
        sourceReviewRevisionHash: hash("b"),
        sourceBaseSha: "c".repeat(40),
        sourceReviewedHeadSha: "d".repeat(40),
        sourceCompatibilityKey: hash("e"),
        sourceRunId: "run-1",
        sourceRunAttempt: "1",
        coverageState: SnapshotSourceCoverageState.Completed,
        effectivePublicationOutcome:
          SnapshotEffectivePublicationOutcome.Succeeded,
        publicationReceiptSetHash: hash("c"),
        ...overrides,
      };
    },
  };
}
