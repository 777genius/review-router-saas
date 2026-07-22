import { createHash } from "node:crypto";
import {
  ReviewCoverageState,
  ReviewExecutionState,
  type FinalizedReviewProjectionArtifact,
  type ReviewExecutionQueryPort,
  type ReviewExecutionSnapshot,
} from "@reviewrouter/features-review-executions";
import {
  RequestReviewPublicationStatus,
  ReviewPublicationAttemptState,
  ReviewPublicationProjectionCoverage,
  ReviewPublicationTerminalOutcome,
  effectiveReviewPublicationOutcome,
  type PublishedReviewProjectionPublicationEnvelope,
  type RequestReviewPublicationCommand,
  type RequestReviewPublicationResult,
  type ReviewPublicationAttemptQueryPort,
  type ReviewPublicationAttemptView,
  type ReviewPublicationOperationPlanningPort,
} from "@reviewrouter/features-review-publishing/v2";
import {
  CommitReviewSnapshotV2Status,
  ReviewSnapshotV2CommitOutcome,
  type CommitReviewSnapshotV2Command,
  type CommitReviewSnapshotV2Result,
  type LineageHintIndex,
  type OccurrenceProvenanceDto,
  type ReviewSnapshotCommitReceipt,
  type ReviewSnapshotV2Record,
  type ReviewSnapshotV2QueryPort,
} from "@reviewrouter/features-review-snapshots/v2";
import {
  ReviewCompletionPublicationOutcome,
  ReviewCompletionPublicationState,
  ReviewCompletionSnapshotOutcome,
  ReviewExecutionCompletionCoverage,
  type ReviewCompletionExecutionQueryPort,
  type ReviewCompletionPublicationFacts,
  type ReviewCompletionPublicationPort,
  type ReviewCompletionSnapshotPort,
  type ReviewCompletionSnapshotReceiptFacts,
  type ReviewExecutionCompletionFacts,
} from "@reviewrouter/features-review-processes";

type ReviewExecutionQueries = Pick<ReviewExecutionQueryPort, "findExecution">;

export type ReviewCompletionWakeupFacts = {
  readonly executionId: string;
  readonly finalizedArtifactId: string;
  readonly finalizedAt: Date;
  readonly retainUntil: Date;
};

export interface ReviewCompletionWakeupQueryPort {
  findFinalizedWakeup(input: {
    readonly executionId: string;
    readonly finalizedArtifactId: string;
  }): Promise<ReviewCompletionWakeupFacts | null>;
}

export class ReviewCompletionExecutionContextAdapter
  implements ReviewCompletionExecutionQueryPort, ReviewCompletionWakeupQueryPort
{
  constructor(private readonly executions: ReviewExecutionQueries) {}

  async findFinalized(input: {
    readonly executionId: string;
    readonly finalizedArtifactId: string;
  }): Promise<ReviewExecutionCompletionFacts | null> {
    const snapshot = await loadFinalizedExecution(this.executions, input);
    if (!snapshot) return null;
    return {
      executionId: snapshot.execution.executionId,
      finalizedArtifactId: snapshot.artifact.artifactId,
      coverage: mapCoverage(snapshot.artifact.coverageState),
    };
  }

  async findFinalizedWakeup(input: {
    readonly executionId: string;
    readonly finalizedArtifactId: string;
  }): Promise<ReviewCompletionWakeupFacts | null> {
    const snapshot = await loadFinalizedExecution(this.executions, input);
    if (!snapshot) return null;
    return {
      executionId: snapshot.execution.executionId,
      finalizedArtifactId: snapshot.artifact.artifactId,
      finalizedAt: new Date(snapshot.artifact.createdAt),
      retainUntil: new Date(snapshot.artifact.retainUntil),
    };
  }
}

export type ReviewCompletionSnapshotProjection = {
  readonly occurrences: readonly OccurrenceProvenanceDto[];
  readonly lineageHints: LineageHintIndex;
  readonly expiresAt: Date;
};

export interface ReviewCompletionProjectionMapperPort {
  publicationEnvelope(
    artifact: FinalizedReviewProjectionArtifact,
  ): Promise<PublishedReviewProjectionPublicationEnvelope | null>;
  snapshotProjection(
    artifact: FinalizedReviewProjectionArtifact,
  ): Promise<ReviewCompletionSnapshotProjection | null>;
}

export interface ReviewPublicationRequestApplicationPort {
  request(
    command: RequestReviewPublicationCommand,
  ): Promise<RequestReviewPublicationResult>;
}

export class DeterministicReviewPublicationRequestFactory {
  constructor(
    private readonly projections: ReviewCompletionProjectionMapperPort,
    private readonly operationPlanner: ReviewPublicationOperationPlanningPort,
  ) {}

  async build(
    snapshot: ReviewExecutionSnapshot,
  ): Promise<RequestReviewPublicationCommand | null> {
    const artifact = requireFinalizedArtifact(snapshot);
    const envelope = await this.projections.publicationEnvelope(artifact);
    if (!envelope) return null;
    assertPublicationEnvelopeMatchesArtifact(envelope, artifact);
    const operations = await this.operationPlanner.plan(envelope);
    if (operations.length === 0) {
      throw new Error("review_completion_publication_operations_empty");
    }

    const publicationAttemptId = deterministicId(
      "publication",
      [artifact.executionId, artifact.artifactId, artifact.projectionHash].join(
        "\0",
      ),
    );
    const requestIdHash = sha256(
      `rr.publication-request.v2\0${publicationAttemptId}`,
    );
    const requestHash = sha256(
      canonicalJson({
        publicationAttemptId,
        requestIdHash,
        permit: artifact.publicationPermit,
        operations,
        createdAt: artifact.createdAt,
        retainUntil: artifact.retainUntil,
      }),
    );
    return {
      publicationAttemptId,
      requestIdHash,
      requestHash,
      permit: artifact.publicationPermit,
      operations,
      createdAt: new Date(artifact.createdAt),
      retainUntil: new Date(artifact.retainUntil),
    };
  }
}

export class ReviewCompletionPublicationContextAdapter implements ReviewCompletionPublicationPort {
  constructor(
    private readonly executions: ReviewExecutionQueries,
    private readonly attempts: ReviewPublicationAttemptQueryPort,
    private readonly requests: ReviewPublicationRequestApplicationPort,
    private readonly requestFactory: DeterministicReviewPublicationRequestFactory,
  ) {}

  async findByExecution(input: {
    readonly executionId: string;
    readonly finalizedArtifactId: string;
    readonly publicationAttemptId: string | null;
  }): Promise<ReviewCompletionPublicationFacts | null> {
    const snapshot = await loadFinalizedExecution(this.executions, input);
    if (!snapshot) return null;
    const view = input.publicationAttemptId
      ? await this.attempts.findById(input.publicationAttemptId)
      : await this.attempts.findByPermitIdentity(
          snapshot.artifact.publicationPermit,
        );
    if (!view) return null;
    assertPublicationMatchesArtifact(view, snapshot.artifact);
    return publicationFacts(view, snapshot.artifact.artifactId);
  }

  async request(input: {
    readonly executionId: string;
    readonly finalizedArtifactId: string;
  }): Promise<ReviewCompletionPublicationFacts> {
    const snapshot = await loadFinalizedExecution(this.executions, input);
    if (!snapshot) {
      throw new Error("review_completion_finalized_execution_unavailable");
    }
    const command = await this.requestFactory.build(snapshot);
    if (!command) {
      throw new Error("review_completion_publication_plan_unavailable");
    }
    assertPublicationCommandMatchesArtifact(command, snapshot.artifact);
    const result = await this.requests.request(command);
    if (
      result.status !== RequestReviewPublicationStatus.Applied &&
      result.status !== RequestReviewPublicationStatus.Restored
    ) {
      throw new Error(`review_completion_publication_${result.status}`);
    }
    const view = await this.attempts.findById(
      result.attempt.publicationAttemptId,
    );
    if (!view) {
      throw new Error("review_completion_publication_ack_unreadable");
    }
    assertPublicationMatchesArtifact(view, snapshot.artifact);
    return publicationFacts(view, snapshot.artifact.artifactId);
  }
}

export type FinalizedArtifactIdentity = {
  readonly executionId: string;
  readonly finalizedArtifactId: string;
  readonly artifactHash: string;
};

export interface FinalizedArtifactIdentityQueryPort {
  findIdentity(input: {
    readonly executionId: string;
    readonly finalizedArtifactId: string;
  }): Promise<FinalizedArtifactIdentity | null>;
}

export interface ReviewSnapshotCommitApplicationPort {
  commit(
    command: CommitReviewSnapshotV2Command,
  ): Promise<CommitReviewSnapshotV2Result>;
}

export interface ReviewSnapshotCommitReceiptQueryPort {
  findBySource(input: {
    readonly sourceExecutionId: string;
    readonly sourceArtifactHash: string;
  }): Promise<ReviewSnapshotCommitReceipt | null>;
}

export class ReviewCompletionSnapshotContextAdapter implements ReviewCompletionSnapshotPort {
  constructor(
    private readonly executions: ReviewExecutionQueries,
    private readonly artifactIdentities: FinalizedArtifactIdentityQueryPort,
    private readonly attempts: ReviewPublicationAttemptQueryPort,
    private readonly snapshots: ReviewSnapshotV2QueryPort,
    private readonly commits: ReviewSnapshotCommitApplicationPort,
    private readonly projections: ReviewCompletionProjectionMapperPort,
    private readonly receipts?: ReviewSnapshotCommitReceiptQueryPort,
  ) {}

  async findReceipt(input: {
    readonly executionId: string;
    readonly finalizedArtifactId: string;
  }): Promise<ReviewCompletionSnapshotReceiptFacts | null> {
    if (!this.receipts) return null;
    const context = await this.loadContext(input);
    if (!context) return null;
    const receipt = await this.receipts.findBySource({
      sourceExecutionId: input.executionId,
      sourceArtifactHash: context.identity.artifactHash,
    });
    return receipt
      ? snapshotReceiptFacts(
          receipt,
          input.finalizedArtifactId,
          context.publication.attempt.publicationAttemptId,
        )
      : null;
  }

  async commit(input: {
    readonly executionId: string;
    readonly finalizedArtifactId: string;
    readonly publicationAttemptId: string;
  }): Promise<ReviewCompletionSnapshotReceiptFacts> {
    const context = await this.loadContext(input, input.publicationAttemptId);
    if (!context) {
      throw new Error("review_completion_snapshot_facts_unavailable");
    }
    if (
      effectiveReviewPublicationOutcome(context.publication) !==
        ReviewPublicationTerminalOutcome.Succeeded ||
      context.publication.attempt.state !==
        ReviewPublicationAttemptState.Terminal
    ) {
      throw new Error("review_completion_snapshot_publication_not_successful");
    }
    const projection = await this.projections.snapshotProjection(
      context.snapshot.artifact,
    );
    if (!projection) {
      throw new Error("review_completion_snapshot_projection_unavailable");
    }
    const scope = context.snapshot.artifact.publicationPermit;
    const current = await this.snapshots.findCurrent({
      workspaceId: scope.workspaceId,
      repositoryConnectionId: scope.repositoryConnectionId,
      scmRepositoryIdentityId: scope.scmRepositoryIdentityId,
      pullRequestNumber: scope.pullRequestNumber,
    });
    const command = buildSnapshotCommitCommand({
      snapshot: context.snapshot,
      artifactHash: context.identity.artifactHash,
      publication: context.publication,
      expectedSnapshotVersion: expectedSnapshotVersionForCommit(
        current,
        context.snapshot.execution.executionId,
        context.identity.artifactHash,
      ),
      projection,
    });
    const result = await this.commits.commit(command);
    if (
      result.status !== CommitReviewSnapshotV2Status.Applied &&
      result.status !== CommitReviewSnapshotV2Status.Restored
    ) {
      throw new Error(`review_completion_snapshot_${result.status}`);
    }
    return snapshotReceiptFacts(
      result.receipt,
      input.finalizedArtifactId,
      input.publicationAttemptId,
    );
  }

  private async loadContext(
    input: {
      readonly executionId: string;
      readonly finalizedArtifactId: string;
    },
    publicationAttemptId?: string,
  ): Promise<{
    readonly snapshot: ReviewExecutionSnapshot & {
      readonly artifact: FinalizedReviewProjectionArtifact;
    };
    readonly identity: FinalizedArtifactIdentity;
    readonly publication: ReviewPublicationAttemptView;
  } | null> {
    const snapshot = await loadFinalizedExecution(this.executions, input);
    if (!snapshot) return null;
    assertSnapshotEligibleArtifact(snapshot);
    const [identity, publication] = await Promise.all([
      this.artifactIdentities.findIdentity(input),
      publicationAttemptId
        ? this.attempts.findById(publicationAttemptId)
        : this.attempts.findByPermitIdentity(
            snapshot.artifact.publicationPermit,
          ),
    ]);
    if (!identity || !publication) return null;
    if (
      identity.executionId !== input.executionId ||
      identity.finalizedArtifactId !== input.finalizedArtifactId ||
      !isSha256(identity.artifactHash)
    ) {
      throw new Error("review_completion_artifact_identity_conflict");
    }
    assertPublicationMatchesArtifact(publication, snapshot.artifact);
    return { snapshot, identity, publication };
  }
}

function buildSnapshotCommitCommand(input: {
  readonly snapshot: ReviewExecutionSnapshot & {
    readonly artifact: FinalizedReviewProjectionArtifact;
  };
  readonly artifactHash: string;
  readonly publication: ReviewPublicationAttemptView;
  readonly expectedSnapshotVersion: number;
  readonly projection: ReviewCompletionSnapshotProjection;
}): CommitReviewSnapshotV2Command {
  const artifact = input.snapshot.artifact;
  const generation = Number(artifact.generation);
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new Error("review_completion_snapshot_generation_unsupported");
  }
  const envelope = parseCanonicalObject(artifact.projectionEnvelopeJson);
  const publicationReceiptSetHash = reviewPublicationReceiptSetHash(
    input.publication,
  );
  const receiptId = deterministicId(
    "snapshot-receipt",
    `${artifact.executionId}\0${input.artifactHash}`,
  );
  const candidate = {
    workspaceId: artifact.publicationPermit.workspaceId,
    repositoryConnectionId: artifact.publicationPermit.repositoryConnectionId,
    scmRepositoryIdentityId: artifact.publicationPermit.scmRepositoryIdentityId,
    pullRequestNumber: artifact.publicationPermit.pullRequestNumber,
    schemaVersion: 2 as const,
    sourceExecutionId: artifact.executionId,
    sourceExecutionGeneration: generation,
    sourceArtifactHash: input.artifactHash,
    sourceReviewRevisionHash: artifact.reviewRevisionHash,
    sourceBaseSha: input.snapshot.execution.revision.baseSha,
    sourceReviewedHeadSha: input.snapshot.execution.revision.headSha,
    sourceCompatibilityKey: input.snapshot.execution.compatibilityKey,
    sourceRunId: input.snapshot.execution.sourceRunId,
    sourceRunAttempt: input.snapshot.execution.sourceRunAttempt,
    payload: {
      projectionEnvelopeVersion: artifact.projectionEnvelopeVersion,
      projectionEnvelope: envelope,
      projectionHash: artifact.projectionHash,
      occurrences: input.projection.occurrences,
      lineageHints: input.projection.lineageHints,
    },
    createdAt: new Date(artifact.createdAt),
    expiresAt: new Date(input.projection.expiresAt),
  };
  const requestHash = sha256(
    canonicalJson({
      receiptId,
      expectedSnapshotVersion: input.expectedSnapshotVersion,
      publicationReceiptSetHash,
      candidate,
      receiptRetainUntil: artifact.retainUntil,
    }),
  );
  return {
    receiptId,
    requestHash,
    expectedSnapshotVersion: input.expectedSnapshotVersion,
    publicationReceiptSetHash,
    candidate,
    receiptRetainUntil: new Date(artifact.retainUntil),
  };
}

function expectedSnapshotVersionForCommit(
  current: Awaited<ReturnType<ReviewSnapshotV2QueryPort["findCurrent"]>>,
  sourceExecutionId: string,
  sourceArtifactHash: string,
): number {
  if (
    isReviewSnapshotV2Record(current) &&
    current.sourceExecutionId === sourceExecutionId &&
    current.sourceArtifactHash === sourceArtifactHash
  ) {
    if (current.version <= 0) {
      throw new Error("review_completion_snapshot_current_version_invalid");
    }
    return current.version - 1;
  }
  return current?.version ?? 0;
}

function isReviewSnapshotV2Record(
  value: Awaited<ReturnType<ReviewSnapshotV2QueryPort["findCurrent"]>>,
): value is ReviewSnapshotV2Record {
  return value?.schemaVersion === 2;
}

async function loadFinalizedExecution(
  executions: ReviewExecutionQueries,
  input: {
    readonly executionId: string;
    readonly finalizedArtifactId: string;
  },
): Promise<
  | (ReviewExecutionSnapshot & {
      readonly artifact: FinalizedReviewProjectionArtifact;
    })
  | null
> {
  const snapshot = await executions.findExecution(input.executionId);
  if (!snapshot || !snapshot.artifact) return null;
  if (
    snapshot.execution.executionId !== input.executionId ||
    snapshot.execution.finalizedArtifactId !== input.finalizedArtifactId ||
    snapshot.artifact.executionId !== input.executionId ||
    snapshot.artifact.artifactId !== input.finalizedArtifactId
  ) {
    return null;
  }
  if (
    snapshot.execution.state !== ReviewExecutionState.Completed &&
    snapshot.execution.state !== ReviewExecutionState.Partial
  ) {
    return null;
  }
  const finalized = { ...snapshot, artifact: snapshot.artifact };
  assertFinalizedSnapshotConsistency(finalized);
  return finalized;
}

export function reviewPublicationReceiptSetHash(
  publication: Pick<ReviewPublicationAttemptView, "receipts">,
): string {
  return sha256(
    canonicalJson(
      [...publication.receipts]
        .map((receipt) => ({
          operationId: receipt.publicationOperationId,
          receiptHash: receipt.receiptHash,
          status: receipt.status,
        }))
        .sort((left, right) =>
          left.operationId.localeCompare(right.operationId),
        ),
    ),
  );
}

function assertFinalizedSnapshotConsistency(
  snapshot: ReviewExecutionSnapshot & {
    readonly artifact: FinalizedReviewProjectionArtifact;
  },
): void {
  const { artifact, execution } = snapshot;
  const permit = artifact.publicationPermit;
  if (
    artifact.generation !== execution.generation ||
    artifact.reviewedHeadSha !== execution.revision.headSha ||
    artifact.reviewRevisionHash !== execution.revision.reviewRevisionHash ||
    permit.executionId !== execution.executionId ||
    permit.generation !== execution.generation ||
    permit.reviewedHeadSha !== artifact.reviewedHeadSha ||
    permit.reviewRevisionHash !== artifact.reviewRevisionHash ||
    permit.projectionHash !== artifact.projectionHash ||
    permit.authorizationId !== execution.authorizationId ||
    permit.producerReleaseId !== execution.producerReleaseId ||
    permit.permitEpoch !== execution.mutationEpoch
  ) {
    throw new Error("review_completion_finalized_execution_inconsistent");
  }
}

function requireFinalizedArtifact(
  snapshot: ReviewExecutionSnapshot,
): FinalizedReviewProjectionArtifact {
  if (!snapshot.artifact) {
    throw new Error("review_completion_finalized_artifact_required");
  }
  const completed =
    snapshot.execution.state === ReviewExecutionState.Completed &&
    snapshot.artifact.coverageState === ReviewCoverageState.Completed;
  const partial =
    snapshot.execution.state === ReviewExecutionState.Partial &&
    snapshot.artifact.coverageState === ReviewCoverageState.Partial;
  if (!completed && !partial) {
    throw new Error("review_completion_finalized_artifact_inconsistent");
  }
  return snapshot.artifact;
}

function assertSnapshotEligibleArtifact(
  snapshot: ReviewExecutionSnapshot & {
    readonly artifact: FinalizedReviewProjectionArtifact;
  },
): void {
  if (
    snapshot.execution.state === ReviewExecutionState.Partial ||
    snapshot.artifact.coverageState === ReviewCoverageState.Partial
  ) {
    throw new Error("review_completion_snapshot_partial_forbidden");
  }
  if (
    snapshot.execution.state !== ReviewExecutionState.Completed ||
    snapshot.artifact.coverageState !== ReviewCoverageState.Completed
  ) {
    throw new Error("review_completion_snapshot_coverage_ambiguous");
  }
}

function assertPublicationEnvelopeMatchesArtifact(
  envelope: PublishedReviewProjectionPublicationEnvelope,
  artifact: FinalizedReviewProjectionArtifact,
): void {
  const expectedCoverage =
    artifact.coverageState === ReviewCoverageState.Partial
      ? ReviewPublicationProjectionCoverage.Partial
      : ReviewPublicationProjectionCoverage.Completed;
  if (
    !(envelope.publicationNotAfter instanceof Date) ||
    !Number.isFinite(envelope.publicationNotAfter.getTime()) ||
    envelope.producerReleaseId !==
      artifact.publicationPermit.producerReleaseId ||
    envelope.projectionHash !== artifact.projectionHash ||
    envelope.coverage !== expectedCoverage ||
    envelope.targetCommitId !== artifact.reviewedHeadSha ||
    envelope.reviewRevisionHash !== artifact.reviewRevisionHash ||
    envelope.publicationNotAfter.getTime() !==
      artifact.publicationPermit.publicationNotAfter.getTime()
  ) {
    throw new Error("review_completion_publication_envelope_conflict");
  }
}

function mapCoverage(
  coverage: ReviewCoverageState,
): ReviewExecutionCompletionCoverage {
  switch (coverage) {
    case ReviewCoverageState.Completed:
      return ReviewExecutionCompletionCoverage.Completed;
    case ReviewCoverageState.Partial:
      return ReviewExecutionCompletionCoverage.Partial;
  }
}

function publicationFacts(
  view: ReviewPublicationAttemptView,
  finalizedArtifactId: string,
): ReviewCompletionPublicationFacts {
  return {
    publicationAttemptId: view.attempt.publicationAttemptId,
    executionId: view.attempt.permit.executionId,
    finalizedArtifactId,
    state: mapPublicationState(view.attempt.state),
    effectiveOutcome: mapPublicationOutcome(
      effectiveReviewPublicationOutcome(view),
    ),
    nextCheckAt: null,
  };
}

function mapPublicationState(
  state: ReviewPublicationAttemptState,
): ReviewCompletionPublicationState {
  switch (state) {
    case ReviewPublicationAttemptState.Pending:
      return ReviewCompletionPublicationState.Pending;
    case ReviewPublicationAttemptState.Publishing:
    case ReviewPublicationAttemptState.Reconciling:
      return ReviewCompletionPublicationState.InProgress;
    case ReviewPublicationAttemptState.Terminal:
      return ReviewCompletionPublicationState.Terminal;
  }
}

function mapPublicationOutcome(
  outcome: ReviewPublicationTerminalOutcome | null,
): ReviewCompletionPublicationOutcome | null {
  switch (outcome) {
    case null:
      return null;
    case ReviewPublicationTerminalOutcome.Succeeded:
      return ReviewCompletionPublicationOutcome.Succeeded;
    case ReviewPublicationTerminalOutcome.SupersededNoEffect:
      return ReviewCompletionPublicationOutcome.SupersededNoEffect;
    case ReviewPublicationTerminalOutcome.FailedNoEffect:
      return ReviewCompletionPublicationOutcome.FailedNoEffect;
    case ReviewPublicationTerminalOutcome.StaleCompensated:
      return ReviewCompletionPublicationOutcome.StaleCompensated;
    case ReviewPublicationTerminalOutcome.StaleVisible:
      return ReviewCompletionPublicationOutcome.StaleVisible;
    case ReviewPublicationTerminalOutcome.TerminalUnknown:
      return ReviewCompletionPublicationOutcome.TerminalUnknown;
  }
}

function assertPublicationMatchesArtifact(
  view: ReviewPublicationAttemptView,
  artifact: FinalizedReviewProjectionArtifact,
): void {
  const permit = view.attempt.permit;
  const expected = artifact.publicationPermit;
  if (
    permit.executionId !== artifact.executionId ||
    permit.generation !== artifact.generation ||
    permit.projectionHash !== artifact.projectionHash ||
    permit.reviewRevisionHash !== artifact.reviewRevisionHash ||
    permit.authorizationId !== expected.authorizationId ||
    permit.producerReleaseId !== expected.producerReleaseId ||
    permit.permitEpoch !== expected.permitEpoch ||
    permit.publicationSafetyDecisionHash !==
      expected.publicationSafetyDecisionHash
  ) {
    throw new Error("review_completion_publication_identity_conflict");
  }
}

function assertPublicationCommandMatchesArtifact(
  command: RequestReviewPublicationCommand,
  artifact: FinalizedReviewProjectionArtifact,
): void {
  if (
    command.permit.executionId !== artifact.executionId ||
    command.permit.generation !== artifact.generation ||
    command.permit.projectionHash !== artifact.projectionHash ||
    command.operations.some(
      (operation) =>
        operation.reviewRevisionHash !== artifact.reviewRevisionHash ||
        operation.targetCommitId !== artifact.reviewedHeadSha,
    )
  ) {
    throw new Error("review_completion_publication_command_identity_conflict");
  }
}

function snapshotReceiptFacts(
  receipt: ReviewSnapshotCommitReceipt,
  finalizedArtifactId: string,
  publicationAttemptId: string,
): ReviewCompletionSnapshotReceiptFacts {
  return {
    snapshotCommitReceiptId: receipt.receiptId,
    executionId: receipt.sourceExecutionId,
    finalizedArtifactId,
    publicationAttemptId,
    outcome: mapSnapshotOutcome(receipt.outcome),
  };
}

function mapSnapshotOutcome(
  outcome: ReviewSnapshotV2CommitOutcome,
): ReviewCompletionSnapshotOutcome {
  switch (outcome) {
    case ReviewSnapshotV2CommitOutcome.Committed:
      return ReviewCompletionSnapshotOutcome.Committed;
    case ReviewSnapshotV2CommitOutcome.AlreadyCurrent:
      return ReviewCompletionSnapshotOutcome.AlreadyCurrent;
    case ReviewSnapshotV2CommitOutcome.SupersededByHigherGeneration:
      return ReviewCompletionSnapshotOutcome.SupersededByHigherGeneration;
  }
}

function deterministicId(prefix: string, preimage: string): string {
  return `${prefix}-${sha256(`rr.${prefix}.v2\0${preimage}`).slice(0, 40)}`;
}

function parseCanonicalObject(
  value: string,
): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("review_completion_projection_envelope_invalid");
  }
  if (!isRecord(parsed) || canonicalJson(parsed) !== value) {
    throw new Error("review_completion_projection_envelope_invalid");
  }
  return parsed;
}

function canonicalJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
