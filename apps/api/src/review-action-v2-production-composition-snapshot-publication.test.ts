import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerReviewPublicationRequestV2Routes } from "@reviewrouter/features-action-control-plane/v2";
import {
  ConfiguredCapabilityKeyRing,
  JoseRotatingCapabilityCodec,
} from "@reviewrouter/platform-signed-capabilities";
import {
  ReviewCoverageState,
  type FinalizedReviewProjectionArtifact,
  type ReviewExecutionSnapshot,
} from "@reviewrouter/features-review-executions";
import {
  ReviewPublicationAdjudicationEvidenceStatus,
  ReviewPublicationCapability,
  ReviewPublicationAttemptState,
  CurrentPublicationLifecycleStatus,
  ReviewPublicationLifecycleExpectationStatus,
  ReviewPublicationLifecycleObservationVersion,
  ReviewPublicationTerminalOutcome,
  RequestReviewPublicationStatus,
  reviewPublicationLifecycleExpectationFromProjection,
  type RequestReviewPublicationCommand,
  type ReviewPublicationDecisionPorts,
} from "@reviewrouter/features-review-publishing/v2";
import {
  createReviewPublicationV2Application,
  reviewLifecycleThreadStateHash,
} from "@reviewrouter/features-review-publishing/v2/composition";
import {
  InMemoryReviewPublicationRepository,
  allowingReviewPublicationDecisionPorts,
} from "@reviewrouter/features-review-publishing/v2/testing";
import {
  ProducerDistributionKind,
  ProducerReleaseState,
  ReviewCapabilityProfile,
  ReviewProtocolVersion,
  ReviewRunAuthorizationState,
  ReviewRunAuthorizationTokenResolutionStatus,
  ReviewTrustDomain,
  canonicalJson,
  type ReviewProtocolLimitsV2,
  type ReviewRunAuthorization,
} from "@reviewrouter/features-review-run-control";
import { LineageHintEvictionReason } from "@reviewrouter/features-review-snapshots/v2";
import {
  ReviewSnapshotRestoreResultStatus,
  ReviewPublicationRequestResultStatus,
  ReviewPublicationStatusResultStatus,
  ReviewActionV2ProtocolErrorCode,
  ReviewActionV2OperationId,
  canonicalizeReviewActionV2Request,
  reviewActionV2PublishedProtocolVersion,
  reviewActionV2PublishedSchemaDigest,
  type ReviewPublicationRequest,
} from "@reviewrouter/protocol-review-action-v2";
import { ReviewActionV2ExecutionEvidenceCapabilityAdapter } from "./review-action-v2-execution-evidence-capabilities.js";
import { createReviewActionV2SnapshotPublicationRoutes } from "./review-action-v2-production-composition-snapshot-publication.js";

const now = new Date("2026-07-23T12:00:00.000Z");
const hash = (character: string) => character.repeat(64);
const digest = {
  digestUtf8: async (value: string) =>
    createHash("sha256").update(value, "utf8").digest("hex"),
  digest: async (value: Uint8Array) =>
    createHash("sha256").update(value).digest("hex"),
};
const pairedActionRepo =
  process.env.REVIEW_ROUTER_PAIRED_ACTION_REPO?.trim() || null;
const pairedActionTest = pairedActionRepo ? it : it.skip;

describe("Review Action v2 snapshot/publication production handlers", () => {
  it("restores an exact trusted snapshot through the domain restore use case", async () => {
    const routes = createRoutes();

    await expect(
      routes.snapshot.restore!.execute({
        ...envelope("snapshot-1"),
        authorizationToken: "authorization-token",
        reviewRevisionHash: authorization.reviewRevisionHash,
      }),
    ).resolves.toMatchObject({
      statusCode: 200,
      result: {
        status: ReviewSnapshotRestoreResultStatus.Found,
        snapshotVersion: 3,
        sourceExecutionId: "execution-previous",
        sourceExecutionGeneration: "2",
      },
    });
  });

  it("validates a signed finalized permit and enqueues immutable publication operations", async () => {
    const publicationRepository = new InMemoryReviewPublicationRepository();
    const routes = createRoutes(publicationRepository);
    const capabilities = capabilityAdapter();
    const publicationPermit = await capabilities.issuePublicationPermit(
      artifact.publicationPermit,
      now,
    );
    const request = await publicationRequest(publicationPermit);

    const accepted = await routes.publication.request!.execute(request);
    expect(accepted).toMatchObject({
      statusCode: 201,
      result: {
        status: ReviewPublicationRequestResultStatus.Accepted,
        publicationState: ReviewPublicationAttemptState.Pending,
      },
    });
    const publicationAttemptId = accepted.result.publicationAttemptId;
    expect(publicationAttemptId).toBeTruthy();

    const stored = await publicationRepository.findById(publicationAttemptId!);
    expect(stored?.attempt.operations.length).toBe(2);
    expect(stored?.attempt.state).toBe(ReviewPublicationAttemptState.Pending);

    await expect(
      routes.publication.status!.execute({
        ...envelope("publication-status-1"),
        authorizationToken: "authorization-token",
        publicationAttemptId: publicationAttemptId!,
      }),
    ).resolves.toMatchObject({
      statusCode: 200,
      result: {
        status: ReviewPublicationStatusResultStatus.Pending,
        publicationAttemptId,
      },
    });
  });

  it("accepts canonical producer metadata outside publication rendering", async () => {
    const publishingWithMetadata = {
      ...publishing,
      inlineReviewChunks: [
        {
          chunkIndex: 0,
          marker: "<!-- inline-chunk-marker -->",
          bodyHash: hash("b"),
          comments: [
            {
              lineageId: "lineage-1",
              marker: "<!-- inline-comment-marker -->",
              path: "src/example.ts",
              startLine: 4,
              line: 5,
              endLine: 5,
              body: "Finding body",
            },
          ],
        },
      ],
      lifecycle: [
        {
          targetId: "target-1",
          threadId: "thread-1",
          lineageId: "lineage-1",
          verdict: "resolved",
          reasonCodes: ["provider_reconfirmed"],
          mutationEligible: true,
        },
      ],
    };
    const projectionHash = hash("c");
    const envelopeWithMetadata = canonicalJson({
      ...JSON.parse(projectionEnvelopeJson),
      publishing: publishingWithMetadata,
    });
    const artifactWithMetadata: FinalizedReviewProjectionArtifact = {
      ...artifact,
      projectionEnvelopeJson: envelopeWithMetadata,
      projectionHash,
      byteCount: Buffer.byteLength(envelopeWithMetadata, "utf8"),
      publicationPermit: {
        ...artifact.publicationPermit,
        projectionHash,
      },
    };
    const routes = createRoutes(
      new InMemoryReviewPublicationRepository(),
      { assertCurrentPolicy: vi.fn() },
      artifactWithMetadata,
    );
    const publicationPermit = await capabilityAdapter().issuePublicationPermit(
      artifactWithMetadata.publicationPermit,
      now,
    );

    await expect(
      routes.publication.request!.execute(
        await publicationRequest(
          publicationPermit,
          canonicalJson(publishingWithMetadata),
          projectionHash,
        ),
      ),
    ).resolves.toMatchObject({
      statusCode: 201,
      result: {
        status: ReviewPublicationRequestResultStatus.Accepted,
      },
    });
  });

  it("accepts an Action v1 lifecycle witness through the outer Fastify parser without stripping it", async () => {
    const publishingV1 = {
      ...publishing,
      lifecycleObservationVersion:
        ReviewPublicationLifecycleObservationVersion.ThreadStateV1,
      lifecycle: [
        {
          targetId: "target-v1",
          threadId: "thread-v1",
          verdict: "resolved",
          reasonCodes: ["provider_reconfirmed"],
          mutationEligible: true,
          markerFingerprint: "a".repeat(24),
          threadStateHash: hash("b"),
        },
      ],
    };
    const artifactV1 = finalizedArtifactWithPublishing(publishingV1, hash("c"));
    const lifecycle = vi.fn(async () => {
      const expectation = reviewPublicationLifecycleExpectationFromProjection({
        reviewedHeadSha: artifactV1.reviewedHeadSha,
        lifecycleStateHash: artifactV1.lifecycleStateHash,
        commandLedgerWatermark: artifactV1.commandLedgerWatermark,
        legacyObservationBoundary: artifactV1.createdAt,
        projectionEnvelopeJson: artifactV1.projectionEnvelopeJson,
      });
      expect(expectation).toMatchObject({
        status: ReviewPublicationLifecycleExpectationStatus.Available,
        lifecycleObservationVersion:
          ReviewPublicationLifecycleObservationVersion.ThreadStateV1,
        targets: [
          {
            targetId: "target-v1",
            observation: {
              markerFingerprint: "a".repeat(24),
              threadStateHash: hash("b"),
            },
          },
        ],
      });
      return {
        status: CurrentPublicationLifecycleStatus.Current,
        lifecycleStateHash: artifactV1.lifecycleStateHash,
        commandLedgerWatermark: artifactV1.commandLedgerWatermark,
      } as const;
    });
    const repository = new InMemoryReviewPublicationRepository();
    const routes = createRoutes(
      repository,
      { assertCurrentPolicy: vi.fn() },
      artifactV1,
      { lifecycle: { resolve: lifecycle } },
    );
    const publicationPermit = await capabilityAdapter().issuePublicationPermit(
      artifactV1.publicationPermit,
      now,
    );
    const app = Fastify({ logger: false });
    await registerReviewPublicationRequestV2Routes(app, routes.publication);

    const response = await app.inject({
      method: "POST",
      url: "/api/action/v2/review-publication/request",
      payload: await publicationRequest(
        publicationPermit,
        canonicalJson(publishingV1),
        artifactV1.projectionHash,
      ),
    });

    expect(response.statusCode).toBe(201);
    expect(lifecycle).toHaveBeenCalledTimes(1);
    await expect(
      repository.findByPermitIdentity(artifactV1.publicationPermit),
    ).resolves.not.toBeNull();
    await app.close();
  });

  pairedActionTest(
    "accepts the paired Action golden projection target and reproduces its thread hash",
    async () => {
      const fixture = await readPairedActionLifecycleFixture(pairedActionRepo!);
      const actualHash = reviewLifecycleThreadStateHash(fixture.thread);
      expect(actualHash).toBe(fixture.expectedThreadStateHash);
      expect(fixture.projectionTarget).toMatchObject({
        threadId: fixture.thread.threadId,
        threadStateHash: fixture.expectedThreadStateHash,
      });
      const publishingFromAction = {
        ...publishing,
        lifecycleObservationVersion:
          ReviewPublicationLifecycleObservationVersion.ThreadStateV1,
        lifecycle: [
          {
            ...fixture.projectionTarget,
            verdict: "resolved",
            reasonCodes: ["provider_reconfirmed"],
            mutationEligible: true,
          },
        ],
      };
      const projectionEnvelopeFromAction = {
        ...JSON.parse(projectionEnvelopeJson),
        publishing: publishingFromAction,
      } as Readonly<Record<string, unknown>>;

      const artifactFromAction = finalizedArtifactWithProjectionEnvelope(
        projectionEnvelopeFromAction,
        hash("e"),
      );
      const lifecycle = vi.fn(async () => {
        const expectation = reviewPublicationLifecycleExpectationFromProjection(
          {
            reviewedHeadSha: artifactFromAction.reviewedHeadSha,
            lifecycleStateHash: artifactFromAction.lifecycleStateHash,
            commandLedgerWatermark: artifactFromAction.commandLedgerWatermark,
            legacyObservationBoundary: artifactFromAction.createdAt,
            projectionEnvelopeJson: artifactFromAction.projectionEnvelopeJson,
          },
        );
        expect(expectation).toMatchObject({
          status: ReviewPublicationLifecycleExpectationStatus.Available,
          lifecycleObservationVersion:
            ReviewPublicationLifecycleObservationVersion.ThreadStateV1,
        });
        if (
          expectation.status !==
          ReviewPublicationLifecycleExpectationStatus.Available
        ) {
          throw new Error("paired_action_lifecycle_expectation_unavailable");
        }
        expect(expectation.targets).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              targetId: fixture.projectionTarget.targetId,
              threadId: fixture.thread.threadId,
              observation: expect.objectContaining({
                markerFingerprint: fixture.projectionTarget.markerFingerprint,
                threadStateHash: fixture.expectedThreadStateHash,
              }),
            }),
          ]),
        );
        return {
          status: CurrentPublicationLifecycleStatus.Current,
          lifecycleStateHash: artifactFromAction.lifecycleStateHash,
          commandLedgerWatermark: artifactFromAction.commandLedgerWatermark,
        } as const;
      });
      const routes = createRoutes(
        new InMemoryReviewPublicationRepository(),
        { assertCurrentPolicy: vi.fn() },
        artifactFromAction,
        { lifecycle: { resolve: lifecycle } },
      );
      const publicationPermit =
        await capabilityAdapter().issuePublicationPermit(
          artifactFromAction.publicationPermit,
          now,
        );
      const app = Fastify({ logger: false });
      await registerReviewPublicationRequestV2Routes(app, routes.publication);

      const response = await app.inject({
        method: "POST",
        url: "/api/action/v2/review-publication/request",
        payload: await publicationRequest(
          publicationPermit,
          canonicalJson(publishingFromAction),
          artifactFromAction.projectionHash,
        ),
      });

      expect(response.statusCode).toBe(201);
      expect(lifecycle).toHaveBeenCalledTimes(1);
      await app.close();
    },
  );

  it.each([
    {
      name: "unknown observation version",
      source: {
        ...publishing,
        lifecycleObservationVersion: "review_lifecycle_observation.v2",
        lifecycle: [],
      },
    },
    {
      name: "v1 target missing its witness",
      source: {
        ...publishing,
        lifecycleObservationVersion:
          ReviewPublicationLifecycleObservationVersion.ThreadStateV1,
        lifecycle: [
          {
            targetId: "target-v1",
            threadId: "thread-v1",
            verdict: "resolved",
            reasonCodes: [],
            mutationEligible: true,
          },
        ],
      },
    },
    {
      name: "mixed v1 targets",
      source: {
        ...publishing,
        lifecycleObservationVersion:
          ReviewPublicationLifecycleObservationVersion.ThreadStateV1,
        lifecycle: [
          {
            targetId: "target-v1",
            threadId: "thread-v1",
            verdict: "resolved",
            reasonCodes: [],
            mutationEligible: true,
            markerFingerprint: "a".repeat(24),
            threadStateHash: hash("b"),
          },
          {
            targetId: "target-legacy",
            threadId: "thread-legacy",
            verdict: "unchanged",
            reasonCodes: [],
            mutationEligible: false,
          },
        ],
      },
    },
    {
      name: "legacy target carrying a v1 witness",
      source: {
        ...publishing,
        lifecycle: [
          {
            targetId: "target-legacy",
            threadId: "thread-legacy",
            verdict: "unchanged",
            reasonCodes: [],
            mutationEligible: false,
            markerFingerprint: "a".repeat(24),
            threadStateHash: hash("b"),
          },
        ],
      },
    },
  ])(
    "rejects $name at the real outer publication parser",
    async ({ source }) => {
      const invalidArtifact = finalizedArtifactWithPublishing(
        source,
        hash("d"),
      );
      const publicationPermit =
        await capabilityAdapter().issuePublicationPermit(
          invalidArtifact.publicationPermit,
          now,
        );
      const routes = createRoutes(
        new InMemoryReviewPublicationRepository(),
        { assertCurrentPolicy: vi.fn() },
        invalidArtifact,
      );
      const app = Fastify({ logger: false });
      await registerReviewPublicationRequestV2Routes(app, routes.publication);

      const response = await app.inject({
        method: "POST",
        url: "/api/action/v2/review-publication/request",
        payload: await publicationRequest(
          publicationPermit,
          canonicalJson(source),
          invalidArtifact.projectionHash,
        ),
      });

      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({
        error: {
          errorCode: ReviewActionV2ProtocolErrorCode.InvariantViolation,
        },
      });
      await app.close();
    },
  );

  it("compares publication expiry using JWT NumericDate precision", async () => {
    const fractionalArtifact = {
      ...artifact,
      publicationPermit: {
        ...artifact.publicationPermit,
        publicationNotAfter: new Date("2026-07-23T12:10:00.123Z"),
      },
    };
    const publicationRepository = new InMemoryReviewPublicationRepository();
    const routes = createRoutes(
      publicationRepository,
      { assertCurrentPolicy: vi.fn() },
      fractionalArtifact,
    );
    const publicationPermit = await capabilityAdapter().issuePublicationPermit(
      fractionalArtifact.publicationPermit,
      now,
    );

    await expect(
      routes.publication.request!.execute(
        await publicationRequest(publicationPermit),
      ),
    ).resolves.toMatchObject({
      statusCode: 201,
      result: {
        status: ReviewPublicationRequestResultStatus.Accepted,
      },
    });
  });

  it("restores an exact publication request before rechecking mutable policy", async () => {
    const publicationRepository = new InMemoryReviewPublicationRepository();
    const publicationRequestSpy = vi.spyOn(publicationRepository, "request");
    const contextPolicy = { assertCurrentPolicy: vi.fn() };
    const routes = createRoutes(publicationRepository, contextPolicy);
    const publicationPermit = await capabilityAdapter().issuePublicationPermit(
      artifact.publicationPermit,
      now,
    );
    const request = await publicationRequest(publicationPermit);

    await expect(
      routes.publication.request!.execute(request),
    ).resolves.toMatchObject({
      statusCode: 201,
      result: {
        status: ReviewPublicationRequestResultStatus.Accepted,
      },
    });
    contextPolicy.assertCurrentPolicy.mockRejectedValue(
      new Error("context_policy_changed_after_publication"),
    );

    await expect(
      routes.publication.request!.execute(request),
    ).resolves.toMatchObject({
      statusCode: 200,
      result: {
        status: ReviewPublicationRequestResultStatus.Restored,
      },
    });
    expect(contextPolicy.assertCurrentPolicy).toHaveBeenCalledTimes(1);
    expect(publicationRequestSpy).toHaveBeenCalledTimes(1);
  });

  it("writes attempt-scoped operation identities for new publication attempts", async () => {
    const publicationRepository = new InMemoryReviewPublicationRepository();
    const routes = createRoutes(publicationRepository);
    const publicationPermit = await capabilityAdapter().issuePublicationPermit(
      artifact.publicationPermit,
      now,
    );

    const accepted = await routes.publication.request!.execute(
      await publicationRequest(publicationPermit),
    );
    expect(accepted).toMatchObject({
      statusCode: 201,
      result: {
        status: ReviewPublicationRequestResultStatus.Accepted,
      },
    });
    const publicationAttemptId = accepted.result.publicationAttemptId;
    expect(publicationAttemptId).toBeTruthy();
    const stored = await publicationRepository.findById(publicationAttemptId!);
    const attemptScopedPrefix = `review-publication:${publicationAttemptId}:${artifact.projectionHash}:`;
    const legacyPrefix = `review-publication:${artifact.projectionHash}:`;
    expect(stored?.attempt.operations.length).toBeGreaterThan(0);
    expect(
      stored?.attempt.operations.every(
        (operation) =>
          operation.publicationOperationId.startsWith(attemptScopedPrefix) &&
          !operation.publicationOperationId.startsWith(legacyPrefix) &&
          (operation.dependsOnOperationId === null ||
            operation.dependsOnOperationId.startsWith(attemptScopedPrefix)),
      ),
    ).toBe(true);
  });

  it("restores a publication request when persistence succeeded but the response was lost", async () => {
    const publicationRepository = new LostPublicationResponseRepository();
    const routes = createRoutes(publicationRepository);
    const publicationPermit = await capabilityAdapter().issuePublicationPermit(
      artifact.publicationPermit,
      now,
    );

    await expect(
      routes.publication.request!.execute(
        await publicationRequest(publicationPermit),
      ),
    ).resolves.toMatchObject({
      statusCode: 200,
      result: {
        status: ReviewPublicationRequestResultStatus.Restored,
      },
    });
    expect(publicationRepository.requestCalls).toBe(1);
  });

  it("returns null poll delay for terminal publication responses", async () => {
    const publicationRepository = new InMemoryReviewPublicationRepository();
    const routes = createRoutes(publicationRepository);
    const publicationPermit = await capabilityAdapter().issuePublicationPermit(
      artifact.publicationPermit,
      now,
    );
    const request = await publicationRequest(publicationPermit);
    const accepted = await routes.publication.request!.execute(request);
    const publicationAttemptId = accepted.result.publicationAttemptId!;
    const stored = await publicationRepository.findById(publicationAttemptId);
    expect(stored).not.toBeNull();

    vi.spyOn(publicationRepository, "findById").mockResolvedValue({
      ...stored!,
      attempt: {
        ...stored!.attempt,
        state: ReviewPublicationAttemptState.Terminal,
        terminalOutcome: ReviewPublicationTerminalOutcome.Succeeded,
      },
    });

    await expect(
      routes.publication.request!.execute(request),
    ).resolves.toMatchObject({
      statusCode: 200,
      result: {
        status: ReviewPublicationRequestResultStatus.Restored,
        pollAfterMs: null,
      },
    });
    await expect(
      routes.publication.status!.execute({
        ...envelope("publication-status-terminal"),
        authorizationToken: "authorization-token",
        publicationAttemptId,
      }),
    ).resolves.toMatchObject({
      statusCode: 200,
      result: {
        status: ReviewPublicationStatusResultStatus.Terminal,
        terminalOutcome: ReviewPublicationTerminalOutcome.Succeeded,
        pollAfterMs: null,
      },
    });
  });

  it("rejects publication expiry drift across JWT NumericDate seconds", async () => {
    const publicationPermit = await capabilityAdapter().issuePublicationPermit(
      {
        ...artifact.publicationPermit,
        publicationNotAfter: new Date("2026-07-23T12:10:01.000Z"),
      },
      now,
    );

    await expect(
      createRoutes().publication.request!.execute(
        await publicationRequest(publicationPermit),
      ),
    ).rejects.toMatchObject({
      statusCode: 403,
      issues: ["publication_permit_authority_mismatch"],
    });
  });

  it("rejects canonical publication payload drift before enqueue", async () => {
    const publicationRepository = new InMemoryReviewPublicationRepository();
    const routes = createRoutes(publicationRepository);
    const publicationPermit = await capabilityAdapter().issuePublicationPermit(
      artifact.publicationPermit,
      now,
    );
    const request = await publicationRequest(
      publicationPermit,
      canonicalJson({ ...publishing, lifecycle: [{ unsafe: true }] }),
    );

    await expect(
      routes.publication.request!.execute(request),
    ).rejects.toMatchObject({
      statusCode: 412,
      issues: ["publication_payload_mismatch"],
    });
    await expect(
      publicationRepository.findByPermitIdentity(artifact.publicationPermit),
    ).resolves.toBeNull();
  });

  it("maps stale context policy to stale precondition before publication is enqueued", async () => {
    const publicationRepository = new InMemoryReviewPublicationRepository();
    const contextPolicy = {
      assertCurrentPolicy: vi
        .fn()
        .mockRejectedValue(new Error("context_policy_stale")),
    };
    const routes = createRoutes(publicationRepository, contextPolicy);
    const publicationPermit = await capabilityAdapter().issuePublicationPermit(
      artifact.publicationPermit,
      now,
    );

    await expect(
      routes.publication.request!.execute(
        await publicationRequest(publicationPermit),
      ),
    ).rejects.toMatchObject({
      statusCode: 412,
      issues: ["publication_context_policy_stale"],
    });
    expect(contextPolicy.assertCurrentPolicy).toHaveBeenCalledTimes(1);
    await expect(
      publicationRepository.findByPermitIdentity(artifact.publicationPermit),
    ).resolves.toBeNull();
  });

  it("maps transient lifecycle unavailability to same-request HTTP retry semantics", async () => {
    const publicationRepository = new InMemoryReviewPublicationRepository();
    const routes = createRoutes(
      publicationRepository,
      { assertCurrentPolicy: vi.fn() },
      artifact,
      {
        lifecycle: {
          async resolve() {
            return {
              status: CurrentPublicationLifecycleStatus.Unavailable,
              lifecycleStateHash: null,
              commandLedgerWatermark: null,
            } as const;
          },
        },
      },
    );
    const publicationPermit = await capabilityAdapter().issuePublicationPermit(
      artifact.publicationPermit,
      now,
    );
    const app = Fastify({ logger: false });
    await registerReviewPublicationRequestV2Routes(app, routes.publication);

    const response = await app.inject({
      method: "POST",
      url: "/api/action/v2/review-publication/request",
      payload: await publicationRequest(publicationPermit),
    });
    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({
      error: {
        errorCode: ReviewActionV2ProtocolErrorCode.CapacityLimited,
        retryClass: "same_request",
        details: { issues: ["publication_facts_unavailable"] },
      },
    });
    await expect(
      publicationRepository.findByPermitIdentity(artifact.publicationPermit),
    ).resolves.toBeNull();
    await app.close();
  });

  it("keeps a proven missing lifecycle non-retryable", async () => {
    const routes = createRoutes(
      new InMemoryReviewPublicationRepository(),
      { assertCurrentPolicy: vi.fn() },
      artifact,
      {
        lifecycle: {
          async resolve() {
            return {
              status: CurrentPublicationLifecycleStatus.Missing,
              lifecycleStateHash: null,
              commandLedgerWatermark: null,
            } as const;
          },
        },
      },
    );
    const publicationPermit = await capabilityAdapter().issuePublicationPermit(
      artifact.publicationPermit,
      now,
    );
    const app = Fastify({ logger: false });
    await registerReviewPublicationRequestV2Routes(app, routes.publication);

    const response = await app.inject({
      method: "POST",
      url: "/api/action/v2/review-publication/request",
      payload: await publicationRequest(publicationPermit),
    });

    expect(response.statusCode).toBe(412);
    expect(response.json()).toMatchObject({
      error: {
        errorCode: ReviewActionV2ProtocolErrorCode.StalePrecondition,
        retryClass: "never",
        details: { issues: ["lifecycle_status_not_current"] },
      },
    });
    await app.close();
  });
});

function createRoutes(
  publicationRepository = new InMemoryReviewPublicationRepository(),
  contextPolicy = { assertCurrentPolicy: vi.fn() },
  finalizedArtifact: FinalizedReviewProjectionArtifact = artifact,
  decisionOverrides: Partial<ReviewPublicationDecisionPorts> = {},
) {
  const publicationApplication = createReviewPublicationV2Application({
    clock: { now: () => now },
    decisions: allowingReviewPublicationDecisionPorts(
      finalizedArtifact.publicationPermit,
      decisionOverrides,
    ),
    attempts: publicationRepository,
    idempotency: publicationRepository,
    adjudicationEvidence: {
      async resolve() {
        return {
          status: ReviewPublicationAdjudicationEvidenceStatus.Unavailable,
          reason: "not_required_for_request",
        };
      },
    },
    commands: {
      requests: publicationRepository,
      claims: publicationRepository,
      claimRenewals: publicationRepository,
      operationBegins: publicationRepository,
      effects: publicationRepository,
      completions: publicationRepository,
      terminalizations: publicationRepository,
      adjudications: publicationRepository,
    },
    enabledCapabilities: new Set([ReviewPublicationCapability.Request]),
  });
  return createReviewActionV2SnapshotPublicationRoutes({
    runtime: {
      readServerTime: async () => now,
      createRequestId: () => "request-generated",
    },
    authorizations: {
      async resolveReviewRunAuthorizationToken() {
        return {
          status: ReviewRunAuthorizationTokenResolutionStatus.Valid,
          authorization,
        };
      },
    },
    executions: {
      async findExecution() {
        return {
          artifact: finalizedArtifact,
        } as unknown as ReviewExecutionSnapshot;
      },
    },
    releases: {
      async findProducerReleaseById() {
        return producerRelease;
      },
      async findProtocolLimitsProfileById() {
        return protocolLimits;
      },
    },
    snapshots: {
      async findCurrent() {
        return snapshot;
      },
    },
    publications: publicationRepository,
    requestPublication: publicationApplication.request,
    capabilities: capabilityAdapter(),
    digest,
    contextPolicy,
    now: () => now,
  });
}

class LostPublicationResponseRepository extends InMemoryReviewPublicationRepository {
  requestCalls = 0;

  override async request(command: RequestReviewPublicationCommand) {
    this.requestCalls += 1;
    if (this.requestCalls === 1) {
      const applied = await super.request(command);
      if (applied.status !== RequestReviewPublicationStatus.Applied) {
        throw new Error("test_publication_not_applied");
      }
      throw new Error("test_publication_response_lost");
    }
    return super.request(command);
  }
}

async function publicationRequest(
  publicationPermit: string,
  operationsCanonicalJson = canonicalJson(publishing),
  projectionHash = artifact.projectionHash,
): Promise<ReviewPublicationRequest> {
  const request: ReviewPublicationRequest = {
    ...envelope("publication-1"),
    authorizationToken: "authorization-token",
    idempotencyKey: "publication-idempotency-1",
    requestBodyHash: hash("0"),
    publicationPermit,
    projectionHash,
    operationsCanonicalJson,
  };
  return {
    ...request,
    requestBodyHash: await digest.digestUtf8(
      canonicalizeReviewActionV2Request(
        ReviewActionV2OperationId.ReviewPublicationRequest,
        request,
      ),
    ),
  };
}

function capabilityAdapter() {
  const keyRing = new ConfiguredCapabilityKeyRing({
    activeKeyId: "test-key",
    keys: [
      {
        keyId: "test-key",
        secret: new TextEncoder().encode("0123456789abcdef0123456789abcdef"),
        verifyUntil: null,
      },
    ],
  });
  return new ReviewActionV2ExecutionEvidenceCapabilityAdapter(
    new JoseRotatingCapabilityCodec(keyRing, 0),
    keyRing,
    "reviewrouter-execution-evidence",
    () => "publication-capability-1",
  );
}

function envelope(requestId: string) {
  return {
    protocolVersion: reviewActionV2PublishedProtocolVersion,
    schemaDigest: reviewActionV2PublishedSchemaDigest,
    requestId,
  };
}

const authorization = {
  authorizationId: "authorization-1",
  workspaceId: "workspace-1",
  repositoryConnectionId: "repository-1",
  scmRepositoryIdentityId: "identity-1",
  pullRequestNumber: 42,
  sourceRunId: "run-1",
  sourceRunAttempt: "1",
  producerReleaseId: "release-1",
  selectedProtocolVersion: ReviewProtocolVersion.V2,
  protocolLimitsProfileId: "limits-1",
  operationalSloProfileId: "slo-1",
  mutationEpoch: 3n,
  providerVoteLanes: [],
  trustDomain: ReviewTrustDomain.TrustedManaged,
  state: ReviewRunAuthorizationState.Active,
  baseSha: "b".repeat(40),
  mergeBaseSha: "c".repeat(40),
  headSha: "a".repeat(40),
  reviewRevisionHash: hash("2"),
  expiresAt: new Date("2026-07-23T12:30:00.000Z"),
} as unknown as ReviewRunAuthorization;

const publishing = {
  check: {
    conclusion: "success",
    marker: "<!-- check-marker -->",
    name: "ReviewRouter",
    summary: "All checks passed",
    title: "Review complete",
  },
  inlineReviewChunks: [],
  lifecycle: [],
  summary: {
    allClear: true,
    body: "No findings",
    marker: "<!-- summary-marker -->",
    occurrenceCounts: {
      new: 0,
      reconfirmed: 0,
      changed: 0,
      carried_unverified: 0,
      resolved: 0,
      uncertain: 0,
      suppressed_by_human: 0,
    },
  },
};

const projectionEnvelopeJson = canonicalJson({
  commandLedgerWatermark: "2",
  coverage: { state: "complete" },
  envelopeVersion: "review_projection.v1",
  lifecycleStateHash: hash("4"),
  occurrences: [],
  publishing,
  snapshot: { lineageHints: [] },
});

const artifact: FinalizedReviewProjectionArtifact = {
  artifactId: "artifact-1",
  executionId: "execution-1",
  generation: 1n,
  reviewedHeadSha: authorization.headSha,
  reviewRevisionHash: authorization.reviewRevisionHash,
  coverageState: ReviewCoverageState.Completed,
  projectionEnvelopeVersion: 1,
  projectionEnvelopeJson,
  projectionHash: hash("3"),
  byteCount: Buffer.byteLength(projectionEnvelopeJson, "utf8"),
  findingCount: 0,
  lifecycleStateHash: hash("4"),
  commandLedgerWatermark: 2n,
  projectionPolicyVersion: "review-projection-policy.v3-t0",
  publicationPermit: {
    workspaceId: authorization.workspaceId,
    repositoryConnectionId: authorization.repositoryConnectionId,
    scmRepositoryIdentityId: authorization.scmRepositoryIdentityId,
    pullRequestNumber: authorization.pullRequestNumber,
    executionId: "execution-1",
    generation: 1n,
    authorizationId: authorization.authorizationId,
    producerReleaseId: authorization.producerReleaseId,
    reviewedHeadSha: authorization.headSha,
    reviewRevisionHash: authorization.reviewRevisionHash,
    projectionHash: hash("3"),
    lifecycleStateHash: hash("4"),
    commandLedgerWatermark: 2n,
    permitEpoch: authorization.mutationEpoch,
    publicationSafetyDecisionHash: hash("5"),
    publicationNotAfter: new Date("2026-07-23T12:10:00.000Z"),
  },
  createdAt: now,
  retainUntil: new Date("2026-08-23T12:00:00.000Z"),
};

function finalizedArtifactWithPublishing(
  source: unknown,
  projectionHash: string,
): FinalizedReviewProjectionArtifact {
  const envelopeJson = canonicalJson({
    ...JSON.parse(projectionEnvelopeJson),
    publishing: source,
  });
  return {
    ...artifact,
    projectionEnvelopeJson: envelopeJson,
    projectionHash,
    byteCount: Buffer.byteLength(envelopeJson, "utf8"),
    publicationPermit: {
      ...artifact.publicationPermit,
      projectionHash,
    },
  };
}

function finalizedArtifactWithProjectionEnvelope(
  projectionEnvelope: Readonly<Record<string, unknown>>,
  projectionHash: string,
): FinalizedReviewProjectionArtifact {
  const envelopeJson = canonicalJson(projectionEnvelope);
  return {
    ...artifact,
    projectionEnvelopeJson: envelopeJson,
    projectionHash,
    byteCount: Buffer.byteLength(envelopeJson, "utf8"),
    publicationPermit: {
      ...artifact.publicationPermit,
      projectionHash,
    },
  };
}

async function readPairedActionLifecycleFixture(actionRepo: string) {
  const fixturePath = resolve(
    actionRepo,
    "src/review-projection/fixtures/review-lifecycle-thread-state.v1.golden.json",
  );
  const fixture = requiredRecordForTest(
    JSON.parse(await readFile(fixturePath, "utf8")),
    "paired_action_fixture_invalid",
  );
  if (fixture.schemaVersion !== "review_lifecycle_thread_state.v1") {
    throw new Error("paired_action_fixture_version_invalid");
  }
  const projectionTarget = requiredRecordForTest(
    fixture.expectedProjectionTarget,
    "paired_action_projection_target_invalid",
  );
  return {
    expectedThreadStateHash: requiredStringForTest(
      fixture.expectedThreadStateHash,
      "paired_action_thread_hash_invalid",
    ),
    projectionTarget: {
      targetId: requiredStringForTest(
        projectionTarget.targetId,
        "paired_action_projection_target_id_invalid",
      ),
      threadId: requiredStringForTest(
        projectionTarget.threadId,
        "paired_action_projection_thread_id_invalid",
      ),
      markerFingerprint: requiredStringForTest(
        projectionTarget.markerFingerprint,
        "paired_action_projection_marker_invalid",
      ),
      threadStateHash: requiredStringForTest(
        projectionTarget.threadStateHash,
        "paired_action_projection_thread_hash_invalid",
      ),
    },
    thread: {
      threadId: requiredStringForTest(
        fixture.threadId,
        "paired_action_thread_id_invalid",
      ),
      comments: requiredArrayForTest(
        fixture.comments,
        "paired_action_comments_invalid",
      ).map((candidate) => {
        const comment = requiredRecordForTest(
          candidate,
          "paired_action_comment_invalid",
        );
        return {
          id: requiredStringForTest(
            comment.id,
            "paired_action_comment_id_invalid",
          ),
          authorLogin:
            comment.authorLogin === null
              ? null
              : requiredStringForTest(
                  comment.authorLogin,
                  "paired_action_comment_author_invalid",
                ),
          body: requiredStringForTest(
            comment.body,
            "paired_action_comment_body_invalid",
          ),
          createdAt: requiredStringForTest(
            comment.createdAt,
            "paired_action_comment_created_at_invalid",
          ),
          updatedAt: requiredStringForTest(
            comment.updatedAt,
            "paired_action_comment_updated_at_invalid",
          ),
        };
      }),
    },
  };
}

function requiredRecordForTest(
  value: unknown,
  error: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(error);
  }
  return value as Record<string, unknown>;
}

function requiredArrayForTest(value: unknown, error: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(error);
  return value;
}

function requiredStringForTest(value: unknown, error: string): string {
  if (typeof value !== "string") throw new Error(error);
  return value;
}

const protocolLimits: ReviewProtocolLimitsV2 = {
  protocolLimitsProfileId: authorization.protocolLimitsProfileId,
  limitsDigest: hash("6"),
  maxWorkSlots: 100,
  maxAttemptsPerSlot: 4,
  maxObservationBytes: 1_000_000,
  maxObservationFindings: 1_000,
  maxProjectionBytes: 2_000_000,
  maxProjectionFindings: 2_000,
  maxPublicationOperations: 100,
  maxPublicationChunks: 100,
  maxPublicationBodyBytes: 2_000_000,
  maxRequestBatchSize: 100,
  maxLeaseDurationMs: 600_000,
  maxResultReportDurationMs: 1_200_000,
  maxReconciliationDurationMs: 3_600_000,
  registeredAt: now,
};

const producerRelease = {
  producerReleaseId: authorization.producerReleaseId,
  distributionKind: ProducerDistributionKind.PublicReusable,
  actionCommitSha: "d".repeat(40),
  runtimeCommitSha: "e".repeat(40),
  wrapperEntrypointDigest: null,
  runtimeEntrypointDigest: hash("7"),
  contextGatewayPolicyVersion: null,
  contextGatewayEntrypointDigest: null,
  reviewInvestigationProfile: null,
  schemaDigest: reviewActionV2PublishedSchemaDigest,
  capabilityProfile: ReviewCapabilityProfile.ExactRevisionV2,
  protocolLimitsProfileId: authorization.protocolLimitsProfileId,
  operationalSloProfileId: authorization.operationalSloProfileId,
  state: ProducerReleaseState.Registered,
  registeredAt: now,
  revokedAt: null,
};

const snapshot = {
  workspaceId: authorization.workspaceId,
  repositoryConnectionId: authorization.repositoryConnectionId,
  scmRepositoryIdentityId: authorization.scmRepositoryIdentityId,
  pullRequestNumber: authorization.pullRequestNumber,
  version: 3,
  schemaVersion: 2 as const,
  sourceExecutionId: "execution-previous",
  sourceExecutionGeneration: 2,
  sourceArtifactHash: hash("8"),
  sourceReviewRevisionHash: authorization.reviewRevisionHash,
  sourceBaseSha: authorization.baseSha,
  sourceReviewedHeadSha: authorization.headSha,
  sourceCompatibilityKey: hash("9"),
  sourceRunId: "previous-run",
  sourceRunAttempt: "1",
  payload: {
    projectionEnvelopeVersion: 1,
    projectionEnvelope: { findings: [] },
    projectionHash: hash("a"),
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
  },
  createdAt: new Date("2026-07-23T11:00:00.000Z"),
  expiresAt: new Date("2026-07-30T12:00:00.000Z"),
};
