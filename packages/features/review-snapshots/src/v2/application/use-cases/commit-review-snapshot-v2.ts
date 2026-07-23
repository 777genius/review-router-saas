import { assertCommitReviewSnapshotV2Command } from "../../domain/review-snapshot-v2";
import type { CommitReviewSnapshotV2Command } from "../../domain/review-snapshot-v2";
import type {
  CommitReviewSnapshotV2Result,
  ReviewSnapshotV2CommandPort,
  ReviewSnapshotCommitEligibilityPort,
} from "../ports/review-snapshot-v2-port";
import {
  SnapshotEffectivePublicationOutcome,
  SnapshotSourceCoverageState,
} from "../ports/review-snapshot-v2-port";

export enum ReviewSnapshotCommitRejectionReason {
  SourceMissing = "source_missing",
  SourceMismatch = "source_mismatch",
  PartialCoverage = "partial_coverage",
  PublicationNotSuccessful = "publication_not_successful",
  ReceiptSetMismatch = "receipt_set_mismatch",
}

export class ReviewSnapshotCommitRejectedError extends Error {
  constructor(readonly reason: ReviewSnapshotCommitRejectionReason) {
    super(`review_snapshot_commit_rejected:${reason}`);
    this.name = "ReviewSnapshotCommitRejectedError";
  }
}

export async function commitReviewSnapshotV2(
  command: CommitReviewSnapshotV2Command,
  dependencies: {
    readonly commands: ReviewSnapshotV2CommandPort;
    readonly eligibility: ReviewSnapshotCommitEligibilityPort;
  },
): Promise<CommitReviewSnapshotV2Result> {
  assertCommitReviewSnapshotV2Command(command);
  const fact = await dependencies.eligibility.resolve({
    sourceExecutionId: command.candidate.sourceExecutionId,
    sourceArtifactHash: command.candidate.sourceArtifactHash,
  });
  if (!fact) {
    throw new ReviewSnapshotCommitRejectedError(
      ReviewSnapshotCommitRejectionReason.SourceMissing,
    );
  }
  if (
    fact.sourceExecutionId !== command.candidate.sourceExecutionId ||
    fact.sourceArtifactHash !== command.candidate.sourceArtifactHash ||
    fact.sourceReviewRevisionHash !==
      command.candidate.sourceReviewRevisionHash ||
    fact.sourceBaseSha !== command.candidate.sourceBaseSha ||
    fact.sourceReviewedHeadSha !== command.candidate.sourceReviewedHeadSha ||
    fact.sourceCompatibilityKey !== command.candidate.sourceCompatibilityKey ||
    fact.sourceRunId !== command.candidate.sourceRunId ||
    fact.sourceRunAttempt !== command.candidate.sourceRunAttempt
  ) {
    throw new ReviewSnapshotCommitRejectedError(
      ReviewSnapshotCommitRejectionReason.SourceMismatch,
    );
  }
  if (fact.coverageState !== SnapshotSourceCoverageState.Completed) {
    throw new ReviewSnapshotCommitRejectedError(
      ReviewSnapshotCommitRejectionReason.PartialCoverage,
    );
  }
  if (
    fact.effectivePublicationOutcome !==
    SnapshotEffectivePublicationOutcome.Succeeded
  ) {
    throw new ReviewSnapshotCommitRejectedError(
      ReviewSnapshotCommitRejectionReason.PublicationNotSuccessful,
    );
  }
  if (fact.publicationReceiptSetHash !== command.publicationReceiptSetHash) {
    throw new ReviewSnapshotCommitRejectedError(
      ReviewSnapshotCommitRejectionReason.ReceiptSetMismatch,
    );
  }
  return dependencies.commands.commit(command);
}
