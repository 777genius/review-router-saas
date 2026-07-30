import type {
  ConsumeFixedWindowRateLimitInput,
  RateLimitStorePort,
} from "@reviewrouter/features-rate-limits";
import { createRateLimitDecision } from "@reviewrouter/features-rate-limits";
import { ReviewConfigurationOperatorOperation } from "@reviewrouter/features-review-config";
import type { Clock } from "@reviewrouter/shared";
import { describe, expect, it } from "vitest";
import { ReviewConfigurationOperatorRateLimit } from "./review-configuration-operator-rate-limit.js";

class RecordingRateLimitStore implements RateLimitStorePort {
  readonly calls: ConsumeFixedWindowRateLimitInput[] = [];

  constructor(private readonly blockFirst = false) {}

  async consumeFixedWindow(input: ConsumeFixedWindowRateLimitInput) {
    this.calls.push(input);
    return createRateLimitDecision({
      key: input.key,
      limit: input.limit,
      count: this.blockFirst && this.calls.length === 1 ? input.limit + 1 : 1,
      resetAt: input.windowEndsAt,
    });
  }
}

const clock: Clock = {
  now: () => new Date("2026-07-30T20:00:00.000Z"),
};

describe("ReviewConfigurationOperatorRateLimit", () => {
  it("consumes global operator and repository-specific buckets", async () => {
    const store = new RecordingRateLimitStore();
    const rateLimit = new ReviewConfigurationOperatorRateLimit(store, clock);

    await expect(
      rateLimit.consume({
        operatorId: "operator:test",
        operation: ReviewConfigurationOperatorOperation.SetReasoningEffort,
        repositoryFullName: "777genius/example",
      }),
    ).resolves.toBe(true);

    expect(store.calls).toHaveLength(2);
    expect(store.calls[0]?.key).toContain(
      "operator:review_config:set_review_reasoning_effort:",
    );
    expect(store.calls[0]?.key.endsWith(":global")).toBe(true);
    expect(store.calls[1]?.key.endsWith(":global")).toBe(false);
  });

  it("does not consume a repository bucket after the global bucket blocks", async () => {
    const store = new RecordingRateLimitStore(true);
    const rateLimit = new ReviewConfigurationOperatorRateLimit(store, clock);

    await expect(
      rateLimit.consume({
        operatorId: "operator:test",
        operation: ReviewConfigurationOperatorOperation.Read,
        repositoryFullName: "777genius/example",
      }),
    ).resolves.toBe(false);
    expect(store.calls).toHaveLength(1);
  });
});
