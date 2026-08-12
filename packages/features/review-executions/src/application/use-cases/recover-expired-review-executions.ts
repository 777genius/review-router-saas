import type {
  ClockPort,
  ReviewExecutionCommandPort,
  ReviewExecutionQueryPort,
} from "../ports/review-execution-ports";
import { ReviewExecutionLifecycleTransitionStatus } from "../ports/review-execution-ports";

export class RecoverExpiredReviewExecutions {
  constructor(
    private readonly queries: ReviewExecutionQueryPort,
    private readonly commands: ReviewExecutionCommandPort,
    private readonly clock: ClockPort,
  ) {}

  async execute(input: { readonly limit: number }) {
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 256
    ) {
      throw new Error("review_execution_recovery_limit_invalid");
    }
    const now = this.clock.now();
    const candidates = await this.queries.listExpiredRunning({
      now,
      limit: input.limit,
    });
    let recovered = 0;
    let conflicts = 0;
    let failures = 0;
    for (const candidate of candidates) {
      let result;
      try {
        result = await this.commands.failExpiredRunningExecution({
          scope: candidate.execution,
          executionId: candidate.execution.executionId,
          expectedStreamVersion: candidate.stream.version,
          now,
        });
      } catch {
        failures += 1;
        continue;
      }
      if (
        result.status === ReviewExecutionLifecycleTransitionStatus.Applied ||
        result.status === ReviewExecutionLifecycleTransitionStatus.Restored
      ) {
        recovered += 1;
      } else {
        conflicts += 1;
      }
    }
    return { scanned: candidates.length, recovered, conflicts, failures };
  }
}
