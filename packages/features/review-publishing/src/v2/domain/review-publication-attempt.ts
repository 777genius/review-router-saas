export const reviewPublicationV2SchemaVersion = 2 as const;

export enum ReviewPublicationAttemptState {
  Pending = "pending",
  Publishing = "publishing",
  Reconciling = "reconciling",
  Terminal = "terminal",
}

export enum ReviewPublicationTerminalOutcome {
  Succeeded = "succeeded",
  SupersededNoEffect = "superseded_no_effect",
  FailedNoEffect = "failed_no_effect",
  StaleCompensated = "stale_compensated",
  StaleVisible = "stale_visible",
  TerminalUnknown = "terminal_unknown",
}

export enum ReviewPublicationOperationState {
  Planned = "planned",
  InFlight = "in_flight",
  EffectObserved = "effect_observed",
  Reconciling = "reconciling",
  Completed = "completed",
  SupersededNoEffect = "superseded_no_effect",
  FailedNoEffect = "failed_no_effect",
  StaleCompensated = "stale_compensated",
  StaleVisible = "stale_visible",
  TerminalUnknown = "terminal_unknown",
}

export enum ReviewPublicationClaimState {
  Active = "active",
  Expired = "expired",
  Released = "released",
  Revoked = "revoked",
}

export enum ReviewPublicationOperationAttemptState {
  Active = "active",
  EffectObserved = "effect_observed",
  NoEffectProven = "no_effect_proven",
  Completed = "completed",
  Stale = "stale",
  TerminalUnknown = "terminal_unknown",
}

export enum ReviewPublicationEffectStrategy {
  MutableSingleton = "mutable_singleton",
  PendingThenSubmit = "pending_then_submit",
  AppendOnlyCanonicalReceipt = "append_only_canonical_receipt",
  ReversibleLifecycle = "reversible_lifecycle",
}

export enum ReviewPublicationOperationRole {
  Standalone = "standalone",
  PendingReviewCreate = "pending_review_create",
  PendingReviewSubmit = "pending_review_submit",
}

export enum ReviewPublicationKind {
  Summary = "summary",
  ManagedCheck = "managed_check",
  PendingReviewCreate = "pending_review_create",
  PendingReviewSubmit = "pending_review_submit",
  SubmittedReview = "submitted_review",
  ThreadLifecycle = "thread_lifecycle",
}

export enum ReviewPublicationExternalEffectKind {
  MutationAcknowledged = "mutation_acknowledged",
  MarkerReconciled = "marker_reconciled",
  LifecycleCompensated = "lifecycle_compensated",
}

export enum ReviewPublicationReceiptStatus {
  Succeeded = "succeeded",
  Compensated = "compensated",
  StaleVisible = "stale_visible",
}

export enum ReviewPublicationCorrectionReason {
  CanonicalEffectsProven = "canonical_effects_proven",
  StaleEffectCompensated = "stale_effect_compensated",
  StaleEffectVisible = "stale_effect_visible",
}

export type ReviewPublicationScope = {
  readonly workspaceId: string;
  readonly repositoryConnectionId: string;
  readonly scmRepositoryIdentityId: string;
  readonly pullRequestNumber: number;
};

export type ReviewPublicationPermitIdentity = ReviewPublicationScope & {
  readonly executionId: string;
  readonly generation: bigint;
  readonly authorizationId: string;
  readonly producerReleaseId: string;
  readonly reviewedHeadSha: string;
  readonly reviewRevisionHash: string;
  readonly projectionHash: string;
  readonly lifecycleStateHash: string;
  readonly commandLedgerWatermark: bigint;
  readonly permitEpoch: bigint;
  readonly publicationSafetyDecisionHash: string;
  readonly publicationNotAfter: Date;
};

export type ReviewPublicationOperationPlan = {
  readonly publicationOperationId: string;
  readonly publicationKind: ReviewPublicationKind;
  readonly chunkIndex: number;
  readonly effectStrategy: ReviewPublicationEffectStrategy;
  readonly role: ReviewPublicationOperationRole;
  readonly markerHash: string;
  readonly bodyHash: string;
  readonly renderPolicyVersion: number;
  readonly targetCommitId: string;
  readonly reviewRevisionHash: string;
  readonly required: boolean;
  readonly dependsOnOperationId: string | null;
  readonly reconcileUntil: Date;
};

export type ReviewPublicationOperation = ReviewPublicationOperationPlan & {
  readonly publicationAttemptId: string;
  readonly state: ReviewPublicationOperationState;
};

export type ReviewPublicationAttempt = {
  readonly schemaVersion: typeof reviewPublicationV2SchemaVersion;
  readonly publicationAttemptId: string;
  readonly permit: ReviewPublicationPermitIdentity;
  readonly requestHash: string;
  readonly version: bigint;
  readonly activeClaimId: string | null;
  readonly state: ReviewPublicationAttemptState;
  readonly terminalOutcome: ReviewPublicationTerminalOutcome | null;
  readonly operations: readonly ReviewPublicationOperation[];
  readonly createdAt: Date;
  readonly retainUntil: Date;
};

export type ReviewPublicationClaimTerm = {
  readonly claimId: string;
  readonly publicationAttemptId: string;
  readonly ownerIdHash: string;
  readonly acquireRequestIdHash: string;
  readonly requestHash: string;
  readonly claimCapabilityId: string;
  readonly capabilitySigningKeyId: string;
  readonly fencingToken: bigint;
  readonly state: ReviewPublicationClaimState;
  readonly acquiredAt: Date;
  readonly renewedAt: Date;
  readonly expiresAt: Date;
  readonly retainUntil: Date;
};

export type ReviewPublicationClaimCapabilityFacts = {
  readonly capabilityId: string;
  readonly capabilitySigningKeyId: string;
  readonly publicationAttemptId: string;
  readonly claimId: string;
  readonly ownerIdHash: string;
  readonly fencingToken: bigint;
  readonly permitEpoch: bigint;
  readonly reviewRevisionHash: string;
  readonly publicationSafetyDecisionHash: string;
  readonly ownershipUntil: Date;
  readonly reportUntil: Date;
};

export type ReviewPublicationOperationAttempt = {
  readonly operationAttemptId: string;
  readonly publicationAttemptId: string;
  readonly publicationOperationId: string;
  readonly claimId: string;
  readonly acquireRequestIdHash: string;
  readonly requestHash: string;
  readonly operationCapabilityId: string;
  readonly capabilitySigningKeyId: string;
  readonly effectReportId: string;
  readonly claimFencingToken: bigint;
  readonly state: ReviewPublicationOperationAttemptState;
  readonly noEffectProofId: string | null;
  readonly noEffectProofHash: string | null;
  readonly noEffectReason: string | null;
  readonly noEffectProvenAt: Date | null;
  readonly startedAt: Date;
  readonly effectReportUntil: Date;
  readonly retainUntil: Date;
};

export type ReviewPublicationOperationCapabilityFacts = {
  readonly capabilityId: string;
  readonly capabilitySigningKeyId: string;
  readonly publicationAttemptId: string;
  readonly publicationOperationId: string;
  readonly operationAttemptId: string;
  readonly effectReportId: string;
  readonly claimId: string;
  readonly claimFencingToken: bigint;
  readonly reviewRevisionHash: string;
  readonly mutationEpoch: bigint;
  readonly publicationSafetyDecisionHash: string;
  readonly bodyHash: string;
  readonly targetCommitId: string;
  readonly targetExternalObjectId: string | null;
  readonly effectReportUntil: Date;
};

export function canonicalReviewPublicationNoEffectProof(input: {
  readonly capability: ReviewPublicationOperationCapabilityFacts;
  readonly noEffectProofId: string;
  readonly noEffectReason: string;
}): string {
  return JSON.stringify(
    normalizeNoEffectProofValue({
      proofVersion: 1,
      noEffectProofId: input.noEffectProofId,
      noEffectReason: input.noEffectReason,
      capability: input.capability,
    }),
  );
}

export type ReviewPublicationExternalEffect = {
  readonly effectId: string;
  readonly publicationAttemptId: string;
  readonly publicationOperationId: string;
  readonly operationAttemptId: string;
  readonly effectReportId: string;
  readonly reportRequestHash: string;
  readonly externalObjectId: string;
  readonly observedObjectHash: string;
  readonly effectKind: ReviewPublicationExternalEffectKind;
  readonly observedAt: Date;
};

export type ReviewPublicationReceipt = {
  readonly receiptId: string;
  readonly publicationAttemptId: string;
  readonly publicationOperationId: string;
  readonly canonicalEffectId: string;
  readonly canonicalExternalObjectId: string;
  readonly status: ReviewPublicationReceiptStatus;
  readonly receiptHash: string;
  readonly updatedAt: Date;
};

export type ReviewPublicationAuditTombstone = {
  readonly tombstoneId: string;
  readonly publicationAttemptId: string;
  readonly publicationOperationId: string;
  readonly reviewRevisionHash: string;
  readonly markerHash: string;
  readonly bodyHash: string;
  readonly knownExternalObjectIds: readonly string[];
  readonly finalOutcome:
    | ReviewPublicationTerminalOutcome.SupersededNoEffect
    | ReviewPublicationTerminalOutcome.FailedNoEffect
    | ReviewPublicationTerminalOutcome.StaleCompensated
    | ReviewPublicationTerminalOutcome.StaleVisible
    | ReviewPublicationTerminalOutcome.TerminalUnknown;
  readonly finalReason: string;
  readonly lastErrorCode: string;
  readonly terminalizedBy: string;
  readonly terminalizedAt: Date;
  readonly retainUntil: Date;
};

export type ReviewPublicationOutcomeCorrection = {
  readonly correctionId: string;
  readonly publicationAttemptId: string;
  readonly correctionOrdinal: number;
  readonly priorOutcome: ReviewPublicationTerminalOutcome.TerminalUnknown;
  readonly correctedOutcome:
    | ReviewPublicationTerminalOutcome.Succeeded
    | ReviewPublicationTerminalOutcome.StaleCompensated
    | ReviewPublicationTerminalOutcome.StaleVisible;
  readonly evidenceHash: string;
  readonly safeReason: ReviewPublicationCorrectionReason;
  readonly correctedBy: string;
  readonly correctedAt: Date;
  readonly retainUntil: Date;
};

const externalEffectRiskOperationStates =
  new Set<ReviewPublicationOperationState>([
    ReviewPublicationOperationState.EffectObserved,
    ReviewPublicationOperationState.Reconciling,
    ReviewPublicationOperationState.Completed,
    ReviewPublicationOperationState.StaleCompensated,
    ReviewPublicationOperationState.StaleVisible,
    ReviewPublicationOperationState.TerminalUnknown,
  ]);

export function isAttemptLevelNoEffectOutcome(
  outcome: ReviewPublicationTerminalOutcome,
): outcome is
  | ReviewPublicationTerminalOutcome.SupersededNoEffect
  | ReviewPublicationTerminalOutcome.FailedNoEffect {
  return (
    outcome === ReviewPublicationTerminalOutcome.SupersededNoEffect ||
    outcome === ReviewPublicationTerminalOutcome.FailedNoEffect
  );
}

export function isActiveReviewPublicationOperation(
  operation: ReviewPublicationOperation,
): boolean {
  return (
    operation.state === ReviewPublicationOperationState.Planned ||
    operation.state === ReviewPublicationOperationState.InFlight ||
    operation.state === ReviewPublicationOperationState.EffectObserved ||
    operation.state === ReviewPublicationOperationState.Reconciling
  );
}

export function publicationOperationsWithExternalEffectRisk(input: {
  readonly operations: readonly ReviewPublicationOperation[];
  readonly operationAttempts: readonly ReviewPublicationOperationAttempt[];
  readonly effects: readonly ReviewPublicationExternalEffect[];
  readonly receipts: readonly ReviewPublicationReceipt[];
}): readonly ReviewPublicationOperation[] {
  const attemptedOperationIds = new Set(
    input.operationAttempts.map((attempt) => attempt.publicationOperationId),
  );
  const evidenceOperationIds = new Set([
    ...input.operationAttempts
      .filter(
        (attempt) =>
          attempt.state !==
          ReviewPublicationOperationAttemptState.NoEffectProven,
      )
      .map((attempt) => attempt.publicationOperationId),
    ...input.effects.map((effect) => effect.publicationOperationId),
    ...input.receipts.map((receipt) => receipt.publicationOperationId),
  ]);
  return input.operations.filter(
    (operation) =>
      externalEffectRiskOperationStates.has(operation.state) ||
      evidenceOperationIds.has(operation.publicationOperationId) ||
      (operation.state === ReviewPublicationOperationState.InFlight &&
        !attemptedOperationIds.has(operation.publicationOperationId)),
  );
}

export function hasPublicationExternalEffectRisk(
  input: Parameters<typeof publicationOperationsWithExternalEffectRisk>[0],
): boolean {
  return publicationOperationsWithExternalEffectRisk(input).length > 0;
}

export function planPublicationSiblingTerminalizations(input: {
  readonly publicationOperationId: string;
  readonly attemptOutcome:
    | ReviewPublicationTerminalOutcome.SupersededNoEffect
    | ReviewPublicationTerminalOutcome.FailedNoEffect
    | ReviewPublicationTerminalOutcome.StaleCompensated
    | ReviewPublicationTerminalOutcome.StaleVisible
    | ReviewPublicationTerminalOutcome.TerminalUnknown;
  readonly operations: readonly ReviewPublicationOperation[];
  readonly operationAttempts: readonly ReviewPublicationOperationAttempt[];
  readonly effects: readonly ReviewPublicationExternalEffect[];
  readonly receipts: readonly ReviewPublicationReceipt[];
}): readonly {
  readonly publicationOperationId: string;
  readonly finalOutcome:
    | ReviewPublicationTerminalOutcome.SupersededNoEffect
    | ReviewPublicationTerminalOutcome.FailedNoEffect
    | ReviewPublicationTerminalOutcome.TerminalUnknown;
}[] {
  const riskOperationIds = new Set(
    publicationOperationsWithExternalEffectRisk(input).map(
      (operation) => operation.publicationOperationId,
    ),
  );
  const provenNoEffectOperationIds = new Set(
    input.operationAttempts
      .filter(
        (attempt) =>
          attempt.state ===
          ReviewPublicationOperationAttemptState.NoEffectProven,
      )
      .map((attempt) => attempt.publicationOperationId),
  );
  const planned: Array<{
    readonly publicationOperationId: string;
    readonly finalOutcome:
      | ReviewPublicationTerminalOutcome.SupersededNoEffect
      | ReviewPublicationTerminalOutcome.FailedNoEffect
      | ReviewPublicationTerminalOutcome.TerminalUnknown;
  }> = [];
  for (const operation of input.operations) {
    if (operation.publicationOperationId === input.publicationOperationId) {
      continue;
    }
    if (operation.state === ReviewPublicationOperationState.Planned) {
      planned.push({
        publicationOperationId: operation.publicationOperationId,
        finalOutcome: isAttemptLevelNoEffectOutcome(input.attemptOutcome)
          ? input.attemptOutcome
          : ReviewPublicationTerminalOutcome.SupersededNoEffect,
      });
      continue;
    }
    if (
      operation.state === ReviewPublicationOperationState.InFlight &&
      provenNoEffectOperationIds.has(operation.publicationOperationId) &&
      !riskOperationIds.has(operation.publicationOperationId)
    ) {
      planned.push({
        publicationOperationId: operation.publicationOperationId,
        finalOutcome: ReviewPublicationTerminalOutcome.FailedNoEffect,
      });
      continue;
    }
    if (
      input.attemptOutcome ===
        ReviewPublicationTerminalOutcome.TerminalUnknown &&
      riskOperationIds.has(operation.publicationOperationId)
    ) {
      planned.push({
        publicationOperationId: operation.publicationOperationId,
        finalOutcome: ReviewPublicationTerminalOutcome.TerminalUnknown,
      });
    }
  }
  return planned;
}

export function isExactPublicationSiblingTerminalizationPlan(input: {
  readonly publicationOperationId: string;
  readonly attemptOutcome:
    | ReviewPublicationTerminalOutcome.SupersededNoEffect
    | ReviewPublicationTerminalOutcome.FailedNoEffect
    | ReviewPublicationTerminalOutcome.StaleCompensated
    | ReviewPublicationTerminalOutcome.StaleVisible
    | ReviewPublicationTerminalOutcome.TerminalUnknown;
  readonly operations: readonly ReviewPublicationOperation[];
  readonly operationAttempts: readonly ReviewPublicationOperationAttempt[];
  readonly effects: readonly ReviewPublicationExternalEffect[];
  readonly receipts: readonly ReviewPublicationReceipt[];
  readonly supplied: readonly {
    readonly publicationOperationId: string;
    readonly finalOutcome:
      | ReviewPublicationTerminalOutcome.SupersededNoEffect
      | ReviewPublicationTerminalOutcome.FailedNoEffect
      | ReviewPublicationTerminalOutcome.TerminalUnknown;
  }[];
}): boolean {
  const riskOperations = publicationOperationsWithExternalEffectRisk(input);
  if (
    (input.attemptOutcome ===
      ReviewPublicationTerminalOutcome.StaleCompensated ||
      input.attemptOutcome === ReviewPublicationTerminalOutcome.StaleVisible) &&
    (riskOperations.length !== 1 ||
      riskOperations[0]?.publicationOperationId !==
        input.publicationOperationId)
  ) {
    return false;
  }
  const expected = planPublicationSiblingTerminalizations(input);
  return (
    expected.length === input.supplied.length &&
    expected.every((planned) =>
      input.supplied.some(
        (supplied) =>
          supplied.publicationOperationId === planned.publicationOperationId &&
          supplied.finalOutcome === planned.finalOutcome,
      ),
    )
  );
}

export function assertReviewPublicationAttemptCandidate(input: {
  readonly publicationAttemptId: string;
  readonly permit: ReviewPublicationPermitIdentity;
  readonly requestHash: string;
  readonly operations: readonly ReviewPublicationOperationPlan[];
  readonly createdAt: Date;
  readonly retainUntil: Date;
}): void {
  assertIdentifier(
    input.publicationAttemptId,
    "publication_attempt_id_invalid",
  );
  assertPermit(input.permit);
  assertHash(input.requestHash, "publication_request_hash_invalid");
  assertFiniteDate(input.createdAt, "publication_created_at_invalid");
  assertFiniteDate(input.retainUntil, "publication_retain_until_invalid");
  if (input.retainUntil <= input.createdAt) {
    throw new Error("publication_retain_until_invalid");
  }
  if (input.operations.length === 0) {
    throw new Error("publication_operations_empty");
  }

  const operationIds = new Set<string>();
  const naturalKeys = new Set<string>();
  const markerHashes = new Set<string>();
  for (const operation of input.operations) {
    assertOperationPlan(
      operation,
      input.permit,
      operationIds,
      naturalKeys,
      markerHashes,
    );
    operationIds.add(operation.publicationOperationId);
    naturalKeys.add(`${operation.publicationKind}:${operation.chunkIndex}`);
    markerHashes.add(operation.markerHash);
  }

  for (const operation of input.operations) {
    assertOperationDependency(operation, input.operations, operationIds);
  }
}

export function publicationAttemptNaturalKey(
  permit: ReviewPublicationPermitIdentity,
): string {
  return [
    permit.workspaceId,
    permit.repositoryConnectionId,
    permit.scmRepositoryIdentityId,
    permit.pullRequestNumber,
    permit.executionId,
    permit.generation,
    permit.projectionHash,
  ].join(":");
}

export function publicationOperationNaturalKey(
  operation: Pick<
    ReviewPublicationOperationPlan,
    "publicationKind" | "chunkIndex"
  >,
): string {
  return `${operation.publicationKind}:${operation.chunkIndex}`;
}

export function claimCapabilityFacts(
  attempt: ReviewPublicationAttempt,
  claim: ReviewPublicationClaimTerm,
  reportUntil: Date,
): ReviewPublicationClaimCapabilityFacts {
  return {
    capabilityId: claim.claimCapabilityId,
    capabilitySigningKeyId: claim.capabilitySigningKeyId,
    publicationAttemptId: attempt.publicationAttemptId,
    claimId: claim.claimId,
    ownerIdHash: claim.ownerIdHash,
    fencingToken: claim.fencingToken,
    permitEpoch: attempt.permit.permitEpoch,
    reviewRevisionHash: attempt.permit.reviewRevisionHash,
    publicationSafetyDecisionHash: attempt.permit.publicationSafetyDecisionHash,
    ownershipUntil: claim.expiresAt,
    reportUntil,
  };
}

export function operationCapabilityFacts(input: {
  readonly attempt: ReviewPublicationAttempt;
  readonly operation: ReviewPublicationOperation;
  readonly operationAttempt: ReviewPublicationOperationAttempt;
  readonly targetExternalObjectId: string | null;
}): ReviewPublicationOperationCapabilityFacts {
  return {
    capabilityId: input.operationAttempt.operationCapabilityId,
    capabilitySigningKeyId: input.operationAttempt.capabilitySigningKeyId,
    publicationAttemptId: input.attempt.publicationAttemptId,
    publicationOperationId: input.operation.publicationOperationId,
    operationAttemptId: input.operationAttempt.operationAttemptId,
    effectReportId: input.operationAttempt.effectReportId,
    claimId: input.operationAttempt.claimId,
    claimFencingToken: input.operationAttempt.claimFencingToken,
    reviewRevisionHash: input.attempt.permit.reviewRevisionHash,
    mutationEpoch: input.attempt.permit.permitEpoch,
    publicationSafetyDecisionHash:
      input.attempt.permit.publicationSafetyDecisionHash,
    bodyHash: input.operation.bodyHash,
    targetCommitId: input.operation.targetCommitId,
    targetExternalObjectId: input.targetExternalObjectId,
    effectReportUntil: input.operationAttempt.effectReportUntil,
  };
}

export function effectiveReviewPublicationOutcome(input: {
  readonly attempt: ReviewPublicationAttempt;
  readonly corrections: readonly ReviewPublicationOutcomeCorrection[];
}): ReviewPublicationTerminalOutcome | null {
  if (
    input.attempt.terminalOutcome !==
    ReviewPublicationTerminalOutcome.TerminalUnknown
  ) {
    return input.attempt.terminalOutcome;
  }
  const latest = [...input.corrections].sort(
    (left, right) => right.correctionOrdinal - left.correctionOrdinal,
  )[0];
  return latest?.correctedOutcome ?? input.attempt.terminalOutcome;
}

export function hasEveryRequiredCanonicalReceipt(input: {
  readonly operations: readonly ReviewPublicationOperation[];
  readonly receipts: readonly ReviewPublicationReceipt[];
}): boolean {
  const successfulIds = new Set(
    input.receipts
      .filter(
        (receipt) =>
          receipt.status === ReviewPublicationReceiptStatus.Succeeded,
      )
      .map((receipt) => receipt.publicationOperationId),
  );
  return input.operations
    .filter((operation) => operation.required)
    .every((operation) => successfulIds.has(operation.publicationOperationId));
}

export function selectCanonicalExternalEffect(
  effects: readonly ReviewPublicationExternalEffect[],
): ReviewPublicationExternalEffect | null {
  return (
    [...effects].sort((left, right) => {
      const time = left.observedAt.getTime() - right.observedAt.getTime();
      return time === 0 ? left.effectId.localeCompare(right.effectId) : time;
    })[0] ?? null
  );
}

export function assertOperationCapabilityMatches(
  capability: ReviewPublicationOperationCapabilityFacts,
  attempt: ReviewPublicationAttempt,
  operation: ReviewPublicationOperation,
  operationAttempt: ReviewPublicationOperationAttempt,
): void {
  const expected = operationCapabilityFacts({
    attempt,
    operation,
    operationAttempt,
    targetExternalObjectId: capability.targetExternalObjectId,
  });
  if (
    expected.capabilityId !== capability.capabilityId ||
    expected.capabilitySigningKeyId !== capability.capabilitySigningKeyId ||
    expected.publicationAttemptId !== capability.publicationAttemptId ||
    expected.publicationOperationId !== capability.publicationOperationId ||
    expected.operationAttemptId !== capability.operationAttemptId ||
    expected.effectReportId !== capability.effectReportId ||
    expected.claimId !== capability.claimId ||
    expected.claimFencingToken !== capability.claimFencingToken ||
    expected.reviewRevisionHash !== capability.reviewRevisionHash ||
    expected.mutationEpoch !== capability.mutationEpoch ||
    expected.publicationSafetyDecisionHash !==
      capability.publicationSafetyDecisionHash ||
    expected.bodyHash !== capability.bodyHash ||
    expected.targetCommitId !== capability.targetCommitId ||
    expected.effectReportUntil.getTime() !==
      capability.effectReportUntil.getTime()
  ) {
    throw new Error("publication_operation_capability_mismatch");
  }
}

function normalizeNoEffectProofValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeNoEffectProofValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalizeNoEffectProofValue(entry)]),
    );
  }
  return value;
}

function assertPermit(permit: ReviewPublicationPermitIdentity): void {
  assertIdentifier(permit.workspaceId, "publication_workspace_invalid");
  assertIdentifier(
    permit.repositoryConnectionId,
    "publication_repository_connection_invalid",
  );
  assertIdentifier(
    permit.scmRepositoryIdentityId,
    "publication_scm_identity_invalid",
  );
  assertPositiveInteger(permit.pullRequestNumber, "publication_pr_invalid");
  assertIdentifier(permit.executionId, "publication_execution_invalid");
  if (permit.generation <= 0n) {
    throw new Error("publication_generation_invalid");
  }
  assertIdentifier(permit.authorizationId, "publication_authorization_invalid");
  assertIdentifier(permit.producerReleaseId, "publication_release_invalid");
  assertCommitId(permit.reviewedHeadSha, "publication_head_sha_invalid");
  assertHash(permit.reviewRevisionHash, "publication_revision_hash_invalid");
  assertHash(permit.projectionHash, "publication_projection_hash_invalid");
  assertHash(permit.lifecycleStateHash, "publication_lifecycle_hash_invalid");
  if (permit.commandLedgerWatermark < 0n) {
    throw new Error("publication_command_watermark_invalid");
  }
  if (permit.permitEpoch <= 0n) {
    throw new Error("publication_permit_epoch_invalid");
  }
  assertHash(
    permit.publicationSafetyDecisionHash,
    "publication_safety_hash_invalid",
  );
  assertFiniteDate(permit.publicationNotAfter, "publication_not_after_invalid");
}

function assertOperationPlan(
  operation: ReviewPublicationOperationPlan,
  permit: ReviewPublicationPermitIdentity,
  operationIds: ReadonlySet<string>,
  naturalKeys: ReadonlySet<string>,
  markerHashes: ReadonlySet<string>,
): void {
  assertIdentifier(
    operation.publicationOperationId,
    "publication_operation_id_invalid",
  );
  if (operationIds.has(operation.publicationOperationId)) {
    throw new Error("publication_operation_duplicate");
  }
  assertNonNegativeInteger(
    operation.chunkIndex,
    "publication_chunk_index_invalid",
  );
  if (naturalKeys.has(publicationOperationNaturalKey(operation))) {
    throw new Error("publication_operation_natural_key_duplicate");
  }
  assertHash(operation.markerHash, "publication_marker_hash_invalid");
  if (markerHashes.has(operation.markerHash)) {
    throw new Error("publication_marker_hash_duplicate");
  }
  assertHash(operation.bodyHash, "publication_body_hash_invalid");
  assertPositiveInteger(
    operation.renderPolicyVersion,
    "publication_render_policy_version_invalid",
  );
  assertCommitId(operation.targetCommitId, "publication_target_commit_invalid");
  assertHash(
    operation.reviewRevisionHash,
    "publication_operation_revision_invalid",
  );
  if (operation.reviewRevisionHash !== permit.reviewRevisionHash) {
    throw new Error("publication_operation_revision_mismatch");
  }
  assertFiniteDate(
    operation.reconcileUntil,
    "publication_reconcile_until_invalid",
  );
  if (operation.reconcileUntil <= permit.publicationNotAfter) {
    throw new Error("publication_reconcile_window_invalid");
  }
  assertOperationPolicy(operation);
}

function assertOperationDependency(
  operation: ReviewPublicationOperationPlan,
  operations: readonly ReviewPublicationOperationPlan[],
  operationIds: ReadonlySet<string>,
): void {
  if (operation.role === ReviewPublicationOperationRole.PendingReviewSubmit) {
    if (
      operation.effectStrategy !==
        ReviewPublicationEffectStrategy.PendingThenSubmit ||
      operation.dependsOnOperationId === null ||
      !operationIds.has(operation.dependsOnOperationId)
    ) {
      throw new Error("publication_pending_submit_dependency_invalid");
    }
    const dependency = operations.find(
      (candidate) =>
        candidate.publicationOperationId === operation.dependsOnOperationId,
    );
    if (
      dependency?.role !== ReviewPublicationOperationRole.PendingReviewCreate ||
      dependency.effectStrategy !==
        ReviewPublicationEffectStrategy.PendingThenSubmit
    ) {
      throw new Error("publication_pending_submit_dependency_invalid");
    }
    if (operations.indexOf(dependency) >= operations.indexOf(operation)) {
      throw new Error("publication_pending_submit_dependency_order_invalid");
    }
    return;
  }

  if (operation.dependsOnOperationId !== null) {
    throw new Error("publication_operation_dependency_unexpected");
  }
  if (
    operation.role === ReviewPublicationOperationRole.PendingReviewCreate &&
    operation.effectStrategy !==
      ReviewPublicationEffectStrategy.PendingThenSubmit
  ) {
    throw new Error("publication_pending_create_strategy_invalid");
  }
  if (
    operation.effectStrategy ===
      ReviewPublicationEffectStrategy.PendingThenSubmit &&
    operation.role === ReviewPublicationOperationRole.Standalone
  ) {
    throw new Error("publication_pending_strategy_role_invalid");
  }
}

function assertOperationPolicy(
  operation: ReviewPublicationOperationPlan,
): void {
  switch (operation.publicationKind) {
    case ReviewPublicationKind.Summary:
    case ReviewPublicationKind.ManagedCheck:
      if (
        operation.effectStrategy !==
          ReviewPublicationEffectStrategy.MutableSingleton ||
        operation.role !== ReviewPublicationOperationRole.Standalone
      ) {
        throw new Error("publication_operation_policy_invalid");
      }
      return;
    case ReviewPublicationKind.PendingReviewCreate:
      if (
        operation.effectStrategy !==
          ReviewPublicationEffectStrategy.PendingThenSubmit ||
        operation.role !== ReviewPublicationOperationRole.PendingReviewCreate
      ) {
        throw new Error("publication_operation_policy_invalid");
      }
      return;
    case ReviewPublicationKind.PendingReviewSubmit:
      if (
        operation.effectStrategy !==
          ReviewPublicationEffectStrategy.PendingThenSubmit ||
        operation.role !== ReviewPublicationOperationRole.PendingReviewSubmit
      ) {
        throw new Error("publication_operation_policy_invalid");
      }
      return;
    case ReviewPublicationKind.SubmittedReview:
      if (
        operation.effectStrategy !==
          ReviewPublicationEffectStrategy.AppendOnlyCanonicalReceipt ||
        operation.role !== ReviewPublicationOperationRole.Standalone
      ) {
        throw new Error("publication_operation_policy_invalid");
      }
      return;
    case ReviewPublicationKind.ThreadLifecycle:
      if (
        operation.effectStrategy !==
          ReviewPublicationEffectStrategy.ReversibleLifecycle ||
        operation.role !== ReviewPublicationOperationRole.Standalone
      ) {
        throw new Error("publication_operation_policy_invalid");
      }
      return;
    default:
      throw new Error("publication_operation_kind_unsupported");
  }
}

export function assertIdentifier(value: string, code: string): void {
  if (value.trim().length === 0 || value.length > 512) {
    throw new Error(code);
  }
}

export function assertHash(value: string, code: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(code);
  }
}

export function assertCommitId(value: string, code: string): void {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) {
    throw new Error(code);
  }
}

export function assertFiniteDate(value: Date, code: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(code);
  }
}

export function assertPositiveInteger(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(code);
  }
}

export function assertNonNegativeInteger(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(code);
  }
}
