import { describe, expect, it, vi } from "vitest";
import type { ProgressSnapshot } from "@reviewrouter/features-review-progress";
import { ReviewProgressPublisher } from "./review-progress-publisher";
import type { ClaimedReviewProgress } from "./review-progress-store";

const now = new Date("2026-08-12T12:00:00.000Z");

describe("ReviewProgressPublisher", () => {
  it("publishes through the installation and fences completion", async () => {
    const publication = claimed();
    const store = fakeStore(publication);
    const calls: string[] = [];
    const publisher = createPublisher(store, async () => ({
      botLogin: "review-router[bot]",
      request: async (route, parameters = {}) => {
        calls.push(route);
        if (route.includes("/pulls/")) return pull();
        if (route.includes("/comments") && route.startsWith("GET"))
          return { data: [] };
        if (route.startsWith("POST")) {
          expect(parameters.body).toContain(
            "<!-- review-router-live-progress -->",
          );
          return {
            data: {
              id: 77,
              body: parameters.body,
              user: { login: "review-router[bot]" },
            },
          };
        }
        throw new Error(`unexpected:${route}`);
      },
    }));

    await expect(publisher.runMaintenance()).resolves.toEqual({
      claimed: 1,
      published: 1,
      deferred: 0,
      suppressed: 0,
      failed: 0,
    });
    expect(calls).toEqual([
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
    ]);
    expect(store.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        publication,
        commentId: 77n,
        bodyHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
  });

  it("defers without touching GitHub when the installation budget is busy", async () => {
    const publication = claimed();
    const store = fakeStore(publication);
    const retryAt = new Date(now.getTime() + 2_000);
    store.reserveInstallationMutation = vi.fn(async () => ({
      allowed: false as const,
      retryAt,
    })) as typeof store.reserveInstallationMutation;
    const factory = vi.fn();

    await expect(
      createPublisher(store, factory).runMaintenance(),
    ).resolves.toMatchObject({
      claimed: 1,
      deferred: 1,
      published: 0,
    });
    expect(factory).not.toHaveBeenCalled();
    expect(store.retry).toHaveBeenCalledWith(
      expect.objectContaining({ retryAt }),
    );
  });

  it("suppresses a corrupt durable snapshot without affecting the review", async () => {
    const publication = { ...claimed(), snapshot: { schemaVersion: 9 } };
    const store = fakeStore(publication);

    await expect(
      createPublisher(store, vi.fn()).runMaintenance(),
    ).resolves.toMatchObject({
      claimed: 1,
      suppressed: 1,
      failed: 0,
    });
    expect(store.suppress).toHaveBeenCalledWith(
      expect.objectContaining({
        safeCode: "review_progress_snapshot_invalid",
      }),
    );
  });

  it("coalesces 72 durable events into one latest-version GitHub mutation", async () => {
    const publication = { ...claimed(), desiredVersion: 72n };
    const store = fakeStore(publication);
    const post = vi.fn(
      async (
        _route: string,
        parameters: Readonly<Record<string, unknown>> = {},
      ) => ({
        data: {
          id: 77,
          body: parameters.body,
          user: { login: "review-router[bot]" },
        },
      }),
    );
    const publisher = createPublisher(store, async () => ({
      botLogin: "review-router[bot]",
      request: async (route, parameters = {}) => {
        if (route.includes("/pulls/")) return pull();
        if (route.startsWith("GET")) return { data: [] };
        return post(route, parameters);
      },
    }));

    await publisher.runMaintenance();

    expect(post).toHaveBeenCalledTimes(1);
    expect(store.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        publication: expect.objectContaining({ desiredVersion: 72n }),
      }),
    );
  });

  it("suppresses a poison publication at the retry bound", async () => {
    const publication = { ...claimed(), failureCount: 2 };
    const store = fakeStore(publication);
    store.retry.mockResolvedValue("suppressed");
    const publisher = createPublisher(store, async () => {
      throw new Error("invalid_installation");
    });

    await expect(publisher.runMaintenance()).resolves.toMatchObject({
      claimed: 1,
      suppressed: 1,
      failed: 0,
    });
    expect(store.retry).toHaveBeenCalledWith(
      expect.objectContaining({ maxFailures: 3 }),
    );
  });
});

function createPublisher(
  store: ReturnType<typeof fakeStore>,
  factory: ConstructorParameters<typeof ReviewProgressPublisher>[1],
) {
  return new ReviewProgressPublisher(
    store,
    factory,
    { now: () => now },
    "a".repeat(64),
    {
      limit: 2,
      claimDurationMs: 60_000,
      minimumMutationIntervalMs: 1_000,
      retryDelayMs: 5_000,
      maxCommentPages: 2,
      maxFailures: 3,
    },
  );
}

function fakeStore(publication: ClaimedReviewProgress) {
  let claimedOnce = false;
  return {
    claimNext: vi.fn(async () => {
      if (claimedOnce) return null;
      claimedOnce = true;
      return publication;
    }),
    reserveInstallationMutation: vi.fn(
      async (): Promise<
        { allowed: true } | { allowed: false; retryAt: Date }
      > => ({ allowed: true as const }),
    ),
    complete: vi.fn(async () => true),
    retry: vi.fn(async (): Promise<"retried" | "suppressed"> => "retried"),
    suppress: vi.fn(async () => true),
  };
}

function claimed(
  snapshot: unknown = progressSnapshot(),
): ClaimedReviewProgress {
  return {
    scope: {
      workspaceId: "workspace-1",
      repositoryConnectionId: "repository-1",
      scmRepositoryIdentityId: "identity-1",
      pullRequestNumber: 42,
    },
    executionId: "execution-1",
    generation: 1n,
    headSha: "a".repeat(40),
    planHash: "b".repeat(64),
    desiredVersion: 2n,
    publishedVersion: 1n,
    commentId: null,
    publishedBodyHash: null,
    failureCount: 0,
    snapshot,
    terminal: false,
    repository: { owner: "acme", name: "rocket", githubInstallationId: 9n },
    claim: {
      claimId: "claim-1",
      ownerIdHash: "a".repeat(64),
      claimUntil: new Date(now.getTime() + 60_000),
    },
  };
}

function progressSnapshot(): ProgressSnapshot {
  return {
    schemaVersion: 1,
    generation: 1,
    phase: "reviewing",
    terminal: "none",
    updatedAt: now.toISOString(),
    counts: {
      total: 2,
      completed: 1,
      exhausted: 0,
      cancelled: 0,
      running: 1,
      pending: 0,
      retrying: 0,
      recovered: 0,
      requiredTotal: 2,
      requiredCompleted: 1,
      requiredExhausted: 0,
      requiredCancelled: 0,
      optionalTotal: 0,
      optionalCompleted: 0,
    },
    fileCoverage: { valid: false },
  };
}

function pull() {
  return {
    data: {
      state: "open",
      head: { sha: "a".repeat(40) },
      base: { repo: { full_name: "acme/rocket" } },
    },
  };
}
