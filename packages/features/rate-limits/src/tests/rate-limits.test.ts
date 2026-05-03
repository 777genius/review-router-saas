import { describe, expect, it } from "vitest";
import type { Clock } from "@reviewrouter/shared";
import { assertRateLimit } from "../application/use-cases/assert-rate-limit";
import type {
  ConsumeFixedWindowRateLimitInput,
  DeleteExpiredRateLimitBucketsInput,
  DeleteExpiredRateLimitBucketsResult,
  RateLimitStorePort,
} from "../application/ports/rate-limit-store-port";
import { pruneExpiredRateLimitBuckets } from "../application/use-cases/prune-expired-rate-limit-buckets";
import {
  createRateLimitDecision,
  RateLimitExceededError,
} from "../domain/rate-limit";

class InMemoryRateLimitStore implements RateLimitStorePort {
  public readonly buckets = new Map<
    string,
    { count: number; limit: number; windowEndsAt: Date }
  >();

  async consumeFixedWindow(
    input: ConsumeFixedWindowRateLimitInput,
  ): Promise<ReturnType<typeof createRateLimitDecision>> {
    const existing = this.buckets.get(input.key);
    const reset =
      !existing || existing.windowEndsAt <= input.now
        ? { count: 1, limit: input.limit, windowEndsAt: input.windowEndsAt }
        : {
            count: existing.count + 1,
            limit: input.limit,
            windowEndsAt: existing.windowEndsAt,
          };
    this.buckets.set(input.key, reset);
    return createRateLimitDecision({
      key: input.key,
      limit: reset.limit,
      count: reset.count,
      resetAt: reset.windowEndsAt,
    });
  }

  async deleteExpiredBuckets(
    input: DeleteExpiredRateLimitBucketsInput,
  ): Promise<DeleteExpiredRateLimitBucketsResult> {
    const expiredKeys = [...this.buckets.entries()]
      .filter(([, bucket]) => bucket.windowEndsAt <= input.expiredBefore)
      .sort(([, left], [, right]) => {
        return left.windowEndsAt.getTime() - right.windowEndsAt.getTime();
      })
      .slice(0, input.limit)
      .map(([key]) => key);

    for (const key of expiredKeys) {
      this.buckets.delete(key);
    }

    return { deleted: expiredKeys.length };
  }
}

describe("rate limits", () => {
  it("allows requests inside a fixed window and blocks after the limit", async () => {
    const store = new InMemoryRateLimitStore();
    const clock = staticClock("2026-05-03T12:00:30.000Z");

    await expect(
      assertRateLimit(
        { key: "action:exchange:repo_1:run_1", limit: 2, windowMs: 60_000 },
        { rateLimits: store, clock },
      ),
    ).resolves.toMatchObject({ allowed: true, remaining: 1 });
    await expect(
      assertRateLimit(
        { key: "action:exchange:repo_1:run_1", limit: 2, windowMs: 60_000 },
        { rateLimits: store, clock },
      ),
    ).resolves.toMatchObject({ allowed: true, remaining: 0 });

    await expect(
      assertRateLimit(
        { key: "action:exchange:repo_1:run_1", limit: 2, windowMs: 60_000 },
        { rateLimits: store, clock },
      ),
    ).rejects.toBeInstanceOf(RateLimitExceededError);
  });

  it("resets after the fixed window ends", async () => {
    const store = new InMemoryRateLimitStore();
    let now = new Date("2026-05-03T12:00:30.000Z");
    const clock: Clock = { now: () => now };
    const rule = {
      key: "action:health:repo_1",
      limit: 1,
      windowMs: 60_000,
    };

    await assertRateLimit(rule, { rateLimits: store, clock });
    await expect(
      assertRateLimit(rule, { rateLimits: store, clock }),
    ).rejects.toBeInstanceOf(RateLimitExceededError);

    now = new Date("2026-05-03T12:01:00.000Z");
    await expect(
      assertRateLimit(rule, { rateLimits: store, clock }),
    ).resolves.toMatchObject({ allowed: true, remaining: 0 });
  });

  it("rejects invalid rules before touching the store", async () => {
    const store = new InMemoryRateLimitStore();
    await expect(
      assertRateLimit(
        { key: "", limit: 1, windowMs: 60_000 },
        { rateLimits: store, clock: staticClock() },
      ),
    ).rejects.toThrow("rate_limit_key_required");
    expect(store.buckets.size).toBe(0);
  });

  it("prunes expired buckets in bounded batches", async () => {
    const store = new InMemoryRateLimitStore();
    store.buckets.set("oldest", {
      count: 1,
      limit: 10,
      windowEndsAt: new Date("2026-05-03T11:58:00.000Z"),
    });
    store.buckets.set("expired", {
      count: 1,
      limit: 10,
      windowEndsAt: new Date("2026-05-03T11:59:00.000Z"),
    });
    store.buckets.set("active", {
      count: 1,
      limit: 10,
      windowEndsAt: new Date("2026-05-03T12:01:00.000Z"),
    });

    await expect(
      pruneExpiredRateLimitBuckets(
        { expiredBefore: new Date("2026-05-03T12:00:00.000Z"), limit: 1 },
        { rateLimits: store },
      ),
    ).resolves.toEqual({ deleted: 1 });

    expect(store.buckets.has("oldest")).toBe(false);
    expect(store.buckets.has("expired")).toBe(true);
    expect(store.buckets.has("active")).toBe(true);
  });

  it("rejects invalid prune settings before touching the store", async () => {
    const store = new InMemoryRateLimitStore();
    store.buckets.set("active", {
      count: 1,
      limit: 1,
      windowEndsAt: new Date("2026-05-03T12:01:00.000Z"),
    });

    await expect(
      pruneExpiredRateLimitBuckets(
        { expiredBefore: new Date("invalid"), limit: 100 },
        { rateLimits: store },
      ),
    ).rejects.toThrow("rate_limit_prune_expired_before_invalid");

    await expect(
      pruneExpiredRateLimitBuckets(
        { expiredBefore: new Date("2026-05-03T12:00:00.000Z"), limit: 0 },
        { rateLimits: store },
      ),
    ).rejects.toThrow("rate_limit_prune_limit_invalid");

    expect(store.buckets.size).toBe(1);
  });
});

function staticClock(timestamp = "2026-05-03T12:00:00.000Z"): Clock {
  return { now: () => new Date(timestamp) };
}
