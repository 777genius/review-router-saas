import { Buffer } from "node:buffer";
import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ContextDependencyKind,
  ContextFileKind,
  ContextGatewayV4OperationKind,
  ContextGatewayV4OutcomeKind,
  canonicalContextAttestationManifest,
  canonicalContextGatewayV4Manifest,
  canonicalContextDependencyManifest,
  canonicalContextDependencyOperation,
  canonicalContextDependencyResult,
  contextDependencyManifestVersion,
  createContextGatewayV4Manifest,
  createContextDependencyManifest,
} from "@reviewrouter/features-review-context-attestation";
import { AesGcmContextReplayMaterialCipher } from "@reviewrouter/features-review-context-attestation/composition";
import { InMemoryContextAttestationStore } from "@reviewrouter/features-review-context-attestation/testing";
import {
  ReviewInvestigationLeasePurpose,
  ReviewInvestigationLeaseState,
  ReviewInvestigationTurnPurpose,
  type ReviewInvestigationLease,
} from "@reviewrouter/features-review-investigations";
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
  CapabilityAudience,
  CapabilityKind,
  ConfiguredCapabilityKeyRing,
  JoseRotatingCapabilityCodec,
} from "@reviewrouter/platform-signed-capabilities";
import {
  ReviewActionV2OperationId,
  ReviewContextGatewayOpenResultStatus,
  ReviewContextGatewaySealResultStatus,
  ReviewContextReplayCommitResultStatus,
  canonicalizeReviewContextConfinementEvidence,
  canonicalizeReviewInvestigationContextConfinementEvidence,
  canonicalizeReviewContextGatewayEvent,
  canonicalizeReviewContextReplayChainSeed,
  canonicalizeReviewContextReplayEvent,
  canonicalizeReviewActionV2Request,
  reviewActionV2PublishedProtocolVersion,
  reviewActionV2PublishedSchemaDigest,
  reviewInvestigationExtensionV1,
  type ReviewActionV2RequestMap,
  type ReviewContextGatewayOpenRequest,
  type ReviewContextGatewaySealRequest,
  type ReviewInvestigationContextGatewayOpenRequest,
  type ReviewInvestigationContextGatewaySealRequest,
  type ReviewContextReplayCommitRequest,
} from "@reviewrouter/protocol-review-action-v2";
import { ReviewActionV2ExecutionEvidenceCapabilityAdapter } from "./review-action-v2-execution-evidence-capabilities.js";
import { ReviewActionV2InvestigationLeaseCapabilityAdapter } from "./review-action-v2-investigation-lease-capabilities.js";
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
  it("opens a gateway session for the investigation gateway profile", async () => {
    const fixture = await createFixture({
      executionProfile: ProviderExecutionProfile.InvestigationGatewayV1,
    });

    const opened = await fixture.routes.openGateway!.execute(
      fixture.openRequest,
    );

    expect(opened.result.status).toBe(
      ReviewContextGatewayOpenResultStatus.Opened,
    );
    await expect(
      fixture.routes.openInvestigationGateway!.execute(
        await withBodyHash(
          ReviewActionV2OperationId.ReviewInvestigationContextGatewayOpen,
          {
            ...fixture.openRequest,
            requestId: "gateway-open-standard-as-shadow",
            idempotencyKey: "gateway-open-standard-as-shadow",
          } satisfies ReviewInvestigationContextGatewayOpenRequest,
        ),
      ),
    ).rejects.toMatchObject({
      statusCode: 401,
      issues: ["context_investigation_lease_capability_invalid"],
    });
  });

  it("opens and seals only with the explicitly selected shadow authority", async () => {
    const fixture = await createShadowFixture();
    const opened = await fixture.routes.openInvestigationGateway!.execute(
      fixture.openRequest,
    );
    expect(opened.result.status).toBe(
      ReviewContextGatewayOpenResultStatus.Opened,
    );

    await expect(
      fixture.routes.openGateway!.execute(
        await withBodyHash(ReviewActionV2OperationId.ReviewContextGatewayOpen, {
          ...fixture.openRequest,
          requestId: "gateway-open-wrong-authority",
          idempotencyKey: "gateway-open-wrong-authority",
        }),
      ),
    ).rejects.toMatchObject({
      statusCode: 401,
      issues: ["lease_capability_invalid"],
    });

    const sessionId = required(opened.result.sessionId);
    const manifest = sourceV4Manifest({
      sessionId,
      sessionSecret: Buffer.from(
        required(opened.result.gatewaySessionSecret),
        "base64url",
      ),
      eventChainSeedHash: required(opened.result.eventChainSeedHash),
    });
    const replayMaterialCanonicalJson = stableJson({
      materialVersion: 1,
      sourceDependencies: [],
    });
    const shadowSealRequest = await createShadowSealRequest({
      fixture: fixture as never,
      sessionId,
      sealCapability: required(opened.result.sealCapability),
      transcriptCanonicalJson: canonicalContextGatewayV4Manifest(manifest),
      replayMaterialCanonicalJson,
    });
    await expect(
      fixture.routes.sealGateway!.execute(
        await withBodyHash(ReviewActionV2OperationId.ReviewContextGatewaySeal, {
          ...shadowSealRequest,
          requestId: "gateway-seal-wrong-authority",
          idempotencyKey: "gateway-seal-wrong-authority",
        }),
      ),
    ).rejects.toMatchObject({
      statusCode: 401,
      issues: ["lease_capability_invalid"],
    });
    const sealed =
      await fixture.routes.sealInvestigationGateway!.execute(shadowSealRequest);
    expect(sealed.result.status).toBe(
      ReviewContextGatewaySealResultStatus.Accepted,
    );
  });

  it("rejects the shadow gateway without the signed investigation extension", async () => {
    const fixture = await createShadowFixture({
      authorizeInvestigationExtension: false,
    });

    await expect(
      fixture.routes.openInvestigationGateway!.execute(fixture.openRequest),
    ).rejects.toMatchObject({
      statusCode: 403,
      issues: ["review_investigation_extension_not_authorized"],
    });
  });

  it("rejects the shadow gateway after the live rollout is disabled", async () => {
    const fixture = await createShadowFixture({
      investigationRolloutAllowed: false,
    });

    await expect(
      fixture.routes.openInvestigationGateway!.execute(fixture.openRequest),
    ).rejects.toThrow("investigation_rollout_emergency_disabled");
  });

  it.each([
    {
      id: "provider",
      name: "critic provider override",
      providerKind: ReviewProviderKind.ClaudeCode,
      requestedModel,
    },
    {
      id: "model",
      name: "critic model override",
      providerKind: ReviewProviderKind.Codex,
      requestedModel: "gpt-independent-critic",
    },
  ])("rejects a $name outside the prepared manifest", async (override) => {
    const fixture = await createFixture({
      executionProfile: ProviderExecutionProfile.InvestigationGatewayV1,
    });
    const confinementEvidenceHash = sha(
      canonicalizeReviewContextConfinementEvidence({
        attemptId: required(fixture.lease.attemptId),
        sourceLeaseId: fixture.lease.leaseId,
        sourceFencingToken: fixture.lease.fencingToken.toString(10),
        sourceExecutionId: fixture.lease.executionId,
        sourceWorkSlotId: fixture.lease.workSlotId,
        sourceReviewRevisionHash: sourceRevision.reviewRevisionHash,
        checkoutTreeOid: sourceTree,
        providerKind: override.providerKind,
        requestedModel: override.requestedModel,
        executionProfile: fixture.manifest.executionProfile,
        providerInvocationKey: fixture.lease.providerInvocationKey,
        toolPolicyHash: fixture.manifest.toolPolicyHash,
        gatewayPolicyVersion,
        gatewayBinaryHash,
      }),
    );
    const request = await withBodyHash(
      ReviewActionV2OperationId.ReviewContextGatewayOpen,
      {
        ...fixture.openRequest,
        requestId: `request-${override.id}`,
        idempotencyKey: `gateway-open-${override.id}`,
        confinementEvidenceHash,
      },
    );

    await expect(
      fixture.routes.openGateway!.execute(request),
    ).rejects.toMatchObject({
      issues: ["context_confinement_evidence_mismatch"],
    });
  });

  it("accepts an authenticated gateway v4 manifest without enabling replay", async () => {
    const fixture = await createFixture({
      gatewayPolicyVersion: "context-gateway-v4",
      release: { contextGatewayPolicyVersion: "context-gateway-v4" },
    });
    const opened = await fixture.routes.openGateway!.execute(
      fixture.openRequest,
    );
    const sessionId = required(opened.result.sessionId);
    const manifest = sourceV4Manifest({
      sessionId,
      sessionSecret: Buffer.from(
        required(opened.result.gatewaySessionSecret),
        "base64url",
      ),
      eventChainSeedHash: required(opened.result.eventChainSeedHash),
    });
    const replayMaterialCanonicalJson = stableJson({
      materialVersion: 1,
      sourceDependencies: [],
    });

    const sealed = await fixture.routes.sealGateway!.execute(
      await sealRequest({
        fixture,
        sessionId,
        sealCapability: required(opened.result.sealCapability),
        transcriptCanonicalJson: canonicalContextGatewayV4Manifest(manifest),
        replayMaterialCanonicalJson,
      }),
    );

    expect(sealed.result.status).toBe(
      ReviewContextGatewaySealResultStatus.Accepted,
    );
  });

  it("preserves legacy gateway crypto, capability, replay AAD, and attestation preimages", async () => {
    const fixture = await createFixture();
    const opened = await fixture.routes.openGateway!.execute(
      fixture.openRequest,
    );
    const sessionId = required(opened.result.sessionId);
    const session = required(
      await fixture.dependencies.store.findSession(sessionId),
    );
    const expectedSessionSecret = createHmac(
      "sha256",
      Buffer.from("abcdef0123456789abcdef0123456789"),
    )
      .update("rr.context-gateway-session-secret.v1")
      .update("\0")
      .update(
        canonicalJson({
          attemptId: session.attemptId,
          openingIntentHash: session.openingIntentHash,
          sourceLeaseId: session.sourceLeaseId,
          sourceFencingToken: session.sourceFencingToken,
          sourceExecutionId: session.sourceExecutionId,
          sourceWorkSlotId: session.sourceWorkSlotId,
          sourceReviewRevisionHash: session.sourceRevision.reviewRevisionHash,
          checkoutTreeOid: session.sourceRevision.checkoutTreeOid,
          gatewayPolicyVersion: session.gatewayPolicyVersion,
          gatewayBinaryHash: session.gatewayBinaryHash,
          confinementProofHash: session.confinementProofHash,
        }),
      )
      .digest();
    expect(required(opened.result.gatewaySessionSecret)).toBe(
      expectedSessionSecret.toString("base64url"),
    );
    expect(required(opened.result.eventChainSeedHash)).toBe(
      createHmac("sha256", expectedSessionSecret)
        .update(
          canonicalJson({
            domain: "rr.context-gateway-seed.v1",
            attemptId: session.attemptId,
            openingIntentHash: session.openingIntentHash,
            sourceLeaseId: session.sourceLeaseId,
            sourceFencingToken: session.sourceFencingToken,
          }),
        )
        .digest("hex"),
    );

    const keyRing = capabilityKeyRing();
    const sealClaims = await new JoseRotatingCapabilityCodec(keyRing, 0).verify(
      {
        token: required(opened.result.sealCapability),
        expectedIssuer: "reviewrouter-context-test",
        expectedAudience: CapabilityAudience.ReviewInvocationLease,
        expectedKind: CapabilityKind.InvocationLease,
        now,
      },
    );
    expect(sealClaims.payload).not.toHaveProperty(
      "source_lease_authority_kind",
    );

    const transcript = sourceTranscript({
      sessionId,
      sessionSecret: expectedSessionSecret,
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
    const attestationId = required(sealed.result.attestationId);
    const attestation = required(
      await fixture.dependencies.store.findAcceptedAttestation(attestationId),
    );
    const material = required(
      await fixture.dependencies.store.findReplayMaterialByAttestationId(
        attestationId,
      ),
    );
    expect(material.associatedDataHash).toBe(
      sha(
        canonicalJson({
          associatedDataVersion: 1,
          sessionId: session.sessionId,
          sourceExecutionId: session.sourceExecutionId,
          sourceWorkSlotId: session.sourceWorkSlotId,
          sourceReviewRevisionHash: session.sourceRevision.reviewRevisionHash,
          checkoutTreeOid: session.sourceRevision.checkoutTreeOid,
          gatewayPolicyVersion: session.gatewayPolicyVersion,
          gatewayBinaryHash: session.gatewayBinaryHash,
          confinementProofHash: session.confinementProofHash,
        }),
      ),
    );
    expect(attestation.attestationHash).toBe(
      sha(
        JSON.stringify({
          acceptedAtMs: attestation.acceptedAtMs,
          actualModel: attestation.actualModel,
          attestationId: attestation.attestationId,
          manifest: canonicalContextAttestationManifest(attestation.manifest),
          reuseExpiresAtMs: attestation.reuseExpiresAtMs,
          replayMaterialHash: attestation.replayMaterialHash,
          sessionId: attestation.sessionId,
          sourceExecutionId: attestation.sourceExecutionId,
          sourceFencingToken: attestation.sourceFencingToken,
          sourceLeaseId: attestation.sourceLeaseId,
          sourceReviewRevisionHash: attestation.sourceReviewRevisionHash,
          sourceWorkSlotId: attestation.sourceWorkSlotId,
          terminalOutcomeHash: attestation.terminalOutcomeHash,
          trustedCapabilityProfile: attestation.trustedCapabilityProfile,
        }),
      ),
    );
  });

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
    gatewayPolicyVersion?: string;
    executionProfile?: ProviderExecutionProfile;
    release?: {
      readonly contextGatewayPolicyVersion?: string | null;
      readonly contextGatewayEntrypointDigest?: string | null;
    };
    authorizeInvestigationExtension?: boolean;
    investigationRolloutAllowed?: boolean;
  } = {},
) {
  const activeGatewayPolicyVersion =
    options.gatewayPolicyVersion ?? gatewayPolicyVersion;
  const scopeHash = sha(
    canonicalJson({
      workspaceId: "workspace-1",
      repositoryConnectionId: "connection-1",
      scmRepositoryIdentityId: "repository-1",
      pullRequestNumber: 42,
    }),
  );
  const manifest = invocationManifest(
    scopeHash,
    options.executionProfile ?? ProviderExecutionProfile.ContextGatewayV1,
  );
  const identity = await buildProviderInvocationIdentity(digest, {
    manifest,
    providerVoteIdentityHash,
  });
  let currentAuthorization = authorization(
    sourceRevision,
    "authorization-1",
    options.authorizeInvestigationExtension ?? true,
  );
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
    investigationLeaseQueries: {} as never,
    investigationQueries: {} as never,
    investigationLeaseCapabilities: {} as never,
    investigationRollout: {
      async assertAllowed() {
        if (options.investigationRolloutAllowed === false) {
          throw new Error("investigation_rollout_emergency_disabled");
        }
      },
    },
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
              ? activeGatewayPolicyVersion
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
      gatewayPolicyVersion: activeGatewayPolicyVersion,
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
      gatewayPolicyVersion: activeGatewayPolicyVersion,
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
        options.authorizeInvestigationExtension ?? true,
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

async function createShadowFixture(
  options: {
    readonly authorizeInvestigationExtension?: boolean;
    readonly investigationRolloutAllowed?: boolean;
  } = {},
) {
  const fixture = await createFixture({
    executionProfile: ProviderExecutionProfile.InvestigationGatewayV1,
    gatewayPolicyVersion: "context-gateway-v4",
    release: { contextGatewayPolicyVersion: "context-gateway-v4" },
    authorizeInvestigationExtension:
      options.authorizeInvestigationExtension ?? true,
    investigationRolloutAllowed: options.investigationRolloutAllowed ?? true,
  });
  const capabilities = investigationCapabilityAdapter();
  const capabilityIdentity = await capabilities.prepareIdentity();
  const manifestCanonicalJson =
    serializeProviderInvocationManifestCanonicalWireJson(fixture.manifest);
  const lease: ReviewInvestigationLease = {
    leaseId: "investigation-lease-1",
    purpose: ReviewInvestigationLeasePurpose.ShadowTurn,
    workspaceId: "workspace-1",
    repositoryConnectionId: "connection-1",
    scmRepositoryIdentityId: "repository-1",
    pullRequestNumber: 42,
    authorizationId: fixture.authorization().authorizationId,
    mutationEpoch: fixture.authorization().mutationEpoch,
    executionId: fixture.openRequest.sourceExecutionId,
    workSlotId: fixture.openRequest.sourceWorkSlotId,
    revision: sourceRevision,
    investigationId: "investigation-1",
    investigationVersion: 3,
    turnId: "investigation-turn-1",
    turnPurpose: ReviewInvestigationTurnPurpose.Discovery,
    providerVoteLaneId: providerVoteIdentityHash,
    providerStrategyId: fixture.providerInvocationKey,
    investigationManifestCanonicalJson: manifestCanonicalJson,
    investigationManifestHash: fixture.manifestKey,
    attemptId: "investigation-attempt-1",
    acquireRequestIdHash: sha("investigation-acquire-request-id"),
    acquireRequestHash: sha("investigation-acquire-request"),
    lastRenewRequestIdHash: null,
    lastRenewRequestHash: null,
    lastReleaseRequestIdHash: null,
    lastReleaseRequestHash: null,
    ownerIdHash: sha("investigation-owner"),
    leaseCapabilityId: capabilityIdentity.capabilityId,
    capabilitySigningKeyId: capabilityIdentity.signingKeyId,
    fencingToken: 91n,
    state: ReviewInvestigationLeaseState.Active,
    acquiredAt: new Date(now.getTime() - 2_000).toISOString(),
    renewedAt: new Date(now.getTime() - 1_000).toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    resultReportUntil: new Date(now.getTime() + 120_000).toISOString(),
    retainUntil: new Date(now.getTime() + 3_600_000).toISOString(),
  };
  const aggregate = {
    investigationId: lease.investigationId,
    version: lease.investigationVersion,
    scope: {
      workspaceId: lease.workspaceId,
      repositoryConnectionId: lease.repositoryConnectionId,
      scmRepositoryIdentityId: lease.scmRepositoryIdentityId,
      pullRequestNumber: lease.pullRequestNumber,
    },
    revision: lease.revision,
    executionId: lease.executionId,
    workSlotId: lease.workSlotId,
    providerVoteLaneId: lease.providerVoteLaneId,
    providerStrategyId: lease.providerStrategyId,
    investigationManifestCanonicalJson:
      lease.investigationManifestCanonicalJson,
    investigationManifestHash: lease.investigationManifestHash,
    activeTurn: {
      turnId: lease.turnId,
      purpose: lease.turnPurpose,
    },
  } as never;
  const leaseCapability = await capabilities.issue(
    lease,
    fixture.manifest.scopeHash,
  );
  const dependencies: ReviewActionV2ContextAttestationHandlerDependencies = {
    ...fixture.dependencies,
    investigationLeaseQueries: {
      findLease: async (leaseId) => (leaseId === lease.leaseId ? lease : null),
    },
    investigationQueries: {
      findById: async (investigationId) =>
        investigationId === lease.investigationId ? aggregate : null,
    },
    investigationLeaseCapabilities: capabilities,
  };
  const routes = composeReviewActionV2ContextAttestationRoutes({
    enabled: true,
    runtime: {
      readServerTime: async () => now,
      createRequestId: () => "request-generated",
    },
    handlers: dependencies,
  });
  const confinementEvidenceHash = sha(
    canonicalizeReviewInvestigationContextConfinementEvidence({
      attemptId: lease.attemptId,
      sourceLeaseId: lease.leaseId,
      sourceFencingToken: lease.fencingToken.toString(10),
      sourceExecutionId: lease.executionId,
      sourceWorkSlotId: lease.workSlotId,
      sourceReviewRevisionHash: lease.revision.reviewRevisionHash,
      checkoutTreeOid: sourceTree,
      providerKind: fixture.manifest.providerKind,
      requestedModel: fixture.manifest.requestedModel,
      executionProfile: fixture.manifest.executionProfile,
      providerInvocationKey: lease.providerStrategyId,
      toolPolicyHash: fixture.manifest.toolPolicyHash,
      gatewayPolicyVersion: fixture.openRequest.gatewayPolicyVersion,
      gatewayBinaryHash,
    }),
  );
  const openRequest = await withBodyHash(
    ReviewActionV2OperationId.ReviewInvestigationContextGatewayOpen,
    {
      ...fixture.openRequest,
      requestId: "shadow-gateway-open",
      idempotencyKey: "shadow-gateway-open",
      leaseCapability,
      attemptId: lease.attemptId,
      sourceLeaseId: lease.leaseId,
      fencingToken: lease.fencingToken.toString(10),
      confinementEvidenceHash,
    } satisfies ReviewInvestigationContextGatewayOpenRequest,
  );
  return {
    ...fixture,
    dependencies,
    lease,
    openRequest,
    routes,
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

function sourceV4Manifest(input: {
  sessionId: string;
  sessionSecret: Buffer;
  eventChainSeedHash: string;
}) {
  const operation = {
    kind: ContextGatewayV4OperationKind.GitFact,
    fact: "merge_base",
  } as const;
  const result = {
    complete: true,
    fact: "merge_base",
    itemCount: 1,
    resultHash: sha("merge-base-result"),
  } as const;
  const operationKey = sha(stableJson(operation));
  const operationReceiptId = sha("operation-receipt");
  const eventIdentity = {
    sessionId: input.sessionId,
    sequence: 1,
    previousEventHash: input.eventChainSeedHash,
    operationKey,
    outcome: ContextGatewayV4OutcomeKind.Succeeded,
    failureClass: null,
    operation,
    result,
    operationReceiptId,
    sanitizedReason: null,
  };
  const eventHash = createHmac("sha256", input.sessionSecret)
    .update(stableJson(eventIdentity))
    .digest("hex");
  return createContextGatewayV4Manifest({
    manifestVersion: 3,
    gatewayPolicyVersion: "context-gateway-v4",
    gatewayBinaryHash,
    checkoutTreeOid: sourceTree,
    eventChainSeedHash: input.eventChainSeedHash,
    authenticatedChainHash: eventHash,
    complete: true,
    confinementTainted: false,
    terminalFailureClass: null,
    events: [
      {
        sequence: 1,
        previousEventHash: input.eventChainSeedHash,
        eventHash,
        operationKey,
        operationKind: ContextGatewayV4OperationKind.GitFact,
        outcome: ContextGatewayV4OutcomeKind.Succeeded,
        failureClass: null,
        operation,
        result,
        operationReceiptId,
        sanitizedReason: null,
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

async function createShadowSealRequest(input: {
  fixture: Awaited<ReturnType<typeof createShadowFixture>>;
  sessionId: string;
  sealCapability: string;
  transcriptCanonicalJson: string;
  replayMaterialCanonicalJson: string;
  actualModel?: string;
}) {
  return withBodyHash(
    ReviewActionV2OperationId.ReviewInvestigationContextGatewaySeal,
    {
      ...envelope("investigation-gateway-seal"),
      authorizationToken: "authorization-token",
      leaseCapability: input.fixture.openRequest.leaseCapability,
      idempotencyKey: "investigation-gateway-seal",
      requestBodyHash: sha("placeholder"),
      sessionId: input.sessionId,
      sealCapability: input.sealCapability,
      attemptId: input.fixture.lease.attemptId,
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
    } satisfies ReviewInvestigationContextGatewaySealRequest,
  );
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
    investigationCertificateId: null,
    investigationCertificateHash: null,
    trustDomain: EvidenceTrustDomain.TrustedManaged,
    createdAtMs: now.getTime(),
    reuseExpiresAtMs: now.getTime() + 3_600_000,
    retainUntilMs: now.getTime() + 7_200_000,
  });
}

function invocationManifest(
  scopeHash: string,
  executionProfile: ProviderExecutionProfile,
): ProviderInvocationManifest {
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
    executionProfile,
    baseTreeHash: null,
    environmentContractHash: sha("environment"),
  };
}

function authorization(
  facts: ReturnType<typeof revision>,
  authorizationId: string,
  authorizeInvestigationExtension = true,
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
    reviewInvestigationAuthorizationDescriptorCanonicalJson:
      authorizeInvestigationExtension
        ? canonicalJson({
            authorizationDescriptorVersion: 3,
            capability: "review_investigation_v1",
            coverageProfileHash: sha("coverage-profile"),
            extensionCanonicalizerDigest:
              reviewInvestigationExtensionV1.canonicalizerDigest,
            extensionId: reviewInvestigationExtensionV1.extensionId,
            extensionSchemaDigest: reviewInvestigationExtensionV1.schemaDigest,
            policyHash: sha("policy"),
            providerCapabilities: [
              { capabilities: ["recording"], providerKind: "codex" },
            ],
          })
        : null,
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
  const keyRing = capabilityKeyRing();
  let sequence = 0;
  return new ReviewActionV2ExecutionEvidenceCapabilityAdapter(
    new JoseRotatingCapabilityCodec(keyRing, 0),
    keyRing,
    "reviewrouter-context-test",
    () => `capability-${++sequence}`,
  );
}

function capabilityKeyRing() {
  return new ConfiguredCapabilityKeyRing({
    activeKeyId: "test-key",
    keys: [
      {
        keyId: "test-key",
        secret: Buffer.from("0123456789abcdef0123456789abcdef"),
        verifyUntil: null,
      },
    ],
  });
}

function investigationCapabilityAdapter() {
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
  return new ReviewActionV2InvestigationLeaseCapabilityAdapter(
    new JoseRotatingCapabilityCodec(keyRing, 0),
    keyRing,
    "reviewrouter-context-test",
    () => `investigation-capability-${++sequence}`,
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
