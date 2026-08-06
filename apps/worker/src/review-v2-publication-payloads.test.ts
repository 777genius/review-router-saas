import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ReviewCoverageState,
  type FinalizedReviewProjectionArtifact,
} from "@reviewrouter/features-review-executions";
import {
  ReviewPublicationOperationPlanningService,
  ReviewPublicationOperationIdentityVersion,
  ReviewPublicationOperationState,
} from "@reviewrouter/features-review-publishing/v2";
import {
  CanonicalReviewV2ProjectionAdapter,
  ReviewV2PublicationPayloadKind,
} from "./review-v2-publication-payloads";

describe("canonical review v2 projection adapter", () => {
  it("derives the same bounded payload identities used by planning and SCM", async () => {
    const artifact = finalizedArtifact();
    const adapter = new CanonicalReviewV2ProjectionAdapter({
      async findArtifact() {
        return {
          artifact,
          protocolLimitsProfileId: "limits-1",
          limitsDigest: hash("8"),
        };
      },
    });
    const envelope = await adapter.publicationEnvelope(artifact);
    expect(envelope).not.toBeNull();
    const planner = new ReviewPublicationOperationPlanningService({
      async findReleaseBoundLimits() {
        return {
          producerReleaseId: "release-1",
          protocolLimitsProfileId: "limits-1",
          limitsDigest: hash("8"),
          maxPublicationOperations: 20,
          maxPublicationChunks: 20,
          maxPublicationBodyBytes: 1_000_000,
          maxReconciliationDurationMs: 60_000,
        };
      },
    });
    const plans = await planner.plan({
      identity: {
        publicationAttemptId: "publication-1",
        version: ReviewPublicationOperationIdentityVersion.AttemptScopedV2,
      },
      envelope: envelope!,
    });
    expect(plans).toHaveLength(5);

    const payloads = await Promise.all(
      plans.map((plan) =>
        adapter.resolve({
          permit: artifact.publicationPermit,
          operation: {
            ...plan,
            publicationAttemptId: "publication-1",
            state: ReviewPublicationOperationState.Planned,
          },
        }),
      ),
    );
    expect(payloads.every(Boolean)).toBe(true);
    expect(payloads.map((payload) => payload?.kind)).toEqual([
      ReviewV2PublicationPayloadKind.Summary,
      ReviewV2PublicationPayloadKind.ManagedCheck,
      ReviewV2PublicationPayloadKind.PendingReviewCreate,
      ReviewV2PublicationPayloadKind.PendingReviewSubmit,
      ReviewV2PublicationPayloadKind.ThreadLifecycle,
    ]);
    expect(payloads[0]).toMatchObject({
      body: "One finding\n\n<!-- reviewrouter:summary:v2:test -->",
    });
    expect(payloads[2]).toMatchObject({
      body: "<!-- reviewrouter:inline:v2:test -->",
    });
    expect(payloads[3]).toMatchObject({
      body: "<!-- reviewrouter:inline:v2:test:submitted -->",
    });
    expect(
      payloads.every(
        (payload, index) =>
          payload?.bodyHash === plans[index]?.bodyHash &&
          payload?.markerHash === plans[index]?.markerHash,
      ),
    ).toBe(true);

    await expect(adapter.snapshotProjection(artifact)).resolves.toMatchObject({
      occurrences: [{ lineageId: "lineage-1" }],
      lineageHints: { hints: [{ lineageId: "lineage-1" }] },
    });
  });

  it("publishes only the preserved summary for a partial v5 projection", async () => {
    const artifact = finalizedArtifact({ partial: true });
    const adapter = new CanonicalReviewV2ProjectionAdapter({
      async findArtifact() {
        return {
          artifact,
          protocolLimitsProfileId: "limits-1",
          limitsDigest: hash("8"),
        };
      },
    });

    const envelope = await adapter.publicationEnvelope(artifact);
    const planner = new ReviewPublicationOperationPlanningService({
      async findReleaseBoundLimits() {
        return {
          producerReleaseId: "release-1",
          protocolLimitsProfileId: "limits-1",
          limitsDigest: hash("8"),
          maxPublicationOperations: 20,
          maxPublicationChunks: 20,
          maxPublicationBodyBytes: 1_000_000,
          maxReconciliationDurationMs: 60_000,
        };
      },
    });
    const plans = await planner.plan({
      identity: {
        publicationAttemptId: "publication-1",
        version: ReviewPublicationOperationIdentityVersion.AttemptScopedV2,
      },
      envelope: envelope!,
    });
    const payload = await adapter.resolve({
      permit: artifact.publicationPermit,
      operation: {
        ...plans[0]!,
        publicationAttemptId: "publication-1",
        state: ReviewPublicationOperationState.Planned,
      },
    });

    expect(envelope).not.toBeNull();
    expect(plans).toHaveLength(1);
    expect(payload).toMatchObject({
      kind: ReviewV2PublicationPayloadKind.Summary,
      bodyHash: plans[0]?.bodyHash,
      markerHash: plans[0]?.markerHash,
    });
    if (payload?.kind !== ReviewV2PublicationPayloadKind.Summary) {
      throw new Error("expected_summary_payload");
    }
    expect(payload.body).toContain(
      "Review incomplete - 1 preliminary finding preserved",
    );
    expect(envelope?.managedCheck).toBeNull();
    expect(envelope?.inlineReviews).toEqual([]);
    expect(envelope?.lifecycle).toEqual([]);
  });
});

function finalizedArtifact(
  options: { readonly partial?: boolean } = {},
): FinalizedReviewProjectionArtifact {
  const partial = options.partial ?? false;
  const createdAt = new Date("2026-07-23T12:00:00.000Z");
  const publicationNotAfter = new Date("2026-07-23T12:10:00.000Z");
  const retainUntil = new Date("2026-08-23T12:00:00.000Z");
  const projectionEnvelopeJson = canonicalJson({
    commandLedgerWatermark: "2",
    coverage: { state: partial ? "partial" : "complete" },
    envelopeVersion: "review_projection.v1",
    lifecycleStateHash: hash("4"),
    occurrences: [
      {
        lineageId: "lineage-1",
        observationIds: ["observation-1"],
        placement: { kind: "inline" },
        providerVoteKeys: ["vote-1"],
        state: "new",
      },
    ],
    publishing: {
      check: {
        conclusion: "success",
        marker: "reviewrouter:check:v2:test",
        name: "ReviewRouter",
        summary: "All checks passed",
        title: "Review complete",
      },
      inlineReviewChunks: [
        {
          chunkIndex: 0,
          comments: [
            {
              body: "Finding body",
              line: 7,
              marker: "reviewrouter:finding:v2:test",
              path: "src/index.ts",
            },
          ],
          marker: "reviewrouter:inline:v2:test",
        },
      ],
      lifecycle: [
        {
          mutationEligible: true,
          targetId: "target-1",
          threadId: "THREAD_1",
          verdict: "resolved",
        },
      ],
      summary: {
        allClear: false,
        body: "One finding",
        marker: "reviewrouter:summary:v2:test",
        occurrenceCounts: {
          new: 1,
          reconfirmed: 0,
          changed: 0,
          carried_unverified: 0,
          resolved: 0,
          uncertain: 0,
          suppressed_by_human: 0,
        },
      },
    },
    snapshot: {
      lineageHints: [{ active: true, lineageId: "lineage-1" }],
    },
  });
  return {
    artifactId: "artifact-1",
    executionId: "execution-1",
    generation: 1n,
    reviewedHeadSha: "a".repeat(40),
    reviewRevisionHash: hash("2"),
    coverageState: partial
      ? ReviewCoverageState.Partial
      : ReviewCoverageState.Completed,
    projectionEnvelopeVersion: 1,
    projectionEnvelopeJson,
    projectionHash: hash("3"),
    byteCount: Buffer.byteLength(projectionEnvelopeJson),
    findingCount: 1,
    lifecycleStateHash: hash("4"),
    commandLedgerWatermark: 2n,
    projectionPolicyVersion: "review-projection-policy.v5-t0",
    publicationPermit: {
      workspaceId: "workspace-1",
      repositoryConnectionId: "repository-1",
      scmRepositoryIdentityId: "identity-1",
      pullRequestNumber: 42,
      executionId: "execution-1",
      generation: 1n,
      authorizationId: "authorization-1",
      producerReleaseId: "release-1",
      reviewedHeadSha: "a".repeat(40),
      reviewRevisionHash: hash("2"),
      projectionHash: hash("3"),
      lifecycleStateHash: hash("4"),
      commandLedgerWatermark: 2n,
      permitEpoch: 3n,
      publicationSafetyDecisionHash: hash("5"),
      publicationNotAfter,
    },
    createdAt,
    retainUntil,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function hash(character: string): string {
  return createHash("sha256").update(character.repeat(8)).digest("hex");
}
