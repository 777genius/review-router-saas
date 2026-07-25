import {
  ProducerDistributionKind,
  ProducerReleaseState,
  ReviewCapabilityProfile,
  assertCommitSha,
  assertDate,
  assertIdentifier,
  assertPositiveInteger,
  assertSha256,
  canonicalJson,
  cloneDate,
  invalid,
} from "./review-run-control-types";

export type ReviewProtocolLimits = {
  readonly maxWorkSlots: number;
  readonly maxAttemptsPerSlot: number;
  readonly maxObservationBytes: number;
  readonly maxObservationFindings: number;
  readonly maxProjectionBytes: number;
  readonly maxProjectionFindings: number;
  readonly maxPublicationOperations: number;
  readonly maxPublicationChunks: number;
  readonly maxPublicationBodyBytes: number;
  readonly maxRequestBatchSize: number;
  readonly maxLeaseDurationMs: number;
  readonly maxResultReportDurationMs: number;
  readonly maxReconciliationDurationMs: number;
};

export type ReviewProtocolLimitsV2 = ReviewProtocolLimits & {
  readonly protocolLimitsProfileId: string;
  readonly limitsDigest: string;
  readonly registeredAt: Date;
};

export type ReviewOperationalSloThresholds = {
  readonly integrationEventDeliveryMs: number;
  readonly outboxClaimAgeMs: number;
  readonly missingCompletionProcessMs: number;
  readonly dueCompletionProcessMs: number;
  readonly publicationReconciliationMs: number;
  readonly v1DrainMs: number;
  readonly admissionMs: number;
  readonly pruningBacklogAgeMs: number;
};

export type ReviewOperationalSloProfileV2 = ReviewOperationalSloThresholds & {
  readonly operationalSloProfileId: string;
  readonly sloDigest: string;
  readonly ownerRefs: readonly string[];
  readonly runbookRefs: readonly string[];
  readonly registeredAt: Date;
};

export type ProducerRelease = {
  readonly producerReleaseId: string;
  readonly distributionKind: ProducerDistributionKind;
  readonly actionCommitSha: string;
  readonly runtimeCommitSha: string;
  readonly wrapperEntrypointDigest: string | null;
  readonly runtimeEntrypointDigest: string;
  readonly contextGatewayPolicyVersion: string | null;
  readonly contextGatewayEntrypointDigest: string | null;
  readonly schemaDigest: string;
  readonly capabilityProfile: ReviewCapabilityProfile;
  readonly protocolLimitsProfileId: string;
  readonly operationalSloProfileId: string;
  readonly state: ProducerReleaseState;
  readonly registeredAt: Date;
  readonly revokedAt: Date | null;
};

export type ProducerReleaseCandidate = Omit<
  ProducerRelease,
  | "state"
  | "registeredAt"
  | "revokedAt"
  | "contextGatewayPolicyVersion"
  | "contextGatewayEntrypointDigest"
> & {
  readonly contextGatewayPolicyVersion?: string | null;
  readonly contextGatewayEntrypointDigest?: string | null;
};

export function createReviewProtocolLimitsProfile(input: {
  readonly protocolLimitsProfileId: string;
  readonly limitsDigest: string;
  readonly limits: ReviewProtocolLimits;
  readonly absoluteMaxima: ReviewProtocolLimits;
  readonly registeredAt: Date;
}): ReviewProtocolLimitsV2 {
  assertIdentifier(input.protocolLimitsProfileId, "protocol_limits_profile_id");
  assertSha256(input.limitsDigest, "limits_digest");
  assertDate(input.registeredAt, "registered_at");
  for (const key of Object.keys(
    input.limits,
  ) as (keyof ReviewProtocolLimits)[]) {
    assertPositiveInteger(input.limits[key], key);
    assertPositiveInteger(input.absoluteMaxima[key], `absolute_${key}`);
    if (input.limits[key] > input.absoluteMaxima[key]) {
      invalid(`protocol_limit_exceeds_absolute_maximum:${key}`);
    }
  }
  return {
    protocolLimitsProfileId: input.protocolLimitsProfileId,
    limitsDigest: input.limitsDigest,
    ...input.limits,
    registeredAt: cloneDate(input.registeredAt),
  };
}

export function canonicalReviewProtocolLimits(
  limits: ReviewProtocolLimits,
): string {
  return canonicalJson({
    maxWorkSlots: limits.maxWorkSlots,
    maxAttemptsPerSlot: limits.maxAttemptsPerSlot,
    maxObservationBytes: limits.maxObservationBytes,
    maxObservationFindings: limits.maxObservationFindings,
    maxProjectionBytes: limits.maxProjectionBytes,
    maxProjectionFindings: limits.maxProjectionFindings,
    maxPublicationOperations: limits.maxPublicationOperations,
    maxPublicationChunks: limits.maxPublicationChunks,
    maxPublicationBodyBytes: limits.maxPublicationBodyBytes,
    maxRequestBatchSize: limits.maxRequestBatchSize,
    maxLeaseDurationMs: limits.maxLeaseDurationMs,
    maxResultReportDurationMs: limits.maxResultReportDurationMs,
    maxReconciliationDurationMs: limits.maxReconciliationDurationMs,
  });
}

export function createReviewOperationalSloProfile(input: {
  readonly operationalSloProfileId: string;
  readonly sloDigest: string;
  readonly thresholds: ReviewOperationalSloThresholds;
  readonly ownerRefs: readonly string[];
  readonly runbookRefs: readonly string[];
  readonly registeredAt: Date;
}): ReviewOperationalSloProfileV2 {
  assertIdentifier(input.operationalSloProfileId, "operational_slo_profile_id");
  assertSha256(input.sloDigest, "slo_digest");
  assertDate(input.registeredAt, "registered_at");
  for (const [key, value] of Object.entries(input.thresholds)) {
    assertPositiveInteger(value, key);
  }
  assertBoundedReferences(input.ownerRefs, "owner_refs");
  assertBoundedReferences(input.runbookRefs, "runbook_refs");
  if (input.ownerRefs.length === 0 || input.runbookRefs.length === 0) {
    invalid("operational_slo_ownership_required");
  }
  return {
    operationalSloProfileId: input.operationalSloProfileId,
    sloDigest: input.sloDigest,
    ...input.thresholds,
    ownerRefs: [...new Set(input.ownerRefs)].sort(),
    runbookRefs: [...new Set(input.runbookRefs)].sort(),
    registeredAt: cloneDate(input.registeredAt),
  };
}

export function canonicalReviewOperationalSloProfile(input: {
  readonly thresholds: ReviewOperationalSloThresholds;
  readonly ownerRefs: readonly string[];
  readonly runbookRefs: readonly string[];
}): string {
  return canonicalJson({
    integrationEventDeliveryMs: input.thresholds.integrationEventDeliveryMs,
    outboxClaimAgeMs: input.thresholds.outboxClaimAgeMs,
    missingCompletionProcessMs: input.thresholds.missingCompletionProcessMs,
    dueCompletionProcessMs: input.thresholds.dueCompletionProcessMs,
    publicationReconciliationMs: input.thresholds.publicationReconciliationMs,
    v1DrainMs: input.thresholds.v1DrainMs,
    admissionMs: input.thresholds.admissionMs,
    pruningBacklogAgeMs: input.thresholds.pruningBacklogAgeMs,
    ownerRefs: [...new Set(input.ownerRefs)].sort(),
    runbookRefs: [...new Set(input.runbookRefs)].sort(),
  });
}

export function createProducerRelease(
  candidate: ProducerReleaseCandidate,
  registeredAt: Date,
): ProducerRelease {
  assertIdentifier(candidate.producerReleaseId, "producer_release_id");
  assertCommitSha(candidate.actionCommitSha, "action_commit_sha");
  assertCommitSha(candidate.runtimeCommitSha, "runtime_commit_sha");
  assertSha256(candidate.runtimeEntrypointDigest, "runtime_entrypoint_digest");
  assertSha256(candidate.schemaDigest, "schema_digest");
  assertIdentifier(
    candidate.protocolLimitsProfileId,
    "protocol_limits_profile_id",
  );
  assertIdentifier(
    candidate.operationalSloProfileId,
    "operational_slo_profile_id",
  );
  assertDate(registeredAt, "registered_at");
  if (candidate.wrapperEntrypointDigest !== null) {
    assertSha256(
      candidate.wrapperEntrypointDigest,
      "wrapper_entrypoint_digest",
    );
  }
  const contextGatewayPolicyVersion =
    candidate.contextGatewayPolicyVersion ?? null;
  const contextGatewayEntrypointDigest =
    candidate.contextGatewayEntrypointDigest ?? null;
  if (
    (contextGatewayPolicyVersion === null) !==
    (contextGatewayEntrypointDigest === null)
  ) {
    invalid("context_gateway_release_artifact_incomplete");
  }
  if (
    contextGatewayPolicyVersion !== null &&
    contextGatewayEntrypointDigest !== null
  ) {
    assertIdentifier(
      contextGatewayPolicyVersion,
      "context_gateway_policy_version",
    );
    assertSha256(
      contextGatewayEntrypointDigest,
      "context_gateway_entrypoint_digest",
    );
  }
  if (
    candidate.distributionKind === ProducerDistributionKind.HostedComposite &&
    candidate.wrapperEntrypointDigest === null
  ) {
    invalid("hosted_composite_wrapper_digest_required");
  }
  return {
    ...candidate,
    contextGatewayPolicyVersion,
    contextGatewayEntrypointDigest,
    state: ProducerReleaseState.Registered,
    registeredAt: cloneDate(registeredAt),
    revokedAt: null,
  };
}

export function revokeProducerRelease(
  release: ProducerRelease,
  revokedAt: Date,
): ProducerRelease {
  assertDate(revokedAt, "revoked_at");
  if (release.state === ProducerReleaseState.Revoked) {
    return cloneProducerRelease(release);
  }
  if (revokedAt < release.registeredAt) {
    invalid("revoked_before_registered");
  }
  return {
    ...release,
    state: ProducerReleaseState.Revoked,
    registeredAt: cloneDate(release.registeredAt),
    revokedAt: cloneDate(revokedAt),
  };
}

export function producerReleaseImmutableKey(
  release: ProducerRelease | ProducerReleaseCandidate,
): string {
  return canonicalJson({
    distributionKind: release.distributionKind,
    actionCommitSha: release.actionCommitSha,
    runtimeCommitSha: release.runtimeCommitSha,
    wrapperEntrypointDigest: release.wrapperEntrypointDigest,
    runtimeEntrypointDigest: release.runtimeEntrypointDigest,
    contextGatewayPolicyVersion: release.contextGatewayPolicyVersion ?? null,
    contextGatewayEntrypointDigest:
      release.contextGatewayEntrypointDigest ?? null,
    schemaDigest: release.schemaDigest,
    capabilityProfile: release.capabilityProfile,
    protocolLimitsProfileId: release.protocolLimitsProfileId,
    operationalSloProfileId: release.operationalSloProfileId,
  });
}

export function cloneProducerRelease(
  release: ProducerRelease,
): ProducerRelease {
  return {
    ...release,
    registeredAt: cloneDate(release.registeredAt),
    revokedAt: release.revokedAt ? cloneDate(release.revokedAt) : null,
  };
}

function assertBoundedReferences(
  values: readonly string[],
  field: string,
): void {
  if (values.length > 32) {
    invalid(`${field}_too_many`);
  }
  for (const value of values) {
    assertIdentifier(value, field);
  }
}
