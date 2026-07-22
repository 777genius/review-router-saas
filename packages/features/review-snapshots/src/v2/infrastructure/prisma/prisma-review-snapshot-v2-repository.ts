import {
  Prisma,
  ReviewSnapshotCommitOutcomeV2 as PrismaCommitOutcome,
  type PrismaClient,
  type ReviewSnapshot as ReviewSnapshotRecord,
  type ReviewSnapshotCommitReceiptV2 as ReceiptRecord,
} from "@prisma/client";
import {
  CommitReviewSnapshotV2Status,
  type CommitReviewSnapshotV2Result,
  type ReviewSnapshotCommitReceiptQueryPort,
  type ReviewSnapshotV2CommandPort,
  type ReviewSnapshotV2QueryPort,
} from "../../application/ports/review-snapshot-v2-port";
import {
  LineageHintEvictionReason,
  LineageHintState,
  ReviewSnapshotV2CommitOutcome,
  SnapshotOccurrenceState,
  assertCommitReviewSnapshotV2Command,
  assertSnapshotCommitReceipt,
  assertSnapshotCommitReceiptSource,
  assertSnapshotRecord,
  type CommitReviewSnapshotV2Command,
  type LegacySnapshotIdentity,
  type OccurrenceProvenanceDto,
  type ReviewSnapshotCommitReceipt,
  type ReviewSnapshotV2Payload,
  type ReviewSnapshotV2Record,
  type ReviewSnapshotV2Scope,
} from "../../domain/review-snapshot-v2";

export class PrismaReviewSnapshotV2Repository
  implements
    ReviewSnapshotV2CommandPort,
    ReviewSnapshotV2QueryPort,
    ReviewSnapshotCommitReceiptQueryPort
{
  constructor(private readonly prisma: PrismaClient) {}

  async commit(
    command: CommitReviewSnapshotV2Command,
  ): Promise<CommitReviewSnapshotV2Result> {
    assertCommitReviewSnapshotV2Command(command);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          async (transaction) => this.commitTransaction(transaction, command),
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (!isRetryableTransactionRace(error) || attempt === 2) throw error;
      }
    }
    throw new Error("review_snapshot_v2_transaction_retry_exhausted");
  }

  async findCurrent(
    scope: ReviewSnapshotV2Scope,
  ): Promise<ReviewSnapshotV2Record | LegacySnapshotIdentity | null> {
    const record = await this.prisma.reviewSnapshot.findUnique({
      where: { workspaceId_repositoryId_pullRequestNumber: toScope(scope) },
    });
    return record ? toDomain(record, scope.scmRepositoryIdentityId) : null;
  }

  async findBySource(input: {
    readonly sourceExecutionId: string;
    readonly sourceArtifactHash: string;
  }): Promise<ReviewSnapshotCommitReceipt | null> {
    assertSnapshotCommitReceiptSource(input);
    const receipt = await this.prisma.reviewSnapshotCommitReceiptV2.findUnique({
      where: {
        sourceExecutionId_sourceArtifactHash: input,
      },
    });
    return receipt ? mapReceipt(receipt) : null;
  }

  private async commitTransaction(
    transaction: Prisma.TransactionClient,
    command: CommitReviewSnapshotV2Command,
  ): Promise<CommitReviewSnapshotV2Result> {
    const existingReceipt =
      await transaction.reviewSnapshotCommitReceiptV2.findUnique({
        where: {
          sourceExecutionId_sourceArtifactHash: {
            sourceExecutionId: command.candidate.sourceExecutionId,
            sourceArtifactHash: command.candidate.sourceArtifactHash,
          },
        },
      });
    if (existingReceipt) {
      const current = await findCurrentInTransaction(
        transaction,
        command.candidate,
      );
      if (existingReceipt.requestHash !== command.requestHash) {
        return {
          status: CommitReviewSnapshotV2Status.RequestConflict,
          currentVersion: current?.version ?? 0,
        };
      }
      return {
        status: CommitReviewSnapshotV2Status.Restored,
        receipt: mapReceipt(existingReceipt),
        snapshot: current?.schemaVersion === 2 ? current : null,
      };
    }

    await transaction.$queryRaw(Prisma.sql`
      SELECT "id"
      FROM "ReviewSnapshot"
      WHERE "workspaceId" = ${command.candidate.workspaceId}
        AND "repositoryId" = ${command.candidate.repositoryConnectionId}
        AND "pullRequestNumber" = ${command.candidate.pullRequestNumber}
      FOR UPDATE
    `);
    const current = await findCurrentInTransaction(
      transaction,
      command.candidate,
    );
    const currentVersion = current?.version ?? 0;
    if (currentVersion !== command.expectedSnapshotVersion) {
      return {
        status: CommitReviewSnapshotV2Status.VersionConflict,
        currentVersion,
      };
    }

    const currentGeneration =
      current?.schemaVersion === 2 ? current.sourceExecutionGeneration : 0;
    let outcome: ReviewSnapshotV2CommitOutcome;
    let snapshot: ReviewSnapshotV2Record | null;
    if (currentGeneration > command.candidate.sourceExecutionGeneration) {
      outcome = ReviewSnapshotV2CommitOutcome.SupersededByHigherGeneration;
      snapshot = current?.schemaVersion === 2 ? current : null;
    } else if (
      currentGeneration === command.candidate.sourceExecutionGeneration
    ) {
      if (
        current?.schemaVersion !== 2 ||
        current.sourceArtifactHash !== command.candidate.sourceArtifactHash
      ) {
        return {
          status: CommitReviewSnapshotV2Status.InvariantConflict,
          currentVersion,
        };
      }
      outcome = ReviewSnapshotV2CommitOutcome.AlreadyCurrent;
      snapshot = current;
    } else {
      outcome = ReviewSnapshotV2CommitOutcome.Committed;
      snapshot = {
        ...command.candidate,
        version: currentVersion + 1,
      };
      assertSnapshotRecord(snapshot);
      if (current) {
        const updated = await transaction.reviewSnapshot.updateMany({
          where: {
            workspaceId: snapshot.workspaceId,
            repositoryId: snapshot.repositoryConnectionId,
            pullRequestNumber: snapshot.pullRequestNumber,
            version: currentVersion,
          },
          data: toUpdateInput(snapshot, command.publicationReceiptSetHash),
        });
        if (updated.count !== 1) {
          throw new ReviewSnapshotV2RetryableRace();
        }
      } else {
        await transaction.reviewSnapshot.create({
          data: toCreateInput(snapshot, command.publicationReceiptSetHash),
        });
      }
    }

    const created = await transaction.reviewSnapshotCommitReceiptV2.create({
      data: {
        receiptId: command.receiptId,
        requestHash: command.requestHash,
        sourceExecutionId: command.candidate.sourceExecutionId,
        sourceExecutionGeneration: BigInt(
          command.candidate.sourceExecutionGeneration,
        ),
        sourceArtifactHash: command.candidate.sourceArtifactHash,
        sourceReviewRevisionHash: command.candidate.sourceReviewRevisionHash,
        outcome: toPrismaOutcome(outcome),
        resultingSnapshotVersion: snapshot?.version ?? currentVersion,
        resultingSnapshotGeneration: BigInt(
          snapshot?.sourceExecutionGeneration ?? currentGeneration,
        ),
        createdAt: command.candidate.createdAt,
        retainUntil: command.receiptRetainUntil,
      },
    });
    return {
      status: CommitReviewSnapshotV2Status.Applied,
      receipt: mapReceipt(created),
      snapshot,
    };
  }
}

async function findCurrentInTransaction(
  transaction: Prisma.TransactionClient,
  scope: ReviewSnapshotV2Scope,
): Promise<ReviewSnapshotV2Record | LegacySnapshotIdentity | null> {
  const record = await transaction.reviewSnapshot.findUnique({
    where: { workspaceId_repositoryId_pullRequestNumber: toScope(scope) },
  });
  return record ? toDomain(record, scope.scmRepositoryIdentityId) : null;
}

function toScope(scope: ReviewSnapshotV2Scope) {
  return {
    workspaceId: scope.workspaceId,
    repositoryId: scope.repositoryConnectionId,
    pullRequestNumber: scope.pullRequestNumber,
  };
}

function toDomain(
  record: ReviewSnapshotRecord,
  expectedScmRepositoryIdentityId: string,
): ReviewSnapshotV2Record | LegacySnapshotIdentity {
  const identity = {
    workspaceId: record.workspaceId,
    repositoryConnectionId: record.repositoryId,
    scmRepositoryIdentityId:
      record.scmRepositoryIdentityId ?? expectedScmRepositoryIdentityId,
    pullRequestNumber: record.pullRequestNumber,
    version: record.version,
  };
  if (record.schemaVersion === 1) {
    return { ...identity, schemaVersion: 1 };
  }
  if (record.schemaVersion !== 2) {
    throw new Error("review_snapshot_schema_version_unsupported");
  }
  if (
    record.scmRepositoryIdentityId === null ||
    record.sourceExecutionId === null ||
    record.sourceExecutionGeneration === null ||
    record.sourceArtifactHash === null ||
    record.sourceReviewRevisionHash === null
  ) {
    throw new Error("review_snapshot_v2_persistence_incomplete");
  }
  if (record.scmRepositoryIdentityId !== expectedScmRepositoryIdentityId) {
    throw new Error("review_snapshot_v2_scm_identity_mismatch");
  }
  const payload = decodePayload(record.payload);
  if (record.payloadHash !== payload.projectionHash) {
    throw new Error("review_snapshot_v2_payload_hash_mismatch");
  }
  const snapshot: ReviewSnapshotV2Record = {
    ...identity,
    scmRepositoryIdentityId: record.scmRepositoryIdentityId,
    schemaVersion: 2,
    sourceExecutionId: record.sourceExecutionId,
    sourceExecutionGeneration: safeNumber(
      record.sourceExecutionGeneration,
      "review_snapshot_generation_out_of_range",
    ),
    sourceArtifactHash: record.sourceArtifactHash,
    sourceReviewRevisionHash: record.sourceReviewRevisionHash,
    sourceBaseSha: record.baseSha,
    sourceReviewedHeadSha: record.reviewedHeadSha,
    sourceCompatibilityKey: record.compatibilityKey,
    sourceRunId: record.sourceRunId,
    sourceRunAttempt: record.sourceRunAttempt,
    payload,
    createdAt: record.reviewedAt,
    expiresAt: record.expiresAt,
  };
  assertSnapshotRecord(snapshot);
  return snapshot;
}

function toCreateInput(
  snapshot: ReviewSnapshotV2Record,
  publicationReceiptSetHash: string,
): Prisma.ReviewSnapshotUncheckedCreateInput {
  return {
    workspaceId: snapshot.workspaceId,
    repositoryId: snapshot.repositoryConnectionId,
    pullRequestNumber: snapshot.pullRequestNumber,
    ...toPersistenceValues(snapshot, publicationReceiptSetHash),
  };
}

function toUpdateInput(
  snapshot: ReviewSnapshotV2Record,
  publicationReceiptSetHash: string,
): Prisma.ReviewSnapshotUncheckedUpdateManyInput {
  return toPersistenceValues(snapshot, publicationReceiptSetHash);
}

function toPersistenceValues(
  snapshot: ReviewSnapshotV2Record,
  publicationReceiptSetHash: string,
) {
  return {
    version: snapshot.version,
    schemaVersion: 2,
    reviewedHeadSha: snapshot.sourceReviewedHeadSha,
    baseSha: snapshot.sourceBaseSha,
    compatibilityKey: snapshot.sourceCompatibilityKey,
    payload: toPrismaPayload(snapshot.payload),
    payloadHash: snapshot.payload.projectionHash,
    sourceRunId: snapshot.sourceRunId,
    sourceRunAttempt: snapshot.sourceRunAttempt,
    scmRepositoryIdentityId: snapshot.scmRepositoryIdentityId,
    sourceExecutionId: snapshot.sourceExecutionId,
    sourceExecutionGeneration: BigInt(snapshot.sourceExecutionGeneration),
    sourceArtifactHash: snapshot.sourceArtifactHash,
    sourceReviewRevisionHash: snapshot.sourceReviewRevisionHash,
    publicationReceiptSetHash,
    reviewedAt: snapshot.createdAt,
    expiresAt: snapshot.expiresAt,
  };
}

function mapReceipt(record: ReceiptRecord): ReviewSnapshotCommitReceipt {
  const receipt: ReviewSnapshotCommitReceipt = {
    receiptId: record.receiptId,
    requestHash: record.requestHash,
    sourceExecutionId: record.sourceExecutionId,
    sourceExecutionGeneration: safeNumber(
      record.sourceExecutionGeneration,
      "review_snapshot_receipt_generation_out_of_range",
    ),
    sourceArtifactHash: record.sourceArtifactHash,
    sourceReviewRevisionHash: record.sourceReviewRevisionHash,
    outcome: fromPrismaOutcome(record.outcome),
    resultingSnapshotVersion: record.resultingSnapshotVersion,
    resultingSnapshotGeneration: safeNumber(
      record.resultingSnapshotGeneration,
      "review_snapshot_receipt_result_generation_out_of_range",
    ),
    createdAt: record.createdAt,
    retainUntil: record.retainUntil,
  };
  assertSnapshotCommitReceipt(receipt);
  return receipt;
}

function toPrismaOutcome(
  outcome: ReviewSnapshotV2CommitOutcome,
): PrismaCommitOutcome {
  switch (outcome) {
    case ReviewSnapshotV2CommitOutcome.Committed:
      return PrismaCommitOutcome.committed;
    case ReviewSnapshotV2CommitOutcome.AlreadyCurrent:
      return PrismaCommitOutcome.already_current;
    case ReviewSnapshotV2CommitOutcome.SupersededByHigherGeneration:
      return PrismaCommitOutcome.superseded_by_higher_generation;
  }
}

function fromPrismaOutcome(
  outcome: PrismaCommitOutcome,
): ReviewSnapshotV2CommitOutcome {
  switch (outcome) {
    case PrismaCommitOutcome.committed:
      return ReviewSnapshotV2CommitOutcome.Committed;
    case PrismaCommitOutcome.already_current:
      return ReviewSnapshotV2CommitOutcome.AlreadyCurrent;
    case PrismaCommitOutcome.superseded_by_higher_generation:
      return ReviewSnapshotV2CommitOutcome.SupersededByHigherGeneration;
  }
}

function toPrismaPayload(
  payload: ReviewSnapshotV2Payload,
): Prisma.InputJsonObject {
  return {
    projectionEnvelopeVersion: payload.projectionEnvelopeVersion,
    projectionEnvelope: jsonObject(payload.projectionEnvelope),
    projectionHash: payload.projectionHash,
    occurrences: payload.occurrences.map((occurrence) => ({
      lineageId: occurrence.lineageId,
      state: occurrence.state,
      observationIds: [...occurrence.observationIds],
      freshProviderVoteKeys: [...occurrence.freshProviderVoteKeys],
      placementConfidence: occurrence.placementConfidence,
    })),
    lineageHints: {
      hints: payload.lineageHints.hints.map((hint) => ({
        lineageId: hint.lineageId,
        fingerprintHash: hint.fingerprintHash,
        state: hint.state,
        lastSeenAt: hint.lastSeenAt.toISOString(),
      })),
      eviction: {
        age: payload.lineageHints.eviction.age,
        count: payload.lineageHints.eviction.count,
        bytes: payload.lineageHints.eviction.bytes,
        evictionWatermark:
          payload.lineageHints.eviction.evictionWatermark?.toISOString() ??
          null,
      },
    },
  };
}

function decodePayload(value: Prisma.JsonValue): ReviewSnapshotV2Payload {
  const record = requireObject(value, "review_snapshot_v2_payload_invalid");
  if (!Array.isArray(record.occurrences)) {
    throw new Error("review_snapshot_v2_occurrences_invalid");
  }
  const lineage = requireObject(
    record.lineageHints,
    "review_snapshot_v2_lineage_invalid",
  );
  const hints = lineage.hints;
  if (!Array.isArray(hints)) {
    throw new Error("review_snapshot_v2_lineage_hints_invalid");
  }
  const eviction = requireObject(
    lineage.eviction,
    "review_snapshot_v2_eviction_invalid",
  );
  return {
    projectionEnvelopeVersion: requiredNumber(record.projectionEnvelopeVersion),
    projectionEnvelope: plainObject(
      requireObject(
        record.projectionEnvelope,
        "review_snapshot_v2_projection_invalid",
      ),
    ),
    projectionHash: requiredString(record.projectionHash),
    occurrences: record.occurrences.map(decodeOccurrence),
    lineageHints: {
      hints: hints.map((entry) => {
        const hint = requireObject(entry, "review_snapshot_v2_hint_invalid");
        return {
          lineageId: requiredString(hint.lineageId),
          fingerprintHash: requiredString(hint.fingerprintHash),
          state: decodeLineageState(hint.state),
          lastSeenAt: requiredDate(hint.lastSeenAt),
        };
      }),
      eviction: {
        [LineageHintEvictionReason.Age]: requiredNumber(eviction.age),
        [LineageHintEvictionReason.Count]: requiredNumber(eviction.count),
        [LineageHintEvictionReason.Bytes]: requiredNumber(eviction.bytes),
        evictionWatermark:
          eviction.evictionWatermark === null
            ? null
            : requiredDate(eviction.evictionWatermark),
      },
    },
  };
}

function decodeOccurrence(value: Prisma.JsonValue): OccurrenceProvenanceDto {
  const record = requireObject(value, "review_snapshot_v2_occurrence_invalid");
  if (
    !Array.isArray(record.observationIds) ||
    !Array.isArray(record.freshProviderVoteKeys)
  ) {
    throw new Error("review_snapshot_v2_occurrence_invalid");
  }
  return {
    lineageId: requiredString(record.lineageId),
    state: decodeOccurrenceState(record.state),
    observationIds: record.observationIds.map(requiredString),
    freshProviderVoteKeys: record.freshProviderVoteKeys.map(requiredString),
    placementConfidence: requiredNumber(record.placementConfidence),
  };
}

function decodeLineageState(
  value: Prisma.JsonValue | undefined,
): LineageHintState {
  switch (value) {
    case LineageHintState.Active:
    case LineageHintState.Resolved:
    case LineageHintState.Absent:
      return value;
    default:
      throw new Error("review_snapshot_v2_lineage_state_invalid");
  }
}

function decodeOccurrenceState(
  value: Prisma.JsonValue | undefined,
): SnapshotOccurrenceState {
  switch (value) {
    case SnapshotOccurrenceState.New:
    case SnapshotOccurrenceState.Reconfirmed:
    case SnapshotOccurrenceState.Changed:
    case SnapshotOccurrenceState.CarriedUnverified:
    case SnapshotOccurrenceState.Resolved:
    case SnapshotOccurrenceState.Uncertain:
    case SnapshotOccurrenceState.SuppressedByHuman:
      return value;
    default:
      throw new Error("review_snapshot_v2_occurrence_state_invalid");
  }
}

function jsonObject(
  value: Readonly<Record<string, unknown>>,
): Prisma.InputJsonObject {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, jsonValue(entry)]),
  );
}

function jsonValue(value: unknown): Prisma.InputJsonValue | null {
  if (value === null) return null;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value === "object") {
    return jsonObject(Object.fromEntries(Object.entries(value)));
  }
  throw new Error("review_snapshot_v2_projection_json_invalid");
}

function plainObject(
  value: Prisma.JsonObject,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, plainValue(entry)]),
  );
}

function plainValue(value: Prisma.JsonValue | undefined): unknown {
  if (value === undefined) {
    throw new Error("review_snapshot_v2_json_undefined");
  }
  if (Array.isArray(value)) return value.map(plainValue);
  if (value !== null && typeof value === "object") return plainObject(value);
  return value;
}

function requireObject(
  value: Prisma.JsonValue | undefined,
  errorCode: string,
): Prisma.JsonObject {
  if (
    value === null ||
    value === undefined ||
    Array.isArray(value) ||
    typeof value !== "object"
  ) {
    throw new Error(errorCode);
  }
  return value;
}

function requiredString(value: Prisma.JsonValue | undefined): string {
  if (typeof value !== "string") {
    throw new Error("review_snapshot_v2_json_string_invalid");
  }
  return value;
}

function requiredNumber(value: Prisma.JsonValue | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("review_snapshot_v2_json_number_invalid");
  }
  return value;
}

function requiredDate(value: Prisma.JsonValue | undefined): Date {
  const date = new Date(requiredString(value));
  if (!Number.isFinite(date.getTime())) {
    throw new Error("review_snapshot_v2_json_date_invalid");
  }
  return date;
}

function safeNumber(value: bigint, errorCode: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(errorCode);
  return number;
}

function isRetryableTransactionRace(error: unknown): boolean {
  return (
    error instanceof ReviewSnapshotV2RetryableRace ||
    (error instanceof Prisma.PrismaClientKnownRequestError &&
      (error.code === "P2034" || error.code === "P2002"))
  );
}

class ReviewSnapshotV2RetryableRace extends Error {
  constructor() {
    super("review_snapshot_v2_cas_race");
    this.name = "ReviewSnapshotV2RetryableRace";
  }
}
