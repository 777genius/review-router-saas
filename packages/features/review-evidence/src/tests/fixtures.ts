import {
  ProviderExecutionProfile,
  ReviewFindingSeverity,
  ReviewObservationQualityFlag,
  ReviewObservationStatus,
  ReviewProviderKind,
  ReviewTaskKind,
  ReviewTrustDomain,
  createReviewObservation,
  prepareReviewObservationPayload,
  providerInvocationManifestVersion,
  reviewEvidencePayloadVersion,
  type ProviderInvocationManifest,
  type ReviewEvidenceScope,
  type ReviewExecutionAttemptFacts,
  type ReviewObservation,
  type ReviewObservationPayload,
  type ReviewRevision,
} from "../index";
import { ReviewExecutionAttemptReportState } from "../application/ports/review-execution-attempt-facts-port";

export const nowMs = Date.UTC(2026, 6, 22, 12, 0, 0);
export const dayMs = 24 * 60 * 60 * 1_000;
export const defaultManifestKey =
  "5b6df3127f1ad247bb9a9597ed4a795c2a0a27e765ac75bd4a5c2c8dc6c8e65b";
export const defaultProviderInvocationKey =
  "997be74c80e81eb01126e72cc371efe2b2a65d7d1a037085bbaab94a61f20bef";

export function hash(character: string): string {
  return character.repeat(64);
}

export function gitSha(character: string): string {
  return character.repeat(40);
}

export function scope(
  overrides: Partial<ReviewEvidenceScope> = {},
): ReviewEvidenceScope {
  return {
    workspaceId: "workspace-1",
    repositoryConnectionId: "connection-1",
    scmRepositoryIdentityId: "scm-repository-1",
    pullRequestNumber: 42,
    authorizationScopeHash: hash("a"),
    ...overrides,
  };
}

export function revision(
  overrides: Partial<ReviewRevision> = {},
): ReviewRevision {
  return {
    baseSha: gitSha("a"),
    mergeBaseSha: gitSha("b"),
    headSha: gitSha("c"),
    reviewRevisionHash: hash("b"),
    ...overrides,
  };
}

export function manifest(
  overrides: Partial<ProviderInvocationManifest> = {},
): ProviderInvocationManifest {
  return {
    manifestVersion: providerInvocationManifestVersion,
    scopeHash: hash("c"),
    taskKindSet: [ReviewTaskKind.FindingDiscovery],
    providerKind: ReviewProviderKind.Codex,
    providerCapabilityHash: hash("d"),
    requestedModel: "gpt-5.3-codex",
    providerPolicyVersion: "provider-policy-v1",
    producerReleaseId: "release-1",
    selectedProtocolVersion: "review-action-v2",
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
    executionProfile: ProviderExecutionProfile.AgenticUnboundedV1,
    baseTreeHash: hash("6"),
    environmentContractHash: hash("7"),
    ...overrides,
  };
}

export function payload(
  overrides: Partial<ReviewObservationPayload> = {},
): ReviewObservationPayload {
  return {
    payloadVersion: reviewEvidencePayloadVersion,
    normalizedFindings: [
      {
        category: "correctness",
        normalizedFailureModeHash: hash("8"),
        severity: ReviewFindingSeverity.Major,
        title: "Lost update",
        message: "The compare-and-write is not fenced.",
        evidence: ["Concurrent writer can overwrite the value."],
        path: "src/store.ts",
        startLine: 10,
        endLine: 12,
        placementConfidence: 0.95,
        suggestion: "Fence the compare-and-write.",
      },
    ],
    normalizedLifecycleRevalidations: [],
    safeUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    ...overrides,
  };
}

export function attemptFacts(
  overrides: Partial<ReviewExecutionAttemptFacts> = {},
): ReviewExecutionAttemptFacts {
  const invocationManifest = overrides.manifest ?? manifest();
  return {
    attemptId: "attempt-1",
    scope: scope(),
    revision: revision(),
    planHash: hash("9"),
    sourceExecutionId: "execution-source-1",
    sourceWorkSlotId: "work-slot-1",
    sourceAuthorizationId: "authorization-1",
    sourceRunId: "run-1",
    sourceRunAttempt: "1",
    manifest: invocationManifest,
    manifestKey: defaultManifestKey,
    providerInvocationKey: defaultProviderInvocationKey,
    providerVoteIdentityHash: hash("c"),
    providerKind: invocationManifest.providerKind,
    taskKindSet: invocationManifest.taskKindSet,
    requestedModel: invocationManifest.requestedModel,
    providerRuntimeVersion: "runtime-v1",
    producerReleaseId: invocationManifest.producerReleaseId,
    selectedProtocolVersion: invocationManifest.selectedProtocolVersion,
    trustedCapabilityProfile: "trusted-capability-v1",
    executionProfile: invocationManifest.executionProfile,
    trustDomain: ReviewTrustDomain.TrustedManaged,
    sourceLeaseId: "lease-1",
    leaseCapabilityId: "lease-capability-1",
    ownerIdHash: hash("d"),
    sourceFencingToken: "1001",
    resultReportUntilMs: nowMs + 60_000,
    reportState: ReviewExecutionAttemptReportState.Reportable,
    ...overrides,
  };
}

export function observation(
  overrides: Partial<ReviewObservation> = {},
): ReviewObservation {
  const observationPayload = overrides.payload ?? payload();
  const prepared = prepareReviewObservationPayload(observationPayload);
  const sourceManifest = manifest({
    executionProfile:
      overrides.executionProfile ?? ProviderExecutionProfile.AgenticUnboundedV1,
    taskKindSet: overrides.taskKindSet ?? [ReviewTaskKind.FindingDiscovery],
  });
  const contextDependencyAttestationId =
    sourceManifest.executionProfile ===
    ProviderExecutionProfile.ContextGatewayV1
      ? "context-attestation-1"
      : null;
  return createReviewObservation({
    observationId: "observation-1",
    scope: scope(),
    manifestKey: defaultManifestKey,
    providerInvocationKey: defaultProviderInvocationKey,
    providerVoteIdentityHash: hash("c"),
    manifestVersion: sourceManifest.manifestVersion,
    taskKindSet: sourceManifest.taskKindSet,
    sourceRevision: revision(),
    sourcePlanHash: hash("9"),
    sourceExecutionId: "execution-source-1",
    sourceWorkSlotId: "work-slot-1",
    sourceAuthorizationId: "authorization-1",
    evidenceWriteSafetyDecisionHash: hash("d"),
    sourceRunId: "run-1",
    sourceRunAttempt: "1",
    providerKind: sourceManifest.providerKind,
    requestedModel: sourceManifest.requestedModel,
    actualModel: sourceManifest.requestedModel,
    providerRuntimeVersion: "runtime-v1",
    producerReleaseId: sourceManifest.producerReleaseId,
    selectedProtocolVersion: sourceManifest.selectedProtocolVersion,
    trustedCapabilityProfile: "trusted-capability-v1",
    executionProfile: sourceManifest.executionProfile,
    attemptId: "attempt-1",
    sourceLeaseId: "lease-1",
    sourceFencingToken: "1001",
    status: ReviewObservationStatus.Success,
    payload: observationPayload,
    payloadHash: hash("e"),
    byteCount: prepared.byteCount,
    findingCount: prepared.findingCount,
    qualityFlags: [ReviewObservationQualityFlag.ProviderWarning],
    transportAttemptCount: 1,
    contextDependencyAttestationId,
    contextDependencyAttestationHash:
      contextDependencyAttestationId === null ? null : hash("7"),
    trustDomain: ReviewTrustDomain.TrustedManaged,
    createdAtMs: nowMs,
    reuseExpiresAtMs: nowMs + 7 * dayMs,
    retainUntilMs: nowMs + 30 * dayMs,
    ...overrides,
  });
}
