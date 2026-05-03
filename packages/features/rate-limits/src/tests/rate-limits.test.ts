import { describe, expect, it } from "vitest";
import type { Clock } from "@reviewrouter/shared";
import { assertRateLimit } from "../application/use-cases/assert-rate-limit";
import type {
  ConsumeFixedWindowRateLimitInput,
  RateLimitStorePort,
} from "../application/ports/rate-limit-store-port";
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
});

function staticClock(timestamp = "2026-05-03T12:00:00.000Z"): Clock {
  return { now: () => new Date(timestamp) };
}
