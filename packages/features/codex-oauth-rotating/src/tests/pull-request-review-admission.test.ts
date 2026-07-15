import { describe, expect, it } from "vitest";
import { decidePullRequestReviewAdmission } from "../domain/pull-request-review-admission";

describe("pull request review admission", () => {
  it("admits any known or unknown size when the limit is disabled", () => {
    expect(
      decidePullRequestReviewAdmission({
        changedLines: null,
        maxChangedLines: 0,
      }),
    ).toEqual({ status: "admitted" });
  });

  it("admits a pull request at the configured line boundary", () => {
    expect(
      decidePullRequestReviewAdmission({
        changedLines: 10_000,
        maxChangedLines: 10_000,
      }),
    ).toEqual({ status: "admitted" });
  });

  it("skips a pull request above the configured line boundary", () => {
    expect(
      decidePullRequestReviewAdmission({
        changedLines: 10_001,
        maxChangedLines: 10_000,
      }),
    ).toEqual({
      status: "skipped",
      reason: "max_changed_lines_exceeded",
      changedLines: 10_001,
      maxChangedLines: 10_000,
    });
  });

  it("fails closed when GitHub omits line counts under an active limit", () => {
    expect(
      decidePullRequestReviewAdmission({
        changedLines: null,
        maxChangedLines: 10_000,
      }),
    ).toEqual({
      status: "skipped",
      reason: "changed_line_count_unavailable",
      maxChangedLines: 10_000,
    });
  });
});
