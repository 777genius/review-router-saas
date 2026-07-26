import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
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
  ReviewPublicationTerminalOutcome,
} from "@reviewrouter/features-review-publishing/v2";
import { createReviewPublicationV2Application } from "@reviewrouter/features-review-publishing/v2/composition";
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

  it("rejects stale context policy before publication is enqueued", async () => {
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
    ).rejects.toThrow("context_policy_stale");
    expect(contextPolicy.assertCurrentPolicy).toHaveBeenCalledTimes(1);
    await expect(
      publicationRepository.findByPermitIdentity(artifact.publicationPermit),
    ).resolves.toBeNull();
  });
});

function createRoutes(
  publicationRepository = new InMemoryReviewPublicationRepository(),
  contextPolicy = { assertCurrentPolicy: vi.fn() },
  finalizedArtifact: FinalizedReviewProjectionArtifact = artifact,
) {
  const publicationApplication = createReviewPublicationV2Application({
    clock: { now: () => now },
    decisions: allowingReviewPublicationDecisionPorts(
      finalizedArtifact.publicationPermit,
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
