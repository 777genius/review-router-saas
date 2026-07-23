import {
  Prisma,
  type PrismaClient,
  type ReviewCompletionProcess as PrismaReviewCompletionProcess,
} from "@prisma/client";
import {
  ReviewCompletionProcessCreateStatus,
  ReviewCompletionProcessTransitionStatus,
  type ReviewCompletionProcessCreateResult,
  type ReviewCompletionProcessRepositoryPort,
  type ReviewCompletionProcessTransitionResult,
} from "../../application/ports/review-completion-process-ports";
import {
  ReviewCompletionProcessState,
  ReviewCompletionSafeReason,
  ReviewCompletionWakeupKind,
  applyReviewCompletionTransition,
  createReviewCompletionProcess,
  isSameReviewCompletionClaim,
  wakeReviewCompletionProcess,
  type CreateReviewCompletionProcessInput,
  type ReviewCompletionProcess,
  type ReviewCompletionProcessClaim,
  type ReviewCompletionTransition,
} from "../../domain/review-completion-process";

const maximumCreateOrWakeAttempts = 8;

export class PrismaReviewCompletionProcessRepository implements ReviewCompletionProcessRepositoryPort {
  constructor(private readonly prisma: PrismaClient) {}

  async createOrWake(
    input: CreateReviewCompletionProcessInput,
  ): Promise<ReviewCompletionProcessCreateResult> {
    for (let attempt = 0; attempt < maximumCreateOrWakeAttempts; attempt += 1) {
      const existing = await this.findByExecutionId(input.executionId);
      if (!existing) {
        const candidate = createReviewCompletionProcess(input);
        try {
          const created = await this.prisma.reviewCompletionProcess.create({
            data: toCreateData(candidate),
          });
          return {
            status: ReviewCompletionProcessCreateStatus.Created,
            process: toDomain(created),
          };
        } catch (error) {
          if (isUniqueConstraintError(error)) continue;
          throw error;
        }
      }

      if (existing.finalizedArtifactId !== input.finalizedArtifactId) {
        return {
          status: ReviewCompletionProcessCreateStatus.ArtifactConflict,
          process: existing,
        };
      }

      const woken = wakeReviewCompletionProcess(existing, input);
      if (woken === existing) {
        return {
          status: ReviewCompletionProcessCreateStatus.Restored,
          process: existing,
        };
      }

      const updated = await this.prisma.reviewCompletionProcess.updateMany({
        where: {
          executionId: existing.executionId,
          processVersion: existing.processVersion,
          finalizedArtifactId: existing.finalizedArtifactId,
        },
        data: toUpdateData(woken),
      });
      if (updated.count === 1) {
        const process = await this.findByExecutionId(input.executionId);
        if (!process) {
          throw new Error("review_completion_process_missing_after_wake");
        }
        return {
          status: ReviewCompletionProcessCreateStatus.Woken,
          process,
        };
      }
    }

    throw new Error("review_completion_process_create_or_wake_contention");
  }

  async findByExecutionId(
    executionId: string,
  ): Promise<ReviewCompletionProcess | null> {
    const record = await this.prisma.reviewCompletionProcess.findUnique({
      where: { executionId },
    });
    return record ? toDomain(record) : null;
  }

  async claimByExecutionId(input: {
    readonly executionId: string;
    readonly claimId: string;
    readonly ownerIdHash: string;
    readonly now: Date;
    readonly claimUntil: Date;
  }): Promise<ReviewCompletionProcessClaim | null> {
    assertClaimInput(input);
    const rows = await this.prisma.$queryRaw<ClaimRow[]>(Prisma.sql`
      UPDATE "ReviewCompletionProcess"
      SET
        "processVersion" = "processVersion" + 1,
        "claimId" = ${input.claimId},
        "claimOwnerIdHash" = ${input.ownerIdHash},
        "claimFencingToken" = nextval('"ReviewCompletionProcess_claimFencingToken_seq"'),
        "claimUntil" = ${input.claimUntil},
        "nextActionAt" = ${input.claimUntil}
      WHERE "executionId" = ${input.executionId}
        AND "state" IN ('awaiting_publication', 'pending_publication', 'pending_snapshot')
        AND "retainUntil" > ${input.now}
        AND ("claimId" IS NULL OR "claimUntil" <= ${input.now})
      RETURNING
        "executionId",
        "processVersion",
        "claimId",
        "claimOwnerIdHash",
        "claimFencingToken",
        "claimUntil"
    `);
    return rows[0] ? claimRowToDomain(rows[0]) : null;
  }

  async claimDue(input: {
    readonly now: Date;
    readonly limit: number;
    readonly ownerIdHash: string;
    readonly claimIdForExecution: (executionId: string) => string;
    readonly claimUntil: Date;
  }): Promise<readonly ReviewCompletionProcessClaim[]> {
    assertClaimLimit(input.limit);
    assertClaimDeadline(input.now, input.claimUntil);
    assertClaimIdentity("ownerIdHash", input.ownerIdHash);

    return this.prisma.$transaction(async (transaction) => {
      const candidates = await transaction.$queryRaw<DueCandidateRow[]>(
        Prisma.sql`
          SELECT "executionId"
          FROM "ReviewCompletionProcess"
          WHERE "state" IN ('awaiting_publication', 'pending_publication', 'pending_snapshot')
            AND "retainUntil" > ${input.now}
            AND "nextActionAt" IS NOT NULL
            AND "nextActionAt" <= ${input.now}
            AND ("claimId" IS NULL OR "claimUntil" <= ${input.now})
          ORDER BY "nextActionAt" ASC, "executionId" ASC
          FOR UPDATE SKIP LOCKED
          LIMIT ${input.limit}
        `,
      );
      const claims: ReviewCompletionProcessClaim[] = [];

      for (const candidate of candidates) {
        const claimId = input.claimIdForExecution(candidate.executionId);
        assertClaimIdentity("claimId", claimId);
        const rows = await transaction.$queryRaw<ClaimRow[]>(Prisma.sql`
          UPDATE "ReviewCompletionProcess"
          SET
            "processVersion" = "processVersion" + 1,
            "claimId" = ${claimId},
            "claimOwnerIdHash" = ${input.ownerIdHash},
            "claimFencingToken" = nextval('"ReviewCompletionProcess_claimFencingToken_seq"'),
            "claimUntil" = ${input.claimUntil},
            "nextActionAt" = ${input.claimUntil}
          WHERE "executionId" = ${candidate.executionId}
          RETURNING
            "executionId",
            "processVersion",
            "claimId",
            "claimOwnerIdHash",
            "claimFencingToken",
            "claimUntil"
        `);
        if (!rows[0]) {
          throw new Error("review_completion_process_claim_lost_locked_row");
        }
        claims.push(claimRowToDomain(rows[0]));
      }

      return claims;
    });
  }

  async applyTransition(
    claim: ReviewCompletionProcessClaim,
    transition: ReviewCompletionTransition,
  ): Promise<ReviewCompletionProcessTransitionResult> {
    const process = await this.findByExecutionId(claim.executionId);
    if (!process) {
      return { status: ReviewCompletionProcessTransitionStatus.Missing };
    }
    if (
      !isSameReviewCompletionClaim(process, claim) ||
      claim.claimUntil.getTime() <= transition.now.getTime()
    ) {
      return { status: ReviewCompletionProcessTransitionStatus.StaleClaim };
    }

    const next = applyReviewCompletionTransition(process, transition);
    const updated = await this.prisma.reviewCompletionProcess.updateMany({
      where: {
        executionId: claim.executionId,
        processVersion: claim.processVersion,
        claimId: claim.claimId,
        claimOwnerIdHash: claim.ownerIdHash,
        claimFencingToken: claim.fencingToken,
        claimUntil: claim.claimUntil,
      },
      data: toUpdateData(next),
    });
    if (updated.count !== 1) {
      const current = await this.findByExecutionId(claim.executionId);
      return current
        ? { status: ReviewCompletionProcessTransitionStatus.StaleClaim }
        : { status: ReviewCompletionProcessTransitionStatus.Missing };
    }

    const applied = await this.findByExecutionId(claim.executionId);
    if (!applied) {
      throw new Error("review_completion_process_missing_after_transition");
    }
    return {
      status: ReviewCompletionProcessTransitionStatus.Applied,
      process: applied,
    };
  }
}

type ClaimRow = {
  readonly executionId: string;
  readonly processVersion: bigint;
  readonly claimId: string | null;
  readonly claimOwnerIdHash: string | null;
  readonly claimFencingToken: bigint | null;
  readonly claimUntil: Date | null;
};

type DueCandidateRow = {
  readonly executionId: string;
};

function claimRowToDomain(row: ClaimRow): ReviewCompletionProcessClaim {
  if (
    row.claimId === null ||
    row.claimOwnerIdHash === null ||
    row.claimFencingToken === null ||
    row.claimUntil === null
  ) {
    throw new Error("review_completion_process_invalid_persisted_claim");
  }
  return {
    executionId: row.executionId,
    processVersion: row.processVersion,
    claimId: row.claimId,
    ownerIdHash: row.claimOwnerIdHash,
    fencingToken: row.claimFencingToken,
    claimUntil: new Date(row.claimUntil),
  };
}

function toDomain(
  record: PrismaReviewCompletionProcess,
): ReviewCompletionProcess {
  const claimParts = [
    record.claimId,
    record.claimOwnerIdHash,
    record.claimFencingToken,
    record.claimUntil,
  ];
  const hasClaim = claimParts.every((part) => part !== null);
  if (!hasClaim && claimParts.some((part) => part !== null)) {
    throw new Error("review_completion_process_invalid_persisted_claim");
  }
  if (record.processVersion < 1n || record.attemptCount < 0) {
    throw new Error("review_completion_process_invalid_persisted_version");
  }
  if (record.lastSafeReason === null) {
    throw new Error("review_completion_process_missing_safe_reason");
  }

  return {
    executionId: record.executionId,
    processVersion: record.processVersion,
    finalizedArtifactId: record.finalizedArtifactId,
    publicationAttemptId: record.publicationAttemptId,
    snapshotCommitReceiptId: record.snapshotCommitReceiptId,
    state: fromPersistenceState(record.state),
    lastWakeupKind: fromPersistenceWakeupKind(record.lastWakeupKind),
    lastWakeupAt: new Date(record.lastWakeupAt),
    nextActionAt: copyDate(record.nextActionAt),
    attemptCount: record.attemptCount,
    lastSafeReason: fromPersistenceSafeReason(record.lastSafeReason),
    activeClaimId: record.claimId,
    claimOwnerHash: record.claimOwnerIdHash,
    claimFencingToken: record.claimFencingToken,
    claimUntil: copyDate(record.claimUntil),
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
    retainUntil: new Date(record.retainUntil),
  };
}

function toCreateData(
  process: ReviewCompletionProcess,
): Prisma.ReviewCompletionProcessUncheckedCreateInput {
  return {
    executionId: process.executionId,
    processVersion: process.processVersion,
    finalizedArtifactId: process.finalizedArtifactId,
    publicationAttemptId: process.publicationAttemptId,
    snapshotCommitReceiptId: process.snapshotCommitReceiptId,
    state: toPersistenceState(process.state),
    lastWakeupKind: toPersistenceWakeupKind(process.lastWakeupKind),
    lastWakeupAt: process.lastWakeupAt,
    nextActionAt: process.nextActionAt,
    attemptCount: process.attemptCount,
    lastSafeReason: process.lastSafeReason,
    claimId: process.activeClaimId,
    claimOwnerIdHash: process.claimOwnerHash,
    claimFencingToken: process.claimFencingToken,
    claimUntil: process.claimUntil,
    createdAt: process.createdAt,
    updatedAt: process.updatedAt,
    retainUntil: process.retainUntil,
  };
}

function toUpdateData(
  process: ReviewCompletionProcess,
): Prisma.ReviewCompletionProcessUpdateManyMutationInput {
  return {
    processVersion: process.processVersion,
    publicationAttemptId: process.publicationAttemptId,
    snapshotCommitReceiptId: process.snapshotCommitReceiptId,
    state: toPersistenceState(process.state),
    lastWakeupKind: toPersistenceWakeupKind(process.lastWakeupKind),
    lastWakeupAt: process.lastWakeupAt,
    nextActionAt: process.nextActionAt,
    attemptCount: process.attemptCount,
    lastSafeReason: process.lastSafeReason,
    claimId: process.activeClaimId,
    claimOwnerIdHash: process.claimOwnerHash,
    claimFencingToken: process.claimFencingToken,
    claimUntil: process.claimUntil,
    updatedAt: process.updatedAt,
    retainUntil: process.retainUntil,
  };
}

function toPersistenceState(state: ReviewCompletionProcessState) {
  switch (state) {
    case ReviewCompletionProcessState.AwaitingPublication:
      return "awaiting_publication" as const;
    case ReviewCompletionProcessState.PublicationInProgress:
      return "pending_publication" as const;
    case ReviewCompletionProcessState.AwaitingSnapshot:
      return "pending_snapshot" as const;
    case ReviewCompletionProcessState.Completed:
      return "completed" as const;
    case ReviewCompletionProcessState.CompletedSuperseded:
      return "completed_superseded" as const;
    case ReviewCompletionProcessState.PartialCompleted:
      // The additive v2 schema originally named this terminal slot blocked_partial.
      return "blocked_partial" as const;
    case ReviewCompletionProcessState.PublicationNotApplied:
      return "publication_not_applied" as const;
    case ReviewCompletionProcessState.PublicationStaleCompensated:
      return "publication_stale_compensated" as const;
    case ReviewCompletionProcessState.PublicationStaleVisible:
      return "publication_stale_visible" as const;
    case ReviewCompletionProcessState.BlockedPublicationUnknown:
      return "blocked_publication_unknown" as const;
  }
}

function fromPersistenceState(
  state: PrismaReviewCompletionProcess["state"],
): ReviewCompletionProcessState {
  switch (state) {
    case "awaiting_publication":
      return ReviewCompletionProcessState.AwaitingPublication;
    case "pending_publication":
      return ReviewCompletionProcessState.PublicationInProgress;
    case "pending_snapshot":
      return ReviewCompletionProcessState.AwaitingSnapshot;
    case "completed":
      return ReviewCompletionProcessState.Completed;
    case "completed_superseded":
      return ReviewCompletionProcessState.CompletedSuperseded;
    case "blocked_partial":
      return ReviewCompletionProcessState.PartialCompleted;
    case "publication_not_applied":
      return ReviewCompletionProcessState.PublicationNotApplied;
    case "publication_stale_compensated":
      return ReviewCompletionProcessState.PublicationStaleCompensated;
    case "publication_stale_visible":
      return ReviewCompletionProcessState.PublicationStaleVisible;
    case "blocked_publication_unknown":
      return ReviewCompletionProcessState.BlockedPublicationUnknown;
  }
}

function toPersistenceWakeupKind(kind: ReviewCompletionWakeupKind) {
  switch (kind) {
    case ReviewCompletionWakeupKind.ExecutionFinalized:
      return "finalized_artifact_event" as const;
    case ReviewCompletionWakeupKind.PublicationChanged:
      return "publication_event" as const;
    case ReviewCompletionWakeupKind.SnapshotChanged:
      return "snapshot_event" as const;
    case ReviewCompletionWakeupKind.RecoveryScan:
      return "recovery_scan" as const;
    case ReviewCompletionWakeupKind.DueScan:
      return "due_scan" as const;
  }
}

function fromPersistenceWakeupKind(
  kind: PrismaReviewCompletionProcess["lastWakeupKind"],
): ReviewCompletionWakeupKind {
  switch (kind) {
    case "finalized_artifact_event":
      return ReviewCompletionWakeupKind.ExecutionFinalized;
    case "publication_event":
      return ReviewCompletionWakeupKind.PublicationChanged;
    case "snapshot_event":
      return ReviewCompletionWakeupKind.SnapshotChanged;
    case "recovery_scan":
      return ReviewCompletionWakeupKind.RecoveryScan;
    case "due_scan":
      return ReviewCompletionWakeupKind.DueScan;
  }
}

function fromPersistenceSafeReason(value: string): ReviewCompletionSafeReason {
  switch (value) {
    case ReviewCompletionSafeReason.AwaitingPublication:
    case ReviewCompletionSafeReason.PartialCoverage:
    case ReviewCompletionSafeReason.PartialCoveragePublished:
    case ReviewCompletionSafeReason.ExecutionFactsUnavailable:
    case ReviewCompletionSafeReason.PublicationRequested:
    case ReviewCompletionSafeReason.PublicationPending:
    case ReviewCompletionSafeReason.PublicationSucceeded:
    case ReviewCompletionSafeReason.PublicationSupersededNoEffect:
    case ReviewCompletionSafeReason.PublicationFailedNoEffect:
    case ReviewCompletionSafeReason.PublicationStaleCompensated:
    case ReviewCompletionSafeReason.PublicationStaleVisible:
    case ReviewCompletionSafeReason.PublicationTerminalUnknown:
    case ReviewCompletionSafeReason.PublicationOutcomeUnavailable:
    case ReviewCompletionSafeReason.PublicationCommandAmbiguous:
    case ReviewCompletionSafeReason.SnapshotCommitted:
    case ReviewCompletionSafeReason.SnapshotAlreadyCurrent:
    case ReviewCompletionSafeReason.SnapshotSuperseded:
    case ReviewCompletionSafeReason.SnapshotOutcomeUnavailable:
    case ReviewCompletionSafeReason.SnapshotCommandAmbiguous:
      return value;
    default:
      throw new Error("review_completion_process_invalid_safe_reason");
  }
}

function assertClaimInput(input: {
  readonly claimId: string;
  readonly ownerIdHash: string;
  readonly now: Date;
  readonly claimUntil: Date;
}): void {
  assertClaimIdentity("claimId", input.claimId);
  assertClaimIdentity("ownerIdHash", input.ownerIdHash);
  assertClaimDeadline(input.now, input.claimUntil);
}

function assertClaimIdentity(field: string, value: string): void {
  if (value.trim().length === 0) {
    throw new Error(`review_completion_invalid_${field}`);
  }
}

function assertClaimLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("review_completion_invalid_claim_limit");
  }
}

function assertClaimDeadline(now: Date, claimUntil: Date): void {
  if (claimUntil.getTime() <= now.getTime()) {
    throw new Error("review_completion_invalid_claim_deadline");
  }
}

function copyDate(value: Date | null): Date | null {
  return value ? new Date(value) : null;
}

function isUniqueConstraintError(
  error: unknown,
): error is Prisma.PrismaClientKnownRequestError {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}
