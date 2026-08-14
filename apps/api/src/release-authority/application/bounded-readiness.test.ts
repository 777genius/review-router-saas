import { afterEach, describe, expect, it, vi } from "vitest";
import { createBoundedReadinessPolicy } from "./bounded-readiness";

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const unavailable = () =>
  Object.assign(new Error("readiness_unavailable"), { statusCode: 503 });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("bounded readiness policy", () => {
  it("coalesces concurrent callers into one successful observation", async () => {
    const observation = deferred();
    const observe = vi.fn(() => observation.promise);
    const policy = createBoundedReadinessPolicy(observe, unavailable, {
      deadlineMilliseconds: 100,
      successfulLeaseMilliseconds: 1_000,
    });

    const first = policy.assertReady();
    const second = policy.assertReady();

    expect(second).toBe(first);
    await Promise.resolve();
    expect(observe).toHaveBeenCalledTimes(1);
    observation.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined,
    ]);
  });

  it("times out a hung observation and allows a later request to succeed", async () => {
    vi.useFakeTimers();
    const hung = deferred();
    let firstSignal: AbortSignal | undefined;
    const observe = vi
      .fn<(signal: AbortSignal) => Promise<void>>()
      .mockImplementationOnce((signal) => {
        firstSignal = signal;
        return hung.promise;
      })
      .mockResolvedValueOnce();
    const policy = createBoundedReadinessPolicy(observe, unavailable, {
      deadlineMilliseconds: 25,
      successfulLeaseMilliseconds: 1_000,
    });

    const first = policy.assertReady();
    const firstResult = expect(first).rejects.toMatchObject({
      message: "readiness_unavailable",
      statusCode: 503,
    });
    await vi.advanceTimersByTimeAsync(25);
    await firstResult;
    expect(firstSignal?.aborted).toBe(true);

    await expect(policy.assertReady()).resolves.toBeUndefined();
    expect(observe).toHaveBeenCalledTimes(2);

    // A late success belongs to the expired execution and cannot replace the
    // successful lease established by the retry.
    hung.resolve();
    await Promise.resolve();
    await expect(policy.assertReady()).resolves.toBeUndefined();
    expect(observe).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed observation", async () => {
    const observe = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("database secret"))
      .mockResolvedValueOnce();
    const policy = createBoundedReadinessPolicy(observe, unavailable, {
      deadlineMilliseconds: 100,
      successfulLeaseMilliseconds: 1_000,
    });

    await expect(policy.assertReady()).rejects.toMatchObject({
      message: "readiness_unavailable",
      statusCode: 503,
    });
    await expect(policy.assertReady()).resolves.toBeUndefined();
    expect(observe).toHaveBeenCalledTimes(2);
  });

  it("uses monotonic elapsed time for the successful lease", async () => {
    let monotonicMilliseconds = 10;
    const observe = vi.fn().mockResolvedValue(undefined);
    const wallClock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const policy = createBoundedReadinessPolicy(observe, unavailable, {
      deadlineMilliseconds: 100,
      successfulLeaseMilliseconds: 100,
      monotonicNow: () => monotonicMilliseconds,
    });

    await policy.assertReady();
    wallClock.mockReturnValue(Number.MAX_SAFE_INTEGER);
    await policy.assertReady();
    wallClock.mockReturnValue(-Number.MAX_SAFE_INTEGER);
    await policy.assertReady();
    expect(observe).toHaveBeenCalledTimes(1);

    monotonicMilliseconds = 110;
    await policy.assertReady();
    expect(observe).toHaveBeenCalledTimes(2);
  });

  it("consumes a late rejection after timeout without an unhandled rejection", async () => {
    vi.useFakeTimers();
    const hung = deferred();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const policy = createBoundedReadinessPolicy(
        () => hung.promise,
        unavailable,
        {
          deadlineMilliseconds: 25,
          successfulLeaseMilliseconds: 1_000,
        },
      );

      const result = policy.assertReady();
      const timedOut = expect(result).rejects.toThrow("readiness_unavailable");
      await vi.advanceTimersByTimeAsync(25);
      await timedOut;
      unhandled.mockClear();
      hung.reject(new Error("late database secret"));
      await Promise.resolve();
      await Promise.resolve();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
