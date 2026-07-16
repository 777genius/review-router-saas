import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isStalePullRequestHeadError,
  stalePullRequestHeadErrorCode,
  startPullRequestHeadSupervisor,
} from "../action/pull-request-head-supervisor";

describe("pull request head supervisor", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts only after a confirmed live head change", async () => {
    vi.useFakeTimers();
    const expectedHeadSha = "a".repeat(40);
    const readCurrentHeadSha = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce(expectedHeadSha)
      .mockResolvedValueOnce("b".repeat(40));

    const supervisor = await startPullRequestHeadSupervisor({
      expectedHeadSha,
      readCurrentHeadSha,
      pollIntervalMs: 1_000,
    });

    expect(supervisor.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(supervisor.signal.aborted).toBe(true);
    expect(isStalePullRequestHeadError(supervisor.signal.reason)).toBe(true);
    expect((supervisor.signal.reason as Error).message).toBe(
      stalePullRequestHeadErrorCode,
    );
    supervisor.stop();
  });

  it("fails open on a transient check failure and retries", async () => {
    vi.useFakeTimers();
    const expectedHeadSha = "a".repeat(40);
    const onPollFailure = vi.fn();
    const readCurrentHeadSha = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("github_unavailable"))
      .mockResolvedValueOnce(expectedHeadSha);

    const supervisor = await startPullRequestHeadSupervisor({
      expectedHeadSha,
      readCurrentHeadSha,
      pollIntervalMs: 1_000,
      onPollFailure,
    });

    expect(supervisor.signal.aborted).toBe(false);
    expect(onPollFailure).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(readCurrentHeadSha).toHaveBeenCalledTimes(2);
    expect(supervisor.signal.aborted).toBe(false);
    supervisor.stop();
  });

  it("does not schedule more checks after stop", async () => {
    vi.useFakeTimers();
    const readCurrentHeadSha = vi
      .fn<() => Promise<string>>()
      .mockResolvedValue("a".repeat(40));
    const supervisor = await startPullRequestHeadSupervisor({
      expectedHeadSha: "a".repeat(40),
      readCurrentHeadSha,
      pollIntervalMs: 1_000,
    });

    supervisor.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(readCurrentHeadSha).toHaveBeenCalledTimes(1);
  });

  it("aborts an in-flight poll when stopped", async () => {
    vi.useFakeTimers();
    let pollWasAborted = false;
    const readCurrentHeadSha = vi
      .fn<(signal: AbortSignal) => Promise<string>>()
      .mockResolvedValueOnce("a".repeat(40))
      .mockImplementationOnce(
        (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                pollWasAborted = true;
                reject(new Error("poll_aborted"));
              },
              { once: true },
            );
          }),
      );
    const supervisor = await startPullRequestHeadSupervisor({
      expectedHeadSha: "a".repeat(40),
      readCurrentHeadSha,
      pollIntervalMs: 1_000,
    });

    vi.advanceTimersByTime(1_000);
    await Promise.resolve();
    supervisor.stop();
    await vi.runAllTimersAsync();
    expect(pollWasAborted).toBe(true);
    expect(supervisor.signal.aborted).toBe(false);
  });
});
