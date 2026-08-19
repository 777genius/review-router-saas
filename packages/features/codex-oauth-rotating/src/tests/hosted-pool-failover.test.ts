import { describe, expect, it } from "vitest";
import {
  hasHostedPoolRetryBudget,
  hostedPoolAccountFailureReason,
  runHostedPoolLeaseFailover,
} from "../action/github-action";

describe("hosted pool account failover", () => {
  it.each([
    ["quota_limited", "quota_exhausted"],
    ["relay_error: account_quota_exhausted", "quota_exhausted"],
    ["relay_error: capacity_unavailable", "quota_exhausted"],
    ["hosted_pool_account_failed", "failed"],
    ["relay_error: account_status_failed", "failed"],
  ] as const)("classifies %s as %s", (message, expected) => {
    expect(hostedPoolAccountFailureReason(new Error(message))).toBe(expected);
  });

  it.each([
    "needs_reconnect",
    "permission_required",
    "review_runtime_timeout",
    "hosted_relay_grant_failed:403",
    "The selected account unavailable message was informational",
  ])("does not rotate accounts for %s", (message) => {
    expect(hostedPoolAccountFailureReason(new Error(message))).toBeUndefined();
  });

  it("requires enough time for another lease exchange before retrying", () => {
    expect(
      hasHostedPoolRetryBudget({
        executionDeadlineEpochMs: 189_999,
        nowEpochMs: 100_000,
      }),
    ).toBe(false);
    expect(
      hasHostedPoolRetryBudget({
        executionDeadlineEpochMs: 190_000,
        nowEpochMs: 100_000,
      }),
    ).toBe(true);
  });

  it("releases failed leases and resumes on the next eligible lease", async () => {
    const attempts: number[] = [];
    const retries: Array<{ attempt: number; reason: string }> = [];

    await expect(
      runHostedPoolLeaseFailover({
        maxAttempts: 3,
        canRetry: () => true,
        runAttempt: async ({ attempt }) => {
          attempts.push(attempt);
          if (attempt === 1) throw new Error("quota_limited");
          if (attempt === 2) throw new Error("hosted_pool_account_failed");
          return "checkpoint-complete";
        },
        onRetry: ({ attempt, reason }) => {
          retries.push({ attempt, reason });
        },
      }),
    ).resolves.toBe("checkpoint-complete");

    expect(attempts).toEqual([1, 2, 3]);
    expect(retries).toEqual([
      { attempt: 1, reason: "quota_exhausted" },
      { attempt: 2, reason: "failed" },
    ]);
  });

  it("bounds exhausted-pool retries", async () => {
    const attempts: number[] = [];

    await expect(
      runHostedPoolLeaseFailover({
        maxAttempts: 3,
        canRetry: () => true,
        runAttempt: async ({ attempt }) => {
          attempts.push(attempt);
          throw new Error("account_quota_exhausted");
        },
      }),
    ).rejects.toThrow("hosted_pool_capacity_exhausted");

    expect(attempts).toEqual([1, 2, 3]);
  });

  it("does not acquire another lease after the execution budget closes", async () => {
    const attempts: number[] = [];

    await expect(
      runHostedPoolLeaseFailover({
        maxAttempts: 3,
        canRetry: () => false,
        runAttempt: async ({ attempt }) => {
          attempts.push(attempt);
          throw new Error("hosted_pool_account_failed");
        },
      }),
    ).rejects.toThrow("hosted_pool_capacity_exhausted");

    expect(attempts).toEqual([1]);
  });
});
