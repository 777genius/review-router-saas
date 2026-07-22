import {
  applyReviewCompletionTransition,
  createReviewCompletionProcess,
  isReviewCompletionProcessTerminal,
  isSameReviewCompletionClaim,
  wakeReviewCompletionProcess,
  type CreateReviewCompletionProcessInput,
  type ReviewCompletionProcess,
  type ReviewCompletionProcessClaim,
  type ReviewCompletionTransition,
} from "../../domain/review-completion-process";
import {
  ReviewCompletionProcessCreateStatus,
  ReviewCompletionProcessTransitionStatus,
  type ReviewCompletionProcessCreateResult,
  type ReviewCompletionProcessRepositoryPort,
  type ReviewCompletionProcessTransitionResult,
} from "../../application/ports/review-completion-process-ports";

export class InMemoryReviewCompletionProcessRepository implements ReviewCompletionProcessRepositoryPort {
  private readonly records = new Map<string, ReviewCompletionProcess>();
  private nextClaimFencingToken = 0n;

  async createOrWake(
    input: CreateReviewCompletionProcessInput,
  ): Promise<ReviewCompletionProcessCreateResult> {
    const existing = this.records.get(input.executionId);
    if (!existing) {
      const created = createReviewCompletionProcess(input);
      this.records.set(input.executionId, copyProcess(created));
      return {
        status: ReviewCompletionProcessCreateStatus.Created,
        process: copyProcess(created),
      };
    }
    if (existing.finalizedArtifactId !== input.finalizedArtifactId) {
      return {
        status: ReviewCompletionProcessCreateStatus.ArtifactConflict,
        process: copyProcess(existing),
      };
    }

    const woken = wakeReviewCompletionProcess(existing, input);
    if (woken === existing) {
      return {
        status: ReviewCompletionProcessCreateStatus.Restored,
        process: copyProcess(existing),
      };
    }
    this.records.set(input.executionId, copyProcess(woken));
    return {
      status: ReviewCompletionProcessCreateStatus.Woken,
      process: copyProcess(woken),
    };
  }

  async findByExecutionId(
    executionId: string,
  ): Promise<ReviewCompletionProcess | null> {
    const process = this.records.get(executionId);
    return process ? copyProcess(process) : null;
  }

  async claimByExecutionId(input: {
    readonly executionId: string;
    readonly claimId: string;
    readonly ownerIdHash: string;
    readonly now: Date;
    readonly claimUntil: Date;
  }): Promise<ReviewCompletionProcessClaim | null> {
    if (input.claimUntil.getTime() <= input.now.getTime()) {
      throw new Error("review_completion_invalid_claim_deadline");
    }
    const process = this.records.get(input.executionId);
    if (!process || !isClaimable(process, input.now, false)) return null;
    return this.claim(process, input);
  }

  async claimDue(input: {
    readonly now: Date;
    readonly limit: number;
    readonly ownerIdHash: string;
    readonly claimIdForExecution: (executionId: string) => string;
    readonly claimUntil: Date;
  }): Promise<readonly ReviewCompletionProcessClaim[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
      throw new Error("review_completion_invalid_claim_limit");
    }
    if (input.claimUntil.getTime() <= input.now.getTime()) {
      throw new Error("review_completion_invalid_claim_deadline");
    }
    const due = [...this.records.values()]
      .filter((process) => isClaimable(process, input.now, true))
      .sort(compareDueProcesses)
      .slice(0, input.limit);
    return due.map((process) =>
      this.claim(process, {
        claimId: input.claimIdForExecution(process.executionId),
        ownerIdHash: input.ownerIdHash,
        claimUntil: input.claimUntil,
      }),
    );
  }

  async applyTransition(
    claim: ReviewCompletionProcessClaim,
    transition: ReviewCompletionTransition,
  ): Promise<ReviewCompletionProcessTransitionResult> {
    const process = this.records.get(claim.executionId);
    if (!process) {
      return { status: ReviewCompletionProcessTransitionStatus.Missing };
    }
    if (!isSameReviewCompletionClaim(process, claim)) {
      return { status: ReviewCompletionProcessTransitionStatus.StaleClaim };
    }
    if (claim.claimUntil.getTime() <= transition.now.getTime()) {
      return { status: ReviewCompletionProcessTransitionStatus.StaleClaim };
    }
    const next = applyReviewCompletionTransition(process, transition);
    this.records.set(next.executionId, copyProcess(next));
    return {
      status: ReviewCompletionProcessTransitionStatus.Applied,
      process: copyProcess(next),
    };
  }

  has(executionId: string): boolean {
    return this.records.has(executionId);
  }

  all(): readonly ReviewCompletionProcess[] {
    return [...this.records.values()].map(copyProcess);
  }

  private claim(
    process: ReviewCompletionProcess,
    input: {
      readonly claimId: string;
      readonly ownerIdHash: string;
      readonly claimUntil: Date;
    },
  ): ReviewCompletionProcessClaim {
    if (
      input.claimId.trim().length === 0 ||
      input.ownerIdHash.trim().length === 0
    ) {
      throw new Error("review_completion_invalid_claim_identity");
    }
    this.nextClaimFencingToken += 1n;
    const claimed: ReviewCompletionProcess = {
      ...process,
      processVersion: process.processVersion + 1n,
      activeClaimId: input.claimId,
      claimOwnerHash: input.ownerIdHash,
      claimFencingToken: this.nextClaimFencingToken,
      claimUntil: new Date(input.claimUntil),
      nextActionAt: new Date(input.claimUntil),
      updatedAt: new Date(process.updatedAt),
    };
    this.records.set(process.executionId, copyProcess(claimed));
    return {
      claimId: input.claimId,
      executionId: process.executionId,
      ownerIdHash: input.ownerIdHash,
      fencingToken: claimed.claimFencingToken!,
      processVersion: claimed.processVersion,
      claimUntil: new Date(input.claimUntil),
    };
  }
}

function isClaimable(
  process: ReviewCompletionProcess,
  now: Date,
  requireDue: boolean,
): boolean {
  if (
    isReviewCompletionProcessTerminal(process.state) ||
    process.retainUntil.getTime() <= now.getTime()
  ) {
    return false;
  }
  const activeClaim =
    process.activeClaimId !== null &&
    process.claimUntil !== null &&
    process.claimUntil.getTime() > now.getTime();
  if (activeClaim) return false;
  return (
    !requireDue ||
    (process.nextActionAt !== null &&
      process.nextActionAt.getTime() <= now.getTime())
  );
}

function compareDueProcesses(
  left: ReviewCompletionProcess,
  right: ReviewCompletionProcess,
): number {
  const byDue =
    (left.nextActionAt?.getTime() ?? Number.MAX_SAFE_INTEGER) -
    (right.nextActionAt?.getTime() ?? Number.MAX_SAFE_INTEGER);
  return byDue || left.executionId.localeCompare(right.executionId);
}

function copyProcess(
  process: ReviewCompletionProcess,
): ReviewCompletionProcess {
  return structuredClone(process);
}
