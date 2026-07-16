import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  codexRotatingCommentTokenRefreshTtlMs,
  codexRotatingReviewSnapshotAccessTtlMs,
} from "../domain/codex-rotating-oauth-posting-window.js";
import {
  orgRulesetTargetsRepository,
  PrismaActionControlPlaneRepository,
} from "../infrastructure/prisma/prisma-action-control-plane-repository.js";
import { PrismaCodexRotatingOAuthRepository } from "../infrastructure/prisma/prisma-codex-rotating-oauth-repository.js";

describe("PrismaActionControlPlaneRepository helpers", () => {
  it("does not trust org ruleset workflows for the source repository itself", () => {
    expect(
      orgRulesetTargetsRepository({
        scope: "all_repositories",
        sourceGithubRepositoryId: "1999",
        targetRepositoryIds: ["1001", "1002"],
        githubRepositoryId: "1999",
      }),
    ).toBe(false);
  });

  it("trusts org ruleset workflows for selected target repositories only", () => {
    expect(
      orgRulesetTargetsRepository({
        scope: "selected_repositories",
        sourceGithubRepositoryId: "1999",
        targetRepositoryIds: ["1001", "1002"],
        githubRepositoryId: "1001",
      }),
    ).toBe(true);
    expect(
      orgRulesetTargetsRepository({
        scope: "selected_repositories",
        sourceGithubRepositoryId: "1999",
        targetRepositoryIds: ["1001", "1002"],
        githubRepositoryId: "1003",
      }),
    ).toBe(false);
  });

  it("hydrates Claude Code provider records without falling back to Codex", async () => {
    const prisma = {
      reviewConfiguration: {
        findUnique: vi.fn().mockResolvedValue({
          versions: [
            {
              version: 11,
              schemaVersion: 2,
              providerKind: "codex",
              providerAuthMode: "codex_subscription_oauth",
              model: "gpt-5.5",
              reasoningEffort: "medium",
              agenticContext: true,
              fastMode: false,
              failOnSeverity: "critical",
              inlineMaxComments: 5,
              providerLimit: 1,
              providerMaxParallel: 1,
              inlineMinAgreement: 1,
              targetTokensPerBatch: 50000,
              reviewLanguage: "Russian",
              providers: [
                {
                  providerKind: "claude",
                  providerAuthMode: "claude_code_oauth",
                  model: "sonnet",
                  reasoningEffort: "medium",
                  agenticContext: true,
                  fastMode: false,
                  requiredHealthy: true,
                },
              ],
            },
          ],
        }),
      },
    } as unknown as PrismaClient;
    const repository = new PrismaActionControlPlaneRepository(prisma);

    const record = await repository.findRuntimeReviewConfiguration({
      workspaceId: "workspace_1",
      repositoryId: "repo_1",
    });

    expect(record?.config.provider).toMatchObject({
      kind: "claude",
      authMode: "claude_code_oauth",
      model: "sonnet",
    });
    expect(record?.config.reviewLanguage).toBe("Russian");
    expect(record?.config.providers).toHaveLength(1);
    expect(record?.config.providers[0]?.requiredHealthy).toBe(true);
  });
});

describe("PrismaCodexRotatingOAuthRepository", () => {
  const now = new Date("2026-05-25T12:00:00.000Z");

  it("allows completed leases to refresh comment tokens after auth lease expiry inside the posting window", async () => {
    const { repository } = buildCodexRotatingRepository({
      status: "completed",
      expiresAt: new Date(now.getTime() - 5 * 60 * 1000),
      completedAt: new Date(now.getTime() - 20 * 60 * 1000),
    });

    await expect(
      repository.findCompletedLeaseWriteTarget({
        leaseId: "lease_1",
        providerInstanceId: "codex-rotating:123456",
        now,
      }),
    ).resolves.toMatchObject({
      status: "ready",
      writeTarget: {
        repositoryFullName: "777genius/example",
        owner: "777genius",
        repo: "example",
      },
    });
    await expect(
      repository.authorizeReviewSnapshotAccess({
        leaseId: "lease_1",
        providerInstanceId: "codex-rotating:123456",
        now,
      }),
    ).resolves.toMatchObject({
      status: "ready",
      scope: {
        workspaceId: "workspace_1",
        repositoryId: "repo_1",
        sourceRunId: "9001",
        sourceRunAttempt: "2",
      },
    });
  });

  it("closes completed leases after the posting window expires", async () => {
    const { repository } = buildCodexRotatingRepository({
      status: "completed",
      expiresAt: new Date(now.getTime() - 5 * 60 * 1000),
      completedAt: new Date(
        now.getTime() - codexRotatingCommentTokenRefreshTtlMs - 1,
      ),
    });

    await expect(
      repository.findCompletedLeaseWriteTarget({
        leaseId: "lease_1",
        providerInstanceId: "codex-rotating:123456",
        now,
      }),
    ).resolves.toEqual({ status: "lease_not_active" });
  });

  it("keeps snapshot access active for long reviews without extending writeback access", async () => {
    const { repository } = buildCodexRotatingRepository({
      status: "completed",
      expiresAt: new Date(now.getTime() - 5 * 60 * 1000),
      completedAt: new Date(
        now.getTime() - codexRotatingCommentTokenRefreshTtlMs - 1,
      ),
    });

    await expect(
      repository.findCompletedLeaseWriteTarget({
        leaseId: "lease_1",
        providerInstanceId: "codex-rotating:123456",
        now,
      }),
    ).resolves.toEqual({ status: "lease_not_active" });
    await expect(
      repository.authorizeReviewSnapshotAccess({
        leaseId: "lease_1",
        providerInstanceId: "codex-rotating:123456",
        now,
      }),
    ).resolves.toMatchObject({ status: "ready" });
    await expect(
      repository.findCompletedLeaseWriteTarget({
        leaseId: "lease_1",
        providerInstanceId: "codex-rotating:123456",
        now,
        completedLeaseTtlMs: codexRotatingReviewSnapshotAccessTtlMs,
      }),
    ).resolves.toMatchObject({
      status: "ready",
      writeTarget: { repositoryFullName: "777genius/example" },
    });

    const expired = buildCodexRotatingRepository({
      status: "completed",
      expiresAt: new Date(now.getTime() - 5 * 60 * 1000),
      completedAt: new Date(
        now.getTime() - codexRotatingReviewSnapshotAccessTtlMs - 1,
      ),
    });
    await expect(
      expired.repository.authorizeReviewSnapshotAccess({
        leaseId: "lease_1",
        providerInstanceId: "codex-rotating:123456",
        now,
      }),
    ).resolves.toEqual({ status: "lease_not_active" });
  });

  it("keeps expired unfinished leases closed for comment token refresh", async () => {
    const { repository } = buildCodexRotatingRepository({
      status: "finalized",
      expiresAt: new Date(now.getTime() - 1),
      completedAt: null,
    });

    await expect(
      repository.findCompletedLeaseWriteTarget({
        leaseId: "lease_1",
        providerInstanceId: "codex-rotating:123456",
        now,
      }),
    ).resolves.toEqual({ status: "lease_not_active" });
  });

  it("uses the immutable lease repository after the provider is rebound", async () => {
    const { prisma, repository } = buildCodexRotatingRepository({
      status: "completed",
      expiresAt: new Date(now.getTime() - 5 * 60 * 1000),
      completedAt: new Date(now.getTime() - 20 * 60 * 1000),
    });

    await expect(
      repository.authorizeReviewSnapshotAccess({
        leaseId: "lease_1",
        providerInstanceId: "codex-rotating:123456",
        now,
      }),
    ).resolves.toMatchObject({
      status: "ready",
      scope: { workspaceId: "workspace_1", repositoryId: "repo_1" },
    });
    expect(prisma.codexOAuthProviderInstance).toBeUndefined();
  });
});

function buildCodexRotatingRepository(lease: {
  readonly status: string;
  readonly expiresAt: Date;
  readonly completedAt: Date | null;
}) {
  const prisma = {
    codexOAuthLease: {
      findFirst: vi.fn().mockResolvedValue({
        workspaceId: "workspace_1",
        repository: {
          id: "repo_1",
          workspaceId: "workspace_1",
          provider: "github",
          githubRepositoryId: 123456n,
          fullName: "777genius/example",
          owner: "777genius",
          name: "example",
          selected: true,
          installation: {
            githubInstallationId: 789n,
            status: "active",
          },
        },
        ...lease,
        githubRunId: "9001",
        githubRunAttempt: "2",
      }),
    },
  } as unknown as PrismaClient;

  return {
    prisma,
    repository: new PrismaCodexRotatingOAuthRepository(prisma, {
      actionOwnerRepo: "777genius/review-router",
    }),
  };
}
