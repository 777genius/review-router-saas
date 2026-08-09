import { describe, expect, it, vi } from "vitest";
import { PrismaCodexRotatingOAuthRepository } from "../infrastructure/prisma/prisma-codex-rotating-oauth-repository.js";

describe("Prisma Codex rotating new-work barrier", () => {
  it("reasserts the closed fence inside the provider-lock transaction before lease writes", async () => {
    const providerUpdate = vi.fn();
    const leaseUpsert = vi.fn();
    const queryRaw = vi.fn(async (query: unknown) => {
      void query;
      return [{ id: "provider-row-1" }];
    });
    const tx = {
      $queryRaw: queryRaw,
      codexOAuthProviderInstance: {
        findUnique: vi.fn(async () => ({
          id: "provider-row-1",
          workspaceId: "workspace-1",
          repositoryId: "repository-1",
          providerInstanceId: "codex-rotating:123456",
          authMode: "codex_subscription_oauth_rotating",
          secretName: "REVIEWROUTER_CODEX_AUTH_JSON",
          activeLeaseId: null,
          activeLeaseExpiresAt: null,
          mutationEpoch: 0n,
          mutationOwner: null,
          mutationOwnerId: null,
          state: "setup_pending",
          latestGeneration: 1,
          latestGenerationHash: null,
          generationHashSalt: "salt",
        })),
        update: providerUpdate,
      },
      codexOAuthWritebackIntent: { findFirst: vi.fn() },
      codexOAuthSetupManifest: { findFirst: vi.fn() },
      codexOAuthLease: { upsert: leaseUpsert },
    };
    const transaction = vi.fn(async (callback) => callback(tx));
    const repository = new PrismaCodexRotatingOAuthRepository(
      { $transaction: transaction } as never,
      { actionOwnerRepo: "reviewrouter/action" },
    );

    await expect(
      repository.acquirePrelease({
        repository: {
          workspaceId: "workspace-1",
          repositoryId: "repository-1",
          githubRepositoryId: "123456",
          githubInstallationId: "789",
          fullName: "owner/repo",
          owner: "owner",
          selected: true,
          installationStatus: "active",
        },
        providerInstanceId: "codex-rotating:123456",
        githubRunId: "100",
        githubRunAttempt: "1",
        now: new Date("2026-08-09T00:00:00Z"),
        newWorkAdmissionBarrier: {
          assertAdmitted() {
            throw new Error("codex_rotating_new_work_admission_closed");
          },
        },
      }),
    ).rejects.toThrow("codex_rotating_new_work_admission_closed");
    expect(transaction).toHaveBeenCalledOnce();
    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(
      (
        queryRaw.mock.calls[0]?.[0] as { strings: readonly string[] }
      ).strings.join(""),
    ).toContain("pg_advisory_xact_lock_shared");
    expect(tx.codexOAuthProviderInstance.findUnique).toHaveBeenCalledOnce();
    expect(providerUpdate).not.toHaveBeenCalled();
    expect(leaseUpsert).not.toHaveBeenCalled();
  });
});
