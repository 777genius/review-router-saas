export type PullRequestReviewAdmissionDecision =
  | { readonly status: "admitted" }
  | {
      readonly status: "skipped";
      readonly reason: "changed_line_count_unavailable";
      readonly maxChangedLines: number;
    }
  | {
      readonly status: "skipped";
      readonly reason: "max_changed_lines_exceeded";
      readonly changedLines: number;
      readonly maxChangedLines: number;
    };

export function decidePullRequestReviewAdmission(input: {
  readonly changedLines: number | null;
  readonly maxChangedLines: number;
}): PullRequestReviewAdmissionDecision {
  assertNonNegativeSafeInteger(input.maxChangedLines, "maxChangedLines");
  if (input.maxChangedLines === 0) {
    return { status: "admitted" };
  }
  if (input.changedLines === null) {
    return {
      status: "skipped",
      reason: "changed_line_count_unavailable",
      maxChangedLines: input.maxChangedLines,
    };
  }
  assertNonNegativeSafeInteger(input.changedLines, "changedLines");
  if (input.changedLines > input.maxChangedLines) {
    return {
      status: "skipped",
      reason: "max_changed_lines_exceeded",
      changedLines: input.changedLines,
      maxChangedLines: input.maxChangedLines,
    };
  }
  return { status: "admitted" };
}

function assertNonNegativeSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid_review_admission_policy:${field}`);
  }
}
