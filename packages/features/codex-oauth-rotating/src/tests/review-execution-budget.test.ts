import { describe, expect, it } from "vitest";
import {
  createReviewExecutionBudget,
  defaultReviewJobTimeoutMinutes,
} from "../domain/review-execution-budget";

describe("review execution budget", () => {
  it("reserves cleanup time from the default job budget", () => {
    expect(createReviewExecutionBudget(defaultReviewJobTimeoutMinutes)).toEqual(
      {
        jobTimeoutMinutes: 60,
        runtimeTimeoutMinutes: 55,
      },
    );
  });

  it("supports an extended repository budget", () => {
    expect(createReviewExecutionBudget(180)).toEqual({
      jobTimeoutMinutes: 180,
      runtimeTimeoutMinutes: 175,
    });
  });

  it("rejects budgets outside GitHub's supported policy range", () => {
    expect(() => createReviewExecutionBudget(9)).toThrow(
      "invalid_review_execution_budget:jobTimeoutMinutes",
    );
    expect(() => createReviewExecutionBudget(361)).toThrow(
      "invalid_review_execution_budget:jobTimeoutMinutes",
    );
  });
});
