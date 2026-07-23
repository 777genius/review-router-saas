import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ConfiguredCapabilityKeyRing,
  JoseRotatingCapabilityCodec,
} from "@reviewrouter/platform-signed-capabilities";
import {
  AcceptReviewObservationStatus,
  LookupReviewEvidenceStatus,
  ProviderResultCompletionStatus,
  ProviderExecutionProfile,
  ReviewProviderKind,
  ReviewReuseTier,
  ReviewTaskKind as EvidenceTaskKind,
  ReviewTrustDomain as EvidenceTrustDomain,
  ReuseEligibility,
  buildProviderInvocationIdentity,
  prepareReviewObservationPayload,
  reviewEvidencePayloadVersion,
  reviewReuseEligibilityPolicyVersion,
  serializeProviderInvocationManifestCanonicalWireJson,
  type ProviderInvocationManifest,
  type ReviewObservation,
} from "@reviewrouter/features-review-evidence";
import {
  CurrentReviewExecutionRevisionStatus,
  ReviewCoverageState,
  ReviewExecutionProviderKind,
  ReviewExecutionFinalizeStatus,
  ReviewExecutionState,
  ReviewInvocationLeaseAcquireStatus,
  ReviewInvocationLeasePurpose,
  ReviewInvocationLeaseState,
  ReviewInvocationLeaseTransitionStatus,
  ReviewObservationAttachmentKind,
  ReviewObservationAttachmentStatus,
  ReviewTaskKind,
  ReviewWorkSlotState,
  type ReviewExecutionSnapshot,
  type FinalizedReviewProjectionArtifact,
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
  canonicalizeReviewActionV2Request,
  ReviewActionV2OperationId,
  ReviewActionV2ProtocolErrorCode,
  ReviewEvidenceLookupResultStatus,
  ReviewEvidenceCommitResultStatus,
  ReviewExecutionMutationResultStatus,
  ReviewInvocationLeaseResultStatus,
  reviewActionV2PublishedProtocolVersion,
  reviewActionV2PublishedSchemaDigest,
  type ReviewExecutionObservationAttachRequest,
  type ReviewExecutionObservationAdoptRequest,
  type ReviewEvidenceCommitRequest,
  type ReviewExecutionFinalizeRequest,
  type ReviewExecutionStartRequest,
  type ReviewInvocationLeaseAcquireRequest,
} from "@reviewrouter/protocol-review-action-v2";
import { ReviewActionV2ExecutionEvidenceCapabilityAdapter } from "./review-action-v2-execution-evidence-capabilities.js";
import {
  composeReviewActionV2EvidenceRoutes,
  composeReviewActionV2ExecutionRoutes,
  createReviewActionV2EvidenceHandlers,
  createReviewActionV2ExecutionHandlers,
  type ReviewActionV2EvidenceHandlerDependencies,
  type ReviewActionV2ExecutionHandlerDependencies,
} from "./review-action-v2-execution-evidence-composition.js";

const now = new Date("2026-07-22T20:00:00.000Z");
const digest = {
  digestUtf8: async (value: string) => sha(value),
  digest: async (value: Uint8Array) =>
    createHash("sha256").update(value).digest("hex"),
};

describe("Review Action v2 execution/evidence composition", () => {
  it("stays disabled unless explicitly composed with every dependency", () => {
    const runtime = {
      readServerTime: async () => now,
      createRequestId: () => "request-1",
    };
    expect(
      composeReviewActionV2ExecutionRoutes({ enabled: false, runtime }),
    ).toEqual(runtime);
    expect(
      composeReviewActionV2EvidenceRoutes({ enabled: false, runtime }),
    ).toEqual(runtime);
    expect(() =>
      composeReviewActionV2ExecutionRoutes({ enabled: true, runtime }),
    ).toThrow("review_action_v2_execution_dependencies_unavailable");
  });

  it("rejects authorization and revision mismatches before starting", async () => {
    const d = executionDependencies();
    const handlers = createReviewActionV2ExecutionHandlers(d);
    await expect(
      handlers.start.execute(
        await startRequest({ authorizationId: "wrong-authorization" }),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      handlers.start.execute(
        await startRequest({ reviewRevisionHash: hash("f") }),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(d.executions.startReviewExecution.execute).not.toHaveBeenCalled();
  });

  it("verifies signed capabilities fail-closed and rejects tampering", async () => {
    const capabilities = capabilityAdapter();
    const token = await capabilities.issueLease(lease(), hash("a"));
    await expect(capabilities.verifyLease(token, now)).resolves.toMatchObject({
      authorizationId: authorization.authorizationId,
      leaseId: "lease-1",
      attemptId: "attempt-1",
    });
    const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
    await expect(capabilities.verifyLease(tampered, now)).rejects.toBeDefined();
  });

  it("revalidates cross-execution reuse and restores an idempotent retry", async () => {
    const capabilities = capabilityAdapter();
    const observation = reusableObservation();
    const invocationManifest = manifest();
    const scopeHash = await digest.digestUtf8(
      canonicalJson({
        workspaceId: authorization.workspaceId,
        repositoryConnectionId: authorization.repositoryConnectionId,
        scmRepositoryIdentityId: authorization.scmRepositoryIdentityId,
        pullRequestNumber: authorization.pullRequestNumber,
      }),
    );
    const attachmentCapability = await capabilities.issueReusableAttachment(
      {
        authorizationId: authorization.authorizationId,
        mutationEpoch: authorization.mutationEpoch,
        scopeHash,
        targetExecutionId: "execution-target",
        targetWorkSlotId: "slot-1",
        targetReviewRevisionHash: authorization.reviewRevisionHash,
        targetPlanHash: hash("9"),
        observationId: observation.observationId,
        sourceExecutionId: observation.sourceExecutionId,
        manifest: invocationManifest,
        manifestKey: observation.manifestKey,
        providerInvocationKey: observation.providerInvocationKey,
        providerVoteIdentityHash: observation.providerVoteIdentityHash,
        payloadHash: observation.payloadHash,
        byteCount: observation.byteCount,
        findingCount: observation.findingCount,
        attachmentKind: ReviewObservationAttachmentKind.ExactRevisionReuse,
        reuseSafetyDecisionHash: hash("8"),
        eligibilityPolicyVersion: reviewReuseEligibilityPolicyVersion,
        trustDomain: EvidenceTrustDomain.TrustedManaged,
        expiresAt: new Date(now.getTime() + 60_000),
      },
      now,
    );
    let attachmentCalls = 0;
    const d = executionDependencies({
      capabilities,
      evidenceLookup: vi.fn(async () => reuseHit(observation)),
      attachReusable: vi.fn(async () => ({
        status:
          attachmentCalls++ === 0
            ? ReviewObservationAttachmentStatus.Attached
            : ReviewObservationAttachmentStatus.Restored,
        snapshot,
      })),
    });
    const handlers = createReviewActionV2ExecutionHandlers(d);
    const request = await attachRequest(attachmentCapability, observation);
    await expect(
      handlers.attachObservation.execute(request),
    ).resolves.toMatchObject({
      result: { status: ReviewExecutionMutationResultStatus.Applied },
    });
    await expect(
      handlers.attachObservation.execute(request),
    ).resolves.toMatchObject({
      result: { status: ReviewExecutionMutationResultStatus.Restored },
    });
    expect(d.evidence.lookupReviewEvidence.execute).toHaveBeenCalledTimes(2);
    expect(
      d.executions.observationAttachments.attachReusable,
    ).toHaveBeenCalledTimes(2);
  });

  it("never issues generic reuse authority for same-execution recovery", async () => {
    const { manifestCanonicalJson, identity, sourceLease, observation } =
      await committedAdoptionFixture();
    const d = evidenceDependencies({
      currentLease: sourceLease,
      evidenceLookup: vi.fn(async () => ({
        ...reuseHit(observation),
        status: LookupReviewEvidenceStatus.Shadow,
        selected: {
          ...reuseHit(observation).selected,
          canAttach: false,
          eligibility: ReuseEligibility.CandidateOnly,
          reason: "same_execution_requires_adoption",
          reuseSafetyDecisionHash: null,
        },
      })),
    });
    const result = await createReviewActionV2EvidenceHandlers(d).lookup.execute(
      {
        ...envelope("lookup-1"),
        authorizationToken: "authorization-token",
        executionId: "execution-target",
        workSlotId: "slot-1",
        planHash: hash("9"),
        manifestCanonicalJson,
        manifestKey: identity.manifestKey,
        providerInvocationKey: identity.providerInvocationKey,
        providerVoteIdentityHash: observation.providerVoteIdentityHash,
      },
    );
    expect(result.result).toMatchObject({
      status: ReviewEvidenceLookupResultStatus.Shadow,
      attachmentCapability: null,
      sourceLeaseId: "lease-1",
      sourceFencingToken: "7",
      sourceOwnerIdHash: hash("d"),
    });
  });

  it("fails same-execution lookup closed when adoption source facts drift", async () => {
    const { manifestCanonicalJson, identity, sourceLease, observation } =
      await committedAdoptionFixture();
    const d = evidenceDependencies({
      currentLease: { ...sourceLease, fencingToken: 8n },
      evidenceLookup: vi.fn(async () => ({
        ...reuseHit(observation),
        status: LookupReviewEvidenceStatus.Shadow,
        selected: {
          ...reuseHit(observation).selected,
          canAttach: false,
          eligibility: ReuseEligibility.CandidateOnly,
          reason: "same_execution_requires_adoption",
          reuseSafetyDecisionHash: null,
        },
      })),
    });

    const result = await createReviewActionV2EvidenceHandlers(d).lookup.execute(
      {
        ...envelope("lookup-source-drift"),
        authorizationToken: "authorization-token",
        executionId: "execution-target",
        workSlotId: "slot-1",
        planHash: hash("9"),
        manifestCanonicalJson,
        manifestKey: identity.manifestKey,
        providerInvocationKey: identity.providerInvocationKey,
        providerVoteIdentityHash: observation.providerVoteIdentityHash,
      },
    );

    expect(result.result).toEqual({
      status: ReviewEvidenceLookupResultStatus.Miss,
      denialReasons: ["adoption_source_facts_unavailable"],
    });
  });

  it("fails same-execution lookup closed after the result-report deadline", async () => {
    const { manifestCanonicalJson, identity, sourceLease, observation } =
      await committedAdoptionFixture();
    const d = evidenceDependencies({
      currentLease: {
        ...sourceLease,
        resultReportUntil: new Date(now.getTime() - 1),
      },
      evidenceLookup: vi.fn(async () => ({
        ...reuseHit(observation),
        status: LookupReviewEvidenceStatus.Shadow,
        selected: {
          ...reuseHit(observation).selected,
          canAttach: false,
          eligibility: ReuseEligibility.CandidateOnly,
          reason: "same_execution_requires_adoption",
          reuseSafetyDecisionHash: null,
        },
      })),
    });

    const result = await createReviewActionV2EvidenceHandlers(d).lookup.execute(
      {
        ...envelope("lookup-source-expired"),
        authorizationToken: "authorization-token",
        executionId: "execution-target",
        workSlotId: "slot-1",
        planHash: hash("9"),
        manifestCanonicalJson,
        manifestKey: identity.manifestKey,
        providerInvocationKey: identity.providerInvocationKey,
        providerVoteIdentityHash: observation.providerVoteIdentityHash,
      },
    );

    expect(result.result).toEqual({
      status: ReviewEvidenceLookupResultStatus.Miss,
      denialReasons: ["adoption_source_facts_unavailable"],
    });
  });

  it("does not return an observation payload above negotiated bounds", async () => {
    const observation = reusableObservation({ byteCount: 2_000_000 });
    const d = evidenceDependencies({
      evidenceLookup: vi.fn(async () => reuseHit(observation)),
    });
    const result = await createReviewActionV2EvidenceHandlers(d).lookup.execute(
      {
        ...envelope("lookup-2"),
        authorizationToken: "authorization-token",
        executionId: "execution-target",
        workSlotId: "slot-1",
        planHash: hash("9"),
        manifestCanonicalJson: stableManifestJson(),
        manifestKey: observation.manifestKey,
        providerInvocationKey: observation.providerInvocationKey,
        providerVoteIdentityHash: observation.providerVoteIdentityHash,
      },
    );
    expect(result.result).toEqual({
      status: ReviewEvidenceLookupResultStatus.Miss,
      denialReasons: ["payload_limit_exceeded"],
    });
  });

  it("releases an acquired lease when the revision changes before capability issuance", async () => {
    const capabilities = capabilityAdapter();
    const issueLease = vi.spyOn(capabilities, "issueLease");
    const acquiredLease = lease();
    const acquire = vi.fn(async () => ({
      status: ReviewInvocationLeaseAcquireStatus.Acquired,
      lease: acquiredLease,
    }));
    const release = vi.fn(async () => ({
      status: ReviewInvocationLeaseTransitionStatus.Applied,
      lease: {
        ...acquiredLease,
        state: ReviewInvocationLeaseState.Released,
      },
    }));
    const currentRevision = vi
      .fn()
      .mockResolvedValueOnce(CurrentReviewExecutionRevisionStatus.Current)
      .mockResolvedValueOnce(CurrentReviewExecutionRevisionStatus.Stale);
    const prepared = manifest();
    const identity = await buildProviderInvocationIdentity(digest, {
      manifest: prepared,
      providerVoteIdentityHash: hash("c"),
    });
    const request = await withBodyHash(
      ReviewActionV2OperationId.ReviewInvocationLeaseAcquire,
      {
        ...envelope("acquire-revision-race"),
        authorizationToken: "authorization-token",
        idempotencyKey: "acquire-revision-race",
        requestBodyHash: hash("0"),
        executionId: snapshot.execution.executionId,
        workSlotId: "slot-1",
        purpose: ReviewInvocationLeasePurpose.ProviderExecution,
        manifestCanonicalJson:
          serializeProviderInvocationManifestCanonicalWireJson(prepared),
        manifestKey: identity.manifestKey,
        providerVoteIdentityHash: hash("c"),
        providerInvocationKey: identity.providerInvocationKey,
        acquireRequestId: "acquire-revision-race",
        ownerIdHash: acquiredLease.ownerIdHash,
      } satisfies ReviewInvocationLeaseAcquireRequest,
    );

    await expect(
      createReviewActionV2ExecutionHandlers(
        executionDependencies({
          capabilities,
          acquire,
          release,
          currentRevision,
          leaseSafety: vi.fn(async () => ({
            allowed: true,
            decisionHash: hash("6"),
          })),
        }),
      ).acquireLease.execute(request),
    ).rejects.toMatchObject({
      statusCode: 412,
      issues: ["execution_revision_stale"],
    });
    expect(release).toHaveBeenCalledWith(
      expect.objectContaining({
        leaseId: acquiredLease.leaseId,
        fencingToken: acquiredLease.fencingToken,
      }),
    );
    expect(issueLease).not.toHaveBeenCalled();
  });

  it("surfaces a stale fencing term without applying a renewal", async () => {
    const capabilities = capabilityAdapter();
    const leaseCapability = await capabilities.issueLease(
      lease(),
      manifest().scopeHash,
    );
    const renew = vi.fn(async () => ({
      status: ReviewInvocationLeaseTransitionStatus.StaleTerm,
    }));
    const d = executionDependencies({ capabilities, renew });
    const request = await withBodyHash(
      ReviewActionV2OperationId.ReviewInvocationLeaseRenew,
      {
        ...envelope("renew-1"),
        leaseCapability,
        idempotencyKey: "renew-idempotency",
        requestBodyHash: hash("0"),
        leaseId: "lease-1",
        ownerIdHash: hash("d"),
        fencingToken: "6",
        renewRequestId: "renew-request-1",
      },
    );
    await expect(
      createReviewActionV2ExecutionHandlers(d).renewLease.execute(request),
    ).resolves.toMatchObject({
      result: { status: ReviewInvocationLeaseResultStatus.StaleTerm },
    });
    expect(renew).toHaveBeenCalledWith(
      expect.objectContaining({
        fencingToken: 6n,
        renewRequestIdHash: await digest.digestUtf8("renew-request-1"),
        renewRequestHash: request.requestBodyHash,
      }),
    );
  });

  it("releases a renewed lease when the revision changes before capability issuance", async () => {
    const capabilities = capabilityAdapter();
    const originalLease = lease();
    const renewedLease = lease({
      renewedAt: new Date(now),
      expiresAt: new Date(now.getTime() + 60_000),
    });
    const leaseCapability = await capabilities.issueLease(
      originalLease,
      manifest().scopeHash,
    );
    const issueLease = vi.spyOn(capabilities, "issueLease");
    issueLease.mockClear();
    const renew = vi.fn(async () => ({
      status: ReviewInvocationLeaseTransitionStatus.Applied,
      lease: renewedLease,
    }));
    const release = vi.fn(async () => ({
      status: ReviewInvocationLeaseTransitionStatus.Applied,
      lease: {
        ...renewedLease,
        state: ReviewInvocationLeaseState.Released,
      },
    }));
    const currentRevision = vi
      .fn()
      .mockResolvedValueOnce(CurrentReviewExecutionRevisionStatus.Current)
      .mockResolvedValueOnce(CurrentReviewExecutionRevisionStatus.Stale);
    const request = await withBodyHash(
      ReviewActionV2OperationId.ReviewInvocationLeaseRenew,
      {
        ...envelope("renew-revision-race"),
        leaseCapability,
        idempotencyKey: "renew-revision-race",
        requestBodyHash: hash("0"),
        leaseId: originalLease.leaseId,
        ownerIdHash: originalLease.ownerIdHash,
        fencingToken: originalLease.fencingToken.toString(10),
        renewRequestId: "renew-revision-race",
      },
    );

    await expect(
      createReviewActionV2ExecutionHandlers(
        executionDependencies({
          capabilities,
          currentLease: originalLease,
          currentRevision,
          renew,
          release,
        }),
      ).renewLease.execute(request),
    ).rejects.toMatchObject({
      statusCode: 412,
      issues: ["execution_revision_stale"],
    });
    expect(release).toHaveBeenCalledWith(
      expect.objectContaining({
        leaseId: renewedLease.leaseId,
        fencingToken: renewedLease.fencingToken,
      }),
    );
    expect(issueLease).not.toHaveBeenCalled();
  });

  it("rejects a renewal replay identity reused with a different body", async () => {
    const capabilities = capabilityAdapter();
    const currentLease = lease();
    const leaseCapability = await capabilities.issueLease(
      currentLease,
      manifest().scopeHash,
    );
    const renew = vi.fn(async () => ({
      status: ReviewInvocationLeaseTransitionStatus.IdempotencyConflict,
    }));
    const request = await withBodyHash(
      ReviewActionV2OperationId.ReviewInvocationLeaseRenew,
      {
        ...envelope("renew-conflict"),
        leaseCapability,
        idempotencyKey: "renew-conflict",
        requestBodyHash: hash("0"),
        leaseId: currentLease.leaseId,
        ownerIdHash: currentLease.ownerIdHash,
        fencingToken: currentLease.fencingToken.toString(10),
        renewRequestId: "renew-request-reused",
      },
    );

    await expect(
      createReviewActionV2ExecutionHandlers(
        executionDependencies({ capabilities, currentLease, renew }),
      ).renewLease.execute(request),
    ).rejects.toMatchObject({
      statusCode: 409,
      issues: ["lease_renewal_replay_conflict"],
    });
  });

  it("returns a renewed capability, rejects old ownership, and keeps late reporting valid", async () => {
    const capabilities = capabilityAdapter();
    const originalLease = lease({
      expiresAt: new Date(now.getTime() + 10_000),
      resultReportUntil: new Date(now.getTime() + 120_000),
    });
    const renewedLease = lease({
      renewedAt: new Date(now),
      expiresAt: new Date(now.getTime() + 60_000),
      resultReportUntil: originalLease.resultReportUntil,
    });
    const oldCapability = await capabilities.issueLease(
      originalLease,
      manifest().scopeHash,
    );
    const renew = vi.fn(async () => ({
      status: ReviewInvocationLeaseTransitionStatus.Applied,
      lease: renewedLease,
    }));
    const renewed = await createReviewActionV2ExecutionHandlers(
      executionDependencies({
        capabilities,
        currentLease: originalLease,
        renew,
      }),
    ).renewLease.execute(
      await withBodyHash(ReviewActionV2OperationId.ReviewInvocationLeaseRenew, {
        ...envelope("renew-fresh-capability"),
        leaseCapability: oldCapability,
        idempotencyKey: "renew-fresh-capability",
        requestBodyHash: hash("0"),
        leaseId: originalLease.leaseId,
        ownerIdHash: originalLease.ownerIdHash,
        fencingToken: originalLease.fencingToken.toString(10),
        renewRequestId: "renew-fresh-capability",
      }),
    );
    const newCapability = renewed.result.leaseCapability;
    if (!newCapability) throw new Error("renewed_capability_missing");
    expect(newCapability).not.toBe(oldCapability);

    const afterOriginalOwnership = new Date(now.getTime() + 20_000);
    await expect(
      capabilities.verifyLease(oldCapability, afterOriginalOwnership),
    ).resolves.toMatchObject({
      ownershipExpiresAt: originalLease.expiresAt,
      resultReportUntil: originalLease.resultReportUntil,
    });
    await expect(
      capabilities.verifyLease(newCapability, afterOriginalOwnership),
    ).resolves.toMatchObject({
      ownershipExpiresAt: renewedLease.expiresAt,
      resultReportUntil: renewedLease.resultReportUntil,
    });

    const release = vi.fn(async () => ({
      status: ReviewInvocationLeaseTransitionStatus.Applied,
      lease: {
        ...renewedLease,
        state: ReviewInvocationLeaseState.Released,
      },
    }));
    const ownershipHandlers = createReviewActionV2ExecutionHandlers(
      executionDependencies({
        capabilities,
        currentLease: renewedLease,
        release,
        now: () => afterOriginalOwnership,
      }),
    );
    const releaseRequest = (leaseCapability: string, requestId: string) =>
      withBodyHash(ReviewActionV2OperationId.ReviewInvocationLeaseRelease, {
        ...envelope(requestId),
        leaseCapability,
        idempotencyKey: requestId,
        requestBodyHash: hash("0"),
        leaseId: renewedLease.leaseId,
        ownerIdHash: renewedLease.ownerIdHash,
        fencingToken: renewedLease.fencingToken.toString(10),
        releaseRequestId: requestId,
      });
    await expect(
      ownershipHandlers.releaseLease.execute(
        await releaseRequest(oldCapability, "release-old-capability"),
      ),
    ).rejects.toMatchObject({
      statusCode: 410,
      issues: ["lease_ownership_expired"],
    });
    expect(release).not.toHaveBeenCalled();

    const preparedPayload = prepareReviewObservationPayload(
      reusableObservation().payload,
    );
    const observation = reusableObservation({
      sourceExecutionId: renewedLease.executionId,
      sourceLeaseId: renewedLease.leaseId,
      attemptId: renewedLease.attemptId!,
      providerInvocationKey: renewedLease.providerInvocationKey,
      payloadHash: await digest.digest(preparedPayload.canonicalBytes),
      byteCount: preparedPayload.byteCount,
    });
    const acceptObservation = vi.fn(async () => ({
      status: AcceptReviewObservationStatus.Accepted,
      observation,
      historicalOnly: false,
      eligibilityPolicyVersion: reviewReuseEligibilityPolicyVersion,
    }));
    await expect(
      createReviewActionV2EvidenceHandlers(
        evidenceDependencies({
          capabilities,
          currentLease: renewedLease,
          acceptObservation,
          now: () => afterOriginalOwnership,
        }),
      ).commit.execute(
        await commitRequest(
          oldCapability,
          observation,
          stableJsonForTest(observation.payload),
        ),
      ),
    ).resolves.toMatchObject({
      result: { status: ReviewEvidenceCommitResultStatus.Accepted },
    });
    expect(acceptObservation).toHaveBeenCalledTimes(1);

    await expect(
      ownershipHandlers.releaseLease.execute(
        await releaseRequest(newCapability, "release-new-capability"),
      ),
    ).resolves.toMatchObject({
      result: { status: ReviewInvocationLeaseResultStatus.Applied },
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rejects fresh attachment after persisted lease expiry", async () => {
    const capabilities = capabilityAdapter();
    const expiredLease = lease({
      acquiredAt: new Date(now.getTime() - 60_000),
      renewedAt: new Date(now.getTime() - 60_000),
      expiresAt: new Date(now.getTime() - 1_000),
      resultReportUntil: new Date(now.getTime() + 60_000),
    });
    const leaseCapability = await capabilities.issueLease(
      expiredLease,
      manifest().scopeHash,
    );
    const observation = reusableObservation({
      sourceExecutionId: "execution-target",
      sourceLeaseId: "lease-1",
      attemptId: "attempt-1",
      providerInvocationKey: expiredLease.providerInvocationKey,
    });
    const d = executionDependencies({
      capabilities,
      currentLease: expiredLease,
    });
    await expect(
      createReviewActionV2ExecutionHandlers(d).attachObservation.execute(
        await attachRequest(leaseCapability, observation),
      ),
    ).rejects.toMatchObject({ statusCode: 410 });
    expect(
      d.executions.observationAttachments.attachFresh,
    ).not.toHaveBeenCalled();
  });

  it("returns resource gone instead of re-signing an expired replay permit", async () => {
    const capabilities = capabilityAdapter();
    const issuePublicationPermit = vi.spyOn(
      capabilities,
      "issuePublicationPermit",
    );
    const projectionEnvelopeCanonicalJson = "{}";
    const projectionHash = await digest.digestUtf8(
      projectionEnvelopeCanonicalJson,
    );
    const artifactHash = hash("a");
    const lifecycleStateHash = hash("b");
    const expiredPublicationNotAfter = new Date(now.getTime() - 1);
    const artifact: FinalizedReviewProjectionArtifact = {
      artifactId: "artifact-1",
      executionId: snapshot.execution.executionId,
      generation: snapshot.execution.generation,
      reviewedHeadSha: snapshot.execution.revision.headSha,
      reviewRevisionHash: snapshot.execution.revision.reviewRevisionHash,
      coverageState: ReviewCoverageState.Completed,
      projectionEnvelopeVersion: 1,
      projectionEnvelopeJson: projectionEnvelopeCanonicalJson,
      projectionHash,
      byteCount: 2,
      findingCount: 0,
      lifecycleStateHash,
      commandLedgerWatermark: 0n,
      projectionPolicyVersion: "projection-policy-1",
      publicationPermit: {
        workspaceId: authorization.workspaceId,
        repositoryConnectionId: authorization.repositoryConnectionId,
        scmRepositoryIdentityId: authorization.scmRepositoryIdentityId,
        pullRequestNumber: authorization.pullRequestNumber,
        executionId: snapshot.execution.executionId,
        generation: snapshot.execution.generation,
        authorizationId: authorization.authorizationId,
        producerReleaseId: authorization.producerReleaseId,
        reviewedHeadSha: snapshot.execution.revision.headSha,
        reviewRevisionHash: snapshot.execution.revision.reviewRevisionHash,
        projectionHash,
        lifecycleStateHash,
        commandLedgerWatermark: 0n,
        permitEpoch: authorization.mutationEpoch,
        publicationSafetyDecisionHash: hash("c"),
        publicationNotAfter: expiredPublicationNotAfter,
      },
      createdAt: new Date(now.getTime() - 60_000),
      retainUntil: new Date(now.getTime() + 3_600_000),
    };
    const finalize = vi.fn(async () => ({
      status: ReviewExecutionFinalizeStatus.Restored,
      artifact,
      snapshot: { ...snapshot, artifact },
    }));
    const finalizationFacts = vi.fn(async () => ({
      expectedArtifactHash: artifactHash,
      byteCount: artifact.byteCount,
      findingCount: artifact.findingCount,
      projectionPolicyVersion: artifact.projectionPolicyVersion,
      publicationSafetyDecisionHash:
        artifact.publicationPermit.publicationSafetyDecisionHash,
      publicationNotAfter: new Date(now.getTime() + 60_000),
      retainUntil: artifact.retainUntil,
    }));
    const request = await withBodyHash(
      ReviewActionV2OperationId.ReviewExecutionFinalize,
      {
        ...envelope("finalize-expired-replay"),
        authorizationToken: "authorization-token",
        idempotencyKey: "finalize-expired-replay",
        requestBodyHash: hash("0"),
        executionId: snapshot.execution.executionId,
        expectedStreamVersion: snapshot.stream.version.toString(10),
        expectedExecutionVersion: snapshot.execution.version.toString(10),
        artifactId: artifact.artifactId,
        artifactHash,
        projectionEnvelopeVersion: artifact.projectionEnvelopeVersion,
        projectionEnvelopeCanonicalJson,
        projectionHash,
        lifecycleStateHash,
        commandLedgerWatermark: artifact.commandLedgerWatermark.toString(10),
        allowPartial: false,
      },
    );

    await expect(
      createReviewActionV2ExecutionHandlers(
        executionDependencies({
          capabilities,
          finalize,
          finalizationFacts,
        }),
      ).finalize.execute(request),
    ).rejects.toMatchObject({
      statusCode: 410,
      errorCode: ReviewActionV2ProtocolErrorCode.ResourceGone,
      issues: ["publication_permit_expired"],
    });
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(issuePublicationPermit).not.toHaveBeenCalled();
  });

  it("does not issue a publication permit when the revision becomes unavailable after finalization", async () => {
    const fixture = await finalizationFixture(new Date(now.getTime() + 60_000));
    const capabilities = capabilityAdapter();
    const issuePublicationPermit = vi.spyOn(
      capabilities,
      "issuePublicationPermit",
    );
    const currentRevision = vi
      .fn()
      .mockResolvedValueOnce(CurrentReviewExecutionRevisionStatus.Current)
      .mockResolvedValueOnce(CurrentReviewExecutionRevisionStatus.Unavailable);

    await expect(
      createReviewActionV2ExecutionHandlers(
        executionDependencies({
          capabilities,
          finalize: fixture.finalize,
          finalizationFacts: fixture.finalizationFacts,
          currentRevision,
        }),
      ).finalize.execute(fixture.request),
    ).rejects.toMatchObject({
      statusCode: 503,
      issues: ["execution_revision_unavailable"],
    });
    expect(fixture.finalize).toHaveBeenCalledTimes(1);
    expect(issuePublicationPermit).not.toHaveBeenCalled();
  });

  it("restores evidence after crash before attach and completes with the original fenced lease", async () => {
    const capabilities = capabilityAdapter();
    const currentLease = lease();
    const leaseCapability = await capabilities.issueLease(
      currentLease,
      manifest().scopeHash,
    );
    const payloadCanonicalJson = stableJsonForTest(
      reusableObservation().payload,
    );
    const preparedPayload = prepareReviewObservationPayload(
      reusableObservation().payload,
    );
    const observation = reusableObservation({
      sourceExecutionId: "execution-target",
      sourceLeaseId: currentLease.leaseId,
      attemptId: currentLease.attemptId!,
      providerInvocationKey: currentLease.providerInvocationKey,
      payloadHash: await digest.digest(preparedPayload.canonicalBytes),
      byteCount: preparedPayload.byteCount,
    });
    const acceptObservation = vi
      .fn()
      .mockResolvedValueOnce({
        status: AcceptReviewObservationStatus.Accepted,
        observation,
        historicalOnly: false,
        eligibilityPolicyVersion: reviewReuseEligibilityPolicyVersion,
      })
      .mockResolvedValueOnce({
        status: AcceptReviewObservationStatus.Idempotent,
        observation,
        historicalOnly: false,
        eligibilityPolicyVersion: reviewReuseEligibilityPolicyVersion,
      });
    const evidence = evidenceDependencies({
      capabilities,
      currentLease,
      acceptObservation,
    });
    const commit = await commitRequest(
      leaseCapability,
      observation,
      payloadCanonicalJson,
    );

    await expect(
      createReviewActionV2EvidenceHandlers(evidence).commit.execute(commit),
    ).resolves.toMatchObject({
      result: {
        status: ReviewEvidenceCommitResultStatus.Accepted,
        observationId: observation.observationId,
      },
    });

    // Simulated crash: no attachment is attempted before the exact commit retry.
    await expect(
      createReviewActionV2EvidenceHandlers(evidence).commit.execute(commit),
    ).resolves.toMatchObject({
      result: {
        status: ReviewEvidenceCommitResultStatus.Idempotent,
        observationId: observation.observationId,
      },
    });

    const attachFresh = vi.fn(async () => ({
      status: ReviewObservationAttachmentStatus.Attached,
      snapshot,
    }));
    const execution = executionDependencies({
      capabilities,
      currentLease,
      observation,
      attachFresh,
    });
    await expect(
      createReviewActionV2ExecutionHandlers(
        execution,
      ).attachObservation.execute(
        await attachRequest(leaseCapability, observation),
      ),
    ).resolves.toMatchObject({
      result: { status: ReviewExecutionMutationResultStatus.Applied },
    });
    expect(acceptObservation).toHaveBeenCalledTimes(2);
    expect(attachFresh).toHaveBeenCalledTimes(1);
  });

  it("adopts committed evidence after process restart without issuing a reuse capability", async () => {
    const { manifestCanonicalJson, identity, sourceLease, observation } =
      await committedAdoptionFixture();
    const leasedSnapshot = snapshotWithSlot({
      state: ReviewWorkSlotState.Leased,
      activeLeaseId: sourceLease.leaseId,
      executionVersion: 3n,
      activeLeases: [sourceLease],
    });
    const adoptedSnapshot = snapshotWithSlot({
      state: ReviewWorkSlotState.Satisfied,
      activeLeaseId: null,
      acceptedObservationRefId: "obsref-adopted",
      executionVersion: 5n,
    });
    const adoptAccepted = vi.fn(async () => ({
      status: ReviewObservationAttachmentStatus.Attached,
      snapshot: adoptedSnapshot,
    }));
    const d = executionDependencies({
      currentLease: sourceLease,
      observation,
      adoptAccepted,
      findExecution: vi.fn().mockResolvedValue(leasedSnapshot),
      findLease: vi.fn(async () => sourceLease),
      leaseSafety: vi.fn(async () => ({
        allowed: true,
        decisionHash: hash("6"),
      })),
    });
    const request = await adoptionRequest({
      sourceLease,
      observation,
      manifestCanonicalJson,
      manifestKey: identity.manifestKey,
      expectedExecutionVersion: leasedSnapshot.execution.version,
      expectedStreamVersion: leasedSnapshot.stream.version,
    });

    await expect(
      createReviewActionV2ExecutionHandlers(d).adoptObservation.execute(
        request,
      ),
    ).resolves.toMatchObject({
      statusCode: 201,
      result: {
        status: ReviewExecutionMutationResultStatus.Applied,
        executionId: sourceLease.executionId,
        workSlotId: sourceLease.workSlotId,
        observationPayloadCanonicalJson: expect.any(String),
        observationFactsCanonicalJson: expect.any(String),
      },
    });
    expect(adoptAccepted).toHaveBeenCalledTimes(1);
    expect(adoptAccepted).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceLeaseId: sourceLease.leaseId,
        sourceFencingToken: sourceLease.fencingToken,
        sourceObservationId: observation.observationId,
        providerInvocationKey: identity.providerInvocationKey,
        leaseCapabilityId: "capability-generated",
        capabilitySigningKeyId: "test-key",
        expectedExecutionVersion: leasedSnapshot.execution.version,
        expectedStreamVersion: leasedSnapshot.stream.version,
      }),
    );
  });

  it("rejects adoption after the source result-report deadline", async () => {
    const { manifestCanonicalJson, identity, sourceLease, observation } =
      await committedAdoptionFixture({
        state: ReviewInvocationLeaseState.Released,
        resultReportUntil: new Date(now.getTime() - 1),
      });
    const adoptAccepted = vi.fn();
    const leaseSafety = vi.fn();
    const d = executionDependencies({
      currentLease: sourceLease,
      observation,
      adoptAccepted,
      leaseSafety,
    });
    const request = await adoptionRequest({
      sourceLease,
      observation,
      manifestCanonicalJson,
      manifestKey: identity.manifestKey,
      expectedExecutionVersion: snapshot.execution.version,
      expectedStreamVersion: snapshot.stream.version,
    });

    await expect(
      createReviewActionV2ExecutionHandlers(d).adoptObservation.execute(
        request,
      ),
    ).rejects.toMatchObject({
      statusCode: 412,
      issues: ["adoption_result_report_expired"],
    });
    expect(leaseSafety).not.toHaveBeenCalled();
    expect(adoptAccepted).not.toHaveBeenCalled();
  });

  it("rejects an inactive-source adoption whose caller version is exactly one behind", async () => {
    const { manifestCanonicalJson, identity, sourceLease, observation } =
      await committedAdoptionFixture({
        state: ReviewInvocationLeaseState.Released,
      });
    const currentSnapshot = snapshotWithSlot({
      state: ReviewWorkSlotState.Pending,
      activeLeaseId: null,
      executionVersion: snapshot.execution.version + 1n,
    });
    const adoptAccepted = vi.fn();
    const leaseSafety = vi.fn();
    const d = executionDependencies({
      currentLease: sourceLease,
      observation,
      adoptAccepted,
      leaseSafety,
      findExecution: vi.fn(async () => currentSnapshot),
    });
    const request = await adoptionRequest({
      sourceLease,
      observation,
      manifestCanonicalJson,
      manifestKey: identity.manifestKey,
      expectedExecutionVersion: currentSnapshot.execution.version - 1n,
      expectedStreamVersion: currentSnapshot.stream.version,
    });

    await expect(
      createReviewActionV2ExecutionHandlers(d).adoptObservation.execute(
        request,
      ),
    ).rejects.toMatchObject({
      statusCode: 412,
      issues: ["adoption_execution_version_mismatch"],
    });
    expect(leaseSafety).not.toHaveBeenCalled();
    expect(adoptAccepted).not.toHaveBeenCalled();
  });

  it("restores an exact observation adoption replay after signing-key rotation", async () => {
    const { manifestCanonicalJson, identity, sourceLease, observation } =
      await committedAdoptionFixture({
        state: ReviewInvocationLeaseState.Released,
      });
    const request = await adoptionRequest({
      sourceLease,
      observation,
      manifestCanonicalJson,
      manifestKey: identity.manifestKey,
      expectedExecutionVersion: 3n,
      expectedStreamVersion: snapshot.stream.version,
    });
    const adoptionIdentityHash = await digest.digestUtf8(
      canonicalJson({
        authorizationId: authorization.authorizationId,
        executionId: request.executionId,
        executionGeneration: request.executionGeneration,
        workSlotId: request.workSlotId,
        observationId: request.observationId,
        sourceLeaseId: request.sourceLeaseId,
        sourceFencingToken: request.sourceFencingToken,
        idempotencyKey: request.idempotencyKey,
      }),
    );
    const observationRefId = `obsref:${await digest.digestUtf8(
      canonicalJson({
        executionId: request.executionId,
        workSlotId: request.workSlotId,
        observationId: request.observationId,
      }),
    )}`;
    const adoptionLease = lease({
      leaseId: `adoption-${adoptionIdentityHash}`,
      purpose: ReviewInvocationLeasePurpose.ObservationAdoption,
      state: ReviewInvocationLeaseState.Released,
      preparedManifestCanonicalJson: null,
      preparedManifestKey: null,
      attemptId: null,
      sourceObservationId: observation.observationId,
      providerInvocationKey: request.providerInvocationKey,
      acquireRequestIdHash: await digest.digestUtf8(request.idempotencyKey),
      acquireRequestHash: request.requestBodyHash,
      leaseCapabilityId: "persisted-adoption-capability",
      capabilitySigningKeyId: "retired-signing-key",
    });
    const replaySnapshot = {
      ...snapshotWithSlot({
        state: ReviewWorkSlotState.Satisfied,
        activeLeaseId: null,
        acceptedObservationRefId: observationRefId,
        executionVersion: 5n,
      }),
      observationRefs: [
        {
          observationRefId,
          executionId: request.executionId,
          workSlotId: request.workSlotId,
          providerInvocationKey: request.providerInvocationKey,
          observationId: request.observationId,
          providerVoteIdentityHash: request.providerVoteIdentityHash,
          attachmentKind: ReviewObservationAttachmentKind.ObservationAdoption,
          eligibilityPolicyVersion: request.eligibilityPolicyVersion,
          reuseSafetyDecisionHash: null,
          sourceExecutionId: request.executionId,
          sourceLeaseId: request.sourceLeaseId,
          sourceFencingToken: sourceLease.fencingToken,
          payloadHash: request.payloadHash,
          byteCount: request.byteCount,
          findingCount: request.findingCount,
          attachedAt: now,
        },
      ],
    } as ReviewExecutionSnapshot;
    const release = vi.fn();
    const adoptAccepted = vi.fn();
    const capabilities = capabilityAdapter();
    const prepareIdentity = vi.spyOn(capabilities, "prepareIdentity");
    const d = executionDependencies({
      capabilities,
      currentLease: sourceLease,
      observation,
      release,
      adoptAccepted,
      findExecution: vi.fn(async () => replaySnapshot),
      findLease: vi.fn(async (leaseId: string) =>
        leaseId === sourceLease.leaseId ? sourceLease : adoptionLease,
      ),
      leaseSafety: vi.fn(),
    });

    await expect(
      createReviewActionV2ExecutionHandlers(d).adoptObservation.execute(
        request,
      ),
    ).resolves.toMatchObject({
      statusCode: 200,
      result: {
        status: ReviewExecutionMutationResultStatus.Restored,
        observationPayloadCanonicalJson: expect.any(String),
        observationFactsCanonicalJson: expect.any(String),
      },
    });
    expect(release).not.toHaveBeenCalled();
    expect(adoptAccepted).not.toHaveBeenCalled();
    expect(prepareIdentity).not.toHaveBeenCalled();
  });
});

function executionDependencies(
  overrides: {
    capabilities?: ReviewActionV2ExecutionEvidenceCapabilityAdapter;
    evidenceLookup?: ReturnType<typeof vi.fn>;
    attachReusable?: ReturnType<typeof vi.fn>;
    attachFresh?: ReturnType<typeof vi.fn>;
    adoptAccepted?: ReturnType<typeof vi.fn>;
    release?: ReturnType<typeof vi.fn>;
    acquire?: ReviewActionV2ExecutionHandlerDependencies["executions"]["invocationLeases"]["acquire"];
    renew?: ReturnType<typeof vi.fn>;
    currentLease?: ReviewInvocationLease;
    observation?: ReviewObservation;
    findExecution?: ReviewActionV2ExecutionHandlerDependencies["executionQueries"]["findExecution"];
    findLease?: ReviewActionV2ExecutionHandlerDependencies["executionQueries"]["findLease"];
    leaseSafety?: ReviewActionV2ExecutionHandlerDependencies["leaseSafety"]["resolve"];
    finalize?: ReviewActionV2ExecutionHandlerDependencies["executions"]["finalizeReviewExecution"]["execute"];
    finalizationFacts?: ReviewActionV2ExecutionHandlerDependencies["finalizationFacts"]["resolve"];
    currentRevision?: ReviewActionV2ExecutionHandlerDependencies["executions"]["currentRevision"]["execute"];
    now?: () => Date;
  } = {},
): ReviewActionV2ExecutionHandlerDependencies {
  const shared = common(
    overrides.capabilities,
    overrides.currentLease,
    overrides.now,
  );
  return {
    ...shared,
    executionQueries: {
      ...shared.executionQueries,
      ...(overrides.findExecution
        ? { findExecution: overrides.findExecution }
        : {}),
      ...(overrides.findLease ? { findLease: overrides.findLease } : {}),
    },
    executions: {
      startReviewExecution: { execute: vi.fn() },
      invocationLeases: {
        acquire: overrides.acquire ?? vi.fn(),
        renew: overrides.renew ?? vi.fn(),
        release: overrides.release ?? vi.fn(),
      },
      observationAttachments: {
        attachFresh: overrides.attachFresh ?? vi.fn(),
        attachReusable: overrides.attachReusable ?? vi.fn(),
        adoptAccepted: overrides.adoptAccepted ?? vi.fn(),
      },
      finalizeReviewExecution: { execute: overrides.finalize ?? vi.fn() },
      executionLifecycle: {
        supersede: vi.fn(),
        failAbandonedPrepared: vi.fn(),
      },
      requestedIntents: {} as never,
      currentRevision: {
        execute:
          overrides.currentRevision ??
          vi.fn(async () => CurrentReviewExecutionRevisionStatus.Current),
      },
    } as unknown as ReviewActionV2ExecutionHandlerDependencies["executions"],
    evidence: {
      lookupReviewEvidence: {
        execute: overrides.evidenceLookup ?? vi.fn(),
      },
    } as unknown as ReviewActionV2ExecutionHandlerDependencies["evidence"],
    observations: {
      findById: vi.fn(async () => overrides.observation ?? null),
    } as unknown as ReviewActionV2ExecutionHandlerDependencies["observations"],
    leaseSafety: { resolve: overrides.leaseSafety ?? vi.fn() },
    finalizationFacts: {
      resolve: overrides.finalizationFacts ?? vi.fn(),
    },
  };
}

function evidenceDependencies(
  overrides: {
    evidenceLookup?: ReturnType<typeof vi.fn>;
    acceptObservation?: ReturnType<typeof vi.fn>;
    capabilities?: ReviewActionV2ExecutionEvidenceCapabilityAdapter;
    currentLease?: ReviewInvocationLease;
    now?: () => Date;
  } = {},
): ReviewActionV2EvidenceHandlerDependencies {
  return {
    ...common(overrides.capabilities, overrides.currentLease, overrides.now),
    evidence: {
      lookupReviewEvidence: { execute: overrides.evidenceLookup ?? vi.fn() },
      acceptReviewObservation: {
        execute: overrides.acceptObservation ?? vi.fn(),
      },
      pruneReviewEvidence: {} as never,
    } as unknown as ReviewActionV2EvidenceHandlerDependencies["evidence"],
    observations: {
      findById: vi.fn(),
    } as unknown as ReviewActionV2EvidenceHandlerDependencies["observations"],
  };
}

function common(
  capabilities = capabilityAdapter(),
  currentLease: ReviewInvocationLease = lease(),
  readNow: () => Date = () => now,
) {
  return {
    authorizations: {
      resolveReviewRunAuthorizationToken: vi.fn(async () => ({
        status: ReviewRunAuthorizationTokenResolutionStatus.Valid,
        authorization,
      })),
    },
    executionQueries: {
      findExecution: vi.fn(async () => snapshot),
      findStream: vi.fn(),
      findByStartIdentity: vi.fn(),
      findLease: vi.fn(async () => currentLease),
    },
    protocolLimits: {
      findProtocolLimitsProfileById: vi.fn(async () => protocolLimits),
    },
    digest,
    capabilities,
    now: readNow,
    nextId: (kind: string) => `${kind}-generated`,
    timing: {
      admissionDurationMs: 30_000,
      executionDurationMs: 300_000,
      initialLeaseDurationMs: 30_000,
      retentionDurationMs: 3_600_000,
      attachmentCapabilityDurationMs: 60_000,
    },
  } as unknown as Omit<
    ReviewActionV2ExecutionHandlerDependencies,
    | "executions"
    | "evidence"
    | "observations"
    | "leaseSafety"
    | "finalizationFacts"
  >;
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
    () => "capability-generated",
  );
}

async function committedAdoptionFixture(
  sourceLeaseOverrides: Partial<ReviewInvocationLease> = {},
) {
  const providerManifest = manifest();
  const manifestCanonicalJson =
    serializeProviderInvocationManifestCanonicalWireJson(providerManifest);
  const identity = await buildProviderInvocationIdentity(digest, {
    manifest: providerManifest,
    providerVoteIdentityHash: hash("c"),
  });
  const sourceLease = lease({
    preparedManifestCanonicalJson: manifestCanonicalJson,
    preparedManifestKey: identity.manifestKey,
    providerInvocationKey: identity.providerInvocationKey,
    ...sourceLeaseOverrides,
  });
  const prepared = prepareReviewObservationPayload(
    reusableObservation().payload,
  );
  const observation = reusableObservation({
    manifestKey: identity.manifestKey,
    providerInvocationKey: identity.providerInvocationKey,
    sourceExecutionId: sourceLease.executionId,
    sourceLeaseId: sourceLease.leaseId,
    sourceFencingToken: sourceLease.fencingToken.toString(10),
    attemptId: sourceLease.attemptId!,
    sourceRevision: {
      baseSha: authorization.baseSha,
      mergeBaseSha: authorization.mergeBaseSha,
      headSha: authorization.headSha,
      reviewRevisionHash: authorization.reviewRevisionHash,
    },
    payloadHash: await digest.digest(prepared.canonicalBytes),
    byteCount: prepared.byteCount,
    findingCount: prepared.findingCount,
  });
  return { manifestCanonicalJson, identity, sourceLease, observation } as const;
}

async function adoptionRequest(input: {
  sourceLease: ReviewInvocationLease;
  observation: ReviewObservation;
  manifestCanonicalJson: string;
  manifestKey: string;
  expectedExecutionVersion: bigint;
  expectedStreamVersion: bigint;
}): Promise<ReviewExecutionObservationAdoptRequest> {
  const request: ReviewExecutionObservationAdoptRequest = {
    ...envelope("adopt-1"),
    authorizationToken: "authorization-token",
    idempotencyKey: "adopt-idempotency-1",
    requestBodyHash: hash("0"),
    executionId: input.sourceLease.executionId,
    executionGeneration: input.sourceLease.executionGeneration.toString(10),
    expectedStreamVersion: input.expectedStreamVersion.toString(10),
    expectedExecutionVersion: input.expectedExecutionVersion.toString(10),
    workSlotId: input.sourceLease.workSlotId,
    observationId: input.observation.observationId,
    providerInvocationKey: input.observation.providerInvocationKey,
    providerVoteIdentityHash: input.observation.providerVoteIdentityHash,
    payloadHash: input.observation.payloadHash,
    byteCount: input.observation.byteCount,
    findingCount: input.observation.findingCount,
    sourceLeaseId: input.sourceLease.leaseId,
    sourceFencingToken: input.sourceLease.fencingToken.toString(10),
    manifestCanonicalJson: input.manifestCanonicalJson,
    manifestKey: input.manifestKey,
    planHash: snapshot.execution.planHash,
    reviewRevisionHash: authorization.reviewRevisionHash,
    ownerIdHash: input.sourceLease.ownerIdHash,
    eligibilityPolicyVersion: reviewReuseEligibilityPolicyVersion,
  };
  return withBodyHash(
    ReviewActionV2OperationId.ReviewExecutionObservationAdopt,
    request,
  );
}

function snapshotWithSlot(input: {
  state: ReviewWorkSlotState;
  activeLeaseId: string | null;
  acceptedObservationRefId?: string | null;
  executionVersion: bigint;
  activeLeases?: readonly ReviewInvocationLease[];
}): ReviewExecutionSnapshot {
  const workSlot = snapshot.execution.workSlots[0]!;
  return {
    ...snapshot,
    execution: {
      ...snapshot.execution,
      version: input.executionVersion,
      workSlots: [
        {
          ...workSlot,
          state: input.state,
          activeLeaseId: input.activeLeaseId,
          acceptedObservationRefId: input.acceptedObservationRefId ?? null,
        },
      ],
    },
    activeLeases: input.activeLeases ?? [],
  };
}

async function startRequest(
  overrides: Partial<ReviewExecutionStartRequest> = {},
): Promise<ReviewExecutionStartRequest> {
  const request: ReviewExecutionStartRequest = {
    ...envelope("start-1"),
    authorizationToken: "authorization-token",
    idempotencyKey: "idempotency-1",
    requestBodyHash: hash("0"),
    authorizationId: authorization.authorizationId,
    executionId: "execution-target",
    reviewRevisionHash: authorization.reviewRevisionHash,
    compatibilityKey: hash("1"),
    planHash: hash("9"),
    workSlotsCanonicalJson: "[]",
    sourceRunId: authorization.sourceRunId,
    sourceRunAttempt: authorization.sourceRunAttempt,
    ...overrides,
  };
  return withBodyHash(ReviewActionV2OperationId.ReviewExecutionStart, request);
}

async function attachRequest(
  capability: string,
  observation: ReviewObservation,
): Promise<ReviewExecutionObservationAttachRequest> {
  const request: ReviewExecutionObservationAttachRequest = {
    ...envelope("attach-1"),
    authorizationToken: "authorization-token",
    leaseCapability: capability,
    idempotencyKey: "idempotency-attach",
    requestBodyHash: hash("0"),
    executionId: "execution-target",
    workSlotId: "slot-1",
    observationId: observation.observationId,
    providerInvocationKey: observation.providerInvocationKey,
    providerVoteIdentityHash: observation.providerVoteIdentityHash,
    payloadHash: observation.payloadHash,
    byteCount: observation.byteCount,
    findingCount: observation.findingCount,
    eligibilityPolicyVersion: reviewReuseEligibilityPolicyVersion,
  };
  return withBodyHash(
    ReviewActionV2OperationId.ReviewExecutionObservationAttach,
    request,
  );
}

async function commitRequest(
  leaseCapability: string,
  observation: ReviewObservation,
  payloadCanonicalJson: string,
): Promise<ReviewEvidenceCommitRequest> {
  const request: ReviewEvidenceCommitRequest = {
    ...envelope("commit-1"),
    authorizationToken: "authorization-token",
    leaseCapability,
    idempotencyKey: "idempotency-commit",
    requestBodyHash: hash("0"),
    attemptId: observation.attemptId,
    sourceLeaseId: observation.sourceLeaseId,
    ownerIdHash: hash("d"),
    fencingToken: "7",
    completionStatus: ProviderResultCompletionStatus.Success,
    schemaValidated: true,
    fullyConsumed: true,
    actualModel: observation.actualModel,
    payloadCanonicalJson,
    payloadHash: observation.payloadHash,
    qualityFlags: observation.qualityFlags,
    transportAttemptCount: observation.transportAttemptCount,
  };
  return withBodyHash(ReviewActionV2OperationId.ReviewEvidenceCommit, request);
}

async function withBodyHash<O extends ReviewActionV2OperationId>(
  operation: O,
  request: Parameters<typeof canonicalizeReviewActionV2Request<O>>[1],
) {
  const requestBodyHash = await digest.digestUtf8(
    canonicalizeReviewActionV2Request(operation, request),
  );
  return { ...request, requestBodyHash };
}

async function finalizationFixture(publicationNotAfter: Date) {
  const projectionEnvelopeCanonicalJson = "{}";
  const projectionHash = await digest.digestUtf8(
    projectionEnvelopeCanonicalJson,
  );
  const artifactHash = hash("a");
  const lifecycleStateHash = hash("b");
  const artifact: FinalizedReviewProjectionArtifact = {
    artifactId: "artifact-race",
    executionId: snapshot.execution.executionId,
    generation: snapshot.execution.generation,
    reviewedHeadSha: snapshot.execution.revision.headSha,
    reviewRevisionHash: snapshot.execution.revision.reviewRevisionHash,
    coverageState: ReviewCoverageState.Completed,
    projectionEnvelopeVersion: 1,
    projectionEnvelopeJson: projectionEnvelopeCanonicalJson,
    projectionHash,
    byteCount: 2,
    findingCount: 0,
    lifecycleStateHash,
    commandLedgerWatermark: 0n,
    projectionPolicyVersion: "projection-policy-1",
    publicationPermit: {
      workspaceId: authorization.workspaceId,
      repositoryConnectionId: authorization.repositoryConnectionId,
      scmRepositoryIdentityId: authorization.scmRepositoryIdentityId,
      pullRequestNumber: authorization.pullRequestNumber,
      executionId: snapshot.execution.executionId,
      generation: snapshot.execution.generation,
      authorizationId: authorization.authorizationId,
      producerReleaseId: authorization.producerReleaseId,
      reviewedHeadSha: snapshot.execution.revision.headSha,
      reviewRevisionHash: snapshot.execution.revision.reviewRevisionHash,
      projectionHash,
      lifecycleStateHash,
      commandLedgerWatermark: 0n,
      permitEpoch: authorization.mutationEpoch,
      publicationSafetyDecisionHash: hash("c"),
      publicationNotAfter,
    },
    createdAt: now,
    retainUntil: new Date(now.getTime() + 3_600_000),
  };
  const finalize = vi.fn(async () => ({
    status: ReviewExecutionFinalizeStatus.Finalized,
    artifact,
    snapshot: { ...snapshot, artifact },
  }));
  const finalizationFacts = vi.fn(async () => ({
    expectedArtifactHash: artifactHash,
    byteCount: artifact.byteCount,
    findingCount: artifact.findingCount,
    projectionPolicyVersion: artifact.projectionPolicyVersion,
    publicationSafetyDecisionHash:
      artifact.publicationPermit.publicationSafetyDecisionHash,
    publicationNotAfter,
    retainUntil: artifact.retainUntil,
  }));
  const request = await withBodyHash(
    ReviewActionV2OperationId.ReviewExecutionFinalize,
    {
      ...envelope("finalize-revision-race"),
      authorizationToken: "authorization-token",
      idempotencyKey: "finalize-revision-race",
      requestBodyHash: hash("0"),
      executionId: snapshot.execution.executionId,
      expectedStreamVersion: snapshot.stream.version.toString(10),
      expectedExecutionVersion: snapshot.execution.version.toString(10),
      artifactId: artifact.artifactId,
      artifactHash,
      projectionEnvelopeVersion: artifact.projectionEnvelopeVersion,
      projectionEnvelopeCanonicalJson,
      projectionHash,
      lifecycleStateHash,
      commandLedgerWatermark: artifact.commandLedgerWatermark.toString(10),
      allowPartial: false,
    } satisfies ReviewExecutionFinalizeRequest,
  );
  return { artifact, finalize, finalizationFacts, request } as const;
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
  repositoryConnectionId: "connection-1",
  scmRepositoryIdentityId: "repository-1",
  pullRequestNumber: 42,
  sourceRunId: "run-1",
  sourceRunAttempt: "1",
  producerReleaseId: "release-1",
  selectedProtocolVersion: ReviewProtocolVersion.V2,
  protocolLimitsProfileId: "limits-1",
  operationalSloProfileId: "slo-1",
  mutationEpoch: 1n,
  providerVoteLanes: [
    {
      providerKind: "codex",
      providerVoteIdentityHash: hash("c"),
    },
  ],
  trustDomain: ReviewTrustDomain.TrustedManaged,
  state: ReviewRunAuthorizationState.Active,
  baseSha: gitSha("a"),
  mergeBaseSha: gitSha("b"),
  headSha: gitSha("c"),
  reviewRevisionHash: hash("b"),
  expiresAt: new Date(now.getTime() + 600_000),
} as unknown as ReviewRunAuthorization;

const protocolLimits = {
  protocolLimitsProfileId: "limits-1",
  maxWorkSlots: 8,
  maxAttemptsPerSlot: 4,
  maxObservationBytes: 100_000,
  maxObservationFindings: 100,
  maxProjectionBytes: 200_000,
  maxProjectionFindings: 200,
  maxPublicationOperations: 100,
  maxPublicationChunks: 10,
  maxPublicationBodyBytes: 10_000,
  maxRequestBatchSize: 10,
  maxLeaseDurationMs: 60_000,
  maxResultReportDurationMs: 120_000,
  maxReconciliationDurationMs: 120_000,
  limitsDigest: hash("d"),
  registeredAt: now,
};

const snapshot = {
  stream: {
    ...authorization,
    version: 2n,
    activeExecutionId: "execution-target",
    preparedExecutionId: null,
    lastAllocatedGeneration: 1n,
    currentRevision: null,
    updatedAt: now,
  },
  execution: {
    ...authorization,
    executionId: "execution-target",
    version: 3n,
    generation: 1n,
    revision: {
      baseSha: authorization.baseSha,
      mergeBaseSha: authorization.mergeBaseSha,
      headSha: authorization.headSha,
      reviewRevisionHash: authorization.reviewRevisionHash,
    },
    state: ReviewExecutionState.Running,
    planHash: hash("9"),
    protocolLimitsProfileId: "limits-1",
    workSlots: [
      {
        workSlotId: "slot-1",
        taskKind: ReviewTaskKind.FindingDiscovery,
        providerKind: ReviewExecutionProviderKind.Codex,
        providerVoteIdentityHash: hash("c"),
        shardKey: "shard-1",
        required: true,
        attemptBudget: 2,
        retryPolicyVersion: "retry-1",
        state: ReviewWorkSlotState.Pending,
        activeLeaseId: null,
        acceptedObservationRefId: null,
        nextAttemptOrdinal: 1,
      },
    ],
    executionDeadlineAt: new Date(now.getTime() + 300_000),
  },
  observationRefs: [],
  activeLeases: [],
  artifact: null,
} as unknown as ReviewExecutionSnapshot;

function lease(
  overrides: Partial<ReviewInvocationLease> = {},
): ReviewInvocationLease {
  return {
    ...snapshot.execution,
    providerInvocationKey: hash("7"),
    preparedManifestCanonicalJson: canonicalJson(manifest()),
    preparedManifestKey: hash("8"),
    providerVoteIdentityHash: hash("c"),
    workSlotId: "slot-1",
    leaseId: "lease-1",
    purpose: ReviewInvocationLeasePurpose.ProviderExecution,
    reviewRevisionHash: authorization.reviewRevisionHash,
    leaseSafetyDecisionHash: hash("6"),
    attemptId: "attempt-1",
    sourceObservationId: null,
    attemptOrdinal: 1,
    acquireRequestIdHash: hash("4"),
    acquireRequestHash: hash("5"),
    ownerIdHash: hash("d"),
    leaseCapabilityId: "lease-capability-1",
    capabilitySigningKeyId: "test-key",
    fencingToken: 7n,
    executionId: "execution-target",
    executionGeneration: 1n,
    state: ReviewInvocationLeaseState.Active,
    acquiredAt: now,
    renewedAt: now,
    expiresAt: new Date(now.getTime() + 60_000),
    resultReportUntil: new Date(now.getTime() + 120_000),
    retainUntil: new Date(now.getTime() + 3_600_000),
    ...overrides,
  } as ReviewInvocationLease;
}

function manifest(): ProviderInvocationManifest {
  return {
    manifestVersion: 1,
    scopeHash: sha(
      canonicalJson({
        workspaceId: authorization.workspaceId,
        repositoryConnectionId: authorization.repositoryConnectionId,
        scmRepositoryIdentityId: authorization.scmRepositoryIdentityId,
        pullRequestNumber: authorization.pullRequestNumber,
      }),
    ),
    taskKindSet: [EvidenceTaskKind.FindingDiscovery],
    providerKind: ReviewProviderKind.Codex,
    providerCapabilityHash: hash("d"),
    requestedModel: "gpt-5-codex",
    providerPolicyVersion: "policy-1",
    producerReleaseId: authorization.producerReleaseId,
    selectedProtocolVersion: authorization.selectedProtocolVersion,
    providerRequestEnvelopeHash: hash("e"),
    outputSchemaHash: hash("f"),
    reviewConfigHash: hash("1"),
    runtimeCompatibilityKey: hash("2"),
    filePatchManifestHash: hash("3"),
    contextManifestHash: hash("4"),
    memoryBundleHash: null,
    codeGraphProjectionHash: null,
    lifecycleTargetSetHash: null,
    liveLifecycleStateHash: null,
    toolPolicyHash: hash("5"),
    executionProfile: ProviderExecutionProfile.PromptOnlyEnvelopeV1,
    baseTreeHash: hash("6"),
    environmentContractHash: hash("7"),
  };
}

function stableManifestJson() {
  return stableJsonForTest(manifest());
}

function reusableObservation(
  overrides: Partial<ReviewObservation> = {},
): ReviewObservation {
  return {
    observationId: "observation-1",
    scope: {
      workspaceId: authorization.workspaceId,
      repositoryConnectionId: authorization.repositoryConnectionId,
      scmRepositoryIdentityId: authorization.scmRepositoryIdentityId,
      pullRequestNumber: authorization.pullRequestNumber,
      authorizationScopeHash: manifest().scopeHash,
    },
    manifestKey: hash("a"),
    providerInvocationKey: hash("7"),
    providerVoteIdentityHash: hash("c"),
    sourceExecutionId: "execution-source",
    sourceLeaseId: "lease-1",
    sourceFencingToken: "7",
    payloadHash: hash("e"),
    byteCount: 100,
    findingCount: 0,
    actualModel: "gpt-5-codex",
    qualityFlags: [],
    transportAttemptCount: 1,
    reuseExpiresAtMs: now.getTime() + 600_000,
    payload: {
      payloadVersion: reviewEvidencePayloadVersion,
      normalizedFindings: [],
      safeUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    },
    ...overrides,
  } as ReviewObservation;
}

function reuseHit(observation: ReviewObservation) {
  return {
    status: LookupReviewEvidenceStatus.Hit,
    selected: {
      observation,
      eligibility: ReuseEligibility.ExactRevision,
      tier: ReviewReuseTier.T0ExactRevision,
      reason: "none",
      canAttach: true,
      reuseSafetyDecisionHash: hash("8"),
    },
    considered: 1,
    denialReasons: [],
  };
}

function stableJsonForTest(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(stableJsonForTest).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJsonForTest(item)}`)
    .join(",")}}`;
}

function sha(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function hash(character: string): string {
  return character.repeat(64).slice(0, 64);
}
function gitSha(character: string): string {
  return character.repeat(40);
}
