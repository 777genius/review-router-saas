import type {
  ReviewCompletionProcessRepositoryPort,
  ReviewCompletionRecoveryCandidate,
  ReviewCompletionRecoveryCursor,
  ReviewCompletionRecoveryFeedPort,
  ReviewCompletionRecoveryPage,
} from "../../application/ports/review-completion-process-ports";

export class InMemoryReviewCompletionRecoveryFeed implements ReviewCompletionRecoveryFeedPort {
  private readonly candidates = new Map<
    string,
    ReviewCompletionRecoveryCandidate
  >();

  constructor(
    private readonly processes: ReviewCompletionProcessRepositoryPort,
  ) {}

  async scanMissingAfter(input: {
    readonly after: ReviewCompletionRecoveryCursor | null;
    readonly limit: number;
  }): Promise<ReviewCompletionRecoveryPage> {
    if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
      throw new Error("review_completion_invalid_recovery_limit");
    }
    const sorted = [...this.candidates.values()].sort(compareCandidates);
    const page: ReviewCompletionRecoveryCandidate[] = [];
    for (const candidate of sorted) {
      if (
        input.after &&
        compareCandidateToCursor(candidate, input.after) <= 0
      ) {
        continue;
      }
      if (await this.processes.findByExecutionId(candidate.executionId))
        continue;
      page.push(copyCandidate(candidate));
      if (page.length === input.limit) break;
    }
    const last = page.at(-1);
    return {
      candidates: page,
      nextCursor:
        page.length === input.limit && last
          ? {
              createdAt: new Date(last.createdAt),
              executionId: last.executionId,
            }
          : null,
    };
  }

  seed(candidate: ReviewCompletionRecoveryCandidate): void {
    this.candidates.set(candidate.executionId, copyCandidate(candidate));
  }
}

function compareCandidates(
  left: ReviewCompletionRecoveryCandidate,
  right: ReviewCompletionRecoveryCandidate,
): number {
  return (
    left.createdAt.getTime() - right.createdAt.getTime() ||
    left.executionId.localeCompare(right.executionId)
  );
}

function compareCandidateToCursor(
  candidate: ReviewCompletionRecoveryCandidate,
  cursor: ReviewCompletionRecoveryCursor,
): number {
  return (
    candidate.createdAt.getTime() - cursor.createdAt.getTime() ||
    candidate.executionId.localeCompare(cursor.executionId)
  );
}

function copyCandidate(
  candidate: ReviewCompletionRecoveryCandidate,
): ReviewCompletionRecoveryCandidate {
  return {
    ...candidate,
    createdAt: new Date(candidate.createdAt),
    retainUntil: new Date(candidate.retainUntil),
  };
}
