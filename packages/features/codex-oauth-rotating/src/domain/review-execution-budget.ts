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
