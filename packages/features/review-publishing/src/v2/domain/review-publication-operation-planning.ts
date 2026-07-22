import {
  ReviewPublicationEffectStrategy,
  ReviewPublicationKind,
  ReviewPublicationOperationRole,
  assertFiniteDate,
  assertHash,
  assertIdentifier,
  assertNonNegativeInteger,
  assertPositiveInteger,
  type ReviewPublicationOperationPlan,
} from "./review-publication-attempt";

export const publishedReviewProjectionPublicationEnvelopeVersion = 1 as const;

export enum ReviewPublicationProjectionCoverage {
  Completed = "completed",
  Partial = "partial",
}

export enum ReviewPublicationSummarySemantic {
  Findings = "findings",
  AllClear = "all_clear",
  PartialCoverage = "partial_coverage",
}

export enum ReviewPublicationInlineReviewDelivery {
  PendingThenSubmit = "pending_then_submit",
  Submitted = "submitted",
}

export enum ReviewPublicationLifecycleSemantic {
  Resolve = "resolve",
  Reopen = "reopen",
  MarkStale = "mark_stale",
}

export type CanonicalReviewPublicationBodyFacts = {
  readonly markerHash: string;
  readonly bodyHash: string;
  readonly bodyByteCount: number;
};

export type PublishedReviewSummary = CanonicalReviewPublicationBodyFacts & {
  readonly semantic: ReviewPublicationSummarySemantic;
};

export type PublishedReviewManagedCheck = CanonicalReviewPublicationBodyFacts;

export type PublishedPendingInlineReview = {
  readonly chunkIndex: number;
  readonly delivery: ReviewPublicationInlineReviewDelivery.PendingThenSubmit;
  readonly create: CanonicalReviewPublicationBodyFacts;
  readonly submit: CanonicalReviewPublicationBodyFacts;
};

export type PublishedSubmittedInlineReview = {
  readonly chunkIndex: number;
  readonly delivery: ReviewPublicationInlineReviewDelivery.Submitted;
  readonly body: CanonicalReviewPublicationBodyFacts;
};

export type PublishedInlineReview =
  | PublishedPendingInlineReview
  | PublishedSubmittedInlineReview;

export type PublishedReviewLifecycleMutation =
  CanonicalReviewPublicationBodyFacts & {
    readonly chunkIndex: number;
    readonly semantic: ReviewPublicationLifecycleSemantic;
  };

/**
 * Publishing-owned Published Language. A completion anti-corruption adapter must
 * construct this from the finalized projection; this context never parses the
 * projection's opaque Action JSON.
 */
export type PublishedReviewProjectionPublicationEnvelope = {
  readonly envelopeVersion: typeof publishedReviewProjectionPublicationEnvelopeVersion;
  readonly producerReleaseId: string;
  readonly protocolLimitsProfileId: string;
  readonly limitsDigest: string;
  readonly projectionHash: string;
  readonly coverage: ReviewPublicationProjectionCoverage;
  readonly targetCommitId: string;
  readonly reviewRevisionHash: string;
  readonly renderPolicyVersion: number;
  readonly publicationNotAfter: Date;
  readonly summary: PublishedReviewSummary;
  readonly managedCheck: PublishedReviewManagedCheck | null;
  readonly inlineReviews: readonly PublishedInlineReview[];
  readonly lifecycle: readonly PublishedReviewLifecycleMutation[];
};

export type ReviewPublicationPlanningLimits = {
  readonly producerReleaseId: string;
  readonly protocolLimitsProfileId: string;
  readonly limitsDigest: string;
  readonly maxPublicationOperations: number;
  readonly maxPublicationChunks: number;
  readonly maxPublicationBodyBytes: number;
  readonly maxReconciliationDurationMs: number;
};

export enum ReviewPublicationPlanningErrorCode {
  EnvelopeVersionUnsupported = "publication_planning_envelope_version_unsupported",
  EnvelopeInvalid = "publication_planning_envelope_invalid",
  ReleaseLimitsUnavailable = "publication_planning_release_limits_unavailable",
  ReleaseLimitsInvalid = "publication_planning_release_limits_invalid",
  ReleaseLimitsMismatch = "publication_planning_release_limits_mismatch",
  CoverageInvalid = "publication_planning_coverage_invalid",
  PartialCoverageViolation = "publication_planning_partial_coverage_violation",
  SummarySemanticUnsupported = "publication_planning_summary_semantic_unsupported",
  CanonicalBodyFactsInvalid = "publication_planning_canonical_body_facts_invalid",
  ChunkOrderInvalid = "publication_planning_chunk_order_invalid",
  InlineDeliveryUnsupported = "publication_planning_inline_delivery_unsupported",
  LifecycleSemanticUnsupported = "publication_planning_lifecycle_semantic_unsupported",
  DuplicateMarker = "publication_planning_duplicate_marker",
  OperationLimitExceeded = "publication_planning_operation_limit_exceeded",
  ChunkLimitExceeded = "publication_planning_chunk_limit_exceeded",
  BodyLimitExceeded = "publication_planning_body_limit_exceeded",
  ReconciliationWindowInvalid = "publication_planning_reconciliation_window_invalid",
}

export class ReviewPublicationPlanningError extends Error {
  constructor(readonly code: ReviewPublicationPlanningErrorCode) {
    super(code);
    this.name = "ReviewPublicationPlanningError";
  }
}

export function planReviewPublicationOperations(input: {
  readonly envelope: PublishedReviewProjectionPublicationEnvelope;
  readonly limits: ReviewPublicationPlanningLimits;
}): readonly ReviewPublicationOperationPlan[] {
  const { envelope, limits } = input;
  assertPublishedReviewProjectionPublicationEnvelopeIdentity(envelope);
  assertPlanningLimits(limits);
  assertReleaseBinding(envelope, limits);
  assertSummarySemantic(envelope.summary.semantic);
  assertCoveragePolicy(envelope);
  assertCanonicalChunkOrder(envelope.inlineReviews);
  assertCanonicalChunkOrder(envelope.lifecycle);

  const reconcileUntil = calculateReconcileUntil(
    envelope.publicationNotAfter,
    limits.maxReconciliationDurationMs,
  );
  const markers = new Set<string>();
  let totalBodyBytes = 0;
  let chunkCount = 0;
  const operations: ReviewPublicationOperationPlan[] = [];

  const append = (input: {
    readonly publicationKind: ReviewPublicationKind;
    readonly chunkIndex: number;
    readonly facts: CanonicalReviewPublicationBodyFacts;
    readonly effectStrategy: ReviewPublicationEffectStrategy;
    readonly role: ReviewPublicationOperationRole;
    readonly dependsOnOperationId: string | null;
  }): ReviewPublicationOperationPlan => {
    assertCanonicalBodyFacts(input.facts);
    if (markers.has(input.facts.markerHash)) {
      fail(ReviewPublicationPlanningErrorCode.DuplicateMarker);
    }
    markers.add(input.facts.markerHash);
    totalBodyBytes = safeAddBodyBytes(
      totalBodyBytes,
      input.facts.bodyByteCount,
    );
    const operation: ReviewPublicationOperationPlan = {
      publicationOperationId: operationId(
        envelope.projectionHash,
        input.publicationKind,
        input.chunkIndex,
      ),
      publicationKind: input.publicationKind,
      chunkIndex: input.chunkIndex,
      effectStrategy: input.effectStrategy,
      role: input.role,
      markerHash: input.facts.markerHash,
      bodyHash: input.facts.bodyHash,
      renderPolicyVersion: envelope.renderPolicyVersion,
      targetCommitId: envelope.targetCommitId,
      reviewRevisionHash: envelope.reviewRevisionHash,
      required: true,
      dependsOnOperationId: input.dependsOnOperationId,
      reconcileUntil,
    };
    operations.push(operation);
    return operation;
  };

  chunkCount += 1;
  append({
    publicationKind: ReviewPublicationKind.Summary,
    chunkIndex: 0,
    facts: envelope.summary,
    effectStrategy: ReviewPublicationEffectStrategy.MutableSingleton,
    role: ReviewPublicationOperationRole.Standalone,
    dependsOnOperationId: null,
  });

  if (envelope.managedCheck !== null) {
    chunkCount += 1;
    append({
      publicationKind: ReviewPublicationKind.ManagedCheck,
      chunkIndex: 0,
      facts: envelope.managedCheck,
      effectStrategy: ReviewPublicationEffectStrategy.MutableSingleton,
      role: ReviewPublicationOperationRole.Standalone,
      dependsOnOperationId: null,
    });
  }

  for (const inlineReview of envelope.inlineReviews) {
    chunkCount += 1;
    switch (inlineReview.delivery) {
      case ReviewPublicationInlineReviewDelivery.PendingThenSubmit: {
        const create = append({
          publicationKind: ReviewPublicationKind.PendingReviewCreate,
          chunkIndex: inlineReview.chunkIndex,
          facts: inlineReview.create,
          effectStrategy: ReviewPublicationEffectStrategy.PendingThenSubmit,
          role: ReviewPublicationOperationRole.PendingReviewCreate,
          dependsOnOperationId: null,
        });
        append({
          publicationKind: ReviewPublicationKind.PendingReviewSubmit,
          chunkIndex: inlineReview.chunkIndex,
          facts: inlineReview.submit,
          effectStrategy: ReviewPublicationEffectStrategy.PendingThenSubmit,
          role: ReviewPublicationOperationRole.PendingReviewSubmit,
          dependsOnOperationId: create.publicationOperationId,
        });
        break;
      }
      case ReviewPublicationInlineReviewDelivery.Submitted:
        append({
          publicationKind: ReviewPublicationKind.SubmittedReview,
          chunkIndex: inlineReview.chunkIndex,
          facts: inlineReview.body,
          effectStrategy:
            ReviewPublicationEffectStrategy.AppendOnlyCanonicalReceipt,
          role: ReviewPublicationOperationRole.Standalone,
          dependsOnOperationId: null,
        });
        break;
      default:
        fail(ReviewPublicationPlanningErrorCode.InlineDeliveryUnsupported);
    }
  }

  for (const lifecycle of envelope.lifecycle) {
    assertLifecycleSemantic(lifecycle.semantic);
    chunkCount += 1;
    append({
      publicationKind: ReviewPublicationKind.ThreadLifecycle,
      chunkIndex: lifecycle.chunkIndex,
      facts: lifecycle,
      effectStrategy: ReviewPublicationEffectStrategy.ReversibleLifecycle,
      role: ReviewPublicationOperationRole.Standalone,
      dependsOnOperationId: null,
    });
  }

  if (operations.length > limits.maxPublicationOperations) {
    fail(ReviewPublicationPlanningErrorCode.OperationLimitExceeded);
  }
  if (chunkCount > limits.maxPublicationChunks) {
    fail(ReviewPublicationPlanningErrorCode.ChunkLimitExceeded);
  }
  if (totalBodyBytes > limits.maxPublicationBodyBytes) {
    fail(ReviewPublicationPlanningErrorCode.BodyLimitExceeded);
  }

  return operations.map(cloneOperationPlan);
}

export function assertPublishedReviewProjectionPublicationEnvelopeIdentity(
  envelope: PublishedReviewProjectionPublicationEnvelope,
): void {
  if (
    !isRecord(envelope) ||
    !isRecord(envelope.summary) ||
    !(envelope.managedCheck === null || isRecord(envelope.managedCheck)) ||
    !Array.isArray(envelope.inlineReviews) ||
    !envelope.inlineReviews.every(isRecord) ||
    !Array.isArray(envelope.lifecycle) ||
    !envelope.lifecycle.every(isRecord)
  ) {
    fail(ReviewPublicationPlanningErrorCode.EnvelopeInvalid);
  }
  if (
    envelope.envelopeVersion !==
    publishedReviewProjectionPublicationEnvelopeVersion
  ) {
    fail(ReviewPublicationPlanningErrorCode.EnvelopeVersionUnsupported);
  }
  try {
    assertIdentifier(envelope.producerReleaseId, "producer_release_id");
    assertIdentifier(
      envelope.protocolLimitsProfileId,
      "protocol_limits_profile_id",
    );
    assertHash(envelope.limitsDigest, "limits_digest");
    assertHash(envelope.projectionHash, "projection_hash");
    assertGitObjectId(envelope.targetCommitId, "target_commit_id");
    assertHash(envelope.reviewRevisionHash, "review_revision_hash");
    assertPositiveInteger(
      envelope.renderPolicyVersion,
      "render_policy_version",
    );
    assertFiniteDate(envelope.publicationNotAfter, "publication_not_after");
  } catch {
    fail(ReviewPublicationPlanningErrorCode.EnvelopeInvalid);
  }
}

function assertGitObjectId(value: string, code: string): void {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)) {
    throw new Error(code);
  }
}

function assertSummarySemantic(
  semantic: ReviewPublicationSummarySemantic,
): void {
  switch (semantic) {
    case ReviewPublicationSummarySemantic.Findings:
    case ReviewPublicationSummarySemantic.AllClear:
    case ReviewPublicationSummarySemantic.PartialCoverage:
      return;
    default:
      fail(ReviewPublicationPlanningErrorCode.SummarySemanticUnsupported);
  }
}

function assertPlanningLimits(limits: ReviewPublicationPlanningLimits): void {
  try {
    assertIdentifier(limits.producerReleaseId, "producer_release_id");
    assertIdentifier(
      limits.protocolLimitsProfileId,
      "protocol_limits_profile_id",
    );
    assertHash(limits.limitsDigest, "limits_digest");
    assertPositiveInteger(
      limits.maxPublicationOperations,
      "max_publication_operations",
    );
    assertPositiveInteger(
      limits.maxPublicationChunks,
      "max_publication_chunks",
    );
    assertPositiveInteger(
      limits.maxPublicationBodyBytes,
      "max_publication_body_bytes",
    );
    assertPositiveInteger(
      limits.maxReconciliationDurationMs,
      "max_reconciliation_duration_ms",
    );
  } catch {
    fail(ReviewPublicationPlanningErrorCode.ReleaseLimitsInvalid);
  }
}

function assertReleaseBinding(
  envelope: PublishedReviewProjectionPublicationEnvelope,
  limits: ReviewPublicationPlanningLimits,
): void {
  if (
    envelope.producerReleaseId !== limits.producerReleaseId ||
    envelope.protocolLimitsProfileId !== limits.protocolLimitsProfileId ||
    envelope.limitsDigest !== limits.limitsDigest
  ) {
    fail(ReviewPublicationPlanningErrorCode.ReleaseLimitsMismatch);
  }
}

function assertCoveragePolicy(
  envelope: PublishedReviewProjectionPublicationEnvelope,
): void {
  switch (envelope.coverage) {
    case ReviewPublicationProjectionCoverage.Completed:
      if (
        envelope.summary.semantic ===
        ReviewPublicationSummarySemantic.PartialCoverage
      ) {
        fail(ReviewPublicationPlanningErrorCode.PartialCoverageViolation);
      }
      return;
    case ReviewPublicationProjectionCoverage.Partial:
      if (
        envelope.summary.semantic !==
          ReviewPublicationSummarySemantic.PartialCoverage ||
        envelope.managedCheck !== null ||
        envelope.inlineReviews.length > 0 ||
        envelope.lifecycle.length > 0
      ) {
        fail(ReviewPublicationPlanningErrorCode.PartialCoverageViolation);
      }
      return;
    default:
      fail(ReviewPublicationPlanningErrorCode.CoverageInvalid);
  }
}

function assertCanonicalChunkOrder(
  chunks: readonly { readonly chunkIndex: number }[],
): void {
  chunks.forEach((chunk, index) => {
    try {
      assertNonNegativeInteger(chunk.chunkIndex, "chunk_index");
    } catch {
      fail(ReviewPublicationPlanningErrorCode.ChunkOrderInvalid);
    }
    if (chunk.chunkIndex !== index) {
      fail(ReviewPublicationPlanningErrorCode.ChunkOrderInvalid);
    }
  });
}

function assertCanonicalBodyFacts(
  facts: CanonicalReviewPublicationBodyFacts,
): void {
  try {
    assertHash(facts.markerHash, "marker_hash");
    assertHash(facts.bodyHash, "body_hash");
    assertNonNegativeInteger(facts.bodyByteCount, "body_byte_count");
  } catch {
    fail(ReviewPublicationPlanningErrorCode.CanonicalBodyFactsInvalid);
  }
}

function assertLifecycleSemantic(
  semantic: ReviewPublicationLifecycleSemantic,
): void {
  switch (semantic) {
    case ReviewPublicationLifecycleSemantic.Resolve:
    case ReviewPublicationLifecycleSemantic.Reopen:
    case ReviewPublicationLifecycleSemantic.MarkStale:
      return;
    default:
      fail(ReviewPublicationPlanningErrorCode.LifecycleSemanticUnsupported);
  }
}

function calculateReconcileUntil(
  publicationNotAfter: Date,
  maxReconciliationDurationMs: number,
): Date {
  const value = publicationNotAfter.getTime() + maxReconciliationDurationMs;
  if (!Number.isSafeInteger(value)) {
    fail(ReviewPublicationPlanningErrorCode.ReconciliationWindowInvalid);
  }
  const result = new Date(value);
  if (
    !Number.isFinite(result.getTime()) ||
    result.getTime() <= publicationNotAfter.getTime()
  ) {
    fail(ReviewPublicationPlanningErrorCode.ReconciliationWindowInvalid);
  }
  return result;
}

function safeAddBodyBytes(current: number, next: number): number {
  const total = current + next;
  if (!Number.isSafeInteger(total)) {
    fail(ReviewPublicationPlanningErrorCode.BodyLimitExceeded);
  }
  return total;
}

function operationId(
  projectionHash: string,
  kind: ReviewPublicationKind,
  chunkIndex: number,
): string {
  return `review-publication:${projectionHash}:${kind}:${chunkIndex}`;
}

function cloneOperationPlan(
  operation: ReviewPublicationOperationPlan,
): ReviewPublicationOperationPlan {
  return {
    ...operation,
    reconcileUntil: new Date(operation.reconcileUntil),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(code: ReviewPublicationPlanningErrorCode): never {
  throw new ReviewPublicationPlanningError(code);
}
