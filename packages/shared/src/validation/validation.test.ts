import { describe, expect, it } from "vitest";
import {
  isSafeConflictReviewDispatchId,
  isSafeGitHubBranchName,
  safeConflictReviewDispatchId,
  safeGitHubBranchName,
} from "./index";

describe("shared validation", () => {
  it("accepts common GitHub branch names", () => {
    expect(isSafeGitHubBranchName("main")).toBe(true);
    expect(isSafeGitHubBranchName("release/v1.2.3")).toBe(true);
    expect(isSafeGitHubBranchName("dependabot/npm/foo-1.2.3")).toBe(true);
  });

  it("rejects base refs that are unsafe for conflict review identity", () => {
    for (const ref of [
      "refs/heads/main",
      "feature/../main",
      "feature/@{main",
      "gh-readonly-queue/main/pr-1",
      "feature\nmain",
      "/main",
      "main/",
      "feature//main",
      ".hidden/main",
      "feature/main.lock",
      "feature:main",
    ]) {
      expect(isSafeGitHubBranchName(ref), ref).toBe(false);
      expect(safeGitHubBranchName.safeParse(ref).success, ref).toBe(false);
    }
  });

  it("accepts only generated conflict review dispatch ids", () => {
    const dispatchId = "cr_123e4567-e89b-12d3-a456-426614174000";

    expect(isSafeConflictReviewDispatchId(dispatchId)).toBe(true);
    expect(safeConflictReviewDispatchId.parse(dispatchId)).toBe(dispatchId);

    for (const unsafe of [
      "123e4567-e89b-12d3-a456-426614174000",
      "cr_123",
      "cr_123e4567-e89b-12d3-a456-426614174000\nx",
      "cr_123e4567e89b12d3a456426614174000",
    ]) {
      expect(isSafeConflictReviewDispatchId(unsafe), unsafe).toBe(false);
      expect(
        safeConflictReviewDispatchId.safeParse(unsafe).success,
        unsafe,
      ).toBe(false);
    }
  });
});
