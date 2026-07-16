export const defaultReviewJobTimeoutMinutes = 60;
export const minimumReviewJobTimeoutMinutes = 10;
export const maximumReviewJobTimeoutMinutes = 360;
export const reviewCleanupReserveMinutes = 5;

export type ReviewExecutionBudget = {
  readonly jobTimeoutMinutes: number;
  readonly runtimeTimeoutMinutes: number;
};

export function createReviewExecutionBudget(
  jobTimeoutMinutes: number,
): ReviewExecutionBudget {
  if (
    !Number.isSafeInteger(jobTimeoutMinutes) ||
    jobTimeoutMinutes < minimumReviewJobTimeoutMinutes ||
    jobTimeoutMinutes > maximumReviewJobTimeoutMinutes
  ) {
    throw new Error("invalid_review_execution_budget:jobTimeoutMinutes");
  }
  return {
    jobTimeoutMinutes,
    runtimeTimeoutMinutes: jobTimeoutMinutes - reviewCleanupReserveMinutes,
  };
}

export function createReviewExecutionDeadlineEpochMs(input: {
  readonly jobTimeoutMinutes: number;
  readonly executionStartedAtEpochMs: number;
}): number {
  if (
    !Number.isSafeInteger(input.executionStartedAtEpochMs) ||
    input.executionStartedAtEpochMs < 0
  ) {
    throw new Error(
      "invalid_review_execution_budget:executionStartedAtEpochMs",
    );
  }
  const runtimeTimeoutMs =
    createReviewExecutionBudget(input.jobTimeoutMinutes).runtimeTimeoutMinutes *
    60 *
    1000;
  return input.executionStartedAtEpochMs + runtimeTimeoutMs;
}

export function remainingReviewExecutionBudgetMs(input: {
  readonly executionDeadlineEpochMs: number;
  readonly nowEpochMs: number;
}): number {
  if (
    !Number.isSafeInteger(input.executionDeadlineEpochMs) ||
    !Number.isSafeInteger(input.nowEpochMs)
  ) {
    throw new Error("invalid_review_execution_budget:epochMs");
  }
  return Math.max(0, input.executionDeadlineEpochMs - input.nowEpochMs);
}
