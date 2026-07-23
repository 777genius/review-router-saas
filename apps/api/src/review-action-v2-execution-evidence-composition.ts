import {
  AcceptReviewObservationStatus,
  LookupReviewEvidenceStatus,
  ProviderResultCompletionStatus,
  ReviewProviderKind as EvidenceProviderKind,
  ReviewObservationQualityFlag,
  ReviewTaskKind as EvidenceTaskKind,
  ReviewTrustDomain as EvidenceTrustDomain,
  ReuseEligibility,
  ReviewReuseTier,
  buildProviderInvocationIdentity,
  normalizeProviderInvocationManifest,
  prepareReviewObservationPayload,
  reviewReuseEligibilityPolicyVersion,
  serializeProviderInvocationManifestCanonicalWireJson,
  stableJson,
  type ProviderInvocationManifest,
  type ReviewObservation,
  type ReviewObservationPayload,
  type ReviewObservationQueryPort,
} from "@reviewrouter/features-review-evidence";
import type { ReturnTypeOfReviewEvidenceComposition } from "./review-action-v2-execution-evidence-types.js";
import {
  ReviewExecutionFinalizeStatus,
  ReviewExecutionLifecycleTransitionStatus,
  ReviewExecutionProviderKind,
  ReviewInvocationLeaseAcquireStatus,
  ReviewInvocationLeasePurpose,
  ReviewInvocationLeaseState,
  ReviewInvocationLeaseTransitionStatus,
  ReviewObservationAttachmentKind,
  ReviewObservationAttachmentStatus,
  ReviewTaskKind,
  StartReviewExecutionStatus,
  type ReviewExecution,
  type ReviewExecutionLimits,
  type ReviewExecutionObservationRef,
  type ReviewExecutionQueryPort,
  type ReviewExecutionScope,
  type ReviewExecutionSnapshot,
  type ReviewInvocationLease,
  type ReviewWorkSlotPlan,
} from "@reviewrouter/features-review-executions";
import type { ReviewExecutionsComposition } from "@reviewrouter/features-review-executions/composition";
import {
  ReviewActionV2RouteFailure,
  type RegisterReviewEvidenceV2RoutesDependencies,
  type RegisterReviewExecutionV2RoutesDependencies,
} from "@reviewrouter/features-action-control-plane/v2";
import {
  ReviewRunAuthorizationState,
  ReviewRunAuthorizationTokenResolutionStatus,
  ReviewTrustDomain,
  canonicalJson,
  type ReviewProtocolLimitsProfileQueryPort,
  type ReviewRunAuthorization,
  type ReviewRunAuthorizationTokenResolution,
} from "@reviewrouter/features-review-run-control";
import {
  canonicalizeReviewActionV2Request,
  ReviewActionV2OperationId,
  ReviewActionV2ProtocolErrorCode,
  ReviewEvidenceCommitResultStatus,
  ReviewEvidenceLookupResultStatus,
  ReviewExecutionMutationResultStatus,
  ReviewExecutionRestoreResultStatus,
  ReviewExecutionStartResultStatus,
  ReviewInvocationLeaseResultStatus,
  type ReviewActionV2RequestMap,
  type ReviewEvidenceCommitRequest,
  type ReviewEvidenceLookupRequest,
  type ReviewExecutionFinalizeRequest,
  type ReviewExecutionObservationAdoptRequest,
  type ReviewExecutionObservationAttachRequest,
  type ReviewExecutionRestoreRequest,
  type ReviewExecutionStartRequest,
  type ReviewExecutionSupersedeRequest,
  type ReviewInvocationLeaseAcquireRequest,
  type ReviewInvocationLeaseReleaseRequest,
  type ReviewInvocationLeaseRenewRequest,
} from "@reviewrouter/protocol-review-action-v2";
import type {
  ReviewActionV2ExecutionEvidenceCapabilityAdapter,
  ReviewActionV2ReusableAttachmentAuthority,
  VerifiedReviewActionV2LeaseCapability,
} from "./review-action-v2-execution-evidence-capabilities.js";

export interface ReviewActionV2AuthorizationResolverPort {
  resolveReviewRunAuthorizationToken(input: {
    readonly token: string;
  }): Promise<ReviewRunAuthorizationTokenResolution>;
}

export interface ReviewActionV2DigestPort {
  digestUtf8(value: string): Promise<string>;
  digest(value: Uint8Array): Promise<string>;
}

export type ReviewActionV2ExecutionTimingPolicy = Readonly<{
  admissionDurationMs: number;
  executionDurationMs: number;
  initialLeaseDurationMs: number;
  retentionDurationMs: number;
  attachmentCapabilityDurationMs: number;
}>;

export interface ReviewActionV2LeaseSafetyPort {
  resolve(input: {
    readonly authorization: ReviewRunAuthorization;
    readonly execution: ReviewExecution;
    readonly workSlotId: string;
    readonly purpose: ReviewInvocationLeasePurpose;
  }): Promise<{ readonly allowed: boolean; readonly decisionHash: string }>;
}

export interface ReviewActionV2FinalizationFactsPort {
  resolve(input: {
    readonly authorization: ReviewRunAuthorization;
    readonly execution: ReviewExecution;
    readonly artifactId: string;
    readonly projectionEnvelopeVersion: number;
    readonly projectionEnvelope: unknown;
    readonly projectionCanonicalJson: string;
    readonly projectionHash: string;
    readonly lifecycleStateHash: string;
    readonly commandLedgerWatermark: bigint;
    readonly allowPartial: boolean;
    readonly limits: ReviewExecutionLimits;
    readonly maxReconciliationDurationMs: number;
    readonly now: Date;
  }): Promise<
    Readonly<{
      expectedArtifactHash: string;
      byteCount: number;
      findingCount: number;
      projectionPolicyVersion: string;
      publicationSafetyDecisionHash: string;
      publicationNotAfter: Date;
      retainUntil: Date;
    }>
  >;
}

type CommonDependencies = Readonly<{
  authorizations: ReviewActionV2AuthorizationResolverPort;
  executionQueries: ReviewExecutionQueryPort;
  protocolLimits: ReviewProtocolLimitsProfileQueryPort;
  digest: ReviewActionV2DigestPort;
  capabilities: ReviewActionV2ExecutionEvidenceCapabilityAdapter;
  now: () => Date;
  nextId: (kind: "lease" | "attempt" | "observation_ref") => string;
  timing: ReviewActionV2ExecutionTimingPolicy;
}>;

export type ReviewActionV2ExecutionHandlerDependencies = CommonDependencies &
  Readonly<{
    executions: ReviewExecutionsComposition;
    evidence: ReturnTypeOfReviewEvidenceComposition;
    observations: ReviewObservationQueryPort;
    leaseSafety: ReviewActionV2LeaseSafetyPort;
    finalizationFacts: ReviewActionV2FinalizationFactsPort;
  }>;

export type ReviewActionV2EvidenceHandlerDependencies = CommonDependencies &
  Readonly<{
    evidence: ReturnTypeOfReviewEvidenceComposition;
    observations: ReviewObservationQueryPort;
  }>;

export function composeReviewActionV2ExecutionRoutes(input: {
  readonly enabled: boolean;
  readonly runtime: Pick<
    RegisterReviewExecutionV2RoutesDependencies,
    "readServerTime" | "createRequestId"
  >;
  readonly handlers?: ReviewActionV2ExecutionHandlerDependencies;
}): RegisterReviewExecutionV2RoutesDependencies {
  if (!input.enabled) return input.runtime;
  if (!input.handlers)
    throw new Error("review_action_v2_execution_dependencies_unavailable");
  return {
    ...input.runtime,
    ...createReviewActionV2ExecutionHandlers(input.handlers),
  };
}

export function composeReviewActionV2EvidenceRoutes(input: {
  readonly enabled: boolean;
  readonly runtime: Pick<
    RegisterReviewEvidenceV2RoutesDependencies,
    "readServerTime" | "createRequestId"
  >;
  readonly handlers?: ReviewActionV2EvidenceHandlerDependencies;
}): RegisterReviewEvidenceV2RoutesDependencies {
  if (!input.enabled) return input.runtime;
  if (!input.handlers)
    throw new Error("review_action_v2_evidence_dependencies_unavailable");
  return {
    ...input.runtime,
    ...createReviewActionV2EvidenceHandlers(input.handlers),
  };
}

export function createReviewActionV2ExecutionHandlers(
  d: ReviewActionV2ExecutionHandlerDependencies,
) {
  validateTiming(d.timing);
  return {
    restore: enabled((request: ReviewExecutionRestoreRequest) =>
      restoreExecution(request, d),
    ),
    start: enabled((request: ReviewExecutionStartRequest) =>
      startExecution(request, d),
    ),
    supersede: enabled((request: ReviewExecutionSupersedeRequest) =>
      supersedeExecution(request, d),
    ),
    attachObservation: enabled(
      (request: ReviewExecutionObservationAttachRequest) =>
        attachObservation(request, d),
    ),
    adoptObservation: enabled(
      (request: ReviewExecutionObservationAdoptRequest) =>
        adoptObservation(request, d),
    ),
    finalize: enabled((request: ReviewExecutionFinalizeRequest) =>
      finalizeExecution(request, d),
    ),
    acquireLease: enabled((request: ReviewInvocationLeaseAcquireRequest) =>
      acquireLease(request, d),
    ),
    renewLease: enabled((request: ReviewInvocationLeaseRenewRequest) =>
      renewLease(request, d),
    ),
    releaseLease: enabled((request: ReviewInvocationLeaseReleaseRequest) =>
      releaseLease(request, d),
    ),
  } satisfies Partial<RegisterReviewExecutionV2RoutesDependencies>;
}

export function createReviewActionV2EvidenceHandlers(
  d: ReviewActionV2EvidenceHandlerDependencies,
) {
  validateTiming(d.timing);
  return {
    lookup: enabled((request: ReviewEvidenceLookupRequest) =>
      lookupEvidence(request, d),
    ),
    commit: enabled((request: ReviewEvidenceCommitRequest) =>
      commitEvidence(request, d),
    ),
  } satisfies Partial<RegisterReviewEvidenceV2RoutesDependencies>;
}

function enabled<Request, Result>(
  execute: (request: Request) => Promise<Result>,
) {
  return { capabilityEnabled: true as const, execute };
}

async function restoreExecution(
  request: ReviewExecutionRestoreRequest,
  d: ReviewActionV2ExecutionHandlerDependencies,
) {
  const authorization = await requireAuthorization(
    request.authorizationToken,
    d,
  );
  requireEqual(
    request.authorizationId,
    authorization.authorizationId,
    "authorization_scope_mismatch",
  );
  requireEqual(
    request.reviewRevisionHash,
    authorization.reviewRevisionHash,
    "revision_scope_mismatch",
  );
  const stream = await d.executionQueries.findStream(
    toExecutionScope(authorization),
  );
  const ids = [stream?.activeExecutionId, stream?.preparedExecutionId].filter(
    (id): id is string => id !== null && id !== undefined,
  );
  for (const id of ids) {
    const snapshot = await d.executionQueries.findExecution(id);
    if (
      snapshot &&
      sameExecutionAuthority(snapshot.execution, authorization) &&
      snapshot.execution.revision.reviewRevisionHash ===
        request.reviewRevisionHash
    ) {
      return { statusCode: 200 as const, result: restoreResult(snapshot) };
    }
  }
  return {
    statusCode: 200 as const,
    result: { status: ReviewExecutionRestoreResultStatus.Missing },
  };
}

async function startExecution(
  request: ReviewExecutionStartRequest,
  d: ReviewActionV2ExecutionHandlerDependencies,
) {
  await assertBodyHash(
    ReviewActionV2OperationId.ReviewExecutionStart,
    request,
    d.digest,
  );
  const authorization = await requireAuthorization(
    request.authorizationToken,
    d,
  );
  requireEqual(
    request.authorizationId,
    authorization.authorizationId,
    "authorization_scope_mismatch",
  );
  requireEqual(
    request.reviewRevisionHash,
    authorization.reviewRevisionHash,
    "revision_scope_mismatch",
  );
  requireEqual(
    request.sourceRunId,
    authorization.sourceRunId,
    "source_run_mismatch",
  );
  requireEqual(
    request.sourceRunAttempt,
    authorization.sourceRunAttempt,
    "source_run_attempt_mismatch",
  );
  await executionLimits(authorization, d);
  const workSlots = parseWorkSlots(request.workSlotsCanonicalJson);
  const now = d.now();
  const outcome = await d.executions.startReviewExecution.execute({
    scope: toExecutionScope(authorization),
    executionId: request.executionId,
    authorizationId: authorization.authorizationId,
    compatibilityKey: request.compatibilityKey,
    planHash: request.planHash,
    workSlots,
    sourceRunId: request.sourceRunId,
    sourceRunAttempt: request.sourceRunAttempt,
    admissionDeadlineAt: add(now, d.timing.admissionDurationMs),
    executionDeadlineAt: add(now, d.timing.executionDurationMs),
    retainUntil: add(now, d.timing.retentionDurationMs),
  });
  return {
    statusCode:
      outcome.status === StartReviewExecutionStatus.Admitted
        ? (201 as const)
        : (200 as const),
    result: {
      status: mapStart(outcome.status),
      ...(outcome.snapshot ? executionResult(outcome.snapshot) : {}),
    },
  };
}

async function supersedeExecution(
  request: ReviewExecutionSupersedeRequest,
  d: ReviewActionV2ExecutionHandlerDependencies,
) {
  await assertBodyHash(
    ReviewActionV2OperationId.ReviewExecutionSupersede,
    request,
    d.digest,
  );
  const authorization = await requireAuthorization(
    request.authorizationToken,
    d,
  );
  requireEqual(
    request.targetRevisionHash,
    authorization.reviewRevisionHash,
    "target_revision_mismatch",
  );
  const snapshot = await requireExecution(
    request.executionId,
    authorization,
    d.executionQueries,
  );
  const result = await d.executions.executionLifecycle.supersede({
    scope: toExecutionScope(authorization),
    executionId: request.executionId,
    expectedStreamVersion: decimal(request.expectedStreamVersion),
    observedCurrentRevision: toExecutionRevision(authorization),
    now: d.now(),
  });
  return {
    statusCode: 200 as const,
    result: mutationResult(
      result.status,
      request.executionId,
      result.snapshot ?? snapshot,
    ),
  };
}

async function acquireLease(
  request: ReviewInvocationLeaseAcquireRequest,
  d: ReviewActionV2ExecutionHandlerDependencies,
) {
  await assertBodyHash(
    ReviewActionV2OperationId.ReviewInvocationLeaseAcquire,
    request,
    d.digest,
  );
  const authorization = await requireAuthorization(
    request.authorizationToken,
    d,
  );
  const snapshot = await requireExecution(
    request.executionId,
    authorization,
    d.executionQueries,
  );
  const purpose = enumValue(
    ReviewInvocationLeasePurpose,
    request.purpose,
    "lease_purpose_invalid",
  );
  if (purpose !== ReviewInvocationLeasePurpose.ProviderExecution)
    throw failure(
      422,
      ReviewActionV2ProtocolErrorCode.InvariantViolation,
      "adoption_requires_dedicated_flow",
    );
  const slot = snapshot.execution.workSlots.find(
    (item) => item.workSlotId === request.workSlotId,
  );
  if (!slot)
    throw failure(
      404,
      ReviewActionV2ProtocolErrorCode.NotFound,
      "work_slot_missing",
    );
  const { scopeHash } = await validatePreparedManifest(
    request,
    authorization,
    slot,
    d,
  );
  const safety = await d.leaseSafety.resolve({
    authorization,
    execution: snapshot.execution,
    workSlotId: request.workSlotId,
    purpose,
  });
  if (!safety.allowed)
    throw failure(
      403,
      ReviewActionV2ProtocolErrorCode.Forbidden,
      "lease_safety_rejected",
    );
  const limits = await executionLimits(authorization, d);
  const now = d.now();
  const identity = await d.capabilities.prepareIdentity();
  const result = await d.executions.invocationLeases.acquire({
    scope: toExecutionScope(authorization),
    executionId: request.executionId,
    workSlotId: request.workSlotId,
    purpose,
    providerInvocationKey: request.providerInvocationKey,
    preparedManifestCanonicalJson: request.manifestCanonicalJson,
    preparedManifestKey: request.manifestKey,
    providerVoteIdentityHash: request.providerVoteIdentityHash,
    leaseId: d.nextId("lease"),
    attemptId: d.nextId("attempt"),
    sourceObservationId: null,
    acquireRequestIdHash: await d.digest.digestUtf8(request.acquireRequestId),
    acquireRequestHash: await d.digest.digestUtf8(
      canonicalizeReviewActionV2Request(
        ReviewActionV2OperationId.ReviewInvocationLeaseAcquire,
        request,
      ),
    ),
    ownerIdHash: request.ownerIdHash,
    leaseCapabilityId: identity.capabilityId,
    capabilitySigningKeyId: identity.signingKeyId,
    leaseSafetyDecisionHash: safety.decisionHash,
    now,
    expiresAt: minDate(
      add(
        now,
        Math.min(limits.maxLeaseDurationMs, d.timing.initialLeaseDurationMs),
      ),
      snapshot.execution.executionDeadlineAt,
    ),
    resultReportUntil: minDate(
      add(now, limits.maxResultReportDurationMs),
      authorization.expiresAt,
    ),
    retainUntil: add(now, d.timing.retentionDurationMs),
    limits,
  });
  if (!result.lease)
    return {
      statusCode: 200 as const,
      result: { status: mapLeaseAcquire(result.status) },
    };
  const leaseCapability = await d.capabilities.issueLease(
    result.lease,
    scopeHash,
  );
  return {
    statusCode:
      result.status === ReviewInvocationLeaseAcquireStatus.Acquired
        ? (201 as const)
        : (200 as const),
    result: {
      status: mapLeaseAcquire(result.status),
      leaseId: result.lease.leaseId,
      attemptId: result.lease.attemptId,
      leaseCapability,
      fencingToken: result.lease.fencingToken.toString(10),
      expiresAt: result.lease.expiresAt.toISOString(),
      resultReportUntil: result.lease.resultReportUntil.toISOString(),
    },
  };
}

async function renewLease(
  request: ReviewInvocationLeaseRenewRequest,
  d: ReviewActionV2ExecutionHandlerDependencies,
) {
  await assertBodyHash(
    ReviewActionV2OperationId.ReviewInvocationLeaseRenew,
    request,
    d.digest,
  );
  const now = d.now();
  const authority = await verifyLease(request.leaseCapability, now, d);
  requireLeaseRequest(authority, request.leaseId, request.ownerIdHash);
  requireLeaseOwnership(authority, now);
  const lease = await requireLease(authority, d.executionQueries, false, now);
  const snapshot = await d.executionQueries.findExecution(lease.executionId);
  if (!snapshot)
    throw failure(
      404,
      ReviewActionV2ProtocolErrorCode.NotFound,
      "execution_missing",
    );
  if (snapshot.execution.authorizationId !== authority.authorizationId)
    throw failure(
      403,
      ReviewActionV2ProtocolErrorCode.Forbidden,
      "lease_authorization_mismatch",
    );
  const limits = await executionLimitsForProfile(
    snapshot.execution.protocolLimitsProfileId,
    d,
  );
  const result = await d.executions.invocationLeases.renew({
    leaseId: lease.leaseId,
    ownerIdHash: request.ownerIdHash,
    leaseCapabilityId: authority.capabilityId,
    fencingToken: decimal(request.fencingToken),
    now,
    expiresAt: minDate(
      add(lease.acquiredAt, limits.maxLeaseDurationMs),
      snapshot.execution.executionDeadlineAt,
    ),
    resultReportUntil: lease.resultReportUntil,
    limits,
  });
  const leaseCapability = result.lease
    ? await d.capabilities.issueLease(
        result.lease,
        authority.scopeHash,
        result.lease.renewedAt,
      )
    : null;
  return {
    statusCode: 200 as const,
    result: {
      ...leaseTransitionResult(result.status, result.lease),
      leaseCapability,
    },
  };
}

async function releaseLease(
  request: ReviewInvocationLeaseReleaseRequest,
  d: ReviewActionV2ExecutionHandlerDependencies,
) {
  await assertBodyHash(
    ReviewActionV2OperationId.ReviewInvocationLeaseRelease,
    request,
    d.digest,
  );
  const now = d.now();
  const authority = await verifyLease(request.leaseCapability, now, d);
  requireLeaseRequest(authority, request.leaseId, request.ownerIdHash);
  requireLeaseOwnership(authority, now);
  await requireLease(authority, d.executionQueries, false, now);
  const result = await d.executions.invocationLeases.release({
    leaseId: request.leaseId,
    ownerIdHash: request.ownerIdHash,
    leaseCapabilityId: authority.capabilityId,
    fencingToken: decimal(request.fencingToken),
    now,
  });
  return {
    statusCode: 200 as const,
    result: leaseTransitionResult(result.status, result.lease),
  };
}

async function attachObservation(
  request: ReviewExecutionObservationAttachRequest,
  d: ReviewActionV2ExecutionHandlerDependencies,
) {
  await assertBodyHash(
    ReviewActionV2OperationId.ReviewExecutionObservationAttach,
    request,
    d.digest,
  );
  const authorization = await requireAuthorization(
    request.authorizationToken,
    d,
  );
  const snapshot = await requireExecution(
    request.executionId,
    authorization,
    d.executionQueries,
  );
  const now = d.now();
  try {
    const reusable = await d.capabilities.verifyReusableAttachment(
      request.leaseCapability,
      now,
    );
    requireEqual(
      reusable.authorizationId,
      authorization.authorizationId,
      "attachment_authorization_mismatch",
    );
    requireEqual(
      reusable.scopeHash,
      await authorizationScopeHash(authorization, d.digest),
      "attachment_scope_mismatch",
    );
    requireEqual(
      reusable.mutationEpoch,
      authorization.mutationEpoch,
      "attachment_mutation_epoch_mismatch",
    );
    requireEqual(
      reusable.targetExecutionId,
      request.executionId,
      "attachment_execution_mismatch",
    );
    requireEqual(
      reusable.targetWorkSlotId,
      request.workSlotId,
      "attachment_slot_mismatch",
    );
    requireEqual(
      reusable.targetReviewRevisionHash,
      snapshot.execution.revision.reviewRevisionHash,
      "attachment_revision_mismatch",
    );
    requireEqual(
      reusable.targetPlanHash,
      snapshot.execution.planHash,
      "attachment_plan_mismatch",
    );
    assertAttachmentRequest(request, reusable);
    const revalidated = await d.evidence.lookupReviewEvidence.execute({
      scope: toEvidenceScope(
        authorization,
        await authorizationScopeHash(authorization, d.digest),
      ),
      revision: toEvidenceRevision(authorization),
      planHash: reusable.targetPlanHash,
      executionId: reusable.targetExecutionId,
      manifest: reusable.manifest,
      manifestKey: reusable.manifestKey,
      providerInvocationKey: reusable.providerInvocationKey,
      providerVoteIdentityHash: reusable.providerVoteIdentityHash,
      trustDomain: reusable.trustDomain,
    });
    if (
      revalidated.status !== LookupReviewEvidenceStatus.Hit ||
      !revalidated.selected?.canAttach ||
      revalidated.selected.observation.observationId !==
        reusable.observationId ||
      revalidated.selected.reuseSafetyDecisionHash !==
        reusable.reuseSafetyDecisionHash ||
      reuseAttachmentKind(
        revalidated.selected.eligibility,
        revalidated.selected.tier,
      ) !== reusable.attachmentKind ||
      revalidated.selected.observation.sourceExecutionId === request.executionId
    ) {
      throw failure(
        412,
        ReviewActionV2ProtocolErrorCode.StalePrecondition,
        "attachment_policy_stale",
      );
    }
    const result = await d.executions.observationAttachments.attachReusable({
      scope: toExecutionScope(authorization),
      executionId: request.executionId,
      workSlotId: request.workSlotId,
      sourceExecutionId: reusable.sourceExecutionId,
      observationRefId: await observationRefId(request, d),
      observationId: request.observationId,
      providerInvocationKey: request.providerInvocationKey,
      providerVoteIdentityHash: request.providerVoteIdentityHash,
      payloadHash: request.payloadHash,
      byteCount: request.byteCount,
      findingCount: request.findingCount,
      attachmentKind: reusable.attachmentKind,
      eligibilityPolicyVersion: request.eligibilityPolicyVersion,
      reuseSafetyDecisionHash: reusable.reuseSafetyDecisionHash,
      now,
    });
    return {
      statusCode: 200 as const,
      result: attachmentResult(
        result.status,
        request,
        result.snapshot ?? snapshot,
      ),
    };
  } catch (error) {
    if (error instanceof ReviewActionV2RouteFailure) throw error;
  }
  const leaseAuthority = await verifyLease(request.leaseCapability, now, d);
  await assertLeaseAuthorization(leaseAuthority, authorization, d);
  requireLeaseOwnership(leaseAuthority, now);
  const lease = await requireLease(
    leaseAuthority,
    d.executionQueries,
    true,
    now,
  );
  requireEqual(
    lease.executionId,
    request.executionId,
    "lease_execution_mismatch",
  );
  requireEqual(lease.workSlotId, request.workSlotId, "lease_slot_mismatch");
  const observation = await d.observations.findById(request.observationId);
  if (!observation)
    throw failure(
      404,
      ReviewActionV2ProtocolErrorCode.NotFound,
      "observation_missing",
    );
  if (
    observation.sourceExecutionId !== request.executionId ||
    observation.sourceLeaseId !== lease.leaseId ||
    observation.attemptId !== lease.attemptId ||
    observation.providerInvocationKey !== request.providerInvocationKey ||
    observation.providerVoteIdentityHash !== request.providerVoteIdentityHash ||
    observation.payloadHash !== request.payloadHash ||
    observation.byteCount !== request.byteCount ||
    observation.findingCount !== request.findingCount ||
    request.eligibilityPolicyVersion !== reviewReuseEligibilityPolicyVersion
  ) {
    throw failure(
      403,
      ReviewActionV2ProtocolErrorCode.Forbidden,
      "fresh_observation_authority_mismatch",
    );
  }
  const result = await d.executions.observationAttachments.attachFresh({
    scope: toExecutionScope(authorization),
    executionId: request.executionId,
    workSlotId: request.workSlotId,
    observationRefId: await observationRefId(request, d),
    observationId: request.observationId,
    providerInvocationKey: request.providerInvocationKey,
    providerVoteIdentityHash: request.providerVoteIdentityHash,
    payloadHash: request.payloadHash,
    byteCount: request.byteCount,
    findingCount: request.findingCount,
    eligibilityPolicyVersion: request.eligibilityPolicyVersion,
    leaseId: lease.leaseId,
    ownerIdHash: lease.ownerIdHash,
    leaseCapabilityId: lease.leaseCapabilityId,
    fencingToken: lease.fencingToken,
    now,
  });
  return {
    statusCode: 200 as const,
    result: attachmentResult(
      result.status,
      request,
      result.snapshot ?? snapshot,
    ),
  };
}

async function adoptObservation(
  request: ReviewExecutionObservationAdoptRequest,
  d: ReviewActionV2ExecutionHandlerDependencies,
) {
  await assertBodyHash(
    ReviewActionV2OperationId.ReviewExecutionObservationAdopt,
    request,
    d.digest,
  );
  const authorization = await requireAuthorization(
    request.authorizationToken,
    d,
  );
  let snapshot = await requireExecution(
    request.executionId,
    authorization,
    d.executionQueries,
  );
  requireEqual(
    snapshot.execution.generation,
    decimal(request.executionGeneration),
    "adoption_generation_mismatch",
  );
  requireEqual(
    snapshot.execution.planHash,
    request.planHash,
    "adoption_plan_mismatch",
  );
  requireEqual(
    snapshot.execution.revision.reviewRevisionHash,
    request.reviewRevisionHash,
    "adoption_revision_mismatch",
  );
  requireEqual(
    authorization.reviewRevisionHash,
    request.reviewRevisionHash,
    "adoption_authorization_revision_mismatch",
  );
  const slot = snapshot.execution.workSlots.find(
    (candidate) => candidate.workSlotId === request.workSlotId,
  );
  if (!slot) {
    throw failure(
      404,
      ReviewActionV2ProtocolErrorCode.NotFound,
      "work_slot_missing",
    );
  }
  await validatePreparedManifest(request, authorization, slot, d);

  const sourceLease = await d.executionQueries.findLease(request.sourceLeaseId);
  if (!sourceLease) {
    throw failure(
      404,
      ReviewActionV2ProtocolErrorCode.NotFound,
      "adoption_source_lease_missing",
    );
  }
  assertAdoptionSourceLease(request, sourceLease, authorization, snapshot);
  const observation = await d.observations.findById(request.observationId);
  if (!observation) {
    throw failure(
      404,
      ReviewActionV2ProtocolErrorCode.NotFound,
      "adoption_observation_missing",
    );
  }
  await assertAdoptionObservation(
    request,
    observation,
    sourceLease,
    authorization,
    d.digest,
  );

  const adoptionIdentityHash = await d.digest.digestUtf8(
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
  const adoptionRequestIdHash = await d.digest.digestUtf8(
    request.idempotencyKey,
  );
  const adoptionLeaseId = `adoption-${adoptionIdentityHash}`;
  const observationRef = await observationRefId(request, d);
  const existingRef = snapshot.observationRefs.find(
    (candidate) => candidate.workSlotId === request.workSlotId,
  );
  if (existingRef) {
    const adoptionLease = await d.executionQueries.findLease(adoptionLeaseId);
    assertAdoptionReplay(
      request,
      existingRef,
      adoptionLease,
      observationRef,
      adoptionIdentityHash,
      adoptionRequestIdHash,
    );
    return {
      statusCode: 200 as const,
      result: adoptionResult(
        ReviewExecutionMutationResultStatus.Restored,
        request,
        snapshot,
        observation,
      ),
    };
  }

  const now = d.now();
  if (now.getTime() > sourceLease.resultReportUntil.getTime()) {
    throw failure(
      412,
      ReviewActionV2ProtocolErrorCode.StalePrecondition,
      "adoption_result_report_expired",
    );
  }
  requireEqual(
    snapshot.stream.version,
    decimal(request.expectedStreamVersion),
    "adoption_stream_version_mismatch",
  );
  if (
    snapshot.execution.version !== decimal(request.expectedExecutionVersion)
  ) {
    throw failure(
      412,
      ReviewActionV2ProtocolErrorCode.StalePrecondition,
      "adoption_execution_version_mismatch",
    );
  }
  const safety = await d.leaseSafety.resolve({
    authorization,
    execution: snapshot.execution,
    workSlotId: request.workSlotId,
    purpose: ReviewInvocationLeasePurpose.ObservationAdoption,
  });
  if (!safety.allowed) {
    throw failure(
      403,
      ReviewActionV2ProtocolErrorCode.Forbidden,
      "adoption_safety_rejected",
    );
  }
  if (sourceLease.state === ReviewInvocationLeaseState.Active) {
    const released = await d.executions.invocationLeases.release({
      leaseId: sourceLease.leaseId,
      ownerIdHash: sourceLease.ownerIdHash,
      leaseCapabilityId: sourceLease.leaseCapabilityId,
      fencingToken: sourceLease.fencingToken,
      now,
    });
    if (
      released.status !== ReviewInvocationLeaseTransitionStatus.Applied &&
      released.status !== ReviewInvocationLeaseTransitionStatus.Expired
    ) {
      throw failure(
        412,
        ReviewActionV2ProtocolErrorCode.StalePrecondition,
        "adoption_source_lease_release_conflict",
      );
    }
    snapshot = await requireExecution(
      request.executionId,
      authorization,
      d.executionQueries,
    );
  }

  const adoptionCapabilityIdentity = await d.capabilities.prepareIdentity();
  const outcome = await d.executions.observationAttachments.adoptAccepted({
    scope: toExecutionScope(authorization),
    executionId: request.executionId,
    workSlotId: request.workSlotId,
    sourceLeaseId: request.sourceLeaseId,
    sourceFencingToken: decimal(request.sourceFencingToken),
    sourceObservationId: request.observationId,
    observationRefId: observationRef,
    providerInvocationKey: request.providerInvocationKey,
    providerVoteIdentityHash: request.providerVoteIdentityHash,
    payloadHash: request.payloadHash,
    byteCount: request.byteCount,
    findingCount: request.findingCount,
    eligibilityPolicyVersion: request.eligibilityPolicyVersion,
    adoptionLeaseId,
    adoptionAcquireRequestIdHash: adoptionRequestIdHash,
    adoptionAcquireRequestHash: request.requestBodyHash,
    ownerIdHash: request.ownerIdHash,
    leaseCapabilityId: adoptionCapabilityIdentity.capabilityId,
    capabilitySigningKeyId: adoptionCapabilityIdentity.signingKeyId,
    leaseSafetyDecisionHash: safety.decisionHash,
    now,
    retainUntil: new Date(snapshot.execution.retainUntil),
  });
  const resultSnapshot = outcome.snapshot ?? snapshot;
  const status = mapAttachmentStatus(outcome.status);
  return {
    statusCode:
      outcome.status === ReviewObservationAttachmentStatus.Attached
        ? (201 as const)
        : (200 as const),
    result: adoptionResult(
      status,
      request,
      resultSnapshot,
      status === ReviewExecutionMutationResultStatus.Applied ||
        status === ReviewExecutionMutationResultStatus.Restored
        ? observation
        : null,
    ),
  };
}

async function finalizeExecution(
  request: ReviewExecutionFinalizeRequest,
  d: ReviewActionV2ExecutionHandlerDependencies,
) {
  await assertBodyHash(
    ReviewActionV2OperationId.ReviewExecutionFinalize,
    request,
    d.digest,
  );
  const authorization = await requireAuthorization(
    request.authorizationToken,
    d,
  );
  const snapshot = await requireExecution(
    request.executionId,
    authorization,
    d.executionQueries,
  );
  const projection = parseCanonicalJson(
    request.projectionEnvelopeCanonicalJson,
    "projection_envelope_invalid",
  );
  requireEqual(
    await d.digest.digestUtf8(request.projectionEnvelopeCanonicalJson),
    request.projectionHash,
    "projection_hash_mismatch",
  );
  const now = d.now();
  const protocolLimits = await requireProtocolLimits(authorization, d);
  const limits = await executionLimits(authorization, d);
  const facts = await d.finalizationFacts.resolve({
    authorization,
    execution: snapshot.execution,
    artifactId: request.artifactId,
    projectionEnvelopeVersion: request.projectionEnvelopeVersion,
    projectionEnvelope: projection,
    projectionCanonicalJson: request.projectionEnvelopeCanonicalJson,
    projectionHash: request.projectionHash,
    lifecycleStateHash: request.lifecycleStateHash,
    commandLedgerWatermark: decimal(request.commandLedgerWatermark),
    allowPartial: request.allowPartial,
    limits,
    maxReconciliationDurationMs: protocolLimits.maxReconciliationDurationMs,
    now,
  });
  requireEqual(
    facts.expectedArtifactHash,
    request.artifactHash,
    "artifact_hash_mismatch",
  );
  const result = await d.executions.finalizeReviewExecution.execute({
    scope: toExecutionScope(authorization),
    executionId: request.executionId,
    expectedStreamVersion: decimal(request.expectedStreamVersion),
    expectedExecutionVersion: decimal(request.expectedExecutionVersion),
    artifactId: request.artifactId,
    artifactHash: request.artifactHash,
    projectionEnvelopeVersion: request.projectionEnvelopeVersion,
    projectionEnvelopeJson: request.projectionEnvelopeCanonicalJson,
    projectionHash: request.projectionHash,
    byteCount: facts.byteCount,
    findingCount: facts.findingCount,
    lifecycleStateHash: request.lifecycleStateHash,
    commandLedgerWatermark: decimal(request.commandLedgerWatermark),
    projectionPolicyVersion: facts.projectionPolicyVersion,
    publicationSafetyDecisionHash: facts.publicationSafetyDecisionHash,
    publicationNotAfter: facts.publicationNotAfter,
    permitEpoch: authorization.mutationEpoch,
    allowPartial: request.allowPartial,
    limits,
    now,
    retainUntil: facts.retainUntil,
  });
  if (
    result.artifact &&
    result.artifact.publicationPermit.publicationNotAfter <= now
  ) {
    throw failure(
      410,
      ReviewActionV2ProtocolErrorCode.ResourceGone,
      "publication_permit_expired",
    );
  }
  const permit = result.artifact
    ? await d.capabilities.issuePublicationPermit(
        result.artifact.publicationPermit,
        now,
      )
    : null;
  return {
    statusCode:
      result.status === ReviewExecutionFinalizeStatus.Finalized
        ? (201 as const)
        : (200 as const),
    result: {
      status: mapFinalize(result.status),
      executionId: request.executionId,
      artifactId: result.artifact?.artifactId ?? null,
      artifactHash: result.artifact ? request.artifactHash : null,
      publicationPermit: permit,
    },
  };
}

async function lookupEvidence(
  request: ReviewEvidenceLookupRequest,
  d: ReviewActionV2EvidenceHandlerDependencies,
) {
  const authorization = await requireAuthorization(
    request.authorizationToken,
    d,
  );
  const snapshot = await requireExecution(
    request.executionId,
    authorization,
    d.executionQueries,
  );
  requireEqual(
    snapshot.execution.planHash,
    request.planHash,
    "plan_hash_mismatch",
  );
  const slot = snapshot.execution.workSlots.find(
    (item) => item.workSlotId === request.workSlotId,
  );
  if (!slot)
    throw failure(
      404,
      ReviewActionV2ProtocolErrorCode.NotFound,
      "work_slot_missing",
    );
  requireEqual(
    slot.providerVoteIdentityHash,
    request.providerVoteIdentityHash,
    "provider_vote_slot_mismatch",
  );
  authorizedVote(authorization, request.providerVoteIdentityHash);
  const manifest = parseManifest(request.manifestCanonicalJson);
  const scopeHash = await authorizationScopeHash(authorization, d.digest);
  requireEqual(manifest.scopeHash, scopeHash, "manifest_scope_mismatch");
  requireEqual(
    manifest.producerReleaseId,
    authorization.producerReleaseId,
    "manifest_release_mismatch",
  );
  requireEqual(
    manifest.selectedProtocolVersion,
    authorization.selectedProtocolVersion,
    "manifest_protocol_mismatch",
  );
  const trustDomain = evidenceTrustDomain(authorization.trustDomain);
  const result = await d.evidence.lookupReviewEvidence.execute({
    scope: toEvidenceScope(authorization, scopeHash),
    revision: toEvidenceRevision(authorization),
    planHash: request.planHash,
    executionId: request.executionId,
    manifest,
    manifestKey: request.manifestKey,
    providerInvocationKey: request.providerInvocationKey,
    providerVoteIdentityHash: request.providerVoteIdentityHash,
    trustDomain,
  });
  const selected = result.selected;
  const profile = await requireProtocolLimits(authorization, d);
  if (
    !selected ||
    selected.observation.byteCount > profile.maxObservationBytes ||
    selected.observation.findingCount > profile.maxObservationFindings
  ) {
    return {
      statusCode: 200 as const,
      result: {
        status: ReviewEvidenceLookupResultStatus.Miss,
        denialReasons: selected
          ? [...result.denialReasons, "payload_limit_exceeded"]
          : result.denialReasons,
      },
    };
  }
  const observation = selected.observation;
  let adoptionSourceLease: ReviewInvocationLease | null = null;
  if (observation.sourceExecutionId === request.executionId) {
    adoptionSourceLease = await d.executionQueries.findLease(
      observation.sourceLeaseId,
    );
    if (
      adoptionSourceLease === null ||
      adoptionSourceLease.executionId !== request.executionId ||
      adoptionSourceLease.workSlotId !== request.workSlotId ||
      adoptionSourceLease.leaseId !== observation.sourceLeaseId ||
      adoptionSourceLease.fencingToken.toString(10) !==
        observation.sourceFencingToken ||
      adoptionSourceLease.providerInvocationKey !==
        request.providerInvocationKey ||
      adoptionSourceLease.providerVoteIdentityHash !==
        request.providerVoteIdentityHash
    ) {
      return {
        statusCode: 200 as const,
        result: {
          status: ReviewEvidenceLookupResultStatus.Miss,
          denialReasons: [
            ...result.denialReasons,
            "adoption_source_facts_unavailable",
          ],
        },
      };
    }
  }
  let attachmentCapability: string | null = null;
  let attachmentKind: ReviewObservationAttachmentKind | null = null;
  if (
    result.status === LookupReviewEvidenceStatus.Hit &&
    selected.canAttach &&
    observation.sourceExecutionId !== request.executionId
  ) {
    attachmentKind = reuseAttachmentKind(selected.eligibility, selected.tier);
    const now = d.now();
    attachmentCapability = await d.capabilities.issueReusableAttachment(
      {
        authorizationId: authorization.authorizationId,
        mutationEpoch: authorization.mutationEpoch,
        scopeHash,
        targetExecutionId: request.executionId,
        targetWorkSlotId: request.workSlotId,
        targetReviewRevisionHash: authorization.reviewRevisionHash,
        targetPlanHash: request.planHash,
        observationId: observation.observationId,
        sourceExecutionId: observation.sourceExecutionId,
        manifest,
        manifestKey: request.manifestKey,
        providerInvocationKey: request.providerInvocationKey,
        providerVoteIdentityHash: request.providerVoteIdentityHash,
        payloadHash: observation.payloadHash,
        byteCount: observation.byteCount,
        findingCount: observation.findingCount,
        attachmentKind,
        reuseSafetyDecisionHash: required(
          selected.reuseSafetyDecisionHash,
          "reuse_safety_decision_missing",
        ),
        eligibilityPolicyVersion: reviewReuseEligibilityPolicyVersion,
        trustDomain,
        expiresAt: minDate(
          add(now, d.timing.attachmentCapabilityDurationMs),
          new Date(observation.reuseExpiresAtMs),
          authorization.expiresAt,
        ),
      },
      now,
    );
  }
  return {
    statusCode: 200 as const,
    result: {
      status: mapLookup(result.status),
      observationId: observation.observationId,
      payloadHash: observation.payloadHash,
      payloadCanonicalJson: canonicalPayload(observation),
      byteCount: observation.byteCount,
      findingCount: observation.findingCount,
      actualModel: observation.actualModel,
      qualityFlags: observation.qualityFlags,
      transportAttemptCount: observation.transportAttemptCount,
      attachmentCapability,
      attachmentKind,
      reuseSafetyDecisionHash: selected.reuseSafetyDecisionHash,
      eligibilityPolicyVersion: reviewReuseEligibilityPolicyVersion,
      sourceLeaseId: adoptionSourceLease?.leaseId ?? null,
      sourceFencingToken:
        adoptionSourceLease?.fencingToken.toString(10) ?? null,
      sourceOwnerIdHash: adoptionSourceLease?.ownerIdHash ?? null,
      denialReasons: result.denialReasons,
    },
  };
}

async function commitEvidence(
  request: ReviewEvidenceCommitRequest,
  d: ReviewActionV2EvidenceHandlerDependencies,
) {
  await assertBodyHash(
    ReviewActionV2OperationId.ReviewEvidenceCommit,
    request,
    d.digest,
  );
  const authorization = await requireAuthorization(
    request.authorizationToken,
    d,
  );
  const now = d.now();
  const authority = await verifyLease(request.leaseCapability, now, d);
  await assertLeaseAuthorization(authority, authorization, d);
  requireLeaseRequest(authority, request.sourceLeaseId, request.ownerIdHash);
  requireEqual(
    authority.attemptId,
    request.attemptId,
    "lease_attempt_mismatch",
  );
  const lease = await requireLease(authority, d.executionQueries, false, now);
  requireEqual(
    lease.fencingToken,
    decimal(request.fencingToken),
    "lease_fencing_mismatch",
  );
  const payload = parsePayload(request.payloadCanonicalJson);
  const prepared = prepareReviewObservationPayload(payload);
  requireEqual(
    await d.digest.digest(prepared.canonicalBytes),
    request.payloadHash,
    "payload_hash_mismatch",
  );
  const result = await d.evidence.acceptReviewObservation.execute({
    attemptId: request.attemptId,
    leaseCapabilityId: authority.capabilityId,
    sourceLeaseId: request.sourceLeaseId,
    ownerIdHash: request.ownerIdHash,
    sourceFencingToken: request.fencingToken,
    completionStatus: enumValue(
      ProviderResultCompletionStatus,
      request.completionStatus,
      "completion_status_invalid",
    ),
    schemaValidated: request.schemaValidated,
    fullyConsumed: request.fullyConsumed,
    actualModel: request.actualModel,
    payload,
    qualityFlags: request.qualityFlags.map((flag) =>
      enumValue(ReviewObservationQualityFlag, flag, "quality_flag_invalid"),
    ),
    transportAttemptCount: request.transportAttemptCount,
  });
  return {
    statusCode:
      result.status === AcceptReviewObservationStatus.Accepted
        ? (201 as const)
        : (200 as const),
    result: {
      status: mapCommit(result.status),
      observationId: result.observation?.observationId ?? null,
      historicalOnly: result.historicalOnly ?? false,
      eligibilityPolicyVersion: result.eligibilityPolicyVersion ?? null,
      rejectionReason:
        result.status === AcceptReviewObservationStatus.Rejected
          ? result.reason
          : null,
    },
  };
}

// Shared fail-closed mapping and canonical parsing helpers.
async function requireAuthorization(
  token: string,
  d: CommonDependencies,
): Promise<ReviewRunAuthorization> {
  let result: ReviewRunAuthorizationTokenResolution;
  try {
    result = await d.authorizations.resolveReviewRunAuthorizationToken({
      token,
    });
  } catch {
    throw failure(
      401,
      ReviewActionV2ProtocolErrorCode.InvalidAuthentication,
      "authorization_token_invalid",
    );
  }
  if (result.status !== ReviewRunAuthorizationTokenResolutionStatus.Valid) {
    const gone =
      result.status === ReviewRunAuthorizationTokenResolutionStatus.Expired ||
      result.status === ReviewRunAuthorizationTokenResolutionStatus.Revoked;
    throw failure(
      gone ? 410 : 401,
      gone
        ? ReviewActionV2ProtocolErrorCode.ResourceGone
        : ReviewActionV2ProtocolErrorCode.InvalidAuthentication,
      `authorization_${result.status}`,
    );
  }
  if (
    result.authorization.state !== ReviewRunAuthorizationState.Active ||
    result.authorization.expiresAt <= d.now()
  )
    throw failure(
      410,
      ReviewActionV2ProtocolErrorCode.ResourceGone,
      "authorization_inactive",
    );
  return result.authorization;
}

async function requireExecution(
  id: string,
  auth: ReviewRunAuthorization,
  queries: ReviewExecutionQueryPort,
) {
  const snapshot = await queries.findExecution(id);
  if (!snapshot)
    throw failure(
      404,
      ReviewActionV2ProtocolErrorCode.NotFound,
      "execution_missing",
    );
  if (!sameExecutionAuthority(snapshot.execution, auth))
    throw failure(
      403,
      ReviewActionV2ProtocolErrorCode.Forbidden,
      "execution_authorization_mismatch",
    );
  return snapshot;
}

async function executionLimits(
  auth: ReviewRunAuthorization,
  d: CommonDependencies,
): Promise<ReviewExecutionLimits> {
  return executionLimitsForProfile(auth.protocolLimitsProfileId, d);
}
async function executionLimitsForProfile(
  profileId: string,
  d: CommonDependencies,
): Promise<ReviewExecutionLimits> {
  const profile =
    await d.protocolLimits.findProtocolLimitsProfileById(profileId);
  if (!profile)
    throw failure(
      503,
      ReviewActionV2ProtocolErrorCode.ServiceUnavailable,
      "protocol_limits_missing",
    );
  return {
    profileId: profile.protocolLimitsProfileId,
    maxWorkSlots: profile.maxWorkSlots,
    maxAttemptBudget: profile.maxAttemptsPerSlot,
    maxProjectionBytes: profile.maxProjectionBytes,
    maxFindingCount: profile.maxProjectionFindings,
    maxLeaseDurationMs: profile.maxLeaseDurationMs,
    maxResultReportDurationMs: profile.maxResultReportDurationMs,
  };
}
async function requireProtocolLimits(
  auth: ReviewRunAuthorization,
  d: CommonDependencies,
) {
  const profile = await d.protocolLimits.findProtocolLimitsProfileById(
    auth.protocolLimitsProfileId,
  );
  if (!profile)
    throw failure(
      503,
      ReviewActionV2ProtocolErrorCode.ServiceUnavailable,
      "protocol_limits_missing",
    );
  return profile;
}

async function assertBodyHash<O extends ReviewActionV2OperationId>(
  operation: O,
  request: ReviewActionV2RequestMap[O],
  digest: ReviewActionV2DigestPort,
) {
  if (
    (await digest.digestUtf8(
      canonicalizeReviewActionV2Request(operation, request),
    )) !== (request as { requestBodyHash?: string }).requestBodyHash
  )
    throw failure(
      400,
      ReviewActionV2ProtocolErrorCode.InvalidRequest,
      "request_body_hash_mismatch",
    );
}

async function verifyLease(token: string, now: Date, d: CommonDependencies) {
  try {
    return await d.capabilities.verifyLease(token, now);
  } catch {
    throw failure(
      401,
      ReviewActionV2ProtocolErrorCode.InvalidAuthentication,
      "lease_capability_invalid",
    );
  }
}

async function requireLease(
  authority: VerifiedReviewActionV2LeaseCapability,
  queries: ReviewExecutionQueryPort,
  requireActive: boolean,
  now: Date,
) {
  const lease = await queries.findLease(authority.leaseId);
  if (!lease)
    throw failure(
      404,
      ReviewActionV2ProtocolErrorCode.NotFound,
      "lease_missing",
    );
  if (
    lease.leaseCapabilityId !== authority.capabilityId ||
    lease.ownerIdHash !== authority.ownerIdHash ||
    lease.executionId !== authority.executionId ||
    lease.workSlotId !== authority.workSlotId ||
    lease.providerInvocationKey !== authority.providerInvocationKey
  )
    throw failure(
      403,
      ReviewActionV2ProtocolErrorCode.Forbidden,
      "lease_capability_mismatch",
    );
  if (
    requireActive &&
    (lease.state !== ReviewInvocationLeaseState.Active ||
      lease.expiresAt <= now)
  )
    throw failure(
      410,
      ReviewActionV2ProtocolErrorCode.ResourceGone,
      "lease_not_active",
    );
  return lease;
}

function requireLeaseRequest(
  authority: VerifiedReviewActionV2LeaseCapability,
  leaseId: string,
  ownerIdHash: string,
) {
  requireEqual(authority.leaseId, leaseId, "lease_id_mismatch");
  requireEqual(authority.ownerIdHash, ownerIdHash, "lease_owner_mismatch");
}
function requireLeaseOwnership(
  authority: VerifiedReviewActionV2LeaseCapability,
  now: Date,
) {
  if (authority.ownershipExpiresAt <= now) {
    throw failure(
      410,
      ReviewActionV2ProtocolErrorCode.ResourceGone,
      "lease_ownership_expired",
    );
  }
}
async function assertLeaseAuthorization(
  authority: VerifiedReviewActionV2LeaseCapability,
  authorization: ReviewRunAuthorization,
  d: CommonDependencies,
) {
  requireEqual(
    authority.authorizationId,
    authorization.authorizationId,
    "lease_authorization_mismatch",
  );
  requireEqual(
    authority.scopeHash,
    await authorizationScopeHash(authorization, d.digest),
    "lease_scope_mismatch",
  );
  requireEqual(
    authority.reviewRevisionHash,
    authorization.reviewRevisionHash,
    "lease_revision_mismatch",
  );
  requireEqual(
    authority.mutationEpoch,
    authorization.mutationEpoch,
    "lease_mutation_epoch_mismatch",
  );
}

function parseWorkSlots(value: string): readonly ReviewWorkSlotPlan[] {
  const parsed = parseCanonicalJson(value, "work_slots_invalid");
  if (!Array.isArray(parsed))
    throw failure(
      422,
      ReviewActionV2ProtocolErrorCode.InvariantViolation,
      "work_slots_invalid",
    );
  return parsed.map((item) => {
    const row = record(item, "work_slot_invalid");
    exactKeys(
      row,
      [
        "workSlotId",
        "taskKind",
        "providerKind",
        "providerVoteIdentityHash",
        "shardKey",
        "required",
        "attemptBudget",
        "retryPolicyVersion",
      ],
      "work_slot_shape_invalid",
    );
    return {
      workSlotId: text(row.workSlotId),
      taskKind: enumValue(ReviewTaskKind, row.taskKind, "task_kind_invalid"),
      providerKind: enumValue(
        ReviewExecutionProviderKind,
        row.providerKind,
        "provider_kind_invalid",
      ),
      providerVoteIdentityHash: text(row.providerVoteIdentityHash),
      shardKey: text(row.shardKey),
      required: boolean(row.required),
      attemptBudget: integer(row.attemptBudget),
      retryPolicyVersion: text(row.retryPolicyVersion),
    };
  });
}

function parseManifest(value: string): ProviderInvocationManifest {
  const parsed = record(
    parseCanonicalJson(value, "manifest_invalid"),
    "manifest_invalid",
  );
  try {
    return normalizeProviderInvocationManifest(
      parsed as unknown as ProviderInvocationManifest,
    );
  } catch {
    throw failure(
      422,
      ReviewActionV2ProtocolErrorCode.InvariantViolation,
      "manifest_invalid",
    );
  }
}

async function validatePreparedManifest(
  request: Pick<
    ReviewInvocationLeaseAcquireRequest,
    | "manifestCanonicalJson"
    | "manifestKey"
    | "providerInvocationKey"
    | "providerVoteIdentityHash"
  >,
  authorization: ReviewRunAuthorization,
  slot: ReviewExecution["workSlots"][number],
  dependencies: Pick<CommonDependencies, "digest">,
) {
  const manifest = parseManifest(request.manifestCanonicalJson);
  if (
    serializeProviderInvocationManifestCanonicalWireJson(manifest) !==
    request.manifestCanonicalJson
  ) {
    throw failure(
      422,
      ReviewActionV2ProtocolErrorCode.InvariantViolation,
      "manifest_not_canonical",
    );
  }
  const scopeHash = await authorizationScopeHash(
    authorization,
    dependencies.digest,
  );
  requireEqual(manifest.scopeHash, scopeHash, "manifest_scope_mismatch");
  requireEqual(
    manifest.producerReleaseId,
    authorization.producerReleaseId,
    "manifest_release_mismatch",
  );
  requireEqual(
    manifest.selectedProtocolVersion,
    authorization.selectedProtocolVersion,
    "manifest_protocol_mismatch",
  );
  requireEqual(
    manifest.providerKind,
    evidenceProviderForExecution(slot.providerKind),
    "manifest_provider_mismatch",
  );
  if (!manifest.taskKindSet.includes(evidenceTaskForExecution(slot.taskKind))) {
    throw failure(
      403,
      ReviewActionV2ProtocolErrorCode.Forbidden,
      "manifest_task_mismatch",
    );
  }
  requireEqual(
    request.providerVoteIdentityHash,
    slot.providerVoteIdentityHash,
    "provider_vote_slot_mismatch",
  );
  requireEqual(
    slot.providerVoteIdentityHash,
    authorizedVote(authorization, request.providerVoteIdentityHash),
    "provider_vote_not_authorized",
  );
  const identity = await buildProviderInvocationIdentity(dependencies.digest, {
    manifest,
    providerVoteIdentityHash: request.providerVoteIdentityHash,
  });
  requireEqual(
    request.manifestKey,
    identity.manifestKey,
    "manifest_key_mismatch",
  );
  requireEqual(
    request.providerInvocationKey,
    identity.providerInvocationKey,
    "provider_invocation_key_mismatch",
  );
  return { manifest, identity, scopeHash } as const;
}
function parsePayload(value: string): ReviewObservationPayload {
  const parsed = record(
    parseCanonicalJson(value, "payload_invalid"),
    "payload_invalid",
  );
  try {
    return prepareReviewObservationPayload(
      parsed as unknown as ReviewObservationPayload,
    ).payload;
  } catch {
    throw failure(
      422,
      ReviewActionV2ProtocolErrorCode.InvariantViolation,
      "payload_invalid",
    );
  }
}
function parseCanonicalJson(value: string, issue: string): unknown {
  try {
    const parsed: unknown = JSON.parse(value);
    if (stableJson(parsed as never) !== value) throw new Error();
    return parsed;
  } catch {
    throw failure(
      422,
      ReviewActionV2ProtocolErrorCode.InvariantViolation,
      issue,
    );
  }
}

function canonicalPayload(observation: ReviewObservation): string {
  return new TextDecoder().decode(
    prepareReviewObservationPayload(observation.payload).canonicalBytes,
  );
}
function executionResult(snapshot: ReviewExecutionSnapshot) {
  return {
    executionId: snapshot.execution.executionId,
    generation: snapshot.execution.generation.toString(10),
    streamVersion: snapshot.stream.version.toString(10),
    executionVersion: snapshot.execution.version.toString(10),
    executionCanonicalJson: canonicalExecution(snapshot),
  };
}
function restoreResult(snapshot: ReviewExecutionSnapshot) {
  return {
    status: ReviewExecutionRestoreResultStatus.Found,
    executionId: snapshot.execution.executionId,
    generation: snapshot.execution.generation.toString(10),
    executionState: snapshot.execution.state,
    executionCanonicalJson: canonicalExecution(snapshot),
  };
}
function canonicalExecution(snapshot: ReviewExecutionSnapshot) {
  const e = snapshot.execution;
  return canonicalJson({
    executionId: e.executionId,
    version: e.version.toString(10),
    generation: e.generation.toString(10),
    state: e.state,
    authorizationId: e.authorizationId,
    reviewRevisionHash: e.revision.reviewRevisionHash,
    planHash: e.planHash,
    workSlots: e.workSlots.map((s) => ({
      workSlotId: s.workSlotId,
      state: s.state,
      required: s.required,
      providerVoteIdentityHash: s.providerVoteIdentityHash,
      activeLeaseId: s.activeLeaseId,
      acceptedObservationRefId: s.acceptedObservationRefId,
    })),
  });
}

function mutationResult(
  status: ReviewExecutionLifecycleTransitionStatus,
  executionId: string,
  snapshot: ReviewExecutionSnapshot,
) {
  return {
    status:
      status === ReviewExecutionLifecycleTransitionStatus.Applied
        ? ReviewExecutionMutationResultStatus.Applied
        : status === ReviewExecutionLifecycleTransitionStatus.Restored
          ? ReviewExecutionMutationResultStatus.Restored
          : status === ReviewExecutionLifecycleTransitionStatus.Missing
            ? ReviewExecutionMutationResultStatus.Missing
            : ReviewExecutionMutationResultStatus.Conflict,
    executionId,
    streamVersion: snapshot.stream.version.toString(10),
  };
}
function attachmentResult(
  status: ReviewObservationAttachmentStatus,
  request: Pick<
    ReviewExecutionObservationAttachRequest,
    "executionId" | "workSlotId"
  >,
  snapshot: ReviewExecutionSnapshot,
) {
  return {
    status: mapAttachmentStatus(status),
    executionId: request.executionId,
    workSlotId: request.workSlotId,
    streamVersion: snapshot.stream.version.toString(10),
  };
}
function mapAttachmentStatus(status: ReviewObservationAttachmentStatus) {
  return status === ReviewObservationAttachmentStatus.Attached
    ? ReviewExecutionMutationResultStatus.Applied
    : status === ReviewObservationAttachmentStatus.Restored
      ? ReviewExecutionMutationResultStatus.Restored
      : status === ReviewObservationAttachmentStatus.Missing
        ? ReviewExecutionMutationResultStatus.Missing
        : status === ReviewObservationAttachmentStatus.Conflict
          ? ReviewExecutionMutationResultStatus.Conflict
          : ReviewExecutionMutationResultStatus.Rejected;
}
function adoptionResult(
  status: ReviewExecutionMutationResultStatus,
  request: ReviewExecutionObservationAdoptRequest,
  snapshot: ReviewExecutionSnapshot,
  observation: ReviewObservation | null,
) {
  return {
    status,
    executionId: request.executionId,
    workSlotId: request.workSlotId,
    streamVersion: snapshot.stream.version.toString(10),
    observationPayloadCanonicalJson:
      observation === null ? null : canonicalPayload(observation),
    observationFactsCanonicalJson:
      observation === null
        ? null
        : canonicalJson({
            observationId: observation.observationId,
            sourceExecutionId: observation.sourceExecutionId,
            sourceLeaseId: observation.sourceLeaseId,
            sourceFencingToken: observation.sourceFencingToken,
            providerInvocationKey: observation.providerInvocationKey,
            providerVoteIdentityHash: observation.providerVoteIdentityHash,
            manifestKey: observation.manifestKey,
            payloadHash: observation.payloadHash,
            byteCount: observation.byteCount,
            findingCount: observation.findingCount,
            actualModel: observation.actualModel,
            qualityFlags: observation.qualityFlags,
            transportAttemptCount: observation.transportAttemptCount,
            eligibilityPolicyVersion: request.eligibilityPolicyVersion,
            planHash: request.planHash,
            reviewRevisionHash: request.reviewRevisionHash,
          }),
  };
}
function mapFinalize(status: ReviewExecutionFinalizeStatus) {
  return status === ReviewExecutionFinalizeStatus.Finalized
    ? ReviewExecutionMutationResultStatus.Applied
    : status === ReviewExecutionFinalizeStatus.Restored
      ? ReviewExecutionMutationResultStatus.Restored
      : status === ReviewExecutionFinalizeStatus.Missing
        ? ReviewExecutionMutationResultStatus.Missing
        : status === ReviewExecutionFinalizeStatus.Conflict
          ? ReviewExecutionMutationResultStatus.Conflict
          : ReviewExecutionMutationResultStatus.Rejected;
}
function mapStart(
  status: StartReviewExecutionStatus,
): ReviewExecutionStartResultStatus {
  switch (status) {
    case StartReviewExecutionStatus.Admitted:
      return ReviewExecutionStartResultStatus.Admitted;
    case StartReviewExecutionStatus.Restored:
      return ReviewExecutionStartResultStatus.Restored;
    case StartReviewExecutionStatus.AdmissionDeferred:
      return ReviewExecutionStartResultStatus.AdmissionDeferred;
    case StartReviewExecutionStatus.StaleRevision:
      return ReviewExecutionStartResultStatus.StaleRevision;
    case StartReviewExecutionStatus.AuthorizationRejected:
      return ReviewExecutionStartResultStatus.AuthorizationRejected;
    case StartReviewExecutionStatus.IdempotencyConflict:
      return ReviewExecutionStartResultStatus.IdempotencyConflict;
    case StartReviewExecutionStatus.ConcurrencyConflict:
      return ReviewExecutionStartResultStatus.ConcurrencyConflict;
  }
}
function mapLookup(
  status: LookupReviewEvidenceStatus,
): ReviewEvidenceLookupResultStatus {
  switch (status) {
    case LookupReviewEvidenceStatus.Hit:
      return ReviewEvidenceLookupResultStatus.Hit;
    case LookupReviewEvidenceStatus.Shadow:
      return ReviewEvidenceLookupResultStatus.Shadow;
    case LookupReviewEvidenceStatus.Miss:
      return ReviewEvidenceLookupResultStatus.Miss;
  }
}
function mapCommit(
  status: AcceptReviewObservationStatus,
): ReviewEvidenceCommitResultStatus {
  switch (status) {
    case AcceptReviewObservationStatus.Accepted:
      return ReviewEvidenceCommitResultStatus.Accepted;
    case AcceptReviewObservationStatus.Idempotent:
      return ReviewEvidenceCommitResultStatus.Idempotent;
    case AcceptReviewObservationStatus.Rejected:
      return ReviewEvidenceCommitResultStatus.Rejected;
    case AcceptReviewObservationStatus.Conflict:
      return ReviewEvidenceCommitResultStatus.Conflict;
  }
}
function mapLeaseAcquire(status: ReviewInvocationLeaseAcquireStatus) {
  switch (status) {
    case ReviewInvocationLeaseAcquireStatus.Acquired:
      return ReviewInvocationLeaseResultStatus.Acquired;
    case ReviewInvocationLeaseAcquireStatus.Restored:
      return ReviewInvocationLeaseResultStatus.Restored;
    case ReviewInvocationLeaseAcquireStatus.Busy:
      return ReviewInvocationLeaseResultStatus.Busy;
    case ReviewInvocationLeaseAcquireStatus.Missing:
      return ReviewInvocationLeaseResultStatus.Missing;
    default:
      return ReviewInvocationLeaseResultStatus.Rejected;
  }
}
function leaseTransitionResult(
  status: ReviewInvocationLeaseTransitionStatus,
  lease?: ReviewInvocationLease,
) {
  return {
    status:
      status === ReviewInvocationLeaseTransitionStatus.Applied
        ? ReviewInvocationLeaseResultStatus.Applied
        : status === ReviewInvocationLeaseTransitionStatus.Restored
          ? ReviewInvocationLeaseResultStatus.Restored
          : status === ReviewInvocationLeaseTransitionStatus.StaleTerm
            ? ReviewInvocationLeaseResultStatus.StaleTerm
            : status === ReviewInvocationLeaseTransitionStatus.Expired
              ? ReviewInvocationLeaseResultStatus.Expired
              : status === ReviewInvocationLeaseTransitionStatus.Missing
                ? ReviewInvocationLeaseResultStatus.Missing
                : ReviewInvocationLeaseResultStatus.Rejected,
    leaseId: lease?.leaseId ?? null,
    fencingToken: lease?.fencingToken.toString(10) ?? null,
    expiresAt: lease?.expiresAt.toISOString() ?? null,
  };
}

function assertAttachmentRequest(
  r: ReviewExecutionObservationAttachRequest,
  a: ReviewActionV2ReusableAttachmentAuthority,
) {
  requireEqual(
    r.observationId,
    a.observationId,
    "attachment_observation_mismatch",
  );
  requireEqual(
    r.providerInvocationKey,
    a.providerInvocationKey,
    "attachment_invocation_mismatch",
  );
  requireEqual(
    r.providerVoteIdentityHash,
    a.providerVoteIdentityHash,
    "attachment_vote_mismatch",
  );
  requireEqual(r.payloadHash, a.payloadHash, "attachment_payload_mismatch");
  requireEqual(r.byteCount, a.byteCount, "attachment_byte_count_mismatch");
  requireEqual(
    r.findingCount,
    a.findingCount,
    "attachment_finding_count_mismatch",
  );
  requireEqual(
    r.eligibilityPolicyVersion,
    a.eligibilityPolicyVersion,
    "attachment_policy_mismatch",
  );
}
function assertAdoptionSourceLease(
  request: ReviewExecutionObservationAdoptRequest,
  sourceLease: ReviewInvocationLease,
  authorization: ReviewRunAuthorization,
  snapshot: ReviewExecutionSnapshot,
) {
  if (
    sourceLease.state === ReviewInvocationLeaseState.Revoked ||
    sourceLease.purpose !== ReviewInvocationLeasePurpose.ProviderExecution ||
    sourceLease.attemptId === null ||
    sourceLease.executionId !== request.executionId ||
    sourceLease.executionGeneration !== decimal(request.executionGeneration) ||
    sourceLease.workSlotId !== request.workSlotId ||
    sourceLease.leaseId !== request.sourceLeaseId ||
    sourceLease.fencingToken !== decimal(request.sourceFencingToken) ||
    sourceLease.ownerIdHash !== request.ownerIdHash ||
    sourceLease.authorizationId !== authorization.authorizationId ||
    sourceLease.producerReleaseId !== authorization.producerReleaseId ||
    sourceLease.mutationEpoch !== authorization.mutationEpoch ||
    sourceLease.reviewRevisionHash !== request.reviewRevisionHash ||
    sourceLease.providerInvocationKey !== request.providerInvocationKey ||
    sourceLease.providerVoteIdentityHash !== request.providerVoteIdentityHash ||
    sourceLease.preparedManifestCanonicalJson !==
      request.manifestCanonicalJson ||
    sourceLease.preparedManifestKey !== request.manifestKey ||
    snapshot.execution.executionId !== sourceLease.executionId
  ) {
    throw failure(
      403,
      ReviewActionV2ProtocolErrorCode.Forbidden,
      "adoption_source_lease_authority_mismatch",
    );
  }
}
async function assertAdoptionObservation(
  request: ReviewExecutionObservationAdoptRequest,
  observation: ReviewObservation,
  sourceLease: ReviewInvocationLease,
  authorization: ReviewRunAuthorization,
  digest: ReviewActionV2DigestPort,
) {
  const prepared = prepareReviewObservationPayload(observation.payload);
  if (
    observation.observationId !== request.observationId ||
    observation.sourceExecutionId !== request.executionId ||
    observation.sourceLeaseId !== request.sourceLeaseId ||
    observation.sourceFencingToken !== request.sourceFencingToken ||
    observation.attemptId !== sourceLease.attemptId ||
    observation.manifestKey !== request.manifestKey ||
    observation.providerInvocationKey !== request.providerInvocationKey ||
    observation.providerVoteIdentityHash !== request.providerVoteIdentityHash ||
    observation.payloadHash !== request.payloadHash ||
    observation.byteCount !== request.byteCount ||
    observation.findingCount !== request.findingCount ||
    observation.scope.workspaceId !== authorization.workspaceId ||
    observation.scope.repositoryConnectionId !==
      authorization.repositoryConnectionId ||
    observation.scope.scmRepositoryIdentityId !==
      authorization.scmRepositoryIdentityId ||
    observation.scope.pullRequestNumber !== authorization.pullRequestNumber ||
    observation.scope.authorizationScopeHash !==
      (await authorizationScopeHash(authorization, digest)) ||
    observation.sourceRevision.reviewRevisionHash !==
      request.reviewRevisionHash ||
    request.eligibilityPolicyVersion !== reviewReuseEligibilityPolicyVersion ||
    (await digest.digest(prepared.canonicalBytes)) !==
      observation.payloadHash ||
    prepared.byteCount !== observation.byteCount ||
    prepared.findingCount !== observation.findingCount
  ) {
    throw failure(
      403,
      ReviewActionV2ProtocolErrorCode.Forbidden,
      "adoption_observation_authority_mismatch",
    );
  }
}
function assertAdoptionReplay(
  request: ReviewExecutionObservationAdoptRequest,
  existingRef: ReviewExecutionObservationRef,
  adoptionLease: ReviewInvocationLease | null,
  observationRefId: string,
  adoptionIdentityHash: string,
  adoptionRequestIdHash: string,
) {
  if (
    existingRef.observationRefId !== observationRefId ||
    existingRef.observationId !== request.observationId ||
    existingRef.executionId !== request.executionId ||
    existingRef.workSlotId !== request.workSlotId ||
    existingRef.providerInvocationKey !== request.providerInvocationKey ||
    existingRef.providerVoteIdentityHash !== request.providerVoteIdentityHash ||
    existingRef.payloadHash !== request.payloadHash ||
    existingRef.byteCount !== request.byteCount ||
    existingRef.findingCount !== request.findingCount ||
    existingRef.eligibilityPolicyVersion !== request.eligibilityPolicyVersion ||
    existingRef.attachmentKind !==
      ReviewObservationAttachmentKind.ObservationAdoption ||
    existingRef.sourceLeaseId !== request.sourceLeaseId ||
    existingRef.sourceFencingToken !== decimal(request.sourceFencingToken) ||
    adoptionLease === null ||
    adoptionLease.leaseId !== `adoption-${adoptionIdentityHash}` ||
    adoptionLease.purpose !==
      ReviewInvocationLeasePurpose.ObservationAdoption ||
    adoptionLease.state !== ReviewInvocationLeaseState.Released ||
    adoptionLease.sourceObservationId !== request.observationId ||
    adoptionLease.providerInvocationKey !== request.providerInvocationKey ||
    adoptionLease.providerVoteIdentityHash !==
      request.providerVoteIdentityHash ||
    adoptionLease.ownerIdHash !== request.ownerIdHash ||
    adoptionLease.acquireRequestIdHash !== adoptionRequestIdHash ||
    adoptionLease.acquireRequestHash !== request.requestBodyHash ||
    !isCapabilityIdentifier(adoptionLease.leaseCapabilityId) ||
    !isCapabilityIdentifier(adoptionLease.capabilitySigningKeyId)
  ) {
    throw failure(
      409,
      ReviewActionV2ProtocolErrorCode.IdempotencyConflict,
      "adoption_replay_conflict",
    );
  }
}
function isCapabilityIdentifier(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,160}$/.test(value);
}
async function observationRefId(
  r: Pick<
    ReviewExecutionObservationAttachRequest,
    "executionId" | "workSlotId" | "observationId"
  >,
  d: CommonDependencies,
) {
  return `obsref:${await d.digest.digestUtf8(canonicalJson({ executionId: r.executionId, workSlotId: r.workSlotId, observationId: r.observationId }))}`;
}
function reuseAttachmentKind(
  eligibility: ReuseEligibility,
  tier: ReviewReuseTier,
) {
  if (
    eligibility === ReuseEligibility.ExactRevision &&
    tier === ReviewReuseTier.T0ExactRevision
  )
    return ReviewObservationAttachmentKind.ExactRevisionReuse;
  if (
    eligibility === ReuseEligibility.PromptOnlyCrossRevision &&
    tier === ReviewReuseTier.T1PromptOnlyCrossRevision
  )
    return ReviewObservationAttachmentKind.PromptOnlyCrossRevisionReuse;
  throw failure(
    422,
    ReviewActionV2ProtocolErrorCode.InvariantViolation,
    "reuse_tier_not_attachable",
  );
}

function toExecutionScope(
  a: Pick<
    ReviewRunAuthorization,
    | "workspaceId"
    | "repositoryConnectionId"
    | "scmRepositoryIdentityId"
    | "pullRequestNumber"
  >,
): ReviewExecutionScope {
  return {
    workspaceId: a.workspaceId,
    repositoryConnectionId: a.repositoryConnectionId,
    scmRepositoryIdentityId: a.scmRepositoryIdentityId,
    pullRequestNumber: a.pullRequestNumber,
  };
}
function toExecutionRevision(a: ReviewRunAuthorization) {
  return {
    baseSha: a.baseSha,
    mergeBaseSha: a.mergeBaseSha,
    headSha: a.headSha,
    reviewRevisionHash: a.reviewRevisionHash,
  };
}
function toEvidenceRevision(a: ReviewRunAuthorization) {
  return toExecutionRevision(a);
}
function toEvidenceScope(
  a: ReviewRunAuthorization,
  authorizationScopeHash: string,
) {
  return { ...toExecutionScope(a), authorizationScopeHash };
}
function evidenceTrustDomain(value: ReviewTrustDomain): EvidenceTrustDomain {
  return value as unknown as EvidenceTrustDomain;
}
function evidenceProviderForExecution(
  value: ReviewExecutionProviderKind,
): EvidenceProviderKind {
  switch (value) {
    case ReviewExecutionProviderKind.Codex:
      return EvidenceProviderKind.Codex;
    case ReviewExecutionProviderKind.ClaudeCode:
      return EvidenceProviderKind.ClaudeCode;
    case ReviewExecutionProviderKind.OpenRouter:
      return EvidenceProviderKind.OpenRouter;
    default:
      throw failure(
        422,
        ReviewActionV2ProtocolErrorCode.InvariantViolation,
        "execution_provider_unknown",
      );
  }
}
function evidenceTaskForExecution(value: ReviewTaskKind): EvidenceTaskKind {
  switch (value) {
    case ReviewTaskKind.FindingDiscovery:
      return EvidenceTaskKind.FindingDiscovery;
    case ReviewTaskKind.LifecycleRevalidation:
      return EvidenceTaskKind.LifecycleRevalidation;
    default:
      throw failure(
        422,
        ReviewActionV2ProtocolErrorCode.InvariantViolation,
        "execution_task_unknown",
      );
  }
}
function sameExecutionAuthority(e: ReviewExecution, a: ReviewRunAuthorization) {
  const scope = toExecutionScope(a);
  return (
    e.authorizationId === a.authorizationId &&
    e.workspaceId === scope.workspaceId &&
    e.repositoryConnectionId === scope.repositoryConnectionId &&
    e.scmRepositoryIdentityId === scope.scmRepositoryIdentityId &&
    e.pullRequestNumber === scope.pullRequestNumber
  );
}
async function authorizationScopeHash(
  a: ReviewRunAuthorization,
  digest: ReviewActionV2DigestPort,
) {
  return digest.digestUtf8(canonicalJson(toExecutionScope(a)));
}
function authorizedVote(a: ReviewRunAuthorization, hash: string) {
  if (
    !a.providerVoteLanes.some((lane) => lane.providerVoteIdentityHash === hash)
  )
    throw failure(
      403,
      ReviewActionV2ProtocolErrorCode.Forbidden,
      "provider_vote_not_authorized",
    );
  return hash;
}

function decimal(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value))
    throw failure(
      422,
      ReviewActionV2ProtocolErrorCode.InvariantViolation,
      "decimal_invalid",
    );
  return BigInt(value);
}
function requireEqual<T>(left: T, right: T, issue: string): void {
  if (left !== right)
    throw failure(403, ReviewActionV2ProtocolErrorCode.Forbidden, issue);
}
function required<T>(value: T | null | undefined, issue: string): T {
  if (value === null || value === undefined)
    throw failure(
      422,
      ReviewActionV2ProtocolErrorCode.InvariantViolation,
      issue,
    );
  return value;
}
function enumValue<T extends string>(
  values: Record<string, T>,
  value: unknown,
  issue: string,
): T {
  if (typeof value !== "string" || !Object.values(values).includes(value as T))
    throw failure(
      422,
      ReviewActionV2ProtocolErrorCode.InvariantViolation,
      issue,
    );
  return value as T;
}
function record(value: unknown, issue: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw failure(
      422,
      ReviewActionV2ProtocolErrorCode.InvariantViolation,
      issue,
    );
  return value as Record<string, unknown>;
}
function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  issue: string,
) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  )
    throw failure(
      422,
      ReviewActionV2ProtocolErrorCode.InvariantViolation,
      issue,
    );
}
function text(value: unknown): string {
  if (typeof value !== "string")
    throw failure(
      422,
      ReviewActionV2ProtocolErrorCode.InvariantViolation,
      "string_invalid",
    );
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean")
    throw failure(
      422,
      ReviewActionV2ProtocolErrorCode.InvariantViolation,
      "boolean_invalid",
    );
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw failure(
      422,
      ReviewActionV2ProtocolErrorCode.InvariantViolation,
      "integer_invalid",
    );
  return value;
}
function add(date: Date, ms: number) {
  return new Date(date.getTime() + ms);
}
function minDate(...values: readonly Date[]) {
  return new Date(Math.min(...values.map((v) => v.getTime())));
}
function validateTiming(t: ReviewActionV2ExecutionTimingPolicy) {
  for (const value of Object.values(t))
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error("review_action_v2_execution_timing_invalid");
}
function failure(
  statusCode: ConstructorParameters<typeof ReviewActionV2RouteFailure>[0],
  errorCode: ReviewActionV2ProtocolErrorCode,
  issue: string,
) {
  return new ReviewActionV2RouteFailure(statusCode, errorCode, [issue]);
}
