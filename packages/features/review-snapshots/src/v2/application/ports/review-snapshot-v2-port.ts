import type {
  CommitReviewSnapshotV2Command,
  LegacySnapshotIdentity,
  ReviewSnapshotCommitReceipt,
  ReviewSnapshotCommitReceiptSource,
  ReviewSnapshotV2Record,
  ReviewSnapshotV2Scope,
} from "../../domain/review-snapshot-v2";

export enum CommitReviewSnapshotV2Status {
  Applied = "applied",
  Restored = "restored",
  VersionConflict = "version_conflict",
  RequestConflict = "request_conflict",
  InvariantConflict = "invariant_conflict",
}

export type CommitReviewSnapshotV2Result =
  | {
      readonly status:
        | CommitReviewSnapshotV2Status.Applied
        | CommitReviewSnapshotV2Status.Restored;
      readonly receipt: ReviewSnapshotCommitReceipt;
      readonly snapshot: ReviewSnapshotV2Record | null;
    }
  | {
      readonly status:
        | CommitReviewSnapshotV2Status.VersionConflict
        | CommitReviewSnapshotV2Status.RequestConflict
        | CommitReviewSnapshotV2Status.InvariantConflict;
      readonly currentVersion: number;
    };

export interface ReviewSnapshotV2CommandPort {
  commit(
    command: CommitReviewSnapshotV2Command,
  ): Promise<CommitReviewSnapshotV2Result>;
}

export interface ReviewSnapshotV2QueryPort {
  findCurrent(
    scope: ReviewSnapshotV2Scope,
  ): Promise<ReviewSnapshotV2Record | LegacySnapshotIdentity | null>;
}

export interface ReviewSnapshotCommitReceiptQueryPort {
  findBySource(
    source: ReviewSnapshotCommitReceiptSource,
  ): Promise<ReviewSnapshotCommitReceipt | null>;
}

export enum SnapshotSourceCoverageState {
  Completed = "completed",
  Partial = "partial",
}

export enum SnapshotEffectivePublicationOutcome {
  Succeeded = "succeeded",
  SupersededNoEffect = "superseded_no_effect",
  FailedNoEffect = "failed_no_effect",
  StaleCompensated = "stale_compensated",
  StaleVisible = "stale_visible",
  TerminalUnknown = "terminal_unknown",
}

export type ReviewSnapshotCommitEligibility = {
  readonly sourceExecutionId: string;
  readonly sourceArtifactHash: string;
  readonly sourceReviewRevisionHash: string;
  readonly sourceBaseSha: string;
  readonly sourceReviewedHeadSha: string;
  readonly sourceCompatibilityKey: string;
  readonly sourceRunId: string;
  readonly sourceRunAttempt: string;
  readonly coverageState: SnapshotSourceCoverageState;
  readonly effectivePublicationOutcome: SnapshotEffectivePublicationOutcome;
  readonly publicationReceiptSetHash: string;
};

export interface ReviewSnapshotCommitEligibilityPort {
  resolve(input: {
    readonly sourceExecutionId: string;
    readonly sourceArtifactHash: string;
  }): Promise<ReviewSnapshotCommitEligibility | null>;
}
