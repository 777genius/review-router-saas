import { describe, expect, it, vi } from "vitest";
import { PrismaReviewProgressPublicationStore } from "./review-progress-store";

const now = new Date("2026-08-12T12:00:00.000Z");

describe("PrismaReviewProgressPublicationStore fencing", () => {
  it("does not complete a stale claim after a newer generation wins the scope", async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const store = new PrismaReviewProgressPublicationStore({
      reviewProgressPublicationV1: { updateMany },
    } as never);

    await expect(
      store.complete({
        publication: claimed(),
        commentId: 42n,
        bodyHash: "c".repeat(64),
        now,
      }),
    ).resolves.toBe(false);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          activeExecutionId: "execution-1",
          activeGeneration: 7n,
          activeHeadSha: "a".repeat(40),
          activePlanHash: "b".repeat(64),
          desiredVersion: 73n,
          claimId: "claim-1",
        }),
      }),
    );
  });

  it("persists installation cooldown with monotonic database GREATEST", async () => {
    const rawQueries: unknown[] = [];
    const prisma = {
      $transaction: async (operation: (transaction: unknown) => unknown) =>
        operation({
          reviewProgressPublicationV1: {
            updateMany: vi.fn(async () => ({ count: 1 })),
          },
          $executeRaw: async (query: unknown) => {
            rawQueries.push(query);
            return 1;
          },
        }),
    };
    const store = new PrismaReviewProgressPublicationStore(prisma as never);

    await store.retry({
      publication: claimed(),
      safeCode: "review_progress_rate_limited",
      retryAt: new Date(now.getTime() + 1_000),
      installationCooldownUntil: new Date(now.getTime() + 60_000),
      now,
    });

    const query = rawQueries[0] as { strings: readonly string[] };
    expect(query.strings.join(" ")).toContain('"nextMutationAt" = GREATEST');
    expect(query.strings.join(" ")).toContain('"cooldownUntil" = GREATEST');
  });

  it("orders terminal snapshots before ordinary due progress", async () => {
    const rawQueries: unknown[] = [];
    const prisma = {
      $transaction: async (operation: (transaction: unknown) => unknown) =>
        operation({
          $queryRaw: async (query: unknown) => {
            rawQueries.push(query);
            return [];
          },
        }),
    };
    const store = new PrismaReviewProgressPublicationStore(prisma as never);

    await expect(
      store.claimNext({
        ownerIdHash: "d".repeat(64),
        now,
        claimDurationMs: 60_000,
      }),
    ).resolves.toBeNull();
    const query = rawQueries[0] as { strings: readonly string[] };
    expect(query.strings.join(" ")).toContain(
      'progress."terminalOutcome" IS NOT NULL',
    );
    expect(query.strings.join(" ")).toContain("THEN 0 ELSE 1 END");
  });

  it("limits hosted claims to the explicit repository cohort", async () => {
    const rawQueries: unknown[] = [];
    const prisma = {
      $transaction: async (operation: (transaction: unknown) => unknown) =>
        operation({
          $queryRaw: async (query: unknown) => {
            rawQueries.push(query);
            return [];
          },
        }),
    };
    const store = new PrismaReviewProgressPublicationStore(prisma as never, {
      allowedRepositoryFullNames: new Set(["acme/rocket"]),
    });

    await store.claimNext({
      ownerIdHash: "d".repeat(64),
      now,
      claimDurationMs: 60_000,
    });

    const query = rawQueries[0] as { strings: readonly string[] };
    expect(query.strings.join(" ")).toContain(
      'LOWER(repository."fullName") IN',
    );
  });

  it("publishes a failed terminal state when final review publication failed", async () => {
    const progressUpdate = vi.fn(async () => ({}));
    const publicationUpdate = vi.fn(async () => ({}));
    const prisma = {
      $transaction: async (operation: (transaction: unknown) => unknown) =>
        operation({
          reviewExecutionV2: {
            findUnique: async () => ({
              executionId: "execution-1",
              state: "completed",
            }),
          },
          reviewExecutionProgressV1: {
            findUnique: async () => ({
              executionId: "execution-1",
              workspaceId: "workspace-1",
              repositoryConnectionId: "repository-1",
              scmRepositoryIdentityId: "identity-1",
              pullRequestNumber: 42,
              generation: 7n,
              headSha: "a".repeat(40),
              planHash: "b".repeat(64),
              terminalOutcome: null,
              snapshotJson: {
                schemaVersion: 1,
                phase: "publishing",
                counts: {
                  requiredTotal: 1,
                  requiredCompleted: 1,
                  requiredExhausted: 0,
                  requiredCancelled: 0,
                },
              },
            }),
            update: progressUpdate,
          },
          reviewProgressPublicationV1: {
            findUnique: async () => ({
              activeExecutionId: "execution-1",
              activeGeneration: 7n,
              activeHeadSha: "a".repeat(40),
              activePlanHash: "b".repeat(64),
              desiredVersion: 73n,
            }),
            update: publicationUpdate,
          },
        }),
    };
    const store = new PrismaReviewProgressPublicationStore(prisma as never);

    await expect(
      store.promoteSettledExecutions({
        settlements: [{ executionId: "execution-1", outcome: "failed" }],
        now,
      }),
    ).resolves.toBe(1);
    expect(progressUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          phase: "terminal",
          terminalOutcome: "failed",
        }),
      }),
    );
  });
});

function claimed() {
  return {
    scope: {
      workspaceId: "workspace-1",
      repositoryConnectionId: "repository-1",
      scmRepositoryIdentityId: "identity-1",
      pullRequestNumber: 42,
    },
    executionId: "execution-1",
    generation: 7n,
    headSha: "a".repeat(40),
    planHash: "b".repeat(64),
    desiredVersion: 73n,
    publishedVersion: 72n,
    commentId: 9n,
    publishedBodyHash: null,
    snapshot: {},
    terminal: false,
    repository: { owner: "acme", name: "rocket", githubInstallationId: 17n },
    claim: {
      claimId: "claim-1",
      ownerIdHash: "d".repeat(64),
      claimUntil: new Date(now.getTime() + 60_000),
    },
  } as const;
}
