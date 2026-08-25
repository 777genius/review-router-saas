import { describe, expect, it, vi } from "vitest";
import { HostedCodexCommentTokenIssuer } from "./hosted-codex-comment-token-composition.js";

const now = new Date("2026-08-15T10:00:00.000Z");

describe("HostedCodexCommentTokenIssuer", () => {
  it("consumes the narrow persisted capability before issuing a repository token", async () => {
    const consume = vi.fn().mockImplementation(async (input) =>
      input.transition({
        commentTokenRefreshCapability: {
          tokenHash: "a".repeat(64),
          expiresAt: new Date("2026-08-15T10:10:00.000Z"),
          maxUses: 2,
          useCount: 0,
          revokedAt: null,
        },
      }),
    );
    const issuer = new HostedCodexCommentTokenIssuer({
      prisma: {
        hostedCodexInvocationGrant: {
          findUnique: vi.fn().mockResolvedValue(grantRecord()),
        },
        hostedCodexRuntimeGate: {
          findUnique: vi.fn().mockResolvedValue(runtimeGateRecord()),
        },
      } as never,
      grants: { consume } as never,
      commentTokens: {
        issueCommentToken: vi.fn().mockResolvedValue({
          token: "ghs-comment",
          repository: "acme/private-repo",
          expiresAt: new Date("2026-08-15T10:45:00.000Z"),
          permissions: {
            contents: "read",
            pullRequests: "write",
            issues: "write",
            statuses: "write",
          },
        }),
      },
      clock: { now: () => now },
    });
    const capability = "c".repeat(43);

    await expect(
      issuer.issue({
        opaqueRefreshCapability: capability,
        idempotencyKey: "refresh-request-1",
        invocationLeaseId: "grant-1",
        bindingId: "binding-1",
        bindingVersion: 7,
      }),
    ).resolves.toEqual({
      token: "ghs-comment",
      repository: "acme/private-repo",
      expiresAt: "2026-08-15T10:45:00.000Z",
    });
    expect(consume).toHaveBeenCalledWith(
      expect.objectContaining({
        presentedTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        requestIdHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    );
  });

  it("rejects a stale binding before consuming the capability", async () => {
    const consume = vi.fn();
    const issuer = new HostedCodexCommentTokenIssuer({
      prisma: {
        hostedCodexInvocationGrant: {
          findUnique: vi.fn().mockResolvedValue(grantRecord()),
        },
        hostedCodexRuntimeGate: {
          findUnique: vi.fn().mockResolvedValue(runtimeGateRecord()),
        },
      } as never,
      grants: { consume } as never,
      commentTokens: { issueCommentToken: vi.fn() },
      clock: { now: () => now },
    });
    await expect(
      issuer.issue({
        opaqueRefreshCapability: "c".repeat(43),
        idempotencyKey: "refresh-request-1",
        invocationLeaseId: "grant-1",
        bindingId: "binding-1",
        bindingVersion: 6,
      }),
    ).rejects.toThrow("hosted_comment_refresh_authority_mismatch");
    expect(consume).not.toHaveBeenCalled();
  });
});

function grantRecord() {
  return {
    id: "grant-1",
    status: "issued",
    expiresAt: new Date("2026-08-15T10:15:00.000Z"),
    repositoryBindingId: "binding-1",
    bindingRevision: 7n,
    authzEpoch: 3n,
    runtimeAuthzEpoch: 5n,
    binding: {
      revision: 7n,
      status: "active",
      pool: { status: "active", authzEpoch: 3n },
      repository: {
        provider: "github",
        selected: true,
        archived: false,
        visibility: "private",
        githubRepositoryId: 123n,
        fullName: "acme/private-repo",
        installation: {
          status: "active",
          githubInstallationId: 456n,
        },
      },
    },
  };
}

function runtimeGateRecord() {
  return { status: "active", authzEpoch: 5n };
}
