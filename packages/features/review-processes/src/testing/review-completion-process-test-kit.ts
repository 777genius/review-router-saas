import type {
  ReviewCompletionClockPort,
  ReviewCompletionExecutionQueryPort,
  ReviewCompletionIdPort,
  ReviewCompletionPublicationFacts,
  ReviewCompletionPublicationPort,
  ReviewCompletionSnapshotPort,
  ReviewCompletionSnapshotReceiptFacts,
  ReviewExecutionCompletionFacts,
} from "../application/ports/review-completion-process-ports";
import {
  ReviewCompletionPublicationState,
  ReviewCompletionSnapshotOutcome,
} from "../application/ports/review-completion-process-ports";

export class MutableReviewCompletionClock implements ReviewCompletionClockPort {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current);
  }

  set(now: Date): void {
    this.current = new Date(now);
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

export class SequentialReviewCompletionIds implements ReviewCompletionIdPort {
  private ordinal = 0;

  nextClaimId(executionId: string): string {
    this.ordinal += 1;
    return `claim-${executionId}-${this.ordinal}`;
  }
}

export class InMemoryReviewCompletionExecutionQuery implements ReviewCompletionExecutionQueryPort {
  private readonly facts = new Map<string, ReviewExecutionCompletionFacts>();

  async findFinalized(input: {
    readonly executionId: string;
    readonly finalizedArtifactId: string;
  }): Promise<ReviewExecutionCompletionFacts | null> {
    const facts = this.facts.get(input.executionId);
    return facts?.finalizedArtifactId === input.finalizedArtifactId
      ? structuredClone(facts)
      : null;
  }

  seed(facts: ReviewExecutionCompletionFacts): void {
    this.facts.set(facts.executionId, structuredClone(facts));
  }
}

export class InMemoryReviewCompletionPublicationPort implements ReviewCompletionPublicationPort {
  private readonly facts = new Map<string, ReviewCompletionPublicationFacts>();
  private requestOrdinal = 0;
  requestCalls = 0;
  failAfterRequestOnce = false;

  async findByExecution(input: {
    readonly executionId: string;
    readonly finalizedArtifactId: string;
    readonly publicationAttemptId: string | null;
  }): Promise<ReviewCompletionPublicationFacts | null> {
    const facts = this.facts.get(input.executionId);
    if (
      !facts ||
      facts.finalizedArtifactId !== input.finalizedArtifactId ||
      (input.publicationAttemptId !== null &&
        input.publicationAttemptId !== facts.publicationAttemptId)
    ) {
      return null;
    }
    return structuredClone(facts);
  }

  async request(input: {
    readonly executionId: string;
    readonly finalizedArtifactId: string;
  }): Promise<ReviewCompletionPublicationFacts> {
    this.requestCalls += 1;
    let facts = this.facts.get(input.executionId);
    if (!facts) {
      this.requestOrdinal += 1;
      facts = {
        publicationAttemptId: `publication-${this.requestOrdinal}`,
        executionId: input.executionId,
        finalizedArtifactId: input.finalizedArtifactId,
        state: ReviewCompletionPublicationState.Pending,
        effectiveOutcome: null,
        nextCheckAt: null,
      };
      this.facts.set(input.executionId, structuredClone(facts));
    }
    if (this.failAfterRequestOnce) {
      this.failAfterRequestOnce = false;
      throw new Error("simulated_lost_publication_ack");
    }
    return structuredClone(facts);
  }

  seed(facts: ReviewCompletionPublicationFacts): void {
    this.facts.set(facts.executionId, structuredClone(facts));
  }
}

export class InMemoryReviewCompletionSnapshotPort implements ReviewCompletionSnapshotPort {
  private readonly receipts = new Map<
    string,
    ReviewCompletionSnapshotReceiptFacts
  >();
  private receiptOrdinal = 0;
  commitCalls = 0;
  failAfterCommitOnce = false;

  async findReceipt(input: {
    readonly executionId: string;
    readonly finalizedArtifactId: string;
  }): Promise<ReviewCompletionSnapshotReceiptFacts | null> {
    const receipt = this.receipts.get(input.executionId);
    return receipt?.finalizedArtifactId === input.finalizedArtifactId
      ? structuredClone(receipt)
      : null;
  }

  async commit(input: {
    readonly executionId: string;
    readonly finalizedArtifactId: string;
    readonly publicationAttemptId: string;
  }): Promise<ReviewCompletionSnapshotReceiptFacts> {
    this.commitCalls += 1;
    let receipt = this.receipts.get(input.executionId);
    if (!receipt) {
      this.receiptOrdinal += 1;
      receipt = {
        snapshotCommitReceiptId: `snapshot-receipt-${this.receiptOrdinal}`,
        executionId: input.executionId,
        finalizedArtifactId: input.finalizedArtifactId,
        publicationAttemptId: input.publicationAttemptId,
        outcome: ReviewCompletionSnapshotOutcome.Committed,
      };
      this.receipts.set(input.executionId, structuredClone(receipt));
    }
    if (this.failAfterCommitOnce) {
      this.failAfterCommitOnce = false;
      throw new Error("simulated_lost_snapshot_ack");
    }
    return structuredClone(receipt);
  }

  seed(receipt: ReviewCompletionSnapshotReceiptFacts): void {
    this.receipts.set(receipt.executionId, structuredClone(receipt));
  }
}
