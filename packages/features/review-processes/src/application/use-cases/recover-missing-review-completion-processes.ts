import { ReviewCompletionWakeupKind } from "../../domain/review-completion-process";
import type {
  ReviewCompletionProcessRepositoryPort,
  ReviewCompletionRecoveryCursor,
  ReviewCompletionRecoveryFeedPort,
} from "../ports/review-completion-process-ports";

export type RecoverMissingReviewCompletionProcessesResult = {
  readonly visited: number;
  readonly createdOrRestored: number;
  readonly completedPass: boolean;
  readonly nextCursor: ReviewCompletionRecoveryCursor | null;
};

export class RecoverMissingReviewCompletionProcesses {
  private cursor: ReviewCompletionRecoveryCursor | null = null;

  constructor(
    private readonly feed: ReviewCompletionRecoveryFeedPort,
    private readonly processes: ReviewCompletionProcessRepositoryPort,
    private readonly pageSize: number,
  ) {
    if (!Number.isSafeInteger(pageSize) || pageSize <= 0) {
      throw new Error("review_completion_invalid_recovery_page_size");
    }
  }

  async scanNextPage(): Promise<RecoverMissingReviewCompletionProcessesResult> {
    const page = await this.feed.scanMissingAfter({
      after: this.cursor,
      limit: this.pageSize,
    });
    for (const candidate of page.candidates) {
      await this.processes.createOrWake({
        executionId: candidate.executionId,
        finalizedArtifactId: candidate.finalizedArtifactId,
        wakeupKind: ReviewCompletionWakeupKind.RecoveryScan,
        wakeupAt: candidate.createdAt,
        retainUntil: candidate.retainUntil,
      });
    }

    const completedPass = page.nextCursor === null;
    this.cursor = completedPass ? null : copyCursor(page.nextCursor);
    return {
      visited: page.candidates.length,
      createdOrRestored: page.candidates.length,
      completedPass,
      nextCursor: this.cursor ? copyCursor(this.cursor) : null,
    };
  }

  restartPass(): void {
    this.cursor = null;
  }

  currentCursor(): ReviewCompletionRecoveryCursor | null {
    return this.cursor ? copyCursor(this.cursor) : null;
  }
}

function copyCursor(
  cursor: ReviewCompletionRecoveryCursor,
): ReviewCompletionRecoveryCursor {
  return {
    createdAt: new Date(cursor.createdAt),
    executionId: cursor.executionId,
  };
}
