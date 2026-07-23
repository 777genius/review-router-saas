export const reviewSnapshotV2SchemaVersion = 2;

export enum LineageHintState {
  Active = "active",
  Resolved = "resolved",
  Absent = "absent",
}

export enum LineageHintEvictionReason {
  Age = "age",
  Count = "count",
  Bytes = "bytes",
}

export enum SnapshotOccurrenceState {
  New = "new",
  Reconfirmed = "reconfirmed",
  Changed = "changed",
  CarriedUnverified = "carried_unverified",
  Resolved = "resolved",
  Uncertain = "uncertain",
  SuppressedByHuman = "suppressed_by_human",
}

export type LineageHintDto = {
  readonly lineageId: string;
  readonly fingerprintHash: string;
  readonly state: LineageHintState;
  readonly lastSeenAt: Date;
};

export type OccurrenceProvenanceDto = {
  readonly lineageId: string;
  readonly state: SnapshotOccurrenceState;
  readonly observationIds: readonly string[];
  readonly freshProviderVoteKeys: readonly string[];
  readonly placementConfidence: number;
};

export type LineageHintEvictionSummary = Readonly<
  Record<LineageHintEvictionReason, number>
> & {
  readonly evictionWatermark: Date | null;
};

export type LineageHintIndex = {
  readonly hints: readonly LineageHintDto[];
  readonly eviction: LineageHintEvictionSummary;
};

export type ReviewSnapshotV2Payload = {
  readonly projectionEnvelopeVersion: number;
  readonly projectionEnvelope: Readonly<Record<string, unknown>>;
  readonly projectionHash: string;
  readonly occurrences: readonly OccurrenceProvenanceDto[];
  readonly lineageHints: LineageHintIndex;
};

export type ReviewSnapshotV2Scope = {
  readonly workspaceId: string;
  readonly repositoryConnectionId: string;
  readonly scmRepositoryIdentityId: string;
  readonly pullRequestNumber: number;
};

export type ReviewSnapshotV2ExecutionProvenance = {
  readonly sourceBaseSha: string;
  readonly sourceReviewedHeadSha: string;
  readonly sourceCompatibilityKey: string;
  readonly sourceRunId: string;
  readonly sourceRunAttempt: string;
};

export type ReviewSnapshotV2Record = ReviewSnapshotV2Scope &
  ReviewSnapshotV2ExecutionProvenance & {
    readonly version: number;
    readonly schemaVersion: typeof reviewSnapshotV2SchemaVersion;
    readonly sourceExecutionId: string;
    readonly sourceExecutionGeneration: number;
    readonly sourceArtifactHash: string;
    readonly sourceReviewRevisionHash: string;
    readonly payload: ReviewSnapshotV2Payload;
    readonly createdAt: Date;
    readonly expiresAt: Date;
  };

export type LegacySnapshotIdentity = ReviewSnapshotV2Scope & {
  readonly version: number;
  readonly schemaVersion: 1;
};

export enum ReviewSnapshotV2CommitOutcome {
  Committed = "committed",
  AlreadyCurrent = "already_current",
  SupersededByHigherGeneration = "superseded_by_higher_generation",
}

export type ReviewSnapshotCommitReceipt = {
  readonly receiptId: string;
  readonly requestHash: string;
  readonly sourceExecutionId: string;
  readonly sourceExecutionGeneration: number;
  readonly sourceArtifactHash: string;
  readonly sourceReviewRevisionHash: string;
  readonly outcome: ReviewSnapshotV2CommitOutcome;
  readonly resultingSnapshotVersion: number;
  readonly resultingSnapshotGeneration: number;
  readonly createdAt: Date;
  readonly retainUntil: Date;
};

export type ReviewSnapshotCommitReceiptSource = {
  readonly sourceExecutionId: string;
  readonly sourceArtifactHash: string;
};

export type CommitReviewSnapshotV2Command = {
  readonly receiptId: string;
  readonly requestHash: string;
  readonly expectedSnapshotVersion: number;
  readonly publicationReceiptSetHash: string;
  readonly candidate: Omit<ReviewSnapshotV2Record, "version">;
  readonly receiptRetainUntil: Date;
};

export enum ReviewSnapshotV2RestoreStatus {
  Found = "found",
  Missing = "missing",
  Expired = "expired",
  RevisionChanged = "revision_changed",
  LegacyUntrusted = "legacy_untrusted",
  TrustRejected = "trust_rejected",
}

export enum ReviewSnapshotV2RestoreMode {
  ExactProjection = "exact_projection",
  LineageHintsOnly = "lineage_hints_only",
}

export type ReviewSnapshotV2RestoreResult =
  | {
      readonly status: ReviewSnapshotV2RestoreStatus.Found;
      readonly expectedVersion: number;
      readonly snapshot: ReviewSnapshotV2Record;
      readonly mode: ReviewSnapshotV2RestoreMode;
      readonly payload: ReviewSnapshotV2Payload | null;
      readonly lineageHints: LineageHintIndex;
    }
  | {
      readonly status: Exclude<
        ReviewSnapshotV2RestoreStatus,
        ReviewSnapshotV2RestoreStatus.Found
      >;
      readonly expectedVersion: number;
    };

export function buildBoundedLineageHintIndex(input: {
  readonly hints: readonly LineageHintDto[];
  readonly now: Date;
  readonly retentionMs: number;
  readonly maximumCount: number;
  readonly maximumBytes: number;
}): LineageHintIndex {
  assertFiniteDate(input.now, "lineage_hint_now_invalid");
  assertPositiveInteger(input.retentionMs, "lineage_hint_retention_invalid");
  assertPositiveInteger(input.maximumCount, "lineage_hint_count_limit_invalid");
  assertPositiveInteger(input.maximumBytes, "lineage_hint_byte_limit_invalid");

  const unique = new Map<string, LineageHintDto>();
  for (const hint of input.hints) {
    assertLineageHint(hint);
    if (unique.has(hint.lineageId)) {
      throw new Error("lineage_hint_duplicate");
    }
    unique.set(hint.lineageId, copyHint(hint));
  }

  const cutoff = input.now.getTime() - input.retentionMs;
  const ageEligible: LineageHintDto[] = [];
  const evictedAt: Date[] = [];
  let age = 0;
  for (const hint of unique.values()) {
    if (hint.lastSeenAt.getTime() < cutoff) {
      age += 1;
      evictedAt.push(hint.lastSeenAt);
    } else {
      ageEligible.push(hint);
    }
  }

  const ranked = ageEligible.sort(compareHintRetentionPriority);
  const countEligible = ranked.slice(0, input.maximumCount);
  const countEvicted = ranked.slice(input.maximumCount);
  evictedAt.push(...countEvicted.map((hint) => hint.lastSeenAt));

  const retained: LineageHintDto[] = [];
  let retainedBytes = 2;
  let bytes = 0;
  for (const [index, hint] of countEligible.entries()) {
    const nextBytes = encodedBytes(hint) + (retained.length === 0 ? 0 : 1);
    if (retainedBytes + nextBytes > input.maximumBytes) {
      const byteEvicted = countEligible.slice(index);
      bytes += byteEvicted.length;
      evictedAt.push(...byteEvicted.map((item) => item.lastSeenAt));
      break;
    }
    retained.push(hint);
    retainedBytes += nextBytes;
  }

  return {
    hints: retained.sort((left, right) =>
      left.lineageId.localeCompare(right.lineageId),
    ),
    eviction: {
      [LineageHintEvictionReason.Age]: age,
      [LineageHintEvictionReason.Count]: countEvicted.length,
      [LineageHintEvictionReason.Bytes]: bytes,
      evictionWatermark:
        evictedAt.length === 0
          ? null
          : new Date(Math.max(...evictedAt.map((date) => date.getTime()))),
    },
  };
}

export function decideReviewSnapshotV2Restore(
  record: ReviewSnapshotV2Record | LegacySnapshotIdentity | null,
  input: {
    readonly now: Date;
    readonly trustedRepositoryBinding: boolean;
    readonly reviewRevisionHash: string;
    readonly mode: ReviewSnapshotV2RestoreMode;
  },
): ReviewSnapshotV2RestoreResult {
  assertFiniteDate(input.now, "review_snapshot_restore_now_invalid");
  assertHash(input.reviewRevisionHash, "review_revision_hash_invalid");
  if (!record) {
    return {
      status: ReviewSnapshotV2RestoreStatus.Missing,
      expectedVersion: 0,
    };
  }
  if (!input.trustedRepositoryBinding) {
    return {
      status: ReviewSnapshotV2RestoreStatus.TrustRejected,
      expectedVersion: record.version,
    };
  }
  if (record.schemaVersion === 1) {
    return {
      status: ReviewSnapshotV2RestoreStatus.LegacyUntrusted,
      expectedVersion: record.version,
    };
  }
  if (record.expiresAt <= input.now) {
    return {
      status: ReviewSnapshotV2RestoreStatus.Expired,
      expectedVersion: record.version,
    };
  }
  if (
    input.mode === ReviewSnapshotV2RestoreMode.ExactProjection &&
    record.sourceReviewRevisionHash !== input.reviewRevisionHash
  ) {
    return {
      status: ReviewSnapshotV2RestoreStatus.RevisionChanged,
      expectedVersion: record.version,
    };
  }
  return {
    status: ReviewSnapshotV2RestoreStatus.Found,
    expectedVersion: record.version,
    snapshot: record,
    mode: input.mode,
    payload:
      input.mode === ReviewSnapshotV2RestoreMode.ExactProjection
        ? record.payload
        : null,
    lineageHints: record.payload.lineageHints,
  };
}

export function assertCommitReviewSnapshotV2Command(
  command: CommitReviewSnapshotV2Command,
): void {
  assertIdentifier(command.receiptId, "snapshot_receipt_id_invalid");
  assertHash(command.requestHash, "snapshot_request_hash_invalid");
  assertNonNegativeInteger(
    command.expectedSnapshotVersion,
    "snapshot_expected_version_invalid",
  );
  assertHash(
    command.publicationReceiptSetHash,
    "snapshot_publication_receipt_set_hash_invalid",
  );
  assertSnapshotRecord({
    ...command.candidate,
    version: command.expectedSnapshotVersion + 1,
  });
  assertFiniteDate(
    command.receiptRetainUntil,
    "snapshot_receipt_retention_invalid",
  );
  if (command.receiptRetainUntil <= command.candidate.createdAt) {
    throw new Error("snapshot_receipt_retention_invalid");
  }
}

export function assertSnapshotRecord(record: ReviewSnapshotV2Record): void {
  assertIdentifier(record.workspaceId, "snapshot_workspace_invalid");
  assertIdentifier(
    record.repositoryConnectionId,
    "snapshot_repository_connection_invalid",
  );
  assertIdentifier(
    record.scmRepositoryIdentityId,
    "snapshot_scm_identity_invalid",
  );
  assertPositiveInteger(record.pullRequestNumber, "snapshot_pr_number_invalid");
  assertPositiveInteger(record.version, "snapshot_version_invalid");
  if (record.schemaVersion !== reviewSnapshotV2SchemaVersion) {
    throw new Error("snapshot_schema_version_invalid");
  }
  assertIdentifier(record.sourceExecutionId, "snapshot_execution_id_invalid");
  assertPositiveInteger(
    record.sourceExecutionGeneration,
    "snapshot_generation_invalid",
  );
  assertHash(record.sourceArtifactHash, "snapshot_artifact_hash_invalid");
  assertHash(record.sourceReviewRevisionHash, "snapshot_revision_hash_invalid");
  assertCommitSha(record.sourceBaseSha, "snapshot_source_base_sha_invalid");
  assertCommitSha(
    record.sourceReviewedHeadSha,
    "snapshot_source_reviewed_head_sha_invalid",
  );
  assertHash(
    record.sourceCompatibilityKey,
    "snapshot_source_compatibility_key_invalid",
  );
  assertIdentifier(record.sourceRunId, "snapshot_source_run_id_invalid");
  assertIdentifier(
    record.sourceRunAttempt,
    "snapshot_source_run_attempt_invalid",
  );
  assertFiniteDate(record.createdAt, "snapshot_created_at_invalid");
  assertFiniteDate(record.expiresAt, "snapshot_expiry_invalid");
  if (record.expiresAt <= record.createdAt) {
    throw new Error("snapshot_expiry_invalid");
  }
  assertSnapshotPayload(record.payload);
}

export function assertSnapshotCommitReceiptSource(
  source: ReviewSnapshotCommitReceiptSource,
): void {
  assertIdentifier(
    source.sourceExecutionId,
    "snapshot_receipt_execution_id_invalid",
  );
  assertHash(
    source.sourceArtifactHash,
    "snapshot_receipt_artifact_hash_invalid",
  );
}

export function assertSnapshotCommitReceipt(
  receipt: ReviewSnapshotCommitReceipt,
): void {
  assertIdentifier(receipt.receiptId, "snapshot_receipt_id_invalid");
  assertHash(receipt.requestHash, "snapshot_receipt_request_hash_invalid");
  assertSnapshotCommitReceiptSource(receipt);
  assertPositiveInteger(
    receipt.sourceExecutionGeneration,
    "snapshot_receipt_generation_invalid",
  );
  assertHash(
    receipt.sourceReviewRevisionHash,
    "snapshot_receipt_revision_hash_invalid",
  );
  if (!Object.values(ReviewSnapshotV2CommitOutcome).includes(receipt.outcome)) {
    throw new Error("snapshot_receipt_outcome_invalid");
  }
  assertPositiveInteger(
    receipt.resultingSnapshotVersion,
    "snapshot_receipt_result_version_invalid",
  );
  assertPositiveInteger(
    receipt.resultingSnapshotGeneration,
    "snapshot_receipt_result_generation_invalid",
  );
  assertFiniteDate(receipt.createdAt, "snapshot_receipt_created_at_invalid");
  assertFiniteDate(
    receipt.retainUntil,
    "snapshot_receipt_retain_until_invalid",
  );
  if (receipt.retainUntil <= receipt.createdAt) {
    throw new Error("snapshot_receipt_retain_until_invalid");
  }
}

function assertSnapshotPayload(payload: ReviewSnapshotV2Payload): void {
  assertPositiveInteger(
    payload.projectionEnvelopeVersion,
    "snapshot_projection_envelope_version_invalid",
  );
  if (!isRecord(payload.projectionEnvelope)) {
    throw new Error("snapshot_projection_envelope_invalid");
  }
  assertHash(payload.projectionHash, "snapshot_projection_hash_invalid");
  if (!Array.isArray(payload.occurrences)) {
    throw new Error("snapshot_occurrences_invalid");
  }
  for (const occurrence of payload.occurrences) {
    assertIdentifier(
      occurrence.lineageId,
      "snapshot_occurrence_lineage_invalid",
    );
    if (!Object.values(SnapshotOccurrenceState).includes(occurrence.state)) {
      throw new Error("snapshot_occurrence_state_invalid");
    }
    assertUniqueIdentifiers(
      occurrence.observationIds,
      "snapshot_occurrence_observations_invalid",
    );
    assertUniqueIdentifiers(
      occurrence.freshProviderVoteKeys,
      "snapshot_occurrence_votes_invalid",
    );
    if (
      !Number.isFinite(occurrence.placementConfidence) ||
      occurrence.placementConfidence < 0 ||
      occurrence.placementConfidence > 1
    ) {
      throw new Error("snapshot_occurrence_confidence_invalid");
    }
  }
  for (const hint of payload.lineageHints.hints) assertLineageHint(hint);
  if (
    payload.lineageHints.hints.length > 10_000 ||
    payload.occurrences.length > 500
  ) {
    throw new Error("snapshot_payload_item_limit_exceeded");
  }
  for (const reason of Object.values(LineageHintEvictionReason)) {
    assertNonNegativeInteger(
      payload.lineageHints.eviction[reason],
      "snapshot_lineage_eviction_count_invalid",
    );
  }
  if (payload.lineageHints.eviction.evictionWatermark !== null) {
    assertFiniteDate(
      payload.lineageHints.eviction.evictionWatermark,
      "snapshot_lineage_eviction_watermark_invalid",
    );
  }
  if (encodedBytes(payload) > 1_048_576) {
    throw new Error("snapshot_payload_too_large");
  }
}

function assertLineageHint(hint: LineageHintDto): void {
  assertIdentifier(hint.lineageId, "lineage_hint_id_invalid");
  assertHash(hint.fingerprintHash, "lineage_hint_fingerprint_invalid");
  if (!Object.values(LineageHintState).includes(hint.state)) {
    throw new Error("lineage_hint_state_invalid");
  }
  assertFiniteDate(hint.lastSeenAt, "lineage_hint_last_seen_invalid");
}

function compareHintRetentionPriority(
  left: LineageHintDto,
  right: LineageHintDto,
): number {
  const state = hintStatePriority(right.state) - hintStatePriority(left.state);
  if (state !== 0) return state;
  const lastSeen = right.lastSeenAt.getTime() - left.lastSeenAt.getTime();
  return lastSeen || left.lineageId.localeCompare(right.lineageId);
}

function hintStatePriority(state: LineageHintState): number {
  if (state === LineageHintState.Active) return 2;
  if (state === LineageHintState.Resolved) return 1;
  return 0;
}

function copyHint(hint: LineageHintDto): LineageHintDto {
  return { ...hint, lastSeenAt: new Date(hint.lastSeenAt) };
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertIdentifier(value: string, code: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    [...value].some((character) => character.charCodeAt(0) < 32)
  ) {
    throw new Error(code);
  }
}

function assertHash(value: string, code: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(code);
}

function assertCommitSha(value: string, code: string): void {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) {
    throw new Error(code);
  }
}

function assertFiniteDate(value: Date, code: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(code);
  }
}

function assertPositiveInteger(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(code);
}

function assertNonNegativeInteger(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(code);
}

function assertUniqueIdentifiers(
  values: readonly string[],
  code: string,
): void {
  if (!Array.isArray(values) || new Set(values).size !== values.length) {
    throw new Error(code);
  }
  for (const value of values) assertIdentifier(value, code);
}
