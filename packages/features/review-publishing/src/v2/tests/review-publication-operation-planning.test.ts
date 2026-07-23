import { describe, expect, it } from "vitest";
import {
  ReviewPublicationEffectStrategy,
  ReviewPublicationInlineReviewDelivery,
  ReviewPublicationKind,
  ReviewPublicationLifecycleSemantic,
  ReviewPublicationOperationPlanningService,
  ReviewPublicationOperationRole,
  ReviewPublicationPlanningError,
  ReviewPublicationPlanningErrorCode,
  ReviewPublicationProjectionCoverage,
  ReviewPublicationSummarySemantic,
  publishedReviewProjectionPublicationEnvelopeVersion,
  type CanonicalReviewPublicationBodyFacts,
  type PublishedReviewProjectionPublicationEnvelope,
  type ReviewPublicationPlanningLimits,
} from "../index";
import { InMemoryReviewPublicationReleaseLimitsQuery } from "../testing";

const hash = (character: string): string => character.repeat(64);
const publicationNotAfter = new Date("2026-07-22T15:00:00.000Z");
const reconcileUntil = new Date("2026-07-22T16:00:00.000Z");

describe("review publication operation planning", () => {
  it("plans the required summary as a mutable singleton", async () => {
    const operations = await planner().plan(envelope());

    expect(operations).toEqual([
      expect.objectContaining({
        publicationOperationId: `review-publication:${hash("1")}:summary:0`,
        publicationKind: ReviewPublicationKind.Summary,
        chunkIndex: 0,
        effectStrategy: ReviewPublicationEffectStrategy.MutableSingleton,
        role: ReviewPublicationOperationRole.Standalone,
        markerHash: hash("a"),
        bodyHash: hash("b"),
        required: true,
        dependsOnOperationId: null,
        reconcileUntil,
      }),
    ]);
  });

  it("accepts Git SHA-1 and SHA-256 object IDs but rejects digest-shaped impostors", async () => {
    await expect(
      planner().plan(envelope({ targetCommitId: "2".repeat(40) })),
    ).resolves.toHaveLength(1);
    await expect(
      planner().plan(envelope({ targetCommitId: "2".repeat(64) })),
    ).resolves.toHaveLength(1);
    await expect(
      planner().plan(envelope({ targetCommitId: "2".repeat(63) })),
    ).rejects.toEqual(
      planningError(ReviewPublicationPlanningErrorCode.EnvelopeInvalid),
    );
  });

  it("maps check, inline-review modes, and lifecycle into closed policies and canonical dependency order", async () => {
    const input = envelope({
      managedCheck: body("c", "d", 20),
      inlineReviews: [
        {
          chunkIndex: 0,
          delivery: ReviewPublicationInlineReviewDelivery.PendingThenSubmit,
          create: body("e", "f", 30),
          submit: body("1", "2", 40),
        },
        {
          chunkIndex: 1,
          delivery: ReviewPublicationInlineReviewDelivery.Submitted,
          body: body("3", "4", 50),
        },
      ],
      lifecycle: [
        {
          chunkIndex: 0,
          semantic: ReviewPublicationLifecycleSemantic.Resolve,
          ...body("5", "6", 10),
        },
        {
          chunkIndex: 1,
          semantic: ReviewPublicationLifecycleSemantic.MarkStale,
          ...body("7", "8", 10),
        },
      ],
    });

    const operations = await planner().plan(input);
    expect(
      operations.map((operation) => [
        operation.publicationKind,
        operation.chunkIndex,
        operation.effectStrategy,
        operation.role,
      ]),
    ).toEqual([
      [
        ReviewPublicationKind.Summary,
        0,
        ReviewPublicationEffectStrategy.MutableSingleton,
        ReviewPublicationOperationRole.Standalone,
      ],
      [
        ReviewPublicationKind.ManagedCheck,
        0,
        ReviewPublicationEffectStrategy.MutableSingleton,
        ReviewPublicationOperationRole.Standalone,
      ],
      [
        ReviewPublicationKind.PendingReviewCreate,
        0,
        ReviewPublicationEffectStrategy.PendingThenSubmit,
        ReviewPublicationOperationRole.PendingReviewCreate,
      ],
      [
        ReviewPublicationKind.PendingReviewSubmit,
        0,
        ReviewPublicationEffectStrategy.PendingThenSubmit,
        ReviewPublicationOperationRole.PendingReviewSubmit,
      ],
      [
        ReviewPublicationKind.SubmittedReview,
        1,
        ReviewPublicationEffectStrategy.AppendOnlyCanonicalReceipt,
        ReviewPublicationOperationRole.Standalone,
      ],
      [
        ReviewPublicationKind.ThreadLifecycle,
        0,
        ReviewPublicationEffectStrategy.ReversibleLifecycle,
        ReviewPublicationOperationRole.Standalone,
      ],
      [
        ReviewPublicationKind.ThreadLifecycle,
        1,
        ReviewPublicationEffectStrategy.ReversibleLifecycle,
        ReviewPublicationOperationRole.Standalone,
      ],
    ]);
    expect(operations[3]?.dependsOnOperationId).toBe(
      operations[2]?.publicationOperationId,
    );
    expect(operations.filter((operation) => operation.required)).toHaveLength(
      7,
    );
  });

  it("accepts only a conservative summary for partial coverage", async () => {
    const partial = envelope({
      coverage: ReviewPublicationProjectionCoverage.Partial,
      summary: {
        semantic: ReviewPublicationSummarySemantic.PartialCoverage,
        ...body("a", "b", 10),
      },
    });
    await expect(planner().plan(partial)).resolves.toHaveLength(1);

    const forbidden = [
      envelope({
        coverage: ReviewPublicationProjectionCoverage.Partial,
        summary: {
          semantic: ReviewPublicationSummarySemantic.AllClear,
          ...body("a", "b", 10),
        },
      }),
      envelope({
        coverage: ReviewPublicationProjectionCoverage.Partial,
        summary: {
          semantic: ReviewPublicationSummarySemantic.PartialCoverage,
          ...body("a", "b", 10),
        },
        managedCheck: body("c", "d", 10),
      }),
      envelope({
        coverage: ReviewPublicationProjectionCoverage.Partial,
        summary: {
          semantic: ReviewPublicationSummarySemantic.PartialCoverage,
          ...body("a", "b", 10),
        },
        inlineReviews: [
          {
            chunkIndex: 0,
            delivery: ReviewPublicationInlineReviewDelivery.Submitted,
            body: body("c", "d", 10),
          },
        ],
      }),
      envelope({
        coverage: ReviewPublicationProjectionCoverage.Partial,
        summary: {
          semantic: ReviewPublicationSummarySemantic.PartialCoverage,
          ...body("a", "b", 10),
        },
        lifecycle: [
          {
            chunkIndex: 0,
            semantic: ReviewPublicationLifecycleSemantic.Resolve,
            ...body("c", "d", 10),
          },
        ],
      }),
    ];

    for (const candidate of forbidden) {
      await expect(planner().plan(candidate)).rejects.toEqual(
        planningError(
          ReviewPublicationPlanningErrorCode.PartialCoverageViolation,
        ),
      );
    }
  });

  it.each([
    [
      ReviewPublicationPlanningErrorCode.OperationLimitExceeded,
      limits({ maxPublicationOperations: 1 }),
      envelope({ managedCheck: body("c", "d", 10) }),
    ],
    [
      ReviewPublicationPlanningErrorCode.ChunkLimitExceeded,
      limits({ maxPublicationChunks: 1 }),
      envelope({ managedCheck: body("c", "d", 10) }),
    ],
    [
      ReviewPublicationPlanningErrorCode.BodyLimitExceeded,
      limits({ maxPublicationBodyBytes: 19 }),
      envelope({ managedCheck: body("c", "d", 10) }),
    ],
  ])("fails closed on release-bound %s", async (code, profile, input) => {
    await expect(planner(profile).plan(input)).rejects.toEqual(
      planningError(code),
    );
  });

  it("rejects duplicate server-owned markers across publication kinds", async () => {
    const input = envelope({
      managedCheck: body("a", "d", 10),
    });

    await expect(planner().plan(input)).rejects.toEqual(
      planningError(ReviewPublicationPlanningErrorCode.DuplicateMarker),
    );
  });

  it("rejects non-canonical chunk order rather than silently sorting it", async () => {
    const input = envelope({
      inlineReviews: [
        {
          chunkIndex: 1,
          delivery: ReviewPublicationInlineReviewDelivery.Submitted,
          body: body("c", "d", 10),
        },
      ],
    });

    await expect(planner().plan(input)).rejects.toEqual(
      planningError(ReviewPublicationPlanningErrorCode.ChunkOrderInvalid),
    );
  });

  it("rejects unknown Published Language semantics fail closed", async () => {
    const input = envelope({
      summary: {
        semantic: "future_summary_semantic" as ReviewPublicationSummarySemantic,
        ...body("a", "b", 10),
      },
    });

    await expect(planner().plan(input)).rejects.toEqual(
      planningError(
        ReviewPublicationPlanningErrorCode.SummarySemanticUnsupported,
      ),
    );
  });

  it("fails closed when immutable release limits are missing or drift from the envelope", async () => {
    await expect(
      new ReviewPublicationOperationPlanningService(
        new InMemoryReviewPublicationReleaseLimitsQuery(),
      ).plan(envelope()),
    ).rejects.toEqual(
      planningError(
        ReviewPublicationPlanningErrorCode.ReleaseLimitsUnavailable,
      ),
    );

    const resolver = {
      async findReleaseBoundLimits() {
        return limits({ producerReleaseId: "another-release" });
      },
    };
    await expect(
      new ReviewPublicationOperationPlanningService(resolver).plan(envelope()),
    ).rejects.toEqual(
      planningError(ReviewPublicationPlanningErrorCode.ReleaseLimitsMismatch),
    );
  });

  it("replays the same finalized envelope deterministically without mutating it", async () => {
    const input = envelope({
      managedCheck: body("c", "d", 10),
      inlineReviews: [
        {
          chunkIndex: 0,
          delivery: ReviewPublicationInlineReviewDelivery.PendingThenSubmit,
          create: body("e", "f", 10),
          submit: body("1", "2", 10),
        },
      ],
    });
    const service = planner();

    const first = await service.plan(input);
    first[0]?.reconcileUntil.setUTCFullYear(2030);
    const second = await service.plan(input);
    const third = await service.plan(structuredClone(input));

    expect(second).toEqual(third);
    expect(second[0]?.reconcileUntil).toEqual(reconcileUntil);
    expect(input.publicationNotAfter).toEqual(publicationNotAfter);
  });
});

function planner(
  profile: ReviewPublicationPlanningLimits = limits(),
): ReviewPublicationOperationPlanningService {
  return new ReviewPublicationOperationPlanningService(
    new InMemoryReviewPublicationReleaseLimitsQuery([profile]),
  );
}

function envelope(
  overrides: Partial<PublishedReviewProjectionPublicationEnvelope> = {},
): PublishedReviewProjectionPublicationEnvelope {
  return {
    envelopeVersion: publishedReviewProjectionPublicationEnvelopeVersion,
    producerReleaseId: "release-1",
    protocolLimitsProfileId: "limits-1",
    limitsDigest: hash("9"),
    projectionHash: hash("1"),
    coverage: ReviewPublicationProjectionCoverage.Completed,
    targetCommitId: "2".repeat(40),
    reviewRevisionHash: hash("3"),
    renderPolicyVersion: 1,
    publicationNotAfter: new Date(publicationNotAfter),
    summary: {
      semantic: ReviewPublicationSummarySemantic.Findings,
      ...body("a", "b", 10),
    },
    managedCheck: null,
    inlineReviews: [],
    lifecycle: [],
    ...overrides,
  };
}

function limits(
  overrides: Partial<ReviewPublicationPlanningLimits> = {},
): ReviewPublicationPlanningLimits {
  return {
    producerReleaseId: "release-1",
    protocolLimitsProfileId: "limits-1",
    limitsDigest: hash("9"),
    maxPublicationOperations: 20,
    maxPublicationChunks: 20,
    maxPublicationBodyBytes: 10_000,
    maxReconciliationDurationMs: 3_600_000,
    ...overrides,
  };
}

function body(
  marker: string,
  content: string,
  bodyByteCount: number,
): CanonicalReviewPublicationBodyFacts {
  return {
    markerHash: hash(marker),
    bodyHash: hash(content),
    bodyByteCount,
  };
}

function planningError(
  code: ReviewPublicationPlanningErrorCode,
): ReviewPublicationPlanningError {
  return new ReviewPublicationPlanningError(code);
}
