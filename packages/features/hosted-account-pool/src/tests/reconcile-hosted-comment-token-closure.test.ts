import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  HostedCommentTokenMintLedgerPort,
  HostedCommentTokenRevocationClaim,
  HostedCommentTokenSecretVaultPort,
} from "../application/ports/hosted-comment-token-mint-ledger-port";
import {
  HostedCommentTokenClosureReconciler,
  startHostedCommentTokenClosureReconciler,
} from "../application/use-cases/reconcile-hosted-comment-token-closure";
import { PrismaHostedCommentTokenMintLedger } from "../infrastructure/prisma/prisma-hosted-comment-token-mint-ledger";

const now = new Date("2026-08-25T12:00:00.000Z");
const token = "github-installation-token";

describe("HostedCommentTokenClosureReconciler", () => {
  it("runs bounded no-network stale recovery before revocation claims", async () => {
    const calls: string[] = [];
    const ledger = ledgerFixture(calls);
    ledger.recoverStale = vi.fn(async ({ limit }) => {
      calls.push(`recover:${limit}`);
      return 3;
    });
    ledger.claimRevocations = vi.fn(async () => {
      calls.push("claim");
      return [];
    });
    const provider = { revoke: vi.fn() };
    const reconciler = new HostedCommentTokenClosureReconciler({
      ledger,
      provider,
      vault: { open: vi.fn(), seal: vi.fn() },
      now: () => now,
      batchSize: 3,
    });

    await expect(reconciler.reconcile()).resolves.toEqual({
      claimed: 0,
      revoked: 0,
      deferred: 0,
    });
    expect(calls).toEqual(["recover:3", "claim"]);
    expect(provider.revoke).not.toHaveBeenCalled();
  });

  it("delegates stale recovery to the bounded database state machine", async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValue([
        { id: "prepared-expired" },
        { id: "dispatch-ambiguity-elapsed" },
        { id: "outcome-ambiguity-elapsed" },
      ]);
    const ledger = new PrismaHostedCommentTokenMintLedger({
      $transaction: async (operation: (transaction: unknown) => unknown) =>
        operation({ $queryRaw: queryRaw }),
    } as never);

    await expect(ledger.recoverStale({ limit: 3 })).resolves.toBe(3);
    expect(queryRaw).toHaveBeenCalledOnce();
    await expect(ledger.recoverStale({ limit: 0 })).rejects.toThrow(
      "hosted_comment_mint_recovery_batch_invalid",
    );
  });

  it("observes finalize ambiguity without loading encrypted custody fields", async () => {
    const findUnique = vi.fn().mockResolvedValue({
      state: "issued",
      tokenHash: "a".repeat(64),
    });
    const ledger = new PrismaHostedCommentTokenMintLedger({
      hostedCodexCommentTokenMint: { findUnique },
    } as never);

    await expect(ledger.observe({ mintId: "mint-1" })).resolves.toEqual({
      state: "issued",
      tokenHash: "a".repeat(64),
    });
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "mint-1" },
      select: { state: true, tokenHash: true },
    });
  });

  it("loads envelope columns only after replay authorization and zeroes driver buffers", async () => {
    const driverEnvelope = {
      secretCiphertext: Buffer.from(token),
      secretEncryptedDataKey: Buffer.from("wrapped-key"),
      secretIv: Buffer.from("twelve-byte-iv"),
      secretAuthTag: Buffer.from("auth-tag"),
      secretKeyId: "key-1",
      secretAadHash: "a".repeat(64),
    };
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce({
        grantId: "grant-1",
        purpose: "initial",
        capabilityId: null,
      })
      .mockResolvedValueOnce({
        id: "mint-1",
        purpose: "initial",
        state: "issued",
        grantId: "grant-1",
        tokenHash: sha256(token),
        tokenExpiresAt: new Date(now.getTime() + 60_000),
        repositoryFullName: "acme/repo",
        workspaceId: "workspace-1",
        poolId: "pool-1",
      })
      .mockResolvedValueOnce(driverEnvelope);
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ locked: true }])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([{ locked: true }])
      .mockResolvedValueOnce([{ now }])
      .mockResolvedValueOnce([{ valid: true }]);
    const ledger = new PrismaHostedCommentTokenMintLedger({
      $transaction: async (operation: (transaction: unknown) => unknown) =>
        operation({
          $queryRaw: queryRaw,
          hostedCodexCommentTokenMint: { findUnique },
        }),
    } as never);

    const replay = await ledger.replayAuthorized({ mintId: "mint-1" });
    expect(Buffer.from(replay.secretEnvelope.ciphertext).toString()).toBe(
      token,
    );
    expect(findUnique).toHaveBeenNthCalledWith(2, {
      where: { id: "mint-1" },
      select: expect.not.objectContaining({ secretCiphertext: true }),
    });
    expect(findUnique).toHaveBeenNthCalledWith(3, {
      where: { id: "mint-1" },
      select: expect.objectContaining({ secretCiphertext: true }),
    });
    for (const value of [
      driverEnvelope.secretCiphertext,
      driverEnvelope.secretEncryptedDataKey,
      driverEnvelope.secretIv,
      driverEnvelope.secretAuthTag,
    ])
      expect(Array.from(value)).toEqual(Array(value.byteLength).fill(0));
  });

  it("copies revocation claims and zeroes every driver-owned secret buffer", async () => {
    const driverRow = {
      id: "mint-claim",
      ownerIdHash: sha256("worker"),
      fenceEpoch: 3n,
      tokenHash: sha256(token),
      tokenExpiresAt: new Date(now.getTime() + 60_000),
      repositoryFullName: "acme/repo",
      workspaceId: "workspace-1",
      poolId: "pool-1",
      secretCiphertext: Buffer.from(token),
      secretEncryptedDataKey: Buffer.from("wrapped-key"),
      secretIv: Buffer.from("twelve-byte-iv"),
      secretAuthTag: Buffer.from("auth-tag"),
      secretKeyId: "key-1",
      secretAadHash: "a".repeat(64),
    };
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([{ status: "active" }])
      .mockResolvedValueOnce([{ now }])
      .mockResolvedValueOnce([driverRow]);
    const ledger = new PrismaHostedCommentTokenMintLedger({
      $transaction: async (operation: (transaction: unknown) => unknown) =>
        operation({ $queryRaw: queryRaw }),
    } as never);

    const claims = await ledger.claimRevocations({
      ownerIdHash: driverRow.ownerIdHash,
      now,
      leaseExpiresAt: new Date(now.getTime() + 30_000),
      limit: 1,
    });
    expect(Buffer.from(claims[0]!.secretEnvelope.ciphertext).toString()).toBe(
      token,
    );
    for (const value of [
      driverRow.secretCiphertext,
      driverRow.secretEncryptedDataKey,
      driverRow.secretIv,
      driverRow.secretAuthTag,
    ])
      expect(Array.from(value)).toEqual(Array(value.byteLength).fill(0));
    expect(Array.from(claims[0]!.secretEnvelope.ciphertext)).not.toEqual(
      Array(driverRow.secretCiphertext.byteLength).fill(0),
    );
  });

  it("rejects stale replay without fetching envelope columns", async () => {
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce({
        grantId: "grant-1",
        purpose: "initial",
        capabilityId: null,
      })
      .mockResolvedValueOnce({
        id: "mint-stale",
        purpose: "initial",
        state: "issued",
        grantId: "grant-1",
        tokenHash: sha256(token),
        tokenExpiresAt: new Date(now.getTime() - 1),
      });
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ locked: true }])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([{ locked: true }])
      .mockResolvedValueOnce([{ now }])
      .mockResolvedValueOnce([{ valid: true }]);
    const ledger = new PrismaHostedCommentTokenMintLedger({
      $transaction: async (operation: (transaction: unknown) => unknown) =>
        operation({
          $queryRaw: queryRaw,
          hostedCodexCommentTokenMint: { findUnique },
        }),
    } as never);

    await expect(
      ledger.replayAuthorized({ mintId: "mint-stale" }),
    ).rejects.toThrow("hosted_comment_mint_replay_not_authorized");
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it("delegates replacement of an existing delivery claim to database time", async () => {
    const tokenHash = sha256(token);
    const replacementClaim = sha256("replacement-delivery-claim");
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce({
        grantId: "grant-1",
        purpose: "initial",
        capabilityId: null,
      })
      .mockResolvedValueOnce({
        id: "mint-claimed",
        purpose: "initial",
        state: "issued",
        grantId: "grant-1",
        tokenHash,
        tokenExpiresAt: new Date(now.getTime() + 60_000),
        deliveryClaimIdHash: sha256("crashed-delivery-claim"),
      });
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ locked: true }])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([{ locked: true }])
      .mockResolvedValueOnce([{ now }])
      .mockResolvedValueOnce([{ valid: true }])
      .mockResolvedValueOnce([{ id: "mint-claimed" }]);
    const ledger = new PrismaHostedCommentTokenMintLedger({
      $transaction: async (operation: (transaction: unknown) => unknown) =>
        operation({
          $queryRaw: queryRaw,
          hostedCodexCommentTokenMint: { findUnique },
        }),
    } as never);

    await expect(
      ledger.confirmReplayDelivery({
        mintId: "mint-claimed",
        tokenHash,
        deliveryClaimIdHash: replacementClaim,
      }),
    ).resolves.toBeUndefined();
    expect(queryRaw).toHaveBeenCalledTimes(6);
  });

  it("decrypts, revokes, and durably records trusted revocation evidence outside the claim transaction", async () => {
    const calls: string[] = [];
    const ledger = ledgerFixture(calls);
    const vault = {
      open: vi.fn(async () => {
        calls.push("decrypt");
        return Buffer.from(token);
      }),
      seal: vi.fn(),
    };
    const provider = {
      revoke: vi.fn(async () => {
        calls.push("network");
        return {
          evidenceHash: sha256("204"),
          receipt: {
            authority: "github_token_delete" as const,
            result: "revoked" as const,
          },
        };
      }),
    };
    const reconciler = new HostedCommentTokenClosureReconciler({
      ledger,
      vault,
      provider,
      now: () => now,
      ownerIdHash: sha256("worker"),
    });

    await expect(reconciler.reconcile()).resolves.toEqual({
      claimed: 1,
      revoked: 1,
      deferred: 0,
    });
    expect(calls).toEqual(["claim-commit", "decrypt", "network", "finalize"]);
    expect(ledger.finalizeRevoked).toHaveBeenCalledWith(
      expect.objectContaining({
        fenceEpoch: 3n,
        evidenceHash: sha256(`${sha256(token)}:${sha256("204")}`),
      }),
    );
  });

  it("keeps revocation pending after an ambiguous provider response so a later worker can retry", async () => {
    const ledger = ledgerFixture([]);
    const provider = {
      revoke: vi
        .fn()
        .mockRejectedValueOnce(new Error("response lost"))
        .mockResolvedValueOnce({
          evidenceHash: sha256("401"),
          receipt: {
            authority: "github_token_delete" as const,
            result: "already_invalid" as const,
          },
        }),
    };
    const reconciler = new HostedCommentTokenClosureReconciler({
      ledger,
      provider,
      now: () => now,
      ownerIdHash: sha256("worker"),
      vault: { open: vi.fn(async () => Buffer.from(token)), seal: vi.fn() },
    });

    await expect(reconciler.reconcile()).resolves.toEqual({
      claimed: 1,
      revoked: 0,
      deferred: 1,
    });
    expect(ledger.releaseRevocation).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "provider_revoke_ambiguous" }),
    );
    await expect(reconciler.reconcile()).resolves.toEqual({
      claimed: 1,
      revoked: 1,
      deferred: 0,
    });
    expect(provider.revoke).toHaveBeenCalledTimes(2);
  });

  it("continues a bounded batch when the first row continually fails", async () => {
    const first = claim();
    const second = {
      ...claim(),
      mintId: "mint-2",
      tokenHash: sha256("second-token"),
      secretEnvelope: {
        ...claim().secretEnvelope,
        ciphertext: Buffer.from("second-token"),
      },
    };
    const ledger = ledgerFixture([]);
    ledger.claimRevocations = vi.fn(async () => [first, second]);
    const provider = {
      revoke: vi.fn(async () => ({
        evidenceHash: sha256("204"),
        receipt: {
          authority: "github_token_delete" as const,
          result: "revoked" as const,
        },
      })),
    };
    const reconciler = new HostedCommentTokenClosureReconciler({
      ledger,
      provider,
      batchSize: 2,
      now: () => now,
      vault: {
        seal: vi.fn(),
        open: vi.fn(async ({ mintId }) => {
          if (mintId === first.mintId) throw new Error("undecryptable");
          return Buffer.from("second-token");
        }),
      },
    });

    await expect(reconciler.reconcile()).resolves.toEqual({
      claimed: 2,
      revoked: 1,
      deferred: 1,
    });
    expect(provider.revoke).toHaveBeenCalledOnce();
    expect(ledger.finalizeRevoked).toHaveBeenCalledWith(
      expect.objectContaining({ mintId: "mint-2" }),
    );
  });

  it("cancels a hung vault open, persists backoff, and continues later claims", async () => {
    const first = claim();
    const secondToken = "second-token";
    const second = {
      ...claim(),
      mintId: "mint-after-vault-timeout",
      tokenHash: sha256(secondToken),
      secretEnvelope: {
        ...claim().secretEnvelope,
        ciphertext: Buffer.from(secondToken),
      },
    };
    const ledger = ledgerFixture([]);
    ledger.claimRevocations = vi.fn(async () => [first, second]);
    const observedSignals: AbortSignal[] = [];
    const provider = {
      revoke: vi.fn(async () => ({
        evidenceHash: sha256("204"),
        receipt: {
          authority: "github_token_delete" as const,
          result: "revoked" as const,
        },
      })),
    };
    const reconciler = new HostedCommentTokenClosureReconciler({
      ledger,
      provider,
      batchSize: 2,
      providerTimeoutMs: 5,
      now: () => now,
      vault: {
        seal: vi.fn(),
        open: vi.fn(({ mintId, signal }) => {
          if (mintId !== first.mintId)
            return Promise.resolve(Buffer.from(secondToken));
          observedSignals.push(signal!);
          return new Promise<Uint8Array>((_resolve, reject) => {
            signal!.addEventListener(
              "abort",
              () =>
                reject(
                  new Error("credential_decryption_failed", {
                    cause: new DOMException("aborted", "AbortError"),
                  }),
                ),
              { once: true },
            );
          });
        }),
      },
    });

    await expect(reconciler.reconcile()).resolves.toEqual({
      claimed: 2,
      revoked: 1,
      deferred: 1,
    });
    expect(observedSignals).toHaveLength(1);
    expect(observedSignals[0]!.aborted).toBe(true);
    expect(ledger.releaseRevocation).toHaveBeenCalledWith(
      expect.objectContaining({
        mintId: first.mintId,
        errorCode: "custody_or_provider_timeout",
      }),
    );
    expect(ledger.finalizeRevoked).toHaveBeenCalledWith(
      expect.objectContaining({ mintId: second.mintId }),
    );
  });

  it("never sends a bearer whose decrypted secret does not match durable token evidence", async () => {
    const ledger = ledgerFixture([]);
    const provider = { revoke: vi.fn() };
    const reconciler = new HostedCommentTokenClosureReconciler({
      ledger,
      provider,
      now: () => now,
      ownerIdHash: sha256("worker"),
      vault: {
        open: vi.fn(async () => Buffer.from("wrong-token")),
        seal: vi.fn(),
      },
    });

    await expect(reconciler.reconcile()).resolves.toEqual({
      claimed: 1,
      revoked: 0,
      deferred: 1,
    });
    expect(provider.revoke).not.toHaveBeenCalled();
    expect(ledger.releaseRevocation).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "revocation_secret_hash_mismatch" }),
    );
  });

  it("zeroes claimed envelope buffers after provider and persistence failures", async () => {
    const claimed = claim();
    const opened = Buffer.from(token);
    const ledger = ledgerFixture([]);
    ledger.claimRevocations = vi.fn(async () => [claimed]);
    ledger.releaseRevocation = vi
      .fn()
      .mockRejectedValue(new Error("db failed"));
    const reconciler = new HostedCommentTokenClosureReconciler({
      ledger,
      provider: { revoke: vi.fn().mockRejectedValue(new Error("lost")) },
      now: () => now,
      ownerIdHash: sha256("worker"),
      vault: { open: vi.fn(async () => opened), seal: vi.fn() },
    });

    await expect(reconciler.reconcile()).rejects.toThrow(
      "hosted_comment_token_revocation_release_failed",
    );
    for (const value of [
      claimed.secretEnvelope.ciphertext,
      claimed.secretEnvelope.encryptedDataKey,
      claimed.secretEnvelope.iv,
      claimed.secretEnvelope.authTag,
    ])
      expect(Array.from(value)).toEqual(Array(value.byteLength).fill(0));
    expect(Array.from(opened)).toEqual(Array(opened.byteLength).fill(0));
  });

  it("zeroes ledger-owned envelope copies when persistence fails", async () => {
    const fromSpy = vi.spyOn(Buffer, "from");
    const ledger = new PrismaHostedCommentTokenMintLedger({
      $transaction: async (operation: (transaction: unknown) => unknown) =>
        operation({
          $queryRaw: vi
            .fn()
            .mockResolvedValueOnce([{ now }])
            .mockResolvedValueOnce([{ locked: true }])
            .mockRejectedValueOnce(new Error("persistence failed")),
          hostedCodexCommentTokenMint: {
            findUnique: vi.fn().mockResolvedValue({
              state: "dispatching",
              unsafeUntil: new Date("2026-08-25T13:01:00.000Z"),
            }),
          },
        }),
    } as never);
    const callerEnvelope = claim().secretEnvelope;
    const ownedCopyStart = fromSpy.mock.results.length;
    await expect(
      ledger.stageRevocation({
        mintId: "mint-1",
        tokenHash: sha256(token),
        tokenExpiresAt: new Date("2026-08-25T13:00:00.000Z"),
        secretEnvelope: callerEnvelope,
        now,
        errorCode: "capture",
      }),
    ).rejects.toThrow("persistence failed");
    const ledgerOwnedCopies = fromSpy.mock.results
      .slice(ownedCopyStart, ownedCopyStart + 4)
      .map((result) => result.value as Buffer);
    expect(ledgerOwnedCopies).toHaveLength(4);
    for (const value of ledgerOwnedCopies)
      expect(Array.from(value)).toEqual(Array(value.byteLength).fill(0));
    expect(Array.from(callerEnvelope.ciphertext)).not.toEqual(
      Array(callerEnvelope.ciphertext.byteLength).fill(0),
    );
    fromSpy.mockRestore();
  });

  it("uses a bounded batch lease and exposes bounded degraded health", async () => {
    vi.useFakeTimers();
    const ledger = ledgerFixture([]);
    ledger.claimRevocations = vi.fn().mockRejectedValue(new Error("db down"));
    const reconciler = new HostedCommentTokenClosureReconciler({
      ledger,
      provider: { revoke: vi.fn() },
      now: () => now,
      providerTimeoutMs: 15_000,
      leaseMs: 1_000,
      vault: { open: vi.fn(), seal: vi.fn() },
    });
    const handle = startHostedCommentTokenClosureReconciler(reconciler, 10);
    try {
      await vi.waitFor(() =>
        expect(ledger.claimRevocations).toHaveBeenCalledTimes(1),
      );
      await vi.advanceTimersByTimeAsync(20);
      await vi.advanceTimersByTimeAsync(40);
      await vi.waitFor(() =>
        expect(
          handle.health().metrics.consecutiveFailures,
        ).toBeGreaterThanOrEqual(3),
      );
      expect(handle.health()).toMatchObject({ status: "degraded" });
      expect(ledger.claimRevocations).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: 4,
          leaseExpiresAt: new Date(now.getTime() + 125_000),
        }),
      );
    } finally {
      handle();
      vi.useRealTimers();
    }
  });

  it("fails readiness closed before the first successful pass and after one degraded pass", async () => {
    vi.useFakeTimers();
    const ledger = ledgerFixture([]);
    ledger.claimRevocations = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockRejectedValue(new Error("db down"));
    const reconciler = new HostedCommentTokenClosureReconciler({
      ledger,
      provider: { revoke: vi.fn() },
      now: () => now,
      vault: { open: vi.fn(), seal: vi.fn() },
    });
    const handle = startHostedCommentTokenClosureReconciler(reconciler, 10);
    try {
      expect(handle.health()).toMatchObject({
        ready: false,
        status: "degraded",
        reason: "initial_reconcile_pending",
      });
      await vi.waitFor(() =>
        expect(handle.health().metrics.successes).toBe(1),
      );
      expect(handle.health()).toMatchObject({
        ready: true,
        status: "ok",
        reason: "ready",
      });

      await vi.advanceTimersByTimeAsync(10);
      await vi.waitFor(() =>
        expect(handle.health().metrics.consecutiveFailures).toBe(1),
      );
      expect(handle.health()).toMatchObject({
        ready: false,
        status: "degraded",
        reason: "reconcile_failed",
      });
    } finally {
      await handle();
      vi.useRealTimers();
    }
  });

  it("marks an overdue active run unhealthy instead of reporting false OK", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const blocked = new Promise<number>((resolve) => {
      release = () => resolve(0);
    });
    const ledger = ledgerFixture([]);
    ledger.recoverStale = vi.fn(async () => blocked);
    const reconciler = new HostedCommentTokenClosureReconciler({
      ledger,
      provider: { revoke: vi.fn() },
      now: () => now,
      vault: { open: vi.fn(), seal: vi.fn() },
    });
    const handle = startHostedCommentTokenClosureReconciler(reconciler, 10);
    try {
      await vi.waitFor(() =>
        expect(handle.health().metrics.running).toBe(true),
      );
      await vi.advanceTimersByTimeAsync(125_001);
      expect(handle.health()).toMatchObject({
        status: "degraded",
        metrics: { running: true, overdue: true },
      });
      release();
      await handle();
      expect(handle.health().metrics.running).toBe(false);
    } finally {
      release();
      await handle();
      vi.useRealTimers();
    }
  });

  it("lets shutdown settle when a vault ignores abort and zeroes its envelope", async () => {
    vi.useFakeTimers();
    const ledger = ledgerFixture([]);
    const vaultOpen = vi.fn(
      (input: Parameters<HostedCommentTokenSecretVaultPort["open"]>[0]) => {
        void input;
        return new Promise<never>(() => undefined);
      },
    );
    const reconciler = new HostedCommentTokenClosureReconciler({
      ledger,
      provider: { revoke: vi.fn() },
      now: () => now,
      providerTimeoutMs: 10,
      vault: { open: vaultOpen, seal: vi.fn() },
    });
    const handle = startHostedCommentTokenClosureReconciler(reconciler, 10);
    try {
      await vi.waitFor(() => expect(vaultOpen).toHaveBeenCalledTimes(1));
      const openedEnvelope = vaultOpen.mock.calls[0]![0].envelope;
      const shutdown = handle();
      await vi.advanceTimersByTimeAsync(11);
      await expect(shutdown).resolves.toBeUndefined();
      expect(openedEnvelope.ciphertext).toEqual(
        Buffer.alloc(openedEnvelope.ciphertext.byteLength),
      );
      expect(handle.health()).toMatchObject({
        ready: false,
        status: "degraded",
        reason: "reconcile_failed",
        metrics: { successes: 0, running: false },
      });
    } finally {
      await handle();
      vi.useRealTimers();
    }
  });

  it("prevents a second replica from claiming while a slow provider call remains inside its bounded lease", async () => {
    let claimedBy: string | undefined;
    let releaseProvider!: () => void;
    const providerBarrier = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const ledger = ledgerFixture([]);
    ledger.claimRevocations = vi.fn(async ({ ownerIdHash, leaseExpiresAt }) => {
      expect(leaseExpiresAt.getTime() - now.getTime()).toBeGreaterThanOrEqual(
        25_000,
      );
      if (claimedBy) return [];
      claimedBy = ownerIdHash;
      return [claim()];
    });
    ledger.finalizeRevoked = vi.fn(async () => {
      claimedBy = undefined;
    });
    const provider = {
      revoke: vi.fn(async () => {
        await providerBarrier;
        return {
          evidenceHash: sha256("receipt"),
          receipt: {
            authority: "github_token_delete" as const,
            result: "revoked" as const,
          },
        };
      }),
    };
    const dependencies = {
      ledger,
      provider,
      now: () => now,
      leaseMs: 1_000,
      providerTimeoutMs: 20_000,
      vault: { open: vi.fn(async () => Buffer.from(token)), seal: vi.fn() },
    };
    const replicaA = new HostedCommentTokenClosureReconciler({
      ...dependencies,
      ownerIdHash: sha256("replica-a"),
    });
    const replicaB = new HostedCommentTokenClosureReconciler({
      ...dependencies,
      ownerIdHash: sha256("replica-b"),
    });

    const slowRevoke = replicaA.reconcile();
    await vi.waitFor(() => expect(provider.revoke).toHaveBeenCalledTimes(1));
    await expect(replicaB.reconcile()).resolves.toEqual({
      claimed: 0,
      revoked: 0,
      deferred: 0,
    });
    releaseProvider();
    await expect(slowRevoke).resolves.toEqual({
      claimed: 1,
      revoked: 1,
      deferred: 0,
    });
    expect(provider.revoke).toHaveBeenCalledTimes(1);
  });
});

function claim(): HostedCommentTokenRevocationClaim {
  return {
    mintId: "mint-1",
    ownerIdHash: sha256("worker"),
    fenceEpoch: 3n,
    tokenHash: sha256(token),
    tokenExpiresAt: new Date("2026-08-25T13:00:00.000Z"),
    repositoryFullName: "acme/private",
    workspaceId: "workspace-1",
    poolId: "pool-1",
    secretEnvelope: {
      ciphertext: Buffer.from("ciphertext"),
      encryptedDataKey: Buffer.from("key"),
      iv: Buffer.from("iv"),
      authTag: Buffer.from("tag"),
      keyId: "key-1",
      aadHash: "a".repeat(64),
    },
  };
}

function ledgerFixture(
  calls: string[],
): HostedCommentTokenMintLedgerPort & Record<string, ReturnType<typeof vi.fn>> {
  return {
    recoverStale: vi.fn(async () => 0),
    claimRevocations: vi.fn(async () => {
      calls.push("claim-commit");
      return [claim()];
    }),
    finalizeRevoked: vi.fn(async () => {
      calls.push("finalize");
    }),
    releaseRevocation: vi.fn(async () => {
      calls.push("release");
    }),
  } as never;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
