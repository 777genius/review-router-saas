import { invocationGrantId, hostedBindingId } from "../domain/identifiers";
import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { PrismaHostedCommentTokenMintLedger } from "../infrastructure/prisma/prisma-hosted-comment-token-mint-ledger";

const now = new Date("2026-09-06T00:00:00Z");
const input = {
  mintId: "mint",
  purpose: "initial" as const,
  ownerIdHash: "a".repeat(64),
  logicalKeyHash: "b".repeat(64),
  requestFingerprintHash: "c".repeat(64),
  grantId: invocationGrantId("grant"),
  bindingId: hostedBindingId("binding"),
  bindingVersion: 1,
  now,
  leaseExpiresAt: new Date(now.getTime() + 30000),
};
function fixture(visibility: string, overrides: Record<string, unknown> = {}) {
  const snapshot = {
    gateStatus: "active",
    runtimeAuthzEpoch: 1n,
    runtimeGateRevision: 1n,
    grantId: "grant",
    grantInvocationId: "invocation",
    grantStatus: "issued",
    grantRevokedAt: null,
    grantExpiresAt: new Date(now.getTime() + 600000),
    grantRuntimeAuthzEpoch: 1n,
    grantAuthzEpoch: 1n,
    grantBindingRevision: 1n,
    workspaceId: "workspace",
    bindingId: "binding",
    bindingStatus: "active",
    bindingRevision: 1n,
    bindingStateVersion: 1n,
    attestedGithubRepositoryId: 123n,
    poolId: "pool",
    poolStatus: "active",
    poolRevision: 1n,
    poolAuthzEpoch: 1n,
    repositoryConnectionId: "repository",
    repositoryProvider: "github",
    repositorySelected: true,
    repositoryArchived: false,
    repositoryVisibility: visibility,
    repositoryUpdatedAt: now,
    githubRepositoryId: 123n,
    repositoryFullName: "owner/repository",
    installationRowId: "installation",
    installationStatus: "active",
    installationSelection: "selected",
    installationUpdatedAt: now,
    installationWorkspaceId: "workspace",
    githubInstallationId: 456n,
    ...overrides,
  };
  const mutation = vi.fn(() => [{ id: "mint", fenceEpoch: 1n, ...snapshot }]);
  const transaction = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join("?");
      if (sql.includes("hosted_codex_comment_token_authority_snapshot"))
        return [snapshot];
      if (sql.includes("hosted_codex_lock_comment_token_mint"))
        return [{ locked: false }];
      if (sql.includes("clock_timestamp")) return [{ now }];
      if (sql.includes("hosted_codex_mutate_comment_token_mint"))
        return mutation();
      throw new Error("unexpected_fixture_query");
    }),
  };
  const prisma = {
    $transaction: async (
      callback: (value: typeof transaction) => Promise<unknown>,
    ) => callback(transaction),
  } as unknown as PrismaClient;
  return { ledger: new PrismaHostedCommentTokenMintLedger(prisma), mutation };
}

describe("mint admission visibility and unchanged authority", () => {
  it.each(["public", "private", "internal"])(
    "prepares mint authority for %s",
    async (visibility) => {
      const f = fixture(visibility);
      await expect(f.ledger.prepare(input)).resolves.toMatchObject({
        mintId: "mint",
        state: "prepared",
      });
      expect(f.mutation).toHaveBeenCalledOnce();
    },
  );
  it.each([
    { installationWorkspaceId: "foreign" },
    { installationStatus: "suspended" },
    { repositorySelected: false },
    { repositoryArchived: true },
    { repositoryVisibility: "unknown" },
    { grantBindingRevision: 2n },
    { bindingStatus: "draining" },
    { grantRuntimeAuthzEpoch: 2n },
    { attestedGithubRepositoryId: 999n },
    { repositoryProvider: "gitlab" },
  ])(
    "denies a public mint with invalid authority case %#",
    async (authority) => {
      const f = fixture("public", authority);
      await expect(f.ledger.prepare(input)).rejects.toThrow(
        "hosted_comment_mint_authority_mismatch",
      );
      expect(f.mutation).not.toHaveBeenCalled();
    },
  );
});
