import type {
  CreateReviewCompletionProcessInput,
  ReviewCompletionProcess,
  ReviewCompletionProcessClaim,
  ReviewCompletionTransition,
} from "../../domain/review-completion-process";

export enum ReviewCompletionProcessCreateStatus {
  Created = "created",
  Restored = "restored",
  Woken = "woken",
  ArtifactConflict = "artifact_conflict",
}

export type ReviewCompletionProcessCreateResult =
  | {
      readonly status:
        | ReviewCompletionProcessCreateStatus.Created
        | ReviewCompletionProcessCreateStatus.Restored
        | ReviewCompletionProcessCreateStatus.Woken;
      readonly process: ReviewCompletionProcess;
    }
  | {
      readonly status: ReviewCompletionProcessCreateStatus.ArtifactConflict;
      readonly process: ReviewCompletionProcess;
    };

export enum ReviewCompletionProcessTransitionStatus {
  Applied = "applied",
  StaleClaim = "stale_claim",
  Missing = "missing",
}

export type ReviewCompletionProcessTransitionResult =
  | {
      readonly status: ReviewCompletionProcessTransitionStatus.Applied;
      readonly process: ReviewCompletionProcess;
    }
  | {
      readonly status: ReviewCompletionProcessTransitionStatus.StaleClaim;
    }
  | {
      readonly status: ReviewCompletionProcessTransitionStatus.Missing;
    };

export type ReviewCompletionProcessCursor = {
  readonly nextActionAt: Date;
  readonly executionId: string;
};

export interface ReviewCompletionProcessRepositoryPort {
  createOrWake(
    input: CreateReviewCompletionProcessInput,
  ): Promise<ReviewCompletionProcessCreateResult>;
  findByExecutionId(
    executionId: string,
  ): Promise<ReviewCompletionProcess | null>;
  claimByExecutionId(input: {
    readonly executionId: string;
    readonly claimId: string;
    readonly ownerIdHash: string;
    readonly now: Date;
    readonly claimUntil: Date;
  }): Promise<ReviewCompletionProcessClaim | null>;
  claimDue(input: {
    readonly now: Date;
    readonly limit: number;
    readonly ownerIdHash: string;
    readonly claimIdForExecution: (executionId: string) => string;
    readonly claimUntil: Date;
  }): Promise<readonly ReviewCompletionProcessClaim[]>;
  applyTransition(
    claim: ReviewCompletionProcessClaim,
    transition: ReviewCompletionTransition,
  ): Promise<ReviewCompletionProcessTransitionResult>;
}

export enum ReviewExecutionCompletionCoverage {
  Completed = "completed",
  Partial = "partial",
}

export type ReviewExecutionCompletionFacts = {
  readonly executionId: string;
  readonly finalizedArtifactId: string;
  readonly coverage: ReviewExecutionCompletionCoverage;
};

export interface ReviewCompletionExecutionQueryPort {
  findFinalized(input: {
    readonly executionId: string;
    readonly finalizedArtifactId: string;
  }): Promise<ReviewExecutionCompletionFacts | null>;
}

export enum ReviewCompletionPublicationState {
  Pending = "pending",
  InProgress = "in_progress",
  Terminal = "terminal",
}

export enum ReviewCompletionPublicationOutcome {
  Succeeded = "succeeded",
  SupersededNoEffect = "superseded_no_effect",
  FailedNoEffect = "failed_no_effect",
  StaleCompensated = "stale_compensated",
  StaleVisible = "stale_visible",
  TerminalUnknown = "terminal_unknown",
}

export type ReviewCompletionPublicationFacts = {
  readonly publicationAttemptId: string;
  readonly executionId: string;
  readonly finalizedArtifactId: string;
  readonly state: ReviewCompletionPublicationState;
  readonly effectiveOutcome: ReviewCompletionPublicationOutcome | null;
  readonly nextCheckAt: Date | null;
};

export interface ReviewCompletionPublicationPort {
  findByExecution(input: {
    readonly executionId: string;
    readonly finalizedArtifactId: string;
    readonly publicationAttemptId: string | null;
  }): Promise<ReviewCompletionPublicationFacts | null>;
  request(input: {
    readonly executionId: string;
    readonly finalizedArtifactId: string;
  }): Promise<ReviewCompletionPublicationFacts>;
}

export enum ReviewCompletionSnapshotOutcome {
  Committed = "committed",
  AlreadyCurrent = "already_current",
  SupersededByHigherGeneration = "superseded_by_higher_generation",
}

export type ReviewCompletionSnapshotReceiptFacts = {
  readonly snapshotCommitReceiptId: string;
  readonly executionId: string;
  readonly finalizedArtifactId: string;
  readonly publicationAttemptId: string;
  readonly outcome: ReviewCompletionSnapshotOutcome;
};

export interface ReviewCompletionSnapshotPort {
  findReceipt(input: {
    readonly executionId: string;
    readonly finalizedArtifactId: string;
  }): Promise<ReviewCompletionSnapshotReceiptFacts | null>;
  commit(input: {
    readonly executionId: string;
    readonly finalizedArtifactId: string;
    readonly publicationAttemptId: string;
  }): Promise<ReviewCompletionSnapshotReceiptFacts>;
}

export type ReviewCompletionRecoveryCursor = {
  readonly createdAt: Date;
  readonly executionId: string;
};

export type ReviewCompletionRecoveryCandidate = {
  readonly executionId: string;
  readonly finalizedArtifactId: string;
  readonly createdAt: Date;
  readonly retainUntil: Date;
};

export type ReviewCompletionRecoveryPage = {
  readonly candidates: readonly ReviewCompletionRecoveryCandidate[];
  readonly nextCursor: ReviewCompletionRecoveryCursor | null;
};

export interface ReviewCompletionRecoveryFeedPort {
  scanMissingAfter(input: {
    readonly after: ReviewCompletionRecoveryCursor | null;
    readonly limit: number;
  }): Promise<ReviewCompletionRecoveryPage>;
}

export interface ReviewCompletionClockPort {
  now(): Date;
}

export interface ReviewCompletionIdPort {
  nextClaimId(executionId: string): string;
}
