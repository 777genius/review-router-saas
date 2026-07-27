import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ReviewCoverageState,
  ReviewExecutionProviderKind,
  ReviewExecutionState,
  ReviewTaskKind,
  ReviewWorkSlotState,
  type ReviewExecutionSnapshot,
} from "@reviewrouter/features-review-executions";
import {
  RequestReviewPublicationStatus,
  ReviewPublicationAttemptState,
  ReviewPublicationEffectStrategy,
  ReviewPublicationKind,
  ReviewPublicationLifecycleSemantic,
  ReviewPublicationOperationPlanningService,
  ReviewPublicationOperationRole,
  ReviewPublicationOperationState,
  ReviewPublicationPlanningErrorCode,
  ReviewPublicationProjectionCoverage,
  ReviewPublicationReceiptStatus,
  ReviewPublicationSummarySemantic,
  ReviewPublicationTerminalOutcome,
  publishedReviewProjectionPublicationEnvelopeVersion,
  type CanonicalReviewPublicationBodyFacts,
  type PublishedReviewProjectionPublicationEnvelope,
  type RequestReviewPublicationCommand,
  type ReviewPublicationAttemptQueryPort,
  type ReviewPublicationAttemptView,
  type ReviewPublicationPlanningLimits,
} from "@reviewrouter/features-review-publishing/v2";
import { InMemoryReviewPublicationReleaseLimitsQuery } from "@reviewrouter/features-review-publishing/v2/testing";
import { canonicalJson } from "@reviewrouter/features-review-run-control";
import {
  CommitReviewSnapshotV2Status,
  LineageHintEvictionReason,
  ReviewSnapshotV2CommitOutcome,
  type CommitReviewSnapshotV2Command,
  type ReviewSnapshotV2Record,
} from "@reviewrouter/features-review-snapshots/v2";
import {
  ReviewCompletionPublicationOutcome,
  ReviewCompletionPublicationState,
  ReviewCompletionSnapshotOutcome,
  ReviewExecutionCompletionCoverage,
} from "@reviewrouter/features-review-processes";
import {
  DeterministicReviewPublicationRequestFactory,
  ReviewCompletionExecutionContextAdapter,
  ReviewCompletionPublicationContextAdapter,
  ReviewCompletionSnapshotContextAdapter,
  type ReviewCompletionProjectionMapperPort,
} from "./review-v2-context-adapters";

const now = new Date("2026-07-22T12:00:00.000Z");
const retainUntil = new Date("2026-08-22T12:00:00.000Z");

describe("review v2 worker context adapters", () => {
  it("maps only a matching terminal execution and preserves partial coverage", async () => {
    const completed = executionSnapshot();
    const adapter = new ReviewCompletionExecutionContextAdapter({
      findExecution: async () => completed,
    });

    await expect(
      adapter.findFinalized({
        executionId: "execution-1",
        finalizedArtifactId: "artifact-1",
      }),
    ).resolves.toEqual({
      executionId: "execution-1",
      finalizedArtifactId: "artifact-1",
      coverage: ReviewExecutionCompletionCoverage.Completed,
    });
    await expect(
      adapter.findFinalized({
        executionId: "execution-1",
        finalizedArtifactId: "artifact-other",
      }),
    ).resolves.toBeNull();

    const partial = executionSnapshot({
      executionState: ReviewExecutionState.Partial,
      coverage: ReviewCoverageState.Partial,
    });
    const partialAdapter = new ReviewCompletionExecutionContextAdapter({
      findExecution: async () => partial,
    });
    await expect(
      partialAdapter.findFinalized({
        executionId: "execution-1",
        finalizedArtifactId: "artifact-1",
      }),
    ).resolves.toMatchObject({
      coverage: ReviewExecutionCompletionCoverage.Partial,
    });

    if (!completed.artifact) throw new Error("test_artifact_missing");
    const inconsistent: ReviewExecutionSnapshot = {
      ...completed,
      artifact: { ...completed.artifact, reviewedHeadSha: hash("9") },
    };
    const inconsistentAdapter = new ReviewCompletionExecutionContextAdapter({
      findExecution: async () => inconsistent,
    });
    await expect(
      inconsistentAdapter.findFinalized({
        executionId: "execution-1",
        finalizedArtifactId: "artifact-1",
      }),
    ).rejects.toThrow("review_completion_finalized_execution_inconsistent");
  });

  it("converges Action-first and process-first publication on one deterministic attempt", async () => {
    const snapshot = executionSnapshot();
    const attempts = new FakePublicationAttempts();
    const requests = new FakePublicationRequests(attempts);
    const factory = publicationRequestFactory(
      completionProjectionMapper(),
      attempts,
    );
    const adapter = new ReviewCompletionPublicationContextAdapter(
      { findExecution: async () => snapshot },
      attempts,
      requests,
      factory,
    );

    const processFirst = await adapter.request({
      executionId: "execution-1",
      finalizedArtifactId: "artifact-1",
    });
    const replay = await adapter.request({
      executionId: "execution-1",
      finalizedArtifactId: "artifact-1",
    });
    expect(replay.publicationAttemptId).toBe(processFirst.publicationAttemptId);
    expect(requests.commands).toHaveLength(2);
    expect(requests.commands[0]).toEqual(requests.commands[1]);

    const actionFirst = await adapter.findByExecution({
      executionId: "execution-1",
      finalizedArtifactId: "artifact-1",
      publicationAttemptId: null,
    });
    expect(actionFirst).toEqual(processFirst);
    expect(actionFirst).toMatchObject({
      state: ReviewCompletionPublicationState.Pending,
      effectiveOutcome: null,
    });
  });

  it("restores legacy projection-scoped operation identities", async () => {
    const snapshot = executionSnapshot();
    const scoped = await publicationRequestFactory().build(snapshot);
    if (!scoped) throw new Error("test_publication_command_missing");
    const scopedPrefix = `review-publication:${scoped.publicationAttemptId}:`;
    const legacyOperations = scoped.operations.map((operation) => ({
      ...operation,
      publicationOperationId: operation.publicationOperationId.replace(
        scopedPrefix,
        "review-publication:",
      ),
      dependsOnOperationId:
        operation.dependsOnOperationId?.replace(
          scopedPrefix,
          "review-publication:",
        ) ?? null,
    }));
    const attempts = new FakePublicationAttempts();
    attempts.store(
      publicationView({
        ...scoped,
        operations: legacyOperations,
      }),
    );

    await expect(
      publicationRequestFactory(completionProjectionMapper(), attempts).build(
        snapshot,
      ),
    ).resolves.toMatchObject({ operations: legacyOperations });
  });

  it("replans against a concurrent legacy winning identity before retrying", async () => {
    const snapshot = executionSnapshot();
    const attempts = new FakePublicationAttempts();
    const requests = new ConcurrentIdentityWinnerRequests(attempts);
    const adapter = new ReviewCompletionPublicationContextAdapter(
      { findExecution: async () => snapshot },
      attempts,
      requests,
      publicationRequestFactory(completionProjectionMapper(), attempts),
    );

    await expect(
      adapter.request({
        executionId: "execution-1",
        finalizedArtifactId: "artifact-1",
      }),
    ).resolves.toMatchObject({
      state: ReviewCompletionPublicationState.Pending,
    });
    expect(requests.commands).toHaveLength(2);
    expect(requests.commands[0]?.requestHash).not.toBe(
      requests.commands[1]?.requestHash,
    );
    expect(requests.commands[1]?.operations).toEqual(
      legacyProjectionScopedCommand(requests.commands[0]!).operations,
    );
  });

  it("plans only the conservative coverage summary for a partial artifact", async () => {
    const snapshot = executionSnapshot({
      executionState: ReviewExecutionState.Partial,
      coverage: ReviewCoverageState.Partial,
    });

    await expect(publicationRequestFactory().build(snapshot)).resolves.toEqual(
      expect.objectContaining({
        operations: [
          expect.objectContaining({
            publicationKind: ReviewPublicationKind.Summary,
            chunkIndex: 0,
            effectStrategy: ReviewPublicationEffectStrategy.MutableSingleton,
            role: ReviewPublicationOperationRole.Standalone,
          }),
        ],
      }),
    );
  });

  it.each([
    [
      "All Clear",
      (envelope: PublishedReviewProjectionPublicationEnvelope) => ({
        ...envelope,
        summary: {
          ...envelope.summary,
          semantic: ReviewPublicationSummarySemantic.AllClear,
        },
      }),
    ],
    [
      "managed check",
      (envelope: PublishedReviewProjectionPublicationEnvelope) => ({
        ...envelope,
        managedCheck: publicationBody("7", "8"),
      }),
    ],
    [
      "auto-resolve lifecycle",
      (envelope: PublishedReviewProjectionPublicationEnvelope) => ({
        ...envelope,
        lifecycle: [
          {
            chunkIndex: 0,
            semantic: ReviewPublicationLifecycleSemantic.Resolve,
            ...publicationBody("7", "8"),
          },
        ],
      }),
    ],
  ])("rejects %s for partial coverage", async (_name, transform) => {
    const snapshot = executionSnapshot({
      executionState: ReviewExecutionState.Partial,
      coverage: ReviewCoverageState.Partial,
    });

    await expect(
      publicationRequestFactory(completionProjectionMapper(transform)).build(
        snapshot,
      ),
    ).rejects.toMatchObject({
      code: ReviewPublicationPlanningErrorCode.PartialCoverageViolation,
    });
  });

  it("rejects an envelope whose coverage conflicts with its finalized artifact", async () => {
    const snapshot = executionSnapshot({
      executionState: ReviewExecutionState.Partial,
      coverage: ReviewCoverageState.Partial,
    });
    const mapper = completionProjectionMapper((envelope) => ({
      ...envelope,
      coverage: ReviewPublicationProjectionCoverage.Completed,
      summary: {
        ...envelope.summary,
        semantic: ReviewPublicationSummarySemantic.Findings,
      },
    }));

    await expect(
      publicationRequestFactory(mapper).build(snapshot),
    ).rejects.toThrow("review_completion_publication_envelope_conflict");
  });

  it("maps corrected publication outcomes without treating terminal_unknown as success", async () => {
    const snapshot = executionSnapshot();
    const attempts = new FakePublicationAttempts();
    attempts.store(
      publicationView(await publicationRequestFactory().build(snapshot), {
        state: ReviewPublicationAttemptState.Terminal,
        terminalOutcome: ReviewPublicationTerminalOutcome.TerminalUnknown,
      }),
    );
    const adapter = new ReviewCompletionPublicationContextAdapter(
      { findExecution: async () => snapshot },
      attempts,
      new FakePublicationRequests(attempts),
      publicationRequestFactory(),
    );
    await expect(
      adapter.findByExecution({
        executionId: "execution-1",
        finalizedArtifactId: "artifact-1",
        publicationAttemptId: null,
      }),
    ).resolves.toMatchObject({
      state: ReviewCompletionPublicationState.Terminal,
      effectiveOutcome: ReviewCompletionPublicationOutcome.TerminalUnknown,
    });
  });

  it("builds a deterministic snapshot command only from proven artifact and publication facts", async () => {
    const snapshot = executionSnapshot();
    const command = await publicationRequestFactory().build(snapshot);
    const attempts = new FakePublicationAttempts();
    attempts.store(
      publicationView(command, {
        state: ReviewPublicationAttemptState.Terminal,
        terminalOutcome: ReviewPublicationTerminalOutcome.Succeeded,
        withReceipt: true,
      }),
    );
    const committed: CommitReviewSnapshotV2Command[] = [];
    let currentSnapshot: ReviewSnapshotV2Record | null = null;
    const adapter = new ReviewCompletionSnapshotContextAdapter(
      { findExecution: async () => snapshot },
      {
        findIdentity: async () => ({
          executionId: "execution-1",
          finalizedArtifactId: "artifact-1",
          artifactHash: hash("9"),
        }),
      },
      attempts,
      { findCurrent: async () => structuredClone(currentSnapshot) },
      {
        commit: async (candidate) => {
          committed.push(candidate);
          currentSnapshot = {
            ...candidate.candidate,
            version: candidate.expectedSnapshotVersion + 1,
          };
          return {
            status: CommitReviewSnapshotV2Status.Applied,
            receipt: {
              receiptId: candidate.receiptId,
              requestHash: candidate.requestHash,
              sourceExecutionId: candidate.candidate.sourceExecutionId,
              sourceExecutionGeneration:
                candidate.candidate.sourceExecutionGeneration,
              sourceArtifactHash: candidate.candidate.sourceArtifactHash,
              sourceReviewRevisionHash:
                candidate.candidate.sourceReviewRevisionHash,
              outcome: ReviewSnapshotV2CommitOutcome.Committed,
              resultingSnapshotVersion: 1,
              resultingSnapshotGeneration:
                candidate.candidate.sourceExecutionGeneration,
              createdAt: candidate.candidate.createdAt,
              retainUntil: candidate.receiptRetainUntil,
            },
            snapshot: null,
          };
        },
      },
      completionProjectionMapper(),
    );

    const publicationAttemptId = command?.publicationAttemptId ?? "missing";
    const first = await adapter.commit({
      executionId: "execution-1",
      finalizedArtifactId: "artifact-1",
      publicationAttemptId,
    });
    const second = await adapter.commit({
      executionId: "execution-1",
      finalizedArtifactId: "artifact-1",
      publicationAttemptId,
    });

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      publicationAttemptId,
      outcome: ReviewCompletionSnapshotOutcome.Committed,
    });
    expect(committed[0]).toEqual(committed[1]);
    expect(committed[0]).toMatchObject({
      candidate: {
        workspaceId: "workspace-1",
        repositoryConnectionId: "repository-1",
        scmRepositoryIdentityId: "scm-repository-1",
        sourceExecutionId: "execution-1",
        sourceArtifactHash: hash("9"),
        payload: {
          projectionEnvelope: { findings: [] },
          projectionHash: hash("4"),
        },
      },
    });
  });

  it("fails closed when the owner APIs cannot provide artifact identity or a projection plan", async () => {
    const snapshot = executionSnapshot();
    const attempts = new FakePublicationAttempts();
    const unavailableMapper: ReviewCompletionProjectionMapperPort = {
      publicationEnvelope: async () => null,
      snapshotProjection: async () => null,
    };
    const publications = new ReviewCompletionPublicationContextAdapter(
      { findExecution: async () => snapshot },
      attempts,
      new FakePublicationRequests(attempts),
      publicationRequestFactory(unavailableMapper),
    );
    await expect(
      publications.request({
        executionId: "execution-1",
        finalizedArtifactId: "artifact-1",
      }),
    ).rejects.toThrow("review_completion_publication_plan_unavailable");

    const publicationCommand =
      await publicationRequestFactory().build(snapshot);
    attempts.store(
      publicationView(publicationCommand, {
        state: ReviewPublicationAttemptState.Terminal,
        terminalOutcome: ReviewPublicationTerminalOutcome.Succeeded,
        withReceipt: true,
      }),
    );
    const snapshots = new ReviewCompletionSnapshotContextAdapter(
      { findExecution: async () => snapshot },
      { findIdentity: async () => null },
      attempts,
      { findCurrent: async () => null },
      {
        commit: async () => {
          throw new Error("must_not_commit");
        },
      },
      completionProjectionMapper(),
    );
    await expect(
      snapshots.commit({
        executionId: "execution-1",
        finalizedArtifactId: "artifact-1",
        publicationAttemptId:
          publicationCommand?.publicationAttemptId ?? "missing",
      }),
    ).rejects.toThrow("review_completion_snapshot_facts_unavailable");
  });

  it("rejects snapshot advancement for a partial artifact", async () => {
    const snapshot = executionSnapshot({
      executionState: ReviewExecutionState.Partial,
      coverage: ReviewCoverageState.Partial,
    });
    const command = await publicationRequestFactory().build(snapshot);
    const attempts = new FakePublicationAttempts();
    attempts.store(
      publicationView(command, {
        state: ReviewPublicationAttemptState.Terminal,
        terminalOutcome: ReviewPublicationTerminalOutcome.Succeeded,
        withReceipt: true,
      }),
    );
    let commitCalls = 0;
    const snapshots = new ReviewCompletionSnapshotContextAdapter(
      { findExecution: async () => snapshot },
      {
        findIdentity: async () => ({
          executionId: "execution-1",
          finalizedArtifactId: "artifact-1",
          artifactHash: hash("9"),
        }),
      },
      attempts,
      { findCurrent: async () => null },
      {
        commit: async () => {
          commitCalls += 1;
          throw new Error("must_not_commit");
        },
      },
      completionProjectionMapper(),
    );

    await expect(
      snapshots.commit({
        executionId: "execution-1",
        finalizedArtifactId: "artifact-1",
        publicationAttemptId: command?.publicationAttemptId ?? "missing",
      }),
    ).rejects.toThrow("review_completion_snapshot_partial_forbidden");
    expect(commitCalls).toBe(0);
  });
});

class FakePublicationAttempts implements ReviewPublicationAttemptQueryPort {
  private view: ReviewPublicationAttemptView | null = null;

  async findById(
    publicationAttemptId: string,
  ): Promise<ReviewPublicationAttemptView | null> {
    return this.view?.attempt.publicationAttemptId === publicationAttemptId
      ? structuredClone(this.view)
      : null;
  }

  async findByPermitIdentity(): Promise<ReviewPublicationAttemptView | null> {
    return this.view ? structuredClone(this.view) : null;
  }

  store(view: ReviewPublicationAttemptView): void {
    this.view = structuredClone(view);
  }
}

class FakePublicationRequests {
  readonly commands: RequestReviewPublicationCommand[] = [];

  constructor(private readonly attempts: FakePublicationAttempts) {}

  async request(command: RequestReviewPublicationCommand) {
    this.commands.push(structuredClone(command));
    const existing = await this.attempts.findById(command.publicationAttemptId);
    if (existing) {
      return {
        status: RequestReviewPublicationStatus.Restored,
        attempt: existing.attempt,
      } as const;
    }
    const view = publicationView(command);
    this.attempts.store(view);
    return {
      status: RequestReviewPublicationStatus.Applied,
      attempt: view.attempt,
    } as const;
  }
}

class ConcurrentIdentityWinnerRequests {
  readonly commands: RequestReviewPublicationCommand[] = [];

  constructor(private readonly attempts: FakePublicationAttempts) {}

  async request(command: RequestReviewPublicationCommand) {
    this.commands.push(structuredClone(command));
    if (this.commands.length === 1) {
      this.attempts.store(
        publicationView(legacyProjectionScopedCommand(command)),
      );
      return {
        status: RequestReviewPublicationStatus.RequestConflict,
      } as const;
    }
    const existing = await this.attempts.findById(command.publicationAttemptId);
    if (!existing) throw new Error("test_publication_winner_missing");
    return {
      status: RequestReviewPublicationStatus.Restored,
      attempt: existing.attempt,
    } as const;
  }
}

function legacyProjectionScopedCommand(
  command: RequestReviewPublicationCommand,
): RequestReviewPublicationCommand {
  const scopedPrefix = `review-publication:${command.publicationAttemptId}:${command.permit.projectionHash}:`;
  const legacyPrefix = `review-publication:${command.permit.projectionHash}:`;
  const operations = command.operations.map((operation) => ({
    ...operation,
    publicationOperationId: operation.publicationOperationId.replace(
      scopedPrefix,
      legacyPrefix,
    ),
    dependsOnOperationId:
      operation.dependsOnOperationId?.replace(scopedPrefix, legacyPrefix) ??
      null,
  }));
  const candidate = { ...command, operations };
  return {
    ...candidate,
    requestHash: createHash("sha256")
      .update(
        canonicalJson({
          publicationAttemptId: candidate.publicationAttemptId,
          requestIdHash: candidate.requestIdHash,
          permit: candidate.permit,
          operations: candidate.operations,
          createdAt: candidate.createdAt,
          retainUntil: candidate.retainUntil,
        }),
        "utf8",
      )
      .digest("hex"),
  };
}

function publicationView(
  command: RequestReviewPublicationCommand | null,
  input: {
    readonly state?: ReviewPublicationAttemptState;
    readonly terminalOutcome?: ReviewPublicationTerminalOutcome | null;
    readonly withReceipt?: boolean;
  } = {},
): ReviewPublicationAttemptView {
  if (!command) throw new Error("test_publication_command_missing");
  const operation = command.operations[0];
  if (!operation) throw new Error("test_publication_operation_missing");
  return {
    attempt: {
      schemaVersion: 2,
      publicationAttemptId: command.publicationAttemptId,
      permit: command.permit,
      requestHash: command.requestHash,
      version: 1n,
      activeClaimId: null,
      state: input.state ?? ReviewPublicationAttemptState.Pending,
      terminalOutcome: input.terminalOutcome ?? null,
      operations: command.operations.map((plan) => ({
        ...plan,
        publicationAttemptId: command.publicationAttemptId,
        state:
          input.state === ReviewPublicationAttemptState.Terminal
            ? ReviewPublicationOperationState.Completed
            : ReviewPublicationOperationState.Planned,
      })),
      createdAt: command.createdAt,
      retainUntil: command.retainUntil,
    },
    activeClaim: null,
    operationAttempts: [],
    effects: [],
    receipts: input.withReceipt
      ? [
          {
            receiptId: "publication-receipt-1",
            publicationAttemptId: command.publicationAttemptId,
            publicationOperationId: operation.publicationOperationId,
            canonicalEffectId: "effect-1",
            canonicalExternalObjectId: "external-1",
            status: ReviewPublicationReceiptStatus.Succeeded,
            receiptHash: hash("8"),
            updatedAt: now,
          },
        ]
      : [],
    tombstones: [],
    corrections: [],
  };
}

function publicationRequestFactory(
  mapper: ReviewCompletionProjectionMapperPort = completionProjectionMapper(),
  attempts: Pick<ReviewPublicationAttemptQueryPort, "findById"> = {
    findById: async () => null,
  },
): DeterministicReviewPublicationRequestFactory {
  return new DeterministicReviewPublicationRequestFactory(
    mapper,
    new ReviewPublicationOperationPlanningService(
      new InMemoryReviewPublicationReleaseLimitsQuery([publicationLimits()]),
    ),
    attempts,
  );
}

function completionProjectionMapper(
  transform: (
    envelope: PublishedReviewProjectionPublicationEnvelope,
  ) => PublishedReviewProjectionPublicationEnvelope = (envelope) => envelope,
): ReviewCompletionProjectionMapperPort {
  return {
    publicationEnvelope: async (artifact) =>
      transform({
        envelopeVersion: publishedReviewProjectionPublicationEnvelopeVersion,
        producerReleaseId: artifact.publicationPermit.producerReleaseId,
        protocolLimitsProfileId: "limits-v2",
        limitsDigest: hash("9"),
        projectionHash: artifact.projectionHash,
        coverage:
          artifact.coverageState === ReviewCoverageState.Partial
            ? ReviewPublicationProjectionCoverage.Partial
            : ReviewPublicationProjectionCoverage.Completed,
        targetCommitId: artifact.reviewedHeadSha,
        reviewRevisionHash: artifact.reviewRevisionHash,
        renderPolicyVersion: 1,
        publicationNotAfter: new Date(
          artifact.publicationPermit.publicationNotAfter,
        ),
        summary: {
          semantic:
            artifact.coverageState === ReviewCoverageState.Partial
              ? ReviewPublicationSummarySemantic.PartialCoverage
              : ReviewPublicationSummarySemantic.Findings,
          ...publicationBody("5", "6"),
        },
        managedCheck: null,
        inlineReviews: [],
        lifecycle: [],
      }),
    snapshotProjection: async () => ({
      occurrences: [],
      lineageHints: {
        hints: [],
        eviction: {
          [LineageHintEvictionReason.Age]: 0,
          [LineageHintEvictionReason.Count]: 0,
          [LineageHintEvictionReason.Bytes]: 0,
          evictionWatermark: null,
        },
      },
      expiresAt: retainUntil,
    }),
  };
}

function publicationLimits(): ReviewPublicationPlanningLimits {
  return {
    producerReleaseId: "release-1",
    protocolLimitsProfileId: "limits-v2",
    limitsDigest: hash("9"),
    maxPublicationOperations: 20,
    maxPublicationChunks: 20,
    maxPublicationBodyBytes: 10_000,
    maxReconciliationDurationMs: 3_600_000,
  };
}

function publicationBody(
  marker: string,
  body: string,
): CanonicalReviewPublicationBodyFacts {
  return {
    markerHash: hash(marker),
    bodyHash: hash(body),
    bodyByteCount: 10,
  };
}

function executionSnapshot(
  input: {
    readonly executionState?: ReviewExecutionState;
    readonly coverage?: ReviewCoverageState;
  } = {},
): ReviewExecutionSnapshot {
  const scope = {
    workspaceId: "workspace-1",
    repositoryConnectionId: "repository-1",
    scmRepositoryIdentityId: "scm-repository-1",
    pullRequestNumber: 42,
  };
  const revision = {
    baseSha: hash("1"),
    mergeBaseSha: hash("2"),
    headSha: hash("3"),
    reviewRevisionHash: hash("7"),
  };
  const artifact = {
    artifactId: "artifact-1",
    executionId: "execution-1",
    generation: 1n,
    reviewedHeadSha: revision.headSha,
    reviewRevisionHash: revision.reviewRevisionHash,
    coverageState: input.coverage ?? ReviewCoverageState.Completed,
    projectionEnvelopeVersion: 2,
    projectionEnvelopeJson: '{"findings":[]}',
    projectionHash: hash("4"),
    byteCount: 15,
    findingCount: 0,
    lifecycleStateHash: hash("a"),
    commandLedgerWatermark: 2n,
    projectionPolicyVersion: "review-projection-policy.v3-t0",
    publicationPermit: {
      ...scope,
      executionId: "execution-1",
      generation: 1n,
      authorizationId: "authorization-1",
      producerReleaseId: "release-1",
      reviewedHeadSha: revision.headSha,
      reviewRevisionHash: revision.reviewRevisionHash,
      projectionHash: hash("4"),
      lifecycleStateHash: hash("a"),
      commandLedgerWatermark: 2n,
      permitEpoch: 1n,
      publicationSafetyDecisionHash: hash("b"),
      publicationNotAfter: new Date("2026-07-22T15:00:00.000Z"),
    },
    createdAt: now,
    retainUntil,
  } as const;
  return {
    stream: {
      ...scope,
      version: 2n,
      activeExecutionId: "execution-1",
      preparedExecutionId: null,
      lastAllocatedGeneration: 1n,
      currentRevision: revision,
      updatedAt: now,
    },
    execution: {
      ...scope,
      executionId: "execution-1",
      version: 2n,
      generation: 1n,
      revision,
      authorizationId: "authorization-1",
      producerReleaseId: "release-1",
      mutationEpoch: 1n,
      startIdentityHash: hash("c"),
      canonicalStartHash: hash("d"),
      admissionSafetyDecisionHash: hash("e"),
      state: input.executionState ?? ReviewExecutionState.Completed,
      compatibilityKey: "compatibility-v2",
      planHash: hash("f"),
      protocolLimitsProfileId: "limits-v2",
      sourceRunId: "run-1",
      sourceRunAttempt: "1",
      workSlots: [
        {
          workSlotId: "slot-1",
          taskKind: ReviewTaskKind.FindingDiscovery,
          providerKind: ReviewExecutionProviderKind.Codex,
          providerVoteIdentityHash: hash("0"),
          shardKey: "all",
          required: true,
          attemptBudget: 1,
          retryPolicyVersion: "retry-v1",
          state: ReviewWorkSlotState.Satisfied,
          activeLeaseId: null,
          acceptedObservationRefId: "observation-ref-1",
          nextAttemptOrdinal: 2,
        },
      ],
      finalizedArtifactId: "artifact-1",
      supersededByExecutionId: null,
      createdAt: now,
      updatedAt: now,
      admissionDeadlineAt: new Date("2026-07-22T12:10:00.000Z"),
      admissionCheckedAt: now,
      executionDeadlineAt: new Date("2026-07-22T14:00:00.000Z"),
      retainUntil,
    },
    observationRefs: [],
    activeLeases: [],
    artifact,
  };
}

function hash(character: string): string {
  return character.repeat(64);
}
