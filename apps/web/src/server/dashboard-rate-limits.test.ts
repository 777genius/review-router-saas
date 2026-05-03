import { describe, expect, it } from "vitest";
import type {
  ConsumeFixedWindowRateLimitInput,
  RateLimitStorePort,
} from "@reviewrouter/features-rate-limits";
import {
  createRateLimitDecision,
  RateLimitExceededError,
} from "@reviewrouter/features-rate-limits";
import { DashboardRateLimitPolicy } from "./dashboard-rate-limits";

type Clock = {
  now(): Date;
};

class InMemoryRateLimitStore implements RateLimitStorePort {
  public readonly keys: string[] = [];
  private readonly buckets = new Map<
    string,
    { count: number; limit: number; windowEndsAt: Date }
  >();

  async consumeFixedWindow(input: ConsumeFixedWindowRateLimitInput) {
    this.keys.push(input.key);
    const existing = this.buckets.get(input.key);
    const bucket =
      !existing || existing.windowEndsAt <= input.now
        ? { count: 1, limit: input.limit, windowEndsAt: input.windowEndsAt }
        : {
            count: existing.count + 1,
            limit: input.limit,
            windowEndsAt: existing.windowEndsAt,
          };
    this.buckets.set(input.key, bucket);
    return createRateLimitDecision({
      key: input.key,
      limit: bucket.limit,
      count: bucket.count,
      resetAt: bucket.windowEndsAt,
    });
  }
}

describe("DashboardRateLimitPolicy", () => {
  it("rate limits workflow setup PR attempts per repository", async () => {
    const store = new InMemoryRateLimitStore();
    const policy = new DashboardRateLimitPolicy(store, staticClock());
    const input = { workspaceId: "workspace_1", repositoryId: "repo_1" };

    for (let index = 0; index < 5; index += 1) {
      await expect(policy.assertWorkflowSetupPrAllowed(input)).resolves.toBe(
        undefined,
      );
    }

    await expect(
      policy.assertWorkflowSetupPrAllowed(input),
    ).rejects.toBeInstanceOf(RateLimitExceededError);
  });

  it("uses resource-scoped keys and encodes unsafe key separators", async () => {
    const store = new InMemoryRateLimitStore();
    const policy = new DashboardRateLimitPolicy(store, staticClock());

    await policy.assertInstallationSyncAllowed({
      workspaceId: "workspace:alpha",
      githubInstallationId: "123/456",
    });

    expect(store.keys).toEqual([
      "dashboard:installation_sync:workspace%3Aalpha:123%2F456",
    ]);
  });

  it("uses workspace-scoped limits for review config saves", async () => {
    const store = new InMemoryRateLimitStore();
    const policy = new DashboardRateLimitPolicy(store, staticClock());

    await policy.assertReviewConfigSaveAllowed({ workspaceId: "workspace_1" });

    expect(store.keys).toEqual([
      "dashboard:review_config_save:workspace_1:workspace",
    ]);
  });

  it("supports repository-scoped limits for repository review config saves", async () => {
    const store = new InMemoryRateLimitStore();
    const policy = new DashboardRateLimitPolicy(store, staticClock());

    await policy.assertReviewConfigSaveAllowed({
      workspaceId: "workspace_1",
      resourceId: "repo_1",
    });

    expect(store.keys).toEqual([
      "dashboard:review_config_save:workspace_1:repo_1",
    ]);
  });
});

function staticClock(): Clock {
  return { now: () => new Date("2026-05-03T12:00:00.000Z") };
}
