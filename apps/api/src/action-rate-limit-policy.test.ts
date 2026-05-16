import { describe, expect, it } from "vitest";
import type {
  ConsumeFixedWindowRateLimitInput,
  RateLimitStorePort,
} from "@reviewrouter/features-rate-limits";
import {
  createRateLimitDecision,
  RateLimitExceededError,
} from "@reviewrouter/features-rate-limits";
import type { Clock } from "@reviewrouter/shared";
import { ActionRateLimitPolicy } from "./action-rate-limit-policy";

class RecordingRateLimitStore implements RateLimitStorePort {
  public readonly calls: ConsumeFixedWindowRateLimitInput[] = [];

  async consumeFixedWindow(input: ConsumeFixedWindowRateLimitInput) {
    this.calls.push(input);
    return createRateLimitDecision({
      key: input.key,
      limit: input.limit,
      count: 1,
      resetAt: input.windowEndsAt,
    });
  }
}

class BlockingRateLimitStore implements RateLimitStorePort {
  public readonly calls: ConsumeFixedWindowRateLimitInput[] = [];

  async consumeFixedWindow(input: ConsumeFixedWindowRateLimitInput) {
    this.calls.push(input);
    return createRateLimitDecision({
      key: input.key,
      limit: input.limit,
      count: input.limit + 1,
      resetAt: input.windowEndsAt,
    });
  }
}

const clock: Clock = {
  now: () => new Date("2026-05-12T12:00:30.000Z"),
};

describe("ActionRateLimitPolicy", () => {
  it("uses only the per-run OIDC bucket for non-interaction events", async () => {
    const store = new RecordingRateLimitStore();
    const policy = new ActionRateLimitPolicy(store, clock);

    await policy.assertOidcExchangeAllowed({
      repositoryId: "repo_1",
      eventName: "pull_request",
      githubActorLogin: "alice",
      githubRunId: "run_1",
      githubRunAttempt: "1",
    });

    expect(store.calls.map((call) => call.key)).toEqual([
      "action:oidc_exchange:repo_1:run_1:1",
    ]);
  });

  it("adds per-actor and per-repository buckets for interaction events", async () => {
    const store = new RecordingRateLimitStore();
    const policy = new ActionRateLimitPolicy(store, clock);

    await policy.assertOidcExchangeAllowed({
      repositoryId: "repo_1",
      eventName: "pull_request_review_comment",
      githubActorLogin: "alice",
      githubRunId: "run_2",
      githubRunAttempt: "1",
    });

    expect(store.calls.map((call) => call.key)).toEqual([
      "action:oidc_exchange:interaction_actor:repo_1:2bd806c97f0e00af",
      "action:oidc_exchange:interaction_repository:repo_1",
      "action:oidc_exchange:repo_1:run_2:1",
    ]);
    expect(store.calls.map((call) => call.limit)).toEqual([30, 120, 20]);
  });

  it("fails closed before spending later buckets when interaction actor is rate limited", async () => {
    const store = new BlockingRateLimitStore();
    const policy = new ActionRateLimitPolicy(store, clock);

    await expect(
      policy.assertOidcExchangeAllowed({
        repositoryId: "repo_1",
        eventName: "issue_comment",
        githubActorLogin: "alice",
        githubRunId: "run_3",
        githubRunAttempt: "1",
      }),
    ).rejects.toBeInstanceOf(RateLimitExceededError);

    expect(store.calls.map((call) => call.key)).toEqual([
      "action:oidc_exchange:interaction_actor:repo_1:2bd806c97f0e00af",
    ]);
  });
});
