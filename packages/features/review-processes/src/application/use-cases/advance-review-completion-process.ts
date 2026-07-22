import {
  ReviewCompletionProcessState,
  ReviewCompletionSafeReason,
  isReviewCompletionProcessTerminal,
  isSameReviewCompletionClaim,
  type ReviewCompletionProcess,
  type ReviewCompletionProcessClaim,
  type ReviewCompletionTransition,
} from "../../domain/review-completion-process";
import {
  ReviewCompletionProcessTransitionStatus,
  ReviewCompletionPublicationOutcome,
  ReviewCompletionPublicationState,
  ReviewCompletionSnapshotOutcome,
  ReviewExecutionCompletionCoverage,
  type ReviewCompletionClockPort,
  type ReviewCompletionExecutionQueryPort,
  type ReviewCompletionIdPort,
  type ReviewCompletionProcessRepositoryPort,
  type ReviewCompletionPublicationFacts,
  type ReviewCompletionPublicationPort,
  type ReviewCompletionSnapshotPort,
  type ReviewCompletionSnapshotReceiptFacts,
} from "../ports/review-completion-process-ports";

export enum AdvanceReviewCompletionProcessStatus {
  Advanced = "advanced",
  RetryDue = "retry_due",
  Completed = "completed",
  CompletedSuperseded = "completed_superseded",
  PartialCompleted = "partial_completed",
  BlockedPublicationUnknown = "blocked_publication_unknown",
  PublicationNotApplied = "publication_not_applied",
  PublicationStaleCompensated = "publication_stale_compensated",
  PublicationStaleVisible = "publication_stale_visible",
  Busy = "busy",
  StaleClaim = "stale_claim",
  Missing = "missing",
}

export type AdvanceReviewCompletionProcessResult = {
  readonly status: AdvanceReviewCompletionProcessStatus;
  readonly process: ReviewCompletionProcess | null;
};

export type AdvanceReviewCompletionProcessOptions = {
  readonly claimDurationMs: number;
  readonly retryDelayMs: (attemptCount: number) => number;
};

export class AdvanceReviewCompletionProcess {
  constructor(
    private readonly processes: ReviewCompletionProcessRepositoryPort,
    private readonly executions: ReviewCompletionExecutionQueryPort,
    private readonly publications: ReviewCompletionPublicationPort,
    private readonly snapshots: ReviewCompletionSnapshotPort,
    private readonly clock: ReviewCompletionClockPort,
    private readonly ids: ReviewCompletionIdPort,
    private readonly options: AdvanceReviewCompletionProcessOptions,
  ) {
    if (
      !Number.isSafeInteger(options.claimDurationMs) ||
      options.claimDurationMs <= 0
    ) {
      throw new Error("review_completion_invalid_claim_duration");
    }
  }

  async execute(input: {
    readonly executionId: string;
    readonly ownerIdHash: string;
  }): Promise<AdvanceReviewCompletionProcessResult> {
    const now = this.clock.now();
    const claim = await this.processes.claimByExecutionId({
      executionId: input.executionId,
      claimId: this.ids.nextClaimId(input.executionId),
      ownerIdHash: input.ownerIdHash,
      now,
      claimUntil: new Date(now.getTime() + this.options.claimDurationMs),
    });
    if (!claim) {
      const process = await this.processes.findByExecutionId(input.executionId);
      if (!process)
        return {
          status: AdvanceReviewCompletionProcessStatus.Missing,
          process: null,
        };
      if (isReviewCompletionProcessTerminal(process.state)) {
        return { status: statusForProcess(process), process };
      }
      return { status: AdvanceReviewCompletionProcessStatus.Busy, process };
    }
    return this.executeClaim(claim);
  }

  async executeClaim(
    claim: ReviewCompletionProcessClaim,
  ): Promise<AdvanceReviewCompletionProcessResult> {
    const process = await this.processes.findByExecutionId(claim.executionId);
    if (!process) {
      return {
        status: AdvanceReviewCompletionProcessStatus.Missing,
        process: null,
      };
    }
    const now = this.clock.now();
    if (
      !isSameReviewCompletionClaim(process, claim) ||
      claim.claimUntil.getTime() <= now.getTime()
    ) {
      return {
        status: AdvanceReviewCompletionProcessStatus.StaleClaim,
        process,
      };
    }

    const execution = await this.executions.findFinalized({
      executionId: process.executionId,
      finalizedArtifactId: process.finalizedArtifactId,
    });
    if (!execution) {
      return this.retry(
        process,
        claim,
        now,
        ReviewCompletionSafeReason.ExecutionFactsUnavailable,
      );
    }
    if (
      execution.executionId !== process.executionId ||
      execution.finalizedArtifactId !== process.finalizedArtifactId
    ) {
      throw new Error("review_completion_execution_facts_identity_conflict");
    }
    if (process.state === ReviewCompletionProcessState.AwaitingSnapshot) {
      if (execution.coverage !== ReviewExecutionCompletionCoverage.Completed) {
        return this.retry(
          process,
          claim,
          now,
          ReviewCompletionSafeReason.ExecutionFactsUnavailable,
        );
      }
      return this.advanceSnapshot(process, claim, now);
    }
    if (
      execution.coverage !== ReviewExecutionCompletionCoverage.Completed &&
      execution.coverage !== ReviewExecutionCompletionCoverage.Partial
    ) {
      return this.retry(
        process,
        claim,
        now,
        ReviewCompletionSafeReason.ExecutionFactsUnavailable,
      );
    }
    return this.advancePublication(process, claim, now, execution.coverage);
  }

  private async advancePublication(
    process: ReviewCompletionProcess,
    claim: ReviewCompletionProcessClaim,
    now: Date,
    coverage: ReviewExecutionCompletionCoverage,
  ): Promise<AdvanceReviewCompletionProcessResult> {
    let publication: ReviewCompletionPublicationFacts | null;
    try {
      publication = await this.publications.findByExecution({
        executionId: process.executionId,
        finalizedArtifactId: process.finalizedArtifactId,
        publicationAttemptId: process.publicationAttemptId,
      });
      if (!publication) {
        publication = await this.publications.request({
          executionId: process.executionId,
          finalizedArtifactId: process.finalizedArtifactId,
        });
      }
    } catch {
      return this.retry(
        process,
        claim,
        now,
        ReviewCompletionSafeReason.PublicationCommandAmbiguous,
      );
    }

    assertPublicationIdentity(process, publication);
    if (
      publication.state === ReviewCompletionPublicationState.Pending ||
      publication.state === ReviewCompletionPublicationState.InProgress
    ) {
      return this.record(process, claim, {
        state: ReviewCompletionProcessState.PublicationInProgress,
        publicationAttemptId: publication.publicationAttemptId,
        nextActionAt: publication.nextCheckAt ?? this.retryAt(process, now),
        lastSafeReason:
          publication.state === ReviewCompletionPublicationState.Pending
            ? ReviewCompletionSafeReason.PublicationRequested
            : ReviewCompletionSafeReason.PublicationPending,
        now,
      });
    }
    if (publication.state !== ReviewCompletionPublicationState.Terminal) {
      return this.retry(
        process,
        claim,
        now,
        ReviewCompletionSafeReason.PublicationOutcomeUnavailable,
      );
    }

    switch (publication.effectiveOutcome) {
      case ReviewCompletionPublicationOutcome.Succeeded:
        if (coverage === ReviewExecutionCompletionCoverage.Partial) {
          return this.record(process, claim, {
            state: ReviewCompletionProcessState.PartialCompleted,
            publicationAttemptId: publication.publicationAttemptId,
            snapshotCommitReceiptId: null,
            nextActionAt: null,
            lastSafeReason: ReviewCompletionSafeReason.PartialCoveragePublished,
            now,
          });
        }
        if (coverage !== ReviewExecutionCompletionCoverage.Completed) {
          return this.retry(
            process,
            claim,
            now,
            ReviewCompletionSafeReason.ExecutionFactsUnavailable,
          );
        }
        return this.record(process, claim, {
          state: ReviewCompletionProcessState.AwaitingSnapshot,
          publicationAttemptId: publication.publicationAttemptId,
          nextActionAt: now,
          lastSafeReason: ReviewCompletionSafeReason.PublicationSucceeded,
          now,
        });
      case ReviewCompletionPublicationOutcome.SupersededNoEffect:
        return this.record(process, claim, {
          state: ReviewCompletionProcessState.PublicationNotApplied,
          publicationAttemptId: publication.publicationAttemptId,
          nextActionAt: null,
          lastSafeReason:
            ReviewCompletionSafeReason.PublicationSupersededNoEffect,
          now,
        });
      case ReviewCompletionPublicationOutcome.FailedNoEffect:
        return this.record(process, claim, {
          state: ReviewCompletionProcessState.PublicationNotApplied,
          publicationAttemptId: publication.publicationAttemptId,
          nextActionAt: null,
          lastSafeReason: ReviewCompletionSafeReason.PublicationFailedNoEffect,
          now,
        });
      case ReviewCompletionPublicationOutcome.StaleCompensated:
        return this.record(process, claim, {
          state: ReviewCompletionProcessState.PublicationStaleCompensated,
          publicationAttemptId: publication.publicationAttemptId,
          nextActionAt: null,
          lastSafeReason:
            ReviewCompletionSafeReason.PublicationStaleCompensated,
          now,
        });
      case ReviewCompletionPublicationOutcome.StaleVisible:
        return this.record(process, claim, {
          state: ReviewCompletionProcessState.PublicationStaleVisible,
          publicationAttemptId: publication.publicationAttemptId,
          nextActionAt: null,
          lastSafeReason: ReviewCompletionSafeReason.PublicationStaleVisible,
          now,
        });
      case ReviewCompletionPublicationOutcome.TerminalUnknown:
        return this.record(process, claim, {
          state: ReviewCompletionProcessState.BlockedPublicationUnknown,
          publicationAttemptId: publication.publicationAttemptId,
          nextActionAt: null,
          lastSafeReason: ReviewCompletionSafeReason.PublicationTerminalUnknown,
          now,
        });
      case null:
        return this.retry(
          process,
          claim,
          now,
          ReviewCompletionSafeReason.PublicationOutcomeUnavailable,
        );
      default:
        return this.retry(
          process,
          claim,
          now,
          ReviewCompletionSafeReason.PublicationOutcomeUnavailable,
        );
    }
  }

  private async advanceSnapshot(
    process: ReviewCompletionProcess,
    claim: ReviewCompletionProcessClaim,
    now: Date,
  ): Promise<AdvanceReviewCompletionProcessResult> {
    if (!process.publicationAttemptId) {
      throw new Error("review_completion_snapshot_without_publication_attempt");
    }

    let receipt: ReviewCompletionSnapshotReceiptFacts | null;
    try {
      receipt = await this.snapshots.findReceipt({
        executionId: process.executionId,
        finalizedArtifactId: process.finalizedArtifactId,
      });
      if (!receipt) {
        receipt = await this.snapshots.commit({
          executionId: process.executionId,
          finalizedArtifactId: process.finalizedArtifactId,
          publicationAttemptId: process.publicationAttemptId,
        });
      }
    } catch {
      return this.retry(
        process,
        claim,
        now,
        ReviewCompletionSafeReason.SnapshotCommandAmbiguous,
      );
    }

    assertSnapshotIdentity(process, receipt);
    const superseded =
      receipt.outcome ===
      ReviewCompletionSnapshotOutcome.SupersededByHigherGeneration;
    return this.record(process, claim, {
      state: superseded
        ? ReviewCompletionProcessState.CompletedSuperseded
        : ReviewCompletionProcessState.Completed,
      snapshotCommitReceiptId: receipt.snapshotCommitReceiptId,
      nextActionAt: null,
      lastSafeReason: superseded
        ? ReviewCompletionSafeReason.SnapshotSuperseded
        : receipt.outcome === ReviewCompletionSnapshotOutcome.AlreadyCurrent
          ? ReviewCompletionSafeReason.SnapshotAlreadyCurrent
          : ReviewCompletionSafeReason.SnapshotCommitted,
      now,
    });
  }

  private retry(
    process: ReviewCompletionProcess,
    claim: ReviewCompletionProcessClaim,
    now: Date,
    reason: ReviewCompletionSafeReason,
  ): Promise<AdvanceReviewCompletionProcessResult> {
    return this.record(process, claim, {
      state: process.state,
      nextActionAt: this.retryAt(process, now),
      lastSafeReason: reason,
      now,
    });
  }

  private retryAt(process: ReviewCompletionProcess, now: Date): Date {
    const delay = this.options.retryDelayMs(process.attemptCount + 1);
    if (!Number.isSafeInteger(delay) || delay <= 0) {
      throw new Error("review_completion_invalid_retry_delay");
    }
    return new Date(
      Math.min(now.getTime() + delay, process.retainUntil.getTime()),
    );
  }

  private async record(
    _process: ReviewCompletionProcess,
    claim: ReviewCompletionProcessClaim,
    transition: ReviewCompletionTransition,
  ): Promise<AdvanceReviewCompletionProcessResult> {
    const result = await this.processes.applyTransition(claim, transition);
    if (result.status === ReviewCompletionProcessTransitionStatus.Missing) {
      return {
        status: AdvanceReviewCompletionProcessStatus.Missing,
        process: null,
      };
    }
    if (result.status === ReviewCompletionProcessTransitionStatus.StaleClaim) {
      return {
        status: AdvanceReviewCompletionProcessStatus.StaleClaim,
        process: await this.processes.findByExecutionId(claim.executionId),
      };
    }
    return {
      status: statusForProcess(result.process),
      process: result.process,
    };
  }
}

function statusForProcess(
  process: ReviewCompletionProcess,
): AdvanceReviewCompletionProcessStatus {
  if (
    !isReviewCompletionProcessTerminal(process.state) &&
    process.nextActionAt !== null &&
    process.nextActionAt.getTime() > process.updatedAt.getTime()
  ) {
    return AdvanceReviewCompletionProcessStatus.RetryDue;
  }
  switch (process.state) {
    case ReviewCompletionProcessState.Completed:
      return AdvanceReviewCompletionProcessStatus.Completed;
    case ReviewCompletionProcessState.CompletedSuperseded:
      return AdvanceReviewCompletionProcessStatus.CompletedSuperseded;
    case ReviewCompletionProcessState.PartialCompleted:
      return AdvanceReviewCompletionProcessStatus.PartialCompleted;
    case ReviewCompletionProcessState.BlockedPublicationUnknown:
      return AdvanceReviewCompletionProcessStatus.BlockedPublicationUnknown;
    case ReviewCompletionProcessState.PublicationNotApplied:
      return AdvanceReviewCompletionProcessStatus.PublicationNotApplied;
    case ReviewCompletionProcessState.PublicationStaleCompensated:
      return AdvanceReviewCompletionProcessStatus.PublicationStaleCompensated;
    case ReviewCompletionProcessState.PublicationStaleVisible:
      return AdvanceReviewCompletionProcessStatus.PublicationStaleVisible;
    case ReviewCompletionProcessState.PublicationInProgress:
      return AdvanceReviewCompletionProcessStatus.RetryDue;
    case ReviewCompletionProcessState.AwaitingPublication:
    case ReviewCompletionProcessState.AwaitingSnapshot:
      return AdvanceReviewCompletionProcessStatus.Advanced;
  }
}

function assertPublicationIdentity(
  process: ReviewCompletionProcess,
  publication: ReviewCompletionPublicationFacts,
): void {
  if (
    publication.executionId !== process.executionId ||
    publication.finalizedArtifactId !== process.finalizedArtifactId ||
    (process.publicationAttemptId !== null &&
      publication.publicationAttemptId !== process.publicationAttemptId)
  ) {
    throw new Error("review_completion_publication_identity_conflict");
  }
}

function assertSnapshotIdentity(
  process: ReviewCompletionProcess,
  receipt: ReviewCompletionSnapshotReceiptFacts,
): void {
  if (
    receipt.executionId !== process.executionId ||
    receipt.finalizedArtifactId !== process.finalizedArtifactId ||
    receipt.publicationAttemptId !== process.publicationAttemptId
  ) {
    throw new Error("review_completion_snapshot_identity_conflict");
  }
}
