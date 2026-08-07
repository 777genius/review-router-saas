import { describe, expect, it } from "vitest";
import {
  createReviewExecutionDeadlineEpochMs,
  createReviewExecutionBudget,
  defaultReviewJobTimeoutMinutes,
  defaultReviewT0LifecycleTimeoutMinutes,
  remainingReviewExecutionBudgetMs,
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

  it("keeps the T0 lifecycle budget independent from the legacy default", () => {
    expect(defaultReviewJobTimeoutMinutes).toBe(60);
    expect(defaultReviewT0LifecycleTimeoutMinutes).toBe(240);
    expect(
      createReviewExecutionBudget(defaultReviewT0LifecycleTimeoutMinutes),
    ).toEqual({
      jobTimeoutMinutes: 240,
      runtimeTimeoutMinutes: 235,
    });
  });

  it("supports an extended repository budget", () => {
    expect(createReviewExecutionBudget(180)).toEqual({
      jobTimeoutMinutes: 180,
      runtimeTimeoutMinutes: 175,
    });
  });

  it("measures the cleanup reserve from wrapper execution start", () => {
    const executionStartedAtEpochMs = 1_750_000_000_000;
    const executionDeadlineEpochMs = createReviewExecutionDeadlineEpochMs({
      jobTimeoutMinutes: 60,
      executionStartedAtEpochMs,
    });

    expect(executionDeadlineEpochMs).toBe(
      executionStartedAtEpochMs + 55 * 60 * 1000,
    );
    expect(
      remainingReviewExecutionBudgetMs({
        executionDeadlineEpochMs,
        nowEpochMs: executionStartedAtEpochMs + 7 * 60 * 1000,
      }),
    ).toBe(48 * 60 * 1000);
    expect(
      remainingReviewExecutionBudgetMs({
        executionDeadlineEpochMs,
        nowEpochMs: executionDeadlineEpochMs + 1,
      }),
    ).toBe(0);
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
