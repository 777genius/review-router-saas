import type {
  ReviewCompletionClockPort,
  ReviewCompletionIdPort,
  ReviewCompletionProcessRepositoryPort,
} from "../ports/review-completion-process-ports";
import type { AdvanceReviewCompletionProcessResult } from "./advance-review-completion-process";
import { AdvanceReviewCompletionProcess } from "./advance-review-completion-process";

export class ScanDueReviewCompletionProcesses {
  constructor(
    private readonly processes: ReviewCompletionProcessRepositoryPort,
    private readonly advance: AdvanceReviewCompletionProcess,
    private readonly clock: ReviewCompletionClockPort,
    private readonly ids: ReviewCompletionIdPort,
    private readonly claimDurationMs: number,
  ) {
    if (!Number.isSafeInteger(claimDurationMs) || claimDurationMs <= 0) {
      throw new Error("review_completion_invalid_claim_duration");
    }
  }

  async execute(input: {
    readonly ownerIdHash: string;
    readonly limit: number;
  }): Promise<readonly AdvanceReviewCompletionProcessResult[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
      throw new Error("review_completion_invalid_due_scan_limit");
    }
    const now = this.clock.now();
    const claims = await this.processes.claimDue({
      now,
      limit: input.limit,
      ownerIdHash: input.ownerIdHash,
      claimIdForExecution: (executionId) => this.ids.nextClaimId(executionId),
      claimUntil: new Date(now.getTime() + this.claimDurationMs),
    });
    return Promise.all(claims.map((claim) => this.advance.executeClaim(claim)));
  }
}
