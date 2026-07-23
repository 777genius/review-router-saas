import { describe, expect, it } from "vitest";
import {
  CurrentPublicationLifecycleStatus,
  LiveReviewPublicationLifecycleStatus,
  ReviewPublicationLifecycleExpectationStatus,
  type LiveReviewPublicationLifecyclePort,
  type ReviewPublicationLifecycleExpectationPort,
} from "../application/ports/review-publication-ports";
import type { ReviewPublicationScope } from "../domain/review-publication-attempt";
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
      name: "target set changed",
      live: availableLive({ targets: liveTargets().slice(0, 1) }),
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
        }),
      }),
    },
  ])("fails closed when $name", async ({ live }) => {
    const result = await resolver({ live }).resolve(scope);

    expect(result.status).toBe(CurrentPublicationLifecycleStatus.Changed);
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
});

describe("reviewPublicationLifecycleExpectationFromProjection", () => {
  it("parses and sorts lifecycle target identities", () => {
    const result = reviewPublicationLifecycleExpectationFromProjection({
      reviewedHeadSha: headSha,
      lifecycleStateHash: "lifecycle-hash",
      commandLedgerWatermark: 17n,
      authorizationCreatedAt: boundary,
      projectionEnvelopeJson: JSON.stringify({
        publishing: {
          lifecycle: [targets[1], targets[0]],
          inlineReviewChunks: [
            {
              comments: [
                {
                  marker: `<!-- review-router-finding:${currentFindingFingerprint} -->`,
                },
              ],
            },
          ],
        },
      }),
    });

    expect(result).toMatchObject({
      status: ReviewPublicationLifecycleExpectationStatus.Available,
      targets,
      createdTargetFingerprints: [currentFindingFingerprint],
    });
  });

  it("rejects duplicate or malformed target identities", () => {
    expect(() =>
      reviewPublicationLifecycleExpectationFromProjection({
        reviewedHeadSha: headSha,
        lifecycleStateHash: "lifecycle-hash",
        commandLedgerWatermark: 17n,
        authorizationCreatedAt: boundary,
        projectionEnvelopeJson: JSON.stringify({
          publishing: { lifecycle: [targets[0], targets[0]] },
        }),
      }),
    ).toThrow("lifecycle_target_duplicate");
  });
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
}) {
  return targets.map((target) => ({
    targetId: target.targetId,
    threadId: target.threadId,
    markerFingerprint: "b".repeat(24),
    isResolved: false,
    parentOwnedByIntegration: true,
    hasRelevantInteractionAfterParent: false,
    parentCreatedAt:
      overrides?.parentCreatedAt ?? new Date("2026-07-23T09:00:00.000Z"),
    lastRelevantChangeAt:
      overrides?.lastRelevantChangeAt ?? new Date("2026-07-23T09:59:59.999Z"),
  }));
}
