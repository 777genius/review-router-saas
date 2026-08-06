import { describe, expect, it } from "vitest";
import {
  CurrentPublicationLifecycleStatus,
  LiveReviewPublicationLifecycleStatus,
  ReviewPublicationLifecycleExpectationStatus,
  type LiveReviewPublicationLifecyclePort,
  type ReviewPublicationLifecycleExpectationPort,
} from "../application/ports/review-publication-ports";
import type { ReviewPublicationScope } from "../domain/review-publication-attempt";
import { ReviewPublicationLifecycleObservationVersion } from "../domain/review-lifecycle-thread-state-witness";
import {
  ResolveCurrentPublicationLifecycle,
  reviewPublicationLifecycleExpectationFromProjection,
} from "../application/use-cases/resolve-current-publication-lifecycle";

const scope: ReviewPublicationScope = {
  workspaceId: "workspace-1",
  repositoryConnectionId: "repository-1",
  scmRepositoryIdentityId: "identity-1",
  pullRequestNumber: 42,
};
const headSha = "a".repeat(40);
const boundary = new Date("2026-07-23T10:00:00.000Z");
const currentFindingFingerprint = "c".repeat(24);
const targetFingerprint = "b".repeat(24);
const targetThreadStateHash = "1".repeat(64);
const targets = [
  {
    targetId: "rrt_first",
    threadId: "thread-first",
    mutationEligible: true,
  },
  {
    targetId: "rrt_second",
    threadId: "thread-second",
    mutationEligible: false,
  },
] as const;

describe("ResolveCurrentPublicationLifecycle", () => {
  it("returns the persisted tuple only when the live inventory is unchanged", async () => {
    const result = await resolver().resolve(scope);

    expect(result).toEqual({
      status: CurrentPublicationLifecycleStatus.Current,
      lifecycleStateHash: "lifecycle-hash",
      commandLedgerWatermark: 17n,
    });
  });

  it.each([
    {
      name: "head changed",
      live: availableLive({ reviewedHeadSha: "b".repeat(40) }),
    },
    {
      name: "target identity changed",
      live: availableLive({
        targets: liveTargets().map((target) =>
          target.targetId === "rrt_first"
            ? { ...target, threadId: "thread-first-replaced" }
            : target,
        ),
      }),
    },
    {
      name: "command ledger changed",
      live: availableLive({ commandLedgerWatermark: 18n }),
    },
    {
      name: "relevant comment changed after authorization",
      live: availableLive({
        targets: liveTargets({
          lastRelevantChangeAt: new Date("2026-07-23T10:00:00.000Z"),
          hasRelevantInteractionAfterParent: true,
        }),
      }),
    },
  ])("fails closed when $name", async ({ live }) => {
    const result = await resolver({ live }).resolve(scope);

    expect(result.status).toBe(CurrentPublicationLifecycleStatus.Changed);
  });

  it("accepts missing expected targets as already absent", async () => {
    const result = await resolver({
      live: availableLive({ targets: [] }),
    }).resolve(scope);

    expect(result.status).toBe(CurrentPublicationLifecycleStatus.Current);
  });

  it("allows new targets created by the publication after authorization", async () => {
    const result = await resolver({
      live: availableLive({
        targets: [
          ...liveTargets(),
          {
            targetId: "rrt_current_publication",
            threadId: "thread-current-publication",
            markerFingerprint: currentFindingFingerprint,
            threadStateHash: "2".repeat(64),
            isResolved: false,
            parentOwnedByIntegration: true,
            hasRelevantInteractionAfterParent: false,
            parentCreatedAt: new Date("2026-07-23T10:00:01.000Z"),
            lastRelevantChangeAt: new Date("2026-07-23T10:00:01.000Z"),
          },
        ],
      }),
    }).resolve(scope);

    expect(result.status).toBe(CurrentPublicationLifecycleStatus.Current);
  });

  it("rejects an old resolved target that was reopened after authorization", async () => {
    const result = await resolver({
      live: availableLive({
        targets: [
          ...liveTargets(),
          {
            targetId: "rrt_reopened",
            threadId: "thread-reopened",
            markerFingerprint: "d".repeat(24),
            threadStateHash: "3".repeat(64),
            isResolved: false,
            parentOwnedByIntegration: true,
            hasRelevantInteractionAfterParent: false,
            parentCreatedAt: new Date("2026-07-23T09:00:00.000Z"),
            lastRelevantChangeAt: new Date("2026-07-23T09:00:00.000Z"),
          },
        ],
      }),
    }).resolve(scope);

    expect(result.status).toBe(CurrentPublicationLifecycleStatus.Changed);
  });

  it.each([
    {
      name: "was not authored by this integration",
      target: { parentOwnedByIntegration: false },
    },
    {
      name: "received a reply or edit",
      target: { hasRelevantInteractionAfterParent: true },
    },
    {
      name: "does not belong to this projection",
      target: { markerFingerprint: "e".repeat(24) },
    },
  ])("rejects a new target that $name", async ({ target }) => {
    const result = await resolver({
      live: availableLive({
        targets: [
          ...liveTargets(),
          {
            targetId: "rrt_untrusted_current",
            threadId: "thread-untrusted-current",
            markerFingerprint: currentFindingFingerprint,
            threadStateHash: "4".repeat(64),
            isResolved: false,
            parentOwnedByIntegration: true,
            hasRelevantInteractionAfterParent: false,
            parentCreatedAt: new Date("2026-07-23T10:00:01.000Z"),
            lastRelevantChangeAt: new Date("2026-07-23T10:00:01.000Z"),
            ...target,
          },
        ],
      }),
    }).resolve(scope);

    expect(result.status).toBe(CurrentPublicationLifecycleStatus.Changed);
  });

  it("accepts the intended resolve transition for a mutation-eligible target", async () => {
    const result = await resolver({
      live: availableLive({
        targets: liveTargets().map((target) =>
          target.targetId === "rrt_first"
            ? { ...target, isResolved: true }
            : target,
        ),
      }),
    }).resolve(scope);

    expect(result.status).toBe(CurrentPublicationLifecycleStatus.Current);
  });

  it("rejects resolution of a target that the projection did not authorize", async () => {
    const result = await resolver({
      live: availableLive({
        targets: liveTargets().map((target) =>
          target.targetId === "rrt_second"
            ? { ...target, isResolved: true }
            : target,
        ),
      }),
    }).resolve(scope);

    expect(result.status).toBe(CurrentPublicationLifecycleStatus.Changed);
  });

  it("ignores old targets that remain resolved", async () => {
    const result = await resolver({
      live: availableLive({
        targets: [
          ...liveTargets(),
          {
            targetId: "rrt_already_resolved",
            threadId: "thread-already-resolved",
            markerFingerprint: "f".repeat(24),
            threadStateHash: "5".repeat(64),
            isResolved: true,
            parentOwnedByIntegration: true,
            hasRelevantInteractionAfterParent: false,
            parentCreatedAt: new Date("2026-07-23T09:00:00.000Z"),
            lastRelevantChangeAt: new Date("2026-07-23T09:00:00.000Z"),
          },
        ],
      }),
    }).resolve(scope);

    expect(result.status).toBe(CurrentPublicationLifecycleStatus.Current);
  });

  it("maps missing and unavailable facts without exposing stale hashes", async () => {
    const missing = await resolver({
      live: { status: LiveReviewPublicationLifecycleStatus.Missing },
    }).resolve(scope);
    const unavailable = await resolver({
      live: { status: LiveReviewPublicationLifecycleStatus.Unavailable },
    }).resolve(scope);

    expect(missing).toEqual({
      status: CurrentPublicationLifecycleStatus.Missing,
      lifecycleStateHash: null,
      commandLedgerWatermark: null,
    });
    expect(unavailable).toEqual({
      status: CurrentPublicationLifecycleStatus.Unavailable,
      lifecycleStateHash: null,
      commandLedgerWatermark: null,
    });
  });

  it("uses an exact v1 witness instead of the legacy authorization boundary", async () => {
    const expectation = expectationWithObservation();
    const result = await resolver({
      expectation,
      live: availableLive({
        targets: liveTargets({
          lastRelevantChangeAt: new Date("2026-07-23T10:00:30.000Z"),
          hasRelevantInteractionAfterParent: true,
        }),
      }),
    }).resolve(scope);

    expect(result.status).toBe(CurrentPublicationLifecycleStatus.Current);
  });

  it("accepts an exact-v1 resolve authorized by mutation eligibility", async () => {
    const result = await resolver({
      expectation: expectationWithObservation(),
      live: availableLive({
        targets: liveTargets().map((target) =>
          target.targetId === "rrt_first"
            ? { ...target, isResolved: true }
            : target,
        ),
      }),
    }).resolve(scope);

    expect(result.status).toBe(CurrentPublicationLifecycleStatus.Current);
  });

  it("keeps an exact-v1 authorized resolve idempotent after resolution", async () => {
    const lifecycle = resolver({
      expectation: expectationWithObservation(),
      live: availableLive({
        targets: liveTargets().map((target) =>
          target.targetId === "rrt_first"
            ? { ...target, isResolved: true }
            : target,
        ),
      }),
    });

    await expect(lifecycle.resolve(scope)).resolves.toMatchObject({
      status: CurrentPublicationLifecycleStatus.Current,
    });
    await expect(lifecycle.resolve(scope)).resolves.toMatchObject({
      status: CurrentPublicationLifecycleStatus.Current,
    });
  });

  it("rejects an exact-v1 external resolution when mutation was not authorized", async () => {
    const result = await resolver({
      expectation: expectationWithObservation(),
      live: availableLive({
        targets: liveTargets().map((target) =>
          target.targetId === "rrt_second"
            ? { ...target, isResolved: true }
            : target,
        ),
      }),
    }).resolve(scope);

    expect(result.status).toBe(CurrentPublicationLifecycleStatus.Changed);
  });

  it.each([
    {
      name: "marker changed",
      override: { markerFingerprint: "d".repeat(24) },
    },
    {
      name: "thread state changed",
      override: { threadStateHash: "9".repeat(64) },
    },
  ])(
    "rejects the lifecycle when $name after projection",
    async ({ override }) => {
      const result = await resolver({
        expectation: expectationWithObservation(),
        live: availableLive({
          targets: liveTargets({
            lastRelevantChangeAt: new Date("2026-07-23T10:00:30.000Z"),
            hasRelevantInteractionAfterParent: true,
            ...override,
          }),
        }),
      }).resolve(scope);

      expect(result.status).toBe(CurrentPublicationLifecycleStatus.Changed);
    },
  );

  it("treats an absent exactly witnessed target as changed", async () => {
    const result = await resolver({
      expectation: expectationWithObservation(),
      live: availableLive({ targets: [] }),
    }).resolve(scope);

    expect(result.status).toBe(CurrentPublicationLifecycleStatus.Changed);
  });
});

describe("reviewPublicationLifecycleExpectationFromProjection", () => {
  it.each([
    {
      name: "legacy hidden marker",
      marker: `<!-- review-router-finding:${currentFindingFingerprint} -->`,
    },
    {
      name: "current v2 marker",
      marker: `reviewrouter:finding:v2:${currentFindingFingerprint}`,
    },
  ])(
    "parses and sorts lifecycle target identities from $name",
    ({ marker }) => {
      const result = reviewPublicationLifecycleExpectationFromProjection({
        reviewedHeadSha: headSha,
        lifecycleStateHash: "lifecycle-hash",
        commandLedgerWatermark: 17n,
        legacyObservationBoundary: boundary,
        projectionEnvelopeJson: JSON.stringify({
          publishing: {
            lifecycle: [targets[1], targets[0]],
            inlineReviewChunks: [
              {
                comments: [{ marker }],
              },
            ],
          },
        }),
      });

      expect(result).toMatchObject({
        status: ReviewPublicationLifecycleExpectationStatus.Available,
        lifecycleObservationVersion: null,
        targets,
        createdTargetFingerprints: [currentFindingFingerprint],
      });
    },
  );

  it("rejects duplicate or malformed target identities", () => {
    expect(() =>
      reviewPublicationLifecycleExpectationFromProjection({
        reviewedHeadSha: headSha,
        lifecycleStateHash: "lifecycle-hash",
        commandLedgerWatermark: 17n,
        legacyObservationBoundary: boundary,
        projectionEnvelopeJson: JSON.stringify({
          publishing: { lifecycle: [targets[0], targets[0]] },
        }),
      }),
    ).toThrow("lifecycle_target_duplicate");
  });

  it("parses a complete lifecycle observation witness", () => {
    const result = reviewPublicationLifecycleExpectationFromProjection({
      reviewedHeadSha: headSha,
      lifecycleStateHash: "lifecycle-hash",
      commandLedgerWatermark: 17n,
      legacyObservationBoundary: boundary,
      projectionEnvelopeJson: JSON.stringify({
        publishing: {
          lifecycleObservationVersion:
            ReviewPublicationLifecycleObservationVersion.ThreadStateV1,
          lifecycle: [projectionTargetWithObservation(targets[0])],
        },
      }),
    });

    expect(result).toMatchObject({
      status: ReviewPublicationLifecycleExpectationStatus.Available,
      lifecycleObservationVersion:
        ReviewPublicationLifecycleObservationVersion.ThreadStateV1,
      targets: [
        {
          ...targets[0],
          observation: {
            markerFingerprint: targetFingerprint,
            threadStateHash: targetThreadStateHash,
          },
        },
      ],
    });
  });

  it.each([
    {
      name: "unknown observation version",
      publishing: {
        lifecycleObservationVersion: "review_lifecycle_observation.v2",
        lifecycle: [projectionTargetWithObservation(targets[0])],
      },
    },
    {
      name: "hash without an envelope version",
      publishing: { lifecycle: [projectionTargetWithObservation(targets[0])] },
    },
    {
      name: "marker without an envelope version",
      publishing: {
        lifecycle: [{ ...targets[0], markerFingerprint: targetFingerprint }],
      },
    },
    {
      name: "mixed v1 targets",
      publishing: {
        lifecycleObservationVersion:
          ReviewPublicationLifecycleObservationVersion.ThreadStateV1,
        lifecycle: [projectionTargetWithObservation(targets[0]), targets[1]],
      },
    },
    {
      name: "malformed v1 hash",
      publishing: {
        lifecycleObservationVersion:
          ReviewPublicationLifecycleObservationVersion.ThreadStateV1,
        lifecycle: [
          {
            ...projectionTargetWithObservation(targets[0]),
            threadStateHash: "bad",
          },
        ],
      },
    },
  ])(
    "maps $name to unavailable rather than changed",
    async ({ publishing }) => {
      const result = await resolverFromProjection(publishing).resolve(scope);

      expect(result.status).toBe(CurrentPublicationLifecycleStatus.Unavailable);
    },
  );
});

function resolver(overrides?: {
  readonly live?:
    | Awaited<ReturnType<LiveReviewPublicationLifecyclePort["resolve"]>>
    | undefined;
  readonly expectation?:
    | Awaited<ReturnType<ReviewPublicationLifecycleExpectationPort["resolve"]>>
    | undefined;
}) {
  return new ResolveCurrentPublicationLifecycle({
    expectations: {
      async resolve() {
        return (
          overrides?.expectation ?? {
            status: ReviewPublicationLifecycleExpectationStatus.Available,
            reviewedHeadSha: headSha,
            lifecycleStateHash: "lifecycle-hash",
            commandLedgerWatermark: 17n,
            observedNotAfter: boundary,
            lifecycleObservationVersion: null,
            targets,
            createdTargetFingerprints: [currentFindingFingerprint],
          }
        );
      },
    },
    live: {
      async resolve() {
        return overrides?.live ?? availableLive();
      },
    },
  });
}

function resolverFromProjection(publishing: unknown) {
  return new ResolveCurrentPublicationLifecycle({
    expectations: {
      async resolve() {
        return reviewPublicationLifecycleExpectationFromProjection({
          reviewedHeadSha: headSha,
          lifecycleStateHash: "lifecycle-hash",
          commandLedgerWatermark: 17n,
          legacyObservationBoundary: boundary,
          projectionEnvelopeJson: JSON.stringify({ publishing }),
        });
      },
    },
    live: {
      async resolve() {
        return availableLive();
      },
    },
  });
}

function availableLive(
  overrides?: Partial<
    Extract<
      Awaited<ReturnType<LiveReviewPublicationLifecyclePort["resolve"]>>,
      { status: LiveReviewPublicationLifecycleStatus.Available }
    >
  >,
) {
  return {
    status: LiveReviewPublicationLifecycleStatus.Available,
    reviewedHeadSha: headSha,
    commandLedgerWatermark: 17n,
    targets: liveTargets(),
    ...overrides,
  } as const;
}

function liveTargets(overrides?: {
  readonly parentCreatedAt?: Date;
  readonly lastRelevantChangeAt?: Date;
  readonly hasRelevantInteractionAfterParent?: boolean;
  readonly markerFingerprint?: string;
  readonly threadStateHash?: string;
  readonly parentOwnedByIntegration?: boolean;
}) {
  return targets.map((target) => ({
    targetId: target.targetId,
    threadId: target.threadId,
    markerFingerprint: overrides?.markerFingerprint ?? targetFingerprint,
    threadStateHash: overrides?.threadStateHash ?? targetThreadStateHash,
    isResolved: false,
    parentOwnedByIntegration: overrides?.parentOwnedByIntegration ?? true,
    hasRelevantInteractionAfterParent:
      overrides?.hasRelevantInteractionAfterParent ?? false,
    parentCreatedAt:
      overrides?.parentCreatedAt ?? new Date("2026-07-23T09:00:00.000Z"),
    lastRelevantChangeAt:
      overrides?.lastRelevantChangeAt ?? new Date("2026-07-23T09:00:00.000Z"),
  }));
}

function expectationWithObservation() {
  return {
    status: ReviewPublicationLifecycleExpectationStatus.Available,
    reviewedHeadSha: headSha,
    lifecycleStateHash: "lifecycle-hash",
    commandLedgerWatermark: 17n,
    observedNotAfter: boundary,
    lifecycleObservationVersion:
      ReviewPublicationLifecycleObservationVersion.ThreadStateV1,
    targets: targets.map((target) => ({
      ...target,
      observation: {
        markerFingerprint: targetFingerprint,
        threadStateHash: targetThreadStateHash,
      },
    })),
    createdTargetFingerprints: [currentFindingFingerprint],
  } as const;
}

function projectionTargetWithObservation(target: (typeof targets)[number]) {
  return {
    ...target,
    markerFingerprint: targetFingerprint,
    threadStateHash: targetThreadStateHash,
  };
}
