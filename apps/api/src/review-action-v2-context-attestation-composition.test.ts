import { Buffer } from "node:buffer";
import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ContextDependencyKind,
  ContextFileKind,
  InMemoryContextAttestationStore,
  canonicalContextDependencyManifest,
  canonicalContextDependencyOperation,
  canonicalContextDependencyResult,
  contextDependencyManifestVersion,
  createContextDependencyManifest,
} from "@reviewrouter/features-review-context-attestation";
import { AesGcmContextReplayMaterialCipher } from "@reviewrouter/features-review-context-attestation/composition";
import {
  ActualModelCompatibilityMode,
  ProviderExecutionProfile,
  ReviewObservationStatus,
  ReviewProviderKind,
  ReviewReuseEffectMode,
  ReviewTaskKind as EvidenceTaskKind,
  ReviewTrustDomain as EvidenceTrustDomain,
  buildProviderInvocationIdentity,
  createReviewObservation,
  prepareReviewObservationPayload,
  serializeProviderInvocationManifestCanonicalWireJson,
  stableJson,
  type ProviderInvocationManifest,
  type ReviewObservation,
} from "@reviewrouter/features-review-evidence";
import {
  ReviewExecutionProviderKind,
  ReviewInvocationLeasePurpose,
  ReviewInvocationLeaseState,
  ReviewTaskKind,
  ReviewWorkSlotState,
  type ReviewExecutionQueryPort,
  type ReviewExecutionSnapshot,
  type ReviewInvocationLease,
} from "@reviewrouter/features-review-executions";
import {
  ReviewProtocolVersion,
  ReviewRunAuthorizationState,
  ReviewRunAuthorizationTokenResolutionStatus,
  ReviewTrustDomain,
  canonicalJson,
  type ReviewRunAuthorization,
} from "@reviewrouter/features-review-run-control";
import {
  ConfiguredCapabilityKeyRing,
  JoseRotatingCapabilityCodec,
} from "@reviewrouter/platform-signed-capabilities";
import {
  ReviewActionV2OperationId,
  ReviewContextGatewayOpenResultStatus,
  ReviewContextGatewaySealResultStatus,
  ReviewContextReplayCommitResultStatus,
  canonicalizeReviewContextConfinementEvidence,
  canonicalizeReviewContextGatewayEvent,
  canonicalizeReviewContextReplayChainSeed,
  canonicalizeReviewContextReplayEvent,
  canonicalizeReviewActionV2Request,
  reviewActionV2PublishedProtocolVersion,
  reviewActionV2PublishedSchemaDigest,
  type ReviewActionV2RequestMap,
  type ReviewContextGatewayOpenRequest,
  type ReviewContextGatewaySealRequest,
  type ReviewContextReplayCommitRequest,
} from "@reviewrouter/protocol-review-action-v2";
import { ReviewActionV2ExecutionEvidenceCapabilityAdapter } from "./review-action-v2-execution-evidence-capabilities.js";
import {
  composeReviewActionV2ContextAttestationRoutes,
  createReviewActionV2ContextReplayCoordinator,
  type ReviewActionV2ContextAttestationHandlerDependencies,
} from "./review-action-v2-context-attestation-composition.js";

const now = new Date("2026-07-24T12:00:00.000Z");
const sourceTree = gitOid("a");
const targetTree = gitOid("b");
const gatewayPolicyVersion = "context-gateway-v1";
const gatewayBinaryHash = sha("gateway-binary");
const capabilityProfile = "context-gateway-v1";
const requestedModel = "gpt-5.6-codex";
const providerVoteIdentityHash = sha("provider-vote");
const sourceRevision = revision("a", "b", "c", "source-revision");
const targetRevision = revision("a", "b", "d", "target-revision");

describe("Review Action v2 context attestation composition", () => {
  it("seals authenticated context, rejects tampering, and replays it for a target revision", async () => {
    const fixture = await createFixture();
    const opened = await fixture.routes.openGateway!.execute(
      fixture.openRequest,
    );
    expect(opened.result.status).toBe(
      ReviewContextGatewayOpenResultStatus.Opened,
    );
    const sessionId = required(opened.result.sessionId);
    const sessionSecret = Buffer.from(
      required(opened.result.gatewaySessionSecret),
      "base64url",
    );
    const sealCapability = required(opened.result.sealCapability);
    const transcript = sourceTranscript({
      sessionId,
      sessionSecret,
      eventChainSeedHash: required(opened.result.eventChainSeedHash),
    });
    const replayMaterialCanonicalJson = stableJson({
      materialVersion: 1,
      sourceDependencies: [
        {
          operationKey: transcript.dependencies[0]!.operationKey,
          replayQuery: null,
          sequence: 1,
        },
      ],
    });
    const validSeal = await sealRequest({
      fixture,
      sessionId,
      sealCapability,
      transcriptCanonicalJson: canonicalContextDependencyManifest(transcript),
      replayMaterialCanonicalJson,
    });
    const tampered = createContextDependencyManifest({
      ...transcript,
      dependencies: transcript.dependencies.map((entry) => ({
        ...entry,
        result: {
          ...entry.result,
          contentHash: sha("tampered-content"),
        },
      })),
    });
    await expect(
      fixture.routes.sealGateway!.execute(
        await sealRequest({
          fixture,
          sessionId,
          sealCapability,
          transcriptCanonicalJson: canonicalContextDependencyManifest(tampered),
          replayMaterialCanonicalJson,
        }),
      ),
    ).rejects.toMatchObject({
      statusCode: 422,
      issues: ["context_transcript_hmac_chain_invalid"],
    });

    const sealed = await fixture.routes.sealGateway!.execute(validSeal);
    expect(sealed.result.status).toBe(
      ReviewContextGatewaySealResultStatus.Accepted,
    );
    const attestationId = required(sealed.result.attestationId);
    const attestationHash = required(sealed.result.attestationHash);
    fixture.moveToTarget(
      sourceObservation({
        fixture,
        attestationId,
        attestationHash,
      }),
    );
    const replay = await fixture.coordinator.prepareReplay({
      authorization: fixture.authorization(),
      snapshot: fixture.snapshot(),
      workSlotId: "slot-1",
      manifest: fixture.manifest,
      manifestKey: fixture.manifestKey,
      providerInvocationKey: fixture.providerInvocationKey,
      providerVoteIdentityHash,
      trustDomain: EvidenceTrustDomain.TrustedManaged,
      observation: fixture.observation(),
    });
    expect(replay).not.toBeNull();
    const replayPlan = JSON.parse(
      required(replay?.contextReplayPlanCanonicalJson),
    ) as {
      sourceDependencies: Array<{
        sequence: number;
        operationKey: string;
        operation: (typeof transcript.dependencies)[number]["operation"];
      }>;
    };
    const replayedManifest = targetReplayManifest({
      attestationId,
      planHash: required(replay?.contextReplayPlanHash),
      sourceDependency: replayPlan.sourceDependencies[0]!,
      sourceResult: transcript.dependencies[0]!.result,
    });
    const committed = await fixture.routes.commitReplay!.execute(
      await withBodyHash(ReviewActionV2OperationId.ReviewContextReplayCommit, {
        ...envelope("replay-commit"),
        authorizationToken: "authorization-token",
        idempotencyKey: "replay-commit",
        requestBodyHash: sha("placeholder"),
        executionId: "execution-target",
        workSlotId: "slot-1",
        attestationId,
        attestationHash,
        targetReviewRevisionHash: targetRevision.reviewRevisionHash,
        targetCheckoutTreeOid: targetTree,
        replayCapability: required(replay?.contextReplayCapability),
        replayResultCanonicalJson:
          canonicalContextDependencyManifest(replayedManifest),
        replayResultHash: sha(
          canonicalContextDependencyManifest(replayedManifest),
        ),
      } satisfies ReviewContextReplayCommitRequest),
    );
    expect(committed.result.status).toBe(
      ReviewContextReplayCommitResultStatus.Accepted,
    );
    const attachmentAuthority =
      await fixture.capabilities.verifyReusableAttachment(
        required(committed.result.attachmentCapability),
        now,
      );
    await expect(
      fixture.coordinator.verifyAttachment({
        authorization: fixture.authorization(),
        snapshot: fixture.snapshot(),
        authority: attachmentAuthority,
      }),
    ).resolves.toBe(true);

    fixture.disableContextReuse();
    await expect(
      fixture.coordinator.verifyAttachment({
        authorization: fixture.authorization(),
        snapshot: fixture.snapshot(),
        authority: attachmentAuthority,
      }),
    ).resolves.toBe(false);
    await expect(
      fixture.coordinator.assertCurrentPolicy({
        authorization: fixture.authorization(),
        snapshot: {
          ...fixture.snapshot(),
          observationRefs: [
            {
              observationId: fixture.observation().observationId,
              workSlotId: "slot-1",
              attachmentKind: attachmentAuthority.attachmentKind,
              reuseSafetyDecisionHash:
                attachmentAuthority.reuseSafetyDecisionHash,
            },
          ],
        } as unknown as ReviewExecutionSnapshot,
      }),
    ).rejects.toMatchObject({
      statusCode: 412,
      issues: ["context_reuse_policy_vector_stale"],
    });
  });

  it("uses one operation timestamp while sealing with an advancing clock", async () => {
    let clockMs = now.getTime();
    const fixture = await createFixture({
      now: () => new Date(clockMs++),
    });
    const opened = await fixture.routes.openGateway!.execute(
      fixture.openRequest,
    );
    const sessionId = required(opened.result.sessionId);
    const transcript = sourceTranscript({
      sessionId,
      sessionSecret: Buffer.from(
        required(opened.result.gatewaySessionSecret),
        "base64url",
      ),
      eventChainSeedHash: required(opened.result.eventChainSeedHash),
    });
    const replayMaterialCanonicalJson = stableJson({
      materialVersion: 1,
      sourceDependencies: [
        {
          operationKey: transcript.dependencies[0]!.operationKey,
          replayQuery: null,
          sequence: 1,
        },
      ],
    });

    const sealed = await fixture.routes.sealGateway!.execute(
      await sealRequest({
        fixture,
        sessionId,
        sealCapability: required(opened.result.sealCapability),
        transcriptCanonicalJson: canonicalContextDependencyManifest(transcript),
        replayMaterialCanonicalJson,
      }),
    );

    expect(sealed.result.status).toBe(
      ReviewContextGatewaySealResultStatus.Accepted,
    );
  });

  it("reports safe transcript manifest validation issues", async () => {
    const fixture = await createFixture();
    const opened = await fixture.routes.openGateway!.execute(
      fixture.openRequest,
    );
    const sessionId = required(opened.result.sessionId);
    const transcriptCanonicalJson = stableJson({
      authenticatedChainHash: sha("empty-chain"),
      checkoutTreeOid: sourceTree,
      complete: true,
      dependencies: [],
      gatewayBinaryHash,
      gatewayPolicyVersion,
      manifestVersion: contextDependencyManifestVersion,
    });
    const replayMaterialCanonicalJson = stableJson({
      materialVersion: 1,
      sourceDependencies: [],
    });

    await expect(
      fixture.routes.sealGateway!.execute(
        await sealRequest({
          fixture,
          sessionId,
          sealCapability: required(opened.result.sealCapability),
          transcriptCanonicalJson,
          replayMaterialCanonicalJson,
        }),
      ),
    ).rejects.toMatchObject({
      statusCode: 422,
      issues: [
        "context_transcript_invalid",
        "context_dependency_manifest_entry_count_invalid",
      ],
    });
  });

  it("seals context when Codex reports a resolved actual model alias", async () => {
    const fixture = await createFixture();
    const opened = await fixture.routes.openGateway!.execute(
      fixture.openRequest,
    );
    const sessionId = required(opened.result.sessionId);
    const transcript = sourceTranscript({
      sessionId,
      sessionSecret: Buffer.from(
        required(opened.result.gatewaySessionSecret),
        "base64url",
      ),
      eventChainSeedHash: required(opened.result.eventChainSeedHash),
    });
    const replayMaterialCanonicalJson = stableJson({
      materialVersion: 1,
      sourceDependencies: [
        {
          operationKey: transcript.dependencies[0]!.operationKey,
          replayQuery: null,
          sequence: 1,
        },
      ],
    });

    const sealed = await fixture.routes.sealGateway!.execute(
      await sealRequest({
        fixture,
        sessionId,
        sealCapability: required(opened.result.sealCapability),
        transcriptCanonicalJson: canonicalContextDependencyManifest(transcript),
        replayMaterialCanonicalJson,
        actualModel: `${requestedModel}:resolved`,
      }),
    );

    expect(sealed.result.status).toBe(
      ReviewContextGatewaySealResultStatus.Accepted,
    );
  });

  it.each([
    {
      name: "legacy release without gateway evidence",
      release: {
        contextGatewayPolicyVersion: null,
        contextGatewayEntrypointDigest: null,
      },
      issue: "context_release_authority_mismatch",
    },
    {
      name: "release bound to another gateway bundle",
      release: {
        contextGatewayEntrypointDigest: sha("other-gateway-binary"),
      },
      issue: "context_gateway_binary_mismatch",
    },
  ])("fails closed for $name", async ({ release, issue }) => {
    const fixture = await createFixture({ release });

    await expect(
      fixture.routes.openGateway!.execute(fixture.openRequest),
    ).rejects.toMatchObject({
      statusCode: expect.any(Number),
      issues: [issue],
    });
  });
});

async function createFixture(
  options: {
    now?: () => Date;
    release?: {
      readonly contextGatewayPolicyVersion?: string | null;
      readonly contextGatewayEntrypointDigest?: string | null;
    };
  } = {},
) {
  const scopeHash = sha(
    canonicalJson({
      workspaceId: "workspace-1",
      repositoryConnectionId: "connection-1",
      scmRepositoryIdentityId: "repository-1",
      pullRequestNumber: 42,
    }),
  );
  const manifest = invocationManifest(scopeHash);
  const identity = await buildProviderInvocationIdentity(digest, {
    manifest,
    providerVoteIdentityHash,
  });
  let currentAuthorization = authorization(sourceRevision, "authorization-1");
  let currentSnapshot = snapshot(
    currentAuthorization,
    "execution-source",
    sourceRevision,
  );
  let currentTree = sourceTree;
  let currentObservation: ReviewObservation | null = null;
  let contextReuseMode = ReviewReuseEffectMode.Enabled;
  const store = new InMemoryContextAttestationStore();
  const capabilities = capabilityAdapter();
  const lease = sourceLease({
    authorization: currentAuthorization,
    manifest,
    manifestKey: identity.manifestKey,
    providerInvocationKey: identity.providerInvocationKey,
  });
  const leaseCapability = await capabilities.issueLease(lease, scopeHash);
  const dependencies: ReviewActionV2ContextAttestationHandlerDependencies = {
    authorizations: {
      async resolveReviewRunAuthorizationToken() {
        return {
          status: ReviewRunAuthorizationTokenResolutionStatus.Valid,
          authorization: currentAuthorization,
        };
      },
    },
    executionQueries: {
      async findExecution() {
        return currentSnapshot;
      },
      async findLease(leaseId: string) {
        return leaseId === lease.leaseId ? lease : null;
      },
    } as unknown as ReviewExecutionQueryPort,
    observations: {
      async findById(observationId) {
        return currentObservation?.observationId === observationId
          ? currentObservation
          : null;
      },
      async findCandidates() {
        return currentObservation ? [currentObservation] : [];
      },
    },
    reusePolicy: {
      async resolveReviewReusePolicy() {
        return {
          safetyDecision: {
            evidenceReuseMode: ReviewReuseEffectMode.Enabled,
            promptOnlyReuseMode: ReviewReuseEffectMode.Disabled,
            contextGatewayReuseMode: contextReuseMode,
            safetyDecisionHash: sha(`safety-${contextReuseMode}`),
          },
          compatibility: {
            registeredProducerReleaseIds: ["release-1"],
            trustedCapabilityProfiles: [capabilityProfile],
            compatibleProviderRuntimeVersions: [
              manifest.runtimeCompatibilityKey,
            ],
            actualModelMode: ActualModelCompatibilityMode.Exact,
            compatibleActualModels: [],
          },
        };
      },
    },
    store,
    cipher: new AesGcmContextReplayMaterialCipher(
      "replay-key-1",
      new Map([
        ["replay-key-1", Buffer.from("0123456789abcdef0123456789abcdef")],
      ]),
    ),
    capabilities,
    digest,
    checkoutTrees: {
      async resolveCheckoutTreeOid() {
        return currentTree;
      },
    },
    producerReleases: {
      async resolve() {
        return {
          capabilityProfile,
          runtimeCommitSha: gitOid("f"),
          contextGatewayPolicyVersion:
            options.release?.contextGatewayPolicyVersion === undefined
              ? gatewayPolicyVersion
              : options.release.contextGatewayPolicyVersion,
          contextGatewayEntrypointDigest:
            options.release?.contextGatewayEntrypointDigest === undefined
              ? gatewayBinaryHash
              : options.release.contextGatewayEntrypointDigest,
        };
      },
    },
    now: options.now ?? (() => now),
    nextId: (() => {
      let sequence = 0;
      return (kind) => `${kind}-${++sequence}`;
    })(),
    sessionSecretKey: Buffer.from("abcdef0123456789abcdef0123456789"),
    config: {
      sessionLifetimeMs: 60_000,
      reuseTtlMs: 3_600_000,
      replayProofLifetimeMs: 60_000,
      replayCapabilityLifetimeMs: 60_000,
      attachmentCapabilityLifetimeMs: 60_000,
    },
  };
  const coordinator =
    createReviewActionV2ContextReplayCoordinator(dependencies);
  const routes = composeReviewActionV2ContextAttestationRoutes({
    enabled: true,
    runtime: {
      readServerTime: async () => now,
      createRequestId: () => "request-generated",
    },
    handlers: dependencies,
  });
  const confinementEvidenceHash = sha(
    canonicalizeReviewContextConfinementEvidence({
      attemptId: required(lease.attemptId),
      sourceLeaseId: lease.leaseId,
      sourceFencingToken: lease.fencingToken.toString(10),
      sourceExecutionId: lease.executionId,
      sourceWorkSlotId: lease.workSlotId,
      sourceReviewRevisionHash: sourceRevision.reviewRevisionHash,
      checkoutTreeOid: sourceTree,
      providerKind: manifest.providerKind,
      requestedModel: manifest.requestedModel,
      executionProfile: manifest.executionProfile,
      providerInvocationKey: lease.providerInvocationKey,
      toolPolicyHash: manifest.toolPolicyHash,
      gatewayPolicyVersion,
      gatewayBinaryHash,
    }),
  );
  const openRequest = await withBodyHash(
    ReviewActionV2OperationId.ReviewContextGatewayOpen,
    {
      ...envelope("gateway-open"),
      authorizationToken: "authorization-token",
      leaseCapability,
      idempotencyKey: "gateway-open",
      requestBodyHash: sha("placeholder"),
      attemptId: required(lease.attemptId),
      sourceLeaseId: lease.leaseId,
      fencingToken: lease.fencingToken.toString(10),
      sourceExecutionId: lease.executionId,
      sourceWorkSlotId: lease.workSlotId,
      sourceReviewRevisionHash: sourceRevision.reviewRevisionHash,
      checkoutTreeOid: sourceTree,
      gatewayPolicyVersion,
      gatewayBinaryHash,
      confinementEvidenceHash,
    } satisfies ReviewContextGatewayOpenRequest,
  );
  return {
    capabilities,
    coordinator,
    dependencies,
    lease,
    manifest,
    manifestKey: identity.manifestKey,
    providerInvocationKey: identity.providerInvocationKey,
    openRequest,
    routes,
    authorization: () => currentAuthorization,
    snapshot: () => currentSnapshot,
    observation: () => required(currentObservation),
    moveToTarget(observation: ReviewObservation) {
      currentObservation = observation;
      currentAuthorization = authorization(
        targetRevision,
        "authorization-target",
      );
      currentSnapshot = snapshot(
        currentAuthorization,
        "execution-target",
        targetRevision,
      );
      currentTree = targetTree;
    },
    disableContextReuse() {
      contextReuseMode = ReviewReuseEffectMode.Disabled;
    },
  };
}

function sourceTranscript(input: {
  sessionId: string;
  sessionSecret: Buffer;
  eventChainSeedHash: string;
}) {
  const operation = {
    kind: ContextDependencyKind.FileRead,
    path: "src/review.ts",
    startByte: 0,
    maxBytes: 64_000,
  } as const;
  const result = {
    kind: ContextDependencyKind.FileRead,
    fileKind: ContextFileKind.Regular,
    mode: 0o100644,
    blobOid: gitOid("c"),
    symlinkTargetHash: null,
    contentHash: sha("source-content"),
    byteCount: 128,
    eof: true,
    complete: true,
    truncated: false,
  } as const;
  const operationKey = sha(canonicalContextDependencyOperation(operation));
  const eventHash = createHmac("sha256", input.sessionSecret)
    .update(
      canonicalizeReviewContextGatewayEvent({
        sessionId: input.sessionId,
        sequence: 1,
        previousEventHash: input.eventChainSeedHash,
        operationKey,
        operation: JSON.parse(canonicalContextDependencyOperation(operation)),
        result: JSON.parse(canonicalContextDependencyResult(result)),
      }),
    )
    .digest("hex");
  return createContextDependencyManifest({
    manifestVersion: contextDependencyManifestVersion,
    gatewayPolicyVersion,
    gatewayBinaryHash,
    checkoutTreeOid: sourceTree,
    authenticatedChainHash: eventHash,
    complete: true,
    dependencies: [
      {
        sequence: 1,
        previousEventHash: input.eventChainSeedHash,
        eventHash,
        operationKey,
        operation,
        result,
      },
    ],
  });
}

function targetReplayManifest(input: {
  attestationId: string;
  planHash: string;
  sourceDependency: {
    sequence: number;
    operationKey: string;
    operation: ReturnType<
      typeof sourceTranscript
    >["dependencies"][number]["operation"];
  };
  sourceResult: ReturnType<
    typeof sourceTranscript
  >["dependencies"][number]["result"];
}) {
  const previousEventHash = sha(
    canonicalizeReviewContextReplayChainSeed({
      planHash: input.planHash,
      attestationId: input.attestationId,
      targetReviewRevisionHash: targetRevision.reviewRevisionHash,
      targetCheckoutTreeOid: targetTree,
    }),
  );
  const eventHash = sha(
    canonicalizeReviewContextReplayEvent({
      sequence: input.sourceDependency.sequence,
      previousEventHash,
      operationKey: input.sourceDependency.operationKey,
      operation: JSON.parse(
        canonicalContextDependencyOperation(input.sourceDependency.operation),
      ),
      result: JSON.parse(canonicalContextDependencyResult(input.sourceResult)),
    }),
  );
  return createContextDependencyManifest({
    manifestVersion: contextDependencyManifestVersion,
    gatewayPolicyVersion,
    gatewayBinaryHash,
    checkoutTreeOid: targetTree,
    authenticatedChainHash: eventHash,
    complete: true,
    dependencies: [
      {
        sequence: input.sourceDependency.sequence,
        previousEventHash,
        eventHash,
        operationKey: input.sourceDependency.operationKey,
        operation: input.sourceDependency.operation,
        result: input.sourceResult,
      },
    ],
  });
}

async function sealRequest(input: {
  fixture: Awaited<ReturnType<typeof createFixture>>;
  sessionId: string;
  sealCapability: string;
  transcriptCanonicalJson: string;
  replayMaterialCanonicalJson: string;
  actualModel?: string;
}) {
  return withBodyHash(ReviewActionV2OperationId.ReviewContextGatewaySeal, {
    ...envelope("gateway-seal"),
    authorizationToken: "authorization-token",
    leaseCapability: input.fixture.openRequest.leaseCapability,
    idempotencyKey: "gateway-seal",
    requestBodyHash: sha("placeholder"),
    sessionId: input.sessionId,
    sealCapability: input.sealCapability,
    attemptId: required(input.fixture.lease.attemptId),
    sourceLeaseId: input.fixture.lease.leaseId,
    fencingToken: input.fixture.lease.fencingToken.toString(10),
    providerSucceeded: true,
    schemaValidated: true,
    fullyConsumed: true,
    actualModel: input.actualModel ?? requestedModel,
    terminalOutcomeHash: sha("terminal-outcome"),
    transcriptCanonicalJson: input.transcriptCanonicalJson,
    transcriptHash: sha(input.transcriptCanonicalJson),
    replayMaterialCanonicalJson: input.replayMaterialCanonicalJson,
    replayMaterialHash: sha(input.replayMaterialCanonicalJson),
  } satisfies ReviewContextGatewaySealRequest);
}

function sourceObservation(input: {
  fixture: Awaited<ReturnType<typeof createFixture>>;
  attestationId: string;
  attestationHash: string;
}): ReviewObservation {
  const prepared = prepareReviewObservationPayload({
    payloadVersion: 2,
    normalizedFindings: [],
    normalizedLifecycleRevalidations: [],
    safeUsage: {
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
    },
  });
  return createReviewObservation({
    observationId: "observation-source",
    scope: {
      workspaceId: "workspace-1",
      repositoryConnectionId: "connection-1",
      scmRepositoryIdentityId: "repository-1",
      pullRequestNumber: 42,
      authorizationScopeHash: input.fixture.manifest.scopeHash,
    },
    manifestKey: input.fixture.manifestKey,
    providerInvocationKey: input.fixture.providerInvocationKey,
    providerVoteIdentityHash,
    manifestVersion: 1,
    taskKindSet: [EvidenceTaskKind.FindingDiscovery],
    sourceRevision,
    sourcePlanHash: sha("plan"),
    sourceExecutionId: "execution-source",
    sourceWorkSlotId: "slot-1",
    sourceAuthorizationId: "authorization-1",
    evidenceWriteSafetyDecisionHash: sha("write-safety"),
    sourceRunId: "run-1",
    sourceRunAttempt: "1",
    providerKind: ReviewProviderKind.Codex,
    requestedModel,
    actualModel: requestedModel,
    providerRuntimeVersion: input.fixture.manifest.runtimeCompatibilityKey,
    producerReleaseId: "release-1",
    selectedProtocolVersion: ReviewProtocolVersion.V2,
    trustedCapabilityProfile: capabilityProfile,
    executionProfile: ProviderExecutionProfile.ContextGatewayV1,
    attemptId: required(input.fixture.lease.attemptId),
    sourceLeaseId: input.fixture.lease.leaseId,
    sourceFencingToken: input.fixture.lease.fencingToken.toString(10),
    status: ReviewObservationStatus.Success,
    payload: prepared.payload,
    payloadHash: createHash("sha256")
      .update(prepared.canonicalBytes)
      .digest("hex"),
    byteCount: prepared.byteCount,
    findingCount: prepared.findingCount,
    qualityFlags: [],
    transportAttemptCount: 1,
    contextDependencyAttestationId: input.attestationId,
    contextDependencyAttestationHash: input.attestationHash,
    trustDomain: EvidenceTrustDomain.TrustedManaged,
    createdAtMs: now.getTime(),
    reuseExpiresAtMs: now.getTime() + 3_600_000,
    retainUntilMs: now.getTime() + 7_200_000,
  });
}

function invocationManifest(scopeHash: string): ProviderInvocationManifest {
  return {
    manifestVersion: 1,
    scopeHash,
    taskKindSet: [EvidenceTaskKind.FindingDiscovery],
    providerKind: ReviewProviderKind.Codex,
    providerCapabilityHash: sha("provider-capability"),
    requestedModel,
    providerPolicyVersion: "provider-policy-v1",
    producerReleaseId: "release-1",
    selectedProtocolVersion: ReviewProtocolVersion.V2,
    providerRequestEnvelopeHash: sha("request-envelope"),
    outputSchemaHash: sha("output-schema"),
    reviewConfigHash: sha("review-config"),
    runtimeCompatibilityKey: sha("runtime-v1"),
    filePatchManifestHash: sha("file-patch"),
    contextManifestHash: sha("context-manifest"),
    memoryBundleHash: null,
    codeGraphProjectionHash: null,
    lifecycleTargetSetHash: null,
    liveLifecycleStateHash: null,
    toolPolicyHash: sha("tool-policy"),
    executionProfile: ProviderExecutionProfile.ContextGatewayV1,
    baseTreeHash: null,
    environmentContractHash: sha("environment"),
  };
}

function authorization(
  facts: ReturnType<typeof revision>,
  authorizationId: string,
): ReviewRunAuthorization {
  return {
    authorizationId,
    authorizationTokenHash: sha("authorization-token"),
    state: ReviewRunAuthorizationState.Active,
    workspaceId: "workspace-1",
    repositoryConnectionId: "connection-1",
    scmRepositoryIdentityId: "repository-1",
    pullRequestNumber: 42,
    sourceRunId: "run-1",
    sourceRunAttempt: "1",
    ...facts,
    trustDomain: ReviewTrustDomain.TrustedManaged,
    producerReleaseId: "release-1",
    producerReleaseCommitSha: gitOid("f"),
    producerCapabilityProfile: capabilityProfile,
    selectedProtocolVersion: ReviewProtocolVersion.V2,
    schemaDigest: reviewActionV2PublishedSchemaDigest,
    protocolLimitsProfileId: "limits-v1",
    operationalSloProfileId: "slo-v1",
    providerVoteLanes: [
      {
        providerKind: "codex",
        providerVoteIdentityHash,
      },
    ],
    mutationEpoch: 1n,
    createdAt: new Date(now.getTime() - 60_000),
    expiresAt: new Date(now.getTime() + 3_600_000),
    revokedAt: null,
  } as unknown as ReviewRunAuthorization;
}

function snapshot(
  auth: ReviewRunAuthorization,
  executionId: string,
  facts: ReturnType<typeof revision>,
): ReviewExecutionSnapshot {
  return {
    stream: {
      ...auth,
      version: 1n,
      activeExecutionId: executionId,
      lastAllocatedGeneration: 1n,
      currentRevision: facts,
    },
    execution: {
      ...auth,
      executionId,
      generation: 1n,
      version: 1n,
      authorizationId: auth.authorizationId,
      compatibilityKey: "compatibility-v1",
      planHash: sha("plan"),
      revision: facts,
      workSlots: [
        {
          workSlotId: "slot-1",
          taskKind: ReviewTaskKind.FindingDiscovery,
          providerKind: ReviewExecutionProviderKind.Codex,
          providerVoteIdentityHash,
          shardKey: "shard-1",
          required: true,
          attemptBudget: 2,
          retryPolicyVersion: "retry-v1",
          state: ReviewWorkSlotState.Pending,
          activeLeaseId: executionId === "execution-source" ? "lease-1" : null,
          acceptedObservationRefId: null,
          nextAttemptOrdinal: 1,
        },
      ],
    },
    observationRefs: [],
    activeLeases: [],
    artifact: null,
  } as unknown as ReviewExecutionSnapshot;
}

function sourceLease(input: {
  authorization: ReviewRunAuthorization;
  manifest: ProviderInvocationManifest;
  manifestKey: string;
  providerInvocationKey: string;
}): ReviewInvocationLease {
  return {
    ...input.authorization,
    executionId: "execution-source",
    executionGeneration: 1n,
    workSlotId: "slot-1",
    leaseId: "lease-1",
    purpose: ReviewInvocationLeasePurpose.ProviderExecution,
    reviewRevisionHash: sourceRevision.reviewRevisionHash,
    providerInvocationKey: input.providerInvocationKey,
    preparedManifestCanonicalJson:
      serializeProviderInvocationManifestCanonicalWireJson(input.manifest),
    preparedManifestKey: input.manifestKey,
    providerVoteIdentityHash,
    leaseSafetyDecisionHash: sha("lease-safety"),
    attemptId: "attempt-1",
    sourceObservationId: null,
    attemptOrdinal: 1,
    acquireRequestIdHash: sha("acquire-id"),
    acquireRequestHash: sha("acquire-body"),
    ownerIdHash: sha("owner"),
    leaseCapabilityId: "lease-capability-1",
    capabilitySigningKeyId: "test-key",
    fencingToken: 1n,
    state: ReviewInvocationLeaseState.Active,
    acquiredAt: new Date(now.getTime() - 1_000),
    renewedAt: new Date(now.getTime() - 1_000),
    expiresAt: new Date(now.getTime() + 60_000),
    resultReportUntil: new Date(now.getTime() + 120_000),
    retainUntil: new Date(now.getTime() + 3_600_000),
    lastRenewRequestIdHash: null,
    lastRenewRequestHash: null,
  } as ReviewInvocationLease;
}

function capabilityAdapter() {
  const keyRing = new ConfiguredCapabilityKeyRing({
    activeKeyId: "test-key",
    keys: [
      {
        keyId: "test-key",
        secret: Buffer.from("0123456789abcdef0123456789abcdef"),
        verifyUntil: null,
      },
    ],
  });
  let sequence = 0;
  return new ReviewActionV2ExecutionEvidenceCapabilityAdapter(
    new JoseRotatingCapabilityCodec(keyRing, 0),
    keyRing,
    "reviewrouter-context-test",
    () => `capability-${++sequence}`,
  );
}

async function withBodyHash<O extends ReviewActionV2OperationId>(
  operation: O,
  request: ReviewActionV2RequestMap[O],
): Promise<ReviewActionV2RequestMap[O]> {
  return {
    ...request,
    requestBodyHash: sha(canonicalizeReviewActionV2Request(operation, request)),
  };
}

function envelope(requestId: string) {
  return {
    protocolVersion: reviewActionV2PublishedProtocolVersion,
    schemaDigest: reviewActionV2PublishedSchemaDigest,
    requestId,
  };
}

function revision(
  base: string,
  mergeBase: string,
  head: string,
  review: string,
) {
  return {
    baseSha: gitOid(base),
    mergeBaseSha: gitOid(mergeBase),
    headSha: gitOid(head),
    reviewRevisionHash: sha(review),
  };
}

const digest = {
  digestUtf8: async (value: string) => sha(value),
  digest: async (value: Uint8Array) =>
    createHash("sha256").update(value).digest("hex"),
};

function sha(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function gitOid(character: string): string {
  return character.repeat(40);
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error("fixture_value_missing");
  }
  return value;
}
