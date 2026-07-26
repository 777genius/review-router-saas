import {
  Prisma,
  ProviderExecutionProfileV2 as PrismaExecutionProfile,
  ReviewProviderKindV2 as PrismaProviderKind,
  ReviewTaskKindV2 as PrismaTaskKind,
  ReviewTrustDomainV2 as PrismaTrustDomain,
  type PrismaClient,
  type ReviewEvidenceObservation as ReviewEvidenceObservationRecord,
} from "@prisma/client";
import {
  ReviewObservationAcceptPersistenceStatus,
  type ReviewEvidencePrunerPort,
  type ReviewObservationAcceptPersistenceResult,
  type ReviewObservationCommandPort,
  type ReviewObservationQueryPort,
} from "../../application/ports/review-observation-ports";
import {
  ProviderExecutionProfile,
  ReviewFindingSeverity,
  ReviewLifecycleRevalidationVerdict,
  ReviewObservationQualityFlag,
  ReviewObservationStatus,
  ReviewProviderKind,
  ReviewTaskKind,
  ReviewTrustDomain,
} from "../../domain/review-evidence-primitives";
import {
  createReviewObservation,
  sameReviewObservationAcceptance,
  type NormalizedReviewFinding,
  type NormalizedLifecycleRevalidation,
  type ReviewObservation,
  type ReviewObservationPayload,
} from "../../domain/review-observation";

export class PrismaReviewObservationStore
  implements
    ReviewObservationCommandPort,
    ReviewObservationQueryPort,
    ReviewEvidencePrunerPort
{
  constructor(private readonly prisma: PrismaClient) {}

  async acceptObservation(
    observation: ReviewObservation,
  ): Promise<ReviewObservationAcceptPersistenceResult> {
    try {
      const created = await this.prisma.reviewEvidenceObservation.create({
        data: toCreateInput(observation),
      });
      return Object.freeze({
        status: ReviewObservationAcceptPersistenceStatus.Accepted,
        observation: toDomain(created),
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      return this.resolveExisting(observation);
    }
  }

  async findCandidates(
    input: Parameters<ReviewObservationQueryPort["findCandidates"]>[0],
  ): Promise<readonly ReviewObservation[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
      throw new Error("review_observation_query_limit_invalid");
    }
    const records = await this.prisma.reviewEvidenceObservation.findMany({
      where: {
        workspaceId: input.scope.workspaceId,
        repositoryConnectionId: input.scope.repositoryConnectionId,
        scmRepositoryIdentityId: input.scope.scmRepositoryIdentityId,
        pullRequestNumber: input.scope.pullRequestNumber,
        authorizationScopeHash: input.scope.authorizationScopeHash,
        trustDomain: toPrismaTrustDomain(input.trustDomain),
        providerInvocationKey: input.providerInvocationKey,
        reuseExpiresAt: { gt: new Date(input.reusableAfterMs) },
      },
      orderBy: [{ createdAt: "desc" }, { observationId: "asc" }],
      take: input.limit,
    });
    return Object.freeze(records.map(toDomain));
  }

  async findById(observationId: string): Promise<ReviewObservation | null> {
    const record = await this.prisma.reviewEvidenceObservation.findUnique({
      where: { observationId },
    });
    return record === null ? null : toDomain(record);
  }

  async pruneRetainedObservations(
    input: Parameters<ReviewEvidencePrunerPort["pruneRetainedObservations"]>[0],
  ): Promise<number> {
    if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
      throw new Error("review_observation_prune_limit_invalid");
    }
    const removed = await this.prisma.$queryRaw<
      Array<{ observationId: string }>
    >(Prisma.sql`
      WITH removable AS (
        SELECT observation."observationId"
        FROM "ReviewEvidenceObservation" AS observation
        WHERE observation."retainUntil" <= ${new Date(input.retainUntilOrBeforeMs)}
          AND NOT EXISTS (
            SELECT 1
            FROM "ReviewExecutionObservationRefV2" AS reference
            WHERE reference."observationId" = observation."observationId"
          )
        ORDER BY observation."retainUntil" ASC, observation."observationId" ASC
        LIMIT ${input.limit}
        FOR UPDATE SKIP LOCKED
      )
      DELETE FROM "ReviewEvidenceObservation" AS observation
      USING removable
      WHERE observation."observationId" = removable."observationId"
      RETURNING observation."observationId"
    `);
    return removed.length;
  }

  private async resolveExisting(
    candidate: ReviewObservation,
  ): Promise<ReviewObservationAcceptPersistenceResult> {
    const existing = await this.prisma.reviewEvidenceObservation.findFirst({
      where: {
        OR: [
          { observationId: candidate.observationId },
          {
            sourceExecutionId: candidate.sourceExecutionId,
            providerVoteIdentityHash: candidate.providerVoteIdentityHash,
            attemptId: candidate.attemptId,
          },
        ],
      },
      orderBy: { observationId: "asc" },
    });
    if (!existing) {
      throw new Error("review_observation_unique_conflict_missing");
    }
    const observation = toDomain(existing);
    if (!sameReviewObservationAcceptance(observation, candidate)) {
      return Object.freeze({
        status: ReviewObservationAcceptPersistenceStatus.Conflict,
      });
    }
    return Object.freeze({
      status: ReviewObservationAcceptPersistenceStatus.Idempotent,
      observation,
    });
  }
}

function toCreateInput(
  observation: ReviewObservation,
): Prisma.ReviewEvidenceObservationUncheckedCreateInput {
  return {
    observationId: observation.observationId,
    workspaceId: observation.scope.workspaceId,
    repositoryConnectionId: observation.scope.repositoryConnectionId,
    scmRepositoryIdentityId: observation.scope.scmRepositoryIdentityId,
    pullRequestNumber: observation.scope.pullRequestNumber,
    manifestKey: observation.manifestKey,
    providerInvocationKey: observation.providerInvocationKey,
    providerVoteIdentityHash: observation.providerVoteIdentityHash,
    manifestVersion: observation.manifestVersion,
    providerKind: toPrismaProviderKind(observation.providerKind),
    requestedModel: observation.requestedModel,
    actualModel: observation.actualModel,
    providerRuntimeVersion: observation.providerRuntimeVersion,
    taskKindSet: observation.taskKindSet.map(toPrismaTaskKind),
    producerReleaseId: observation.producerReleaseId,
    selectedProtocolVersion: observation.selectedProtocolVersion,
    trustedCapabilityProfile: observation.trustedCapabilityProfile,
    executionProfile: toPrismaExecutionProfile(observation.executionProfile),
    trustDomain: toPrismaTrustDomain(observation.trustDomain),
    authorizationScopeHash: observation.scope.authorizationScopeHash,
    sourceBaseSha: observation.sourceRevision.baseSha,
    sourceMergeBaseSha: observation.sourceRevision.mergeBaseSha,
    sourceHeadSha: observation.sourceRevision.headSha,
    sourceReviewRevisionHash: observation.sourceRevision.reviewRevisionHash,
    sourcePlanHash: observation.sourcePlanHash,
    sourceExecutionId: observation.sourceExecutionId,
    sourceWorkSlotId: observation.sourceWorkSlotId,
    sourceAuthorizationId: observation.sourceAuthorizationId,
    evidenceWriteSafetyDecisionHash:
      observation.evidenceWriteSafetyDecisionHash,
    sourceRunId: observation.sourceRunId,
    sourceRunAttempt: observation.sourceRunAttempt,
    attemptId: observation.attemptId,
    sourceLeaseId: observation.sourceLeaseId,
    sourceFencingToken: BigInt(observation.sourceFencingToken),
    payloadJson: toPrismaPayload(observation.payload),
    payloadHash: observation.payloadHash,
    byteCount: observation.byteCount,
    findingCount: observation.findingCount,
    qualityFlagsJson: observation.qualityFlags,
    transportAttemptCount: observation.transportAttemptCount,
    contextDependencyAttestationId: observation.contextDependencyAttestationId,
    contextDependencyAttestationHash:
      observation.contextDependencyAttestationHash,
    createdAt: new Date(observation.createdAtMs),
    reuseExpiresAt: new Date(observation.reuseExpiresAtMs),
    retainUntil: new Date(observation.retainUntilMs),
  };
}

function toDomain(record: ReviewEvidenceObservationRecord): ReviewObservation {
  return createReviewObservation({
    observationId: record.observationId,
    scope: {
      workspaceId: record.workspaceId,
      repositoryConnectionId: record.repositoryConnectionId,
      scmRepositoryIdentityId: record.scmRepositoryIdentityId,
      pullRequestNumber: record.pullRequestNumber,
      authorizationScopeHash: record.authorizationScopeHash,
    },
    manifestKey: record.manifestKey,
    providerInvocationKey: record.providerInvocationKey,
    providerVoteIdentityHash: record.providerVoteIdentityHash,
    manifestVersion: record.manifestVersion,
    taskKindSet: record.taskKindSet.map(fromPrismaTaskKind),
    sourceRevision: {
      baseSha: record.sourceBaseSha,
      mergeBaseSha: record.sourceMergeBaseSha,
      headSha: record.sourceHeadSha,
      reviewRevisionHash: record.sourceReviewRevisionHash,
    },
    sourcePlanHash: record.sourcePlanHash,
    sourceExecutionId: record.sourceExecutionId,
    sourceWorkSlotId: record.sourceWorkSlotId,
    sourceAuthorizationId: record.sourceAuthorizationId,
    evidenceWriteSafetyDecisionHash: record.evidenceWriteSafetyDecisionHash,
    sourceRunId: record.sourceRunId,
    sourceRunAttempt: record.sourceRunAttempt,
    providerKind: fromPrismaProviderKind(record.providerKind),
    requestedModel: record.requestedModel,
    actualModel: record.actualModel,
    providerRuntimeVersion: record.providerRuntimeVersion,
    producerReleaseId: record.producerReleaseId,
    selectedProtocolVersion: record.selectedProtocolVersion,
    trustedCapabilityProfile: record.trustedCapabilityProfile,
    executionProfile: fromPrismaExecutionProfile(record.executionProfile),
    attemptId: record.attemptId,
    sourceLeaseId: record.sourceLeaseId,
    sourceFencingToken: record.sourceFencingToken.toString(),
    status: ReviewObservationStatus.Success,
    payload: decodePayload(record.payloadJson),
    payloadHash: record.payloadHash,
    byteCount: record.byteCount,
    findingCount: record.findingCount,
    qualityFlags: decodeQualityFlags(record.qualityFlagsJson),
    transportAttemptCount: record.transportAttemptCount,
    contextDependencyAttestationId: record.contextDependencyAttestationId,
    contextDependencyAttestationHash: record.contextDependencyAttestationHash,
    trustDomain: fromPrismaTrustDomain(record.trustDomain),
    createdAtMs: record.createdAt.getTime(),
    reuseExpiresAtMs: record.reuseExpiresAt.getTime(),
    retainUntilMs: record.retainUntil.getTime(),
  });
}

function toPrismaPayload(
  payload: ReviewObservationPayload,
): Prisma.InputJsonObject {
  return {
    payloadVersion: payload.payloadVersion,
    normalizedFindings: payload.normalizedFindings.map((finding) => ({
      category: finding.category,
      normalizedFailureModeHash: finding.normalizedFailureModeHash,
      severity: finding.severity,
      title: finding.title,
      message: finding.message,
      evidence: [...finding.evidence],
      path: finding.path,
      startLine: finding.startLine,
      endLine: finding.endLine,
      placementConfidence: finding.placementConfidence,
      suggestion: finding.suggestion,
    })),
    normalizedLifecycleRevalidations:
      payload.normalizedLifecycleRevalidations.map((revalidation) => ({
        targetId: revalidation.targetId,
        fingerprint: revalidation.fingerprint,
        verdict: revalidation.verdict,
        confidence: revalidation.confidence,
        evidence: revalidation.evidence.map((item) => ({
          path: item.path,
          startLine: item.startLine,
          endLine: item.endLine,
          reason: item.reason,
        })),
        rationale: revalidation.rationale,
      })),
    safeUsage: {
      inputTokens: payload.safeUsage.inputTokens,
      outputTokens: payload.safeUsage.outputTokens,
      totalTokens: payload.safeUsage.totalTokens,
    },
  };
}

function decodePayload(value: Prisma.JsonValue): ReviewObservationPayload {
  const record = requireRecord(value, "review_observation_payload_invalid");
  if (
    record.payloadVersion !== 2 ||
    !Array.isArray(record.normalizedFindings) ||
    !Array.isArray(record.normalizedLifecycleRevalidations)
  ) {
    throw new Error("review_observation_payload_invalid");
  }
  const usage = requireRecord(
    record.safeUsage,
    "review_observation_safe_usage_invalid",
  );
  return {
    payloadVersion: 2,
    normalizedFindings: record.normalizedFindings.map(decodeFinding),
    normalizedLifecycleRevalidations:
      record.normalizedLifecycleRevalidations.map(decodeRevalidation),
    safeUsage: {
      inputTokens: nullableNumber(usage.inputTokens),
      outputTokens: nullableNumber(usage.outputTokens),
      totalTokens: nullableNumber(usage.totalTokens),
    },
  };
}

function decodeFinding(value: Prisma.JsonValue): NormalizedReviewFinding {
  const record = requireRecord(value, "review_observation_finding_invalid");
  if (!Array.isArray(record.evidence)) {
    throw new Error("review_observation_finding_invalid");
  }
  return {
    category: requireString(record.category),
    normalizedFailureModeHash: requireString(record.normalizedFailureModeHash),
    severity: decodeFindingSeverity(record.severity),
    title: requireString(record.title),
    message: requireString(record.message),
    evidence: record.evidence.map(requireString),
    path: nullableString(record.path),
    startLine: nullableNumber(record.startLine),
    endLine: nullableNumber(record.endLine),
    placementConfidence: nullableNumber(record.placementConfidence),
    suggestion: nullableString(record.suggestion),
  };
}

function decodeRevalidation(
  value: Prisma.JsonValue,
): NormalizedLifecycleRevalidation {
  const record = requireRecord(
    value,
    "review_observation_lifecycle_revalidation_invalid",
  );
  if (!Array.isArray(record.evidence)) {
    throw new Error("review_observation_lifecycle_revalidation_invalid");
  }
  return {
    targetId: requireString(record.targetId),
    fingerprint: nullableString(record.fingerprint),
    verdict: decodeRevalidationVerdict(record.verdict),
    confidence: nullableNumber(record.confidence),
    evidence: record.evidence.map((item) => {
      const evidence = requireRecord(
        item,
        "review_observation_lifecycle_evidence_invalid",
      );
      return {
        path: requireString(evidence.path),
        startLine: nullableNumber(evidence.startLine),
        endLine: nullableNumber(evidence.endLine),
        reason: requireString(evidence.reason),
      };
    }),
    rationale: nullableString(record.rationale),
  };
}

function decodeQualityFlags(
  value: Prisma.JsonValue,
): ReviewObservationQualityFlag[] {
  if (!Array.isArray(value)) {
    throw new Error("review_observation_quality_flags_invalid");
  }
  return value.map((entry) => {
    if (
      typeof entry !== "string" ||
      !Object.hasOwn(decodableQualityFlags, entry) ||
      !decodableQualityFlags[entry as ReviewObservationQualityFlag]
    ) {
      throw new Error(`review_observation_quality_flag_invalid:${String(entry)}`);
    }
    return entry as ReviewObservationQualityFlag;
  });
}

const decodableQualityFlags = {
  [ReviewObservationQualityFlag.ModelFallback]: true,
  [ReviewObservationQualityFlag.LowConfidence]: true,
  [ReviewObservationQualityFlag.ProviderWarning]: true,
  [ReviewObservationQualityFlag.ContextInspectionIncomplete]: true,
  [ReviewObservationQualityFlag.ContextAttestationUnavailable]: true,
  [ReviewObservationQualityFlag.CrossRevisionReuseDisabled]: true,
  [ReviewObservationQualityFlag.Unknown]: false,
} as const satisfies Record<ReviewObservationQualityFlag, boolean>;

function decodeFindingSeverity(
  value: Prisma.JsonValue | undefined,
): ReviewFindingSeverity {
  switch (value) {
    case ReviewFindingSeverity.Critical:
    case ReviewFindingSeverity.Major:
    case ReviewFindingSeverity.Minor:
      return value;
    default:
      throw new Error("review_observation_finding_severity_invalid");
  }
}

function decodeRevalidationVerdict(
  value: Prisma.JsonValue | undefined,
): ReviewLifecycleRevalidationVerdict {
  switch (value) {
    case ReviewLifecycleRevalidationVerdict.Resolved:
    case ReviewLifecycleRevalidationVerdict.StillValid:
    case ReviewLifecycleRevalidationVerdict.Uncertain:
      return value;
    default:
      throw new Error(
        "review_observation_lifecycle_revalidation_verdict_invalid",
      );
  }
}

function toPrismaProviderKind(value: ReviewProviderKind): PrismaProviderKind {
  switch (value) {
    case ReviewProviderKind.Codex:
      return PrismaProviderKind.codex;
    case ReviewProviderKind.ClaudeCode:
      return PrismaProviderKind.claude_code;
    case ReviewProviderKind.OpenRouter:
      return PrismaProviderKind.openrouter;
    case ReviewProviderKind.Unknown:
      throw new Error("review_observation_provider_kind_unknown");
  }
}

function fromPrismaProviderKind(value: PrismaProviderKind): ReviewProviderKind {
  switch (value) {
    case PrismaProviderKind.codex:
      return ReviewProviderKind.Codex;
    case PrismaProviderKind.claude_code:
      return ReviewProviderKind.ClaudeCode;
    case PrismaProviderKind.openrouter:
      return ReviewProviderKind.OpenRouter;
  }
}

function toPrismaTaskKind(value: ReviewTaskKind): PrismaTaskKind {
  switch (value) {
    case ReviewTaskKind.FindingDiscovery:
      return PrismaTaskKind.finding_discovery;
    case ReviewTaskKind.LifecycleRevalidation:
      return PrismaTaskKind.lifecycle_revalidation;
    case ReviewTaskKind.Unknown:
      throw new Error("review_observation_task_kind_unknown");
  }
}

function fromPrismaTaskKind(value: PrismaTaskKind): ReviewTaskKind {
  switch (value) {
    case PrismaTaskKind.finding_discovery:
      return ReviewTaskKind.FindingDiscovery;
    case PrismaTaskKind.lifecycle_revalidation:
      return ReviewTaskKind.LifecycleRevalidation;
    case PrismaTaskKind.code_review:
    case PrismaTaskKind.finding_revalidation:
    case PrismaTaskKind.conflict_review:
      throw new Error(`review_observation_task_kind_unsupported:${value}`);
  }
}

function toPrismaExecutionProfile(
  value: ProviderExecutionProfile,
): PrismaExecutionProfile {
  switch (value) {
    case ProviderExecutionProfile.PromptOnlyEnvelopeV1:
      return PrismaExecutionProfile.prompt_only_envelope_v1;
    case ProviderExecutionProfile.AgenticUnboundedV1:
      return PrismaExecutionProfile.agentic_unbounded_v1;
    case ProviderExecutionProfile.ContextGatewayV1:
      return PrismaExecutionProfile.context_gateway_v1;
    case ProviderExecutionProfile.Unknown:
      throw new Error("review_observation_execution_profile_unknown");
  }
}

function fromPrismaExecutionProfile(
  value: PrismaExecutionProfile,
): ProviderExecutionProfile {
  switch (value) {
    case PrismaExecutionProfile.prompt_only_envelope_v1:
      return ProviderExecutionProfile.PromptOnlyEnvelopeV1;
    case PrismaExecutionProfile.agentic_unbounded_v1:
      return ProviderExecutionProfile.AgenticUnboundedV1;
    case PrismaExecutionProfile.context_gateway_v1:
      return ProviderExecutionProfile.ContextGatewayV1;
  }
}

function toPrismaTrustDomain(value: ReviewTrustDomain): PrismaTrustDomain {
  switch (value) {
    case ReviewTrustDomain.TrustedManaged:
      return PrismaTrustDomain.trusted_managed;
    case ReviewTrustDomain.TrustedLocal:
      return PrismaTrustDomain.trusted_local;
    case ReviewTrustDomain.UntrustedContribution:
      return PrismaTrustDomain.untrusted_contribution;
    case ReviewTrustDomain.Unknown:
      throw new Error("review_observation_trust_domain_unknown");
  }
}

function fromPrismaTrustDomain(value: PrismaTrustDomain): ReviewTrustDomain {
  switch (value) {
    case PrismaTrustDomain.trusted_managed:
      return ReviewTrustDomain.TrustedManaged;
    case PrismaTrustDomain.trusted_local:
      return ReviewTrustDomain.TrustedLocal;
    case PrismaTrustDomain.untrusted_contribution:
      return ReviewTrustDomain.UntrustedContribution;
  }
}

function requireRecord(
  value: Prisma.JsonValue | undefined,
  errorCode: string,
): Prisma.JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(errorCode);
  }
  return value;
}

function requireString(value: Prisma.JsonValue | undefined): string {
  if (typeof value !== "string") {
    throw new Error("review_observation_json_string_invalid");
  }
  return value;
}

function nullableString(value: Prisma.JsonValue | undefined): string | null {
  if (value === null) return null;
  return requireString(value);
}

function nullableNumber(value: Prisma.JsonValue | undefined): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("review_observation_json_number_invalid");
  }
  return value;
}

function isUniqueConstraintError(
  error: unknown,
): error is Prisma.PrismaClientKnownRequestError {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}
