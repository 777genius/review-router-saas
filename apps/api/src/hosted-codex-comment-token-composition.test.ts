import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitHubAppCommentTokenIssuerPort } from "@reviewrouter/features-action-control-plane";
import type {
  HostedCommentTokenMintLedgerPort,
  PreparedHostedCommentTokenMint,
} from "@reviewrouter/features-hosted-account-pool";
import {
  HostedCommentTokenClosureReconciler,
  hostedCommentTokenDelivery,
} from "@reviewrouter/features-hosted-account-pool";
import {
  HostedCodexCommentTokenIssuer,
  HostedCommentTokenEnvelopeVault,
} from "./hosted-codex-comment-token-composition";

const instant = new Date("2026-08-25T12:00:00.000Z");
const request = {
  opaqueRefreshCapability: "c".repeat(43),
  idempotencyKey: "refresh-1",
  invocationLeaseId: "grant-1",
  bindingId: "binding-1",
  bindingVersion: 7,
};

describe("HostedCodexCommentTokenIssuer durable protocol", () => {
  afterEach(() => vi.useRealTimers());

  it("prepares, commits dispatch before network I/O, and finalizes success", async () => {
    const calls: string[] = [];
    const gate = gateFixture(calls);
    const provider = providerFixture(calls);
    const result = await issuer(gate, provider).issue(request);
    expect(result).toMatchObject({
      token: "github-token",
      repository: "acme/repo",
      expiresAt: "2026-08-25T13:00:00.000Z",
    });
    expect(calls).toEqual([
      "prepare",
      "dispatch",
      "confirm",
      "network",
      "success",
    ]);
  });

  it("replays the stable attempt without consuming or minting again", async () => {
    const gate = gateFixture([]);
    gate.prepare = vi
      .fn()
      .mockResolvedValue({ mintId: "same", state: "issued" });
    gate.replayAuthorized = vi.fn().mockResolvedValue({
      tokenHash: createHash("sha256").update("github-token").digest("hex"),
      tokenExpiresAt: new Date("2026-08-25T13:00:00.000Z"),
      repositoryFullName: "acme/repo",
      workspaceId: "workspace-1",
      poolId: "pool-1",
      secretEnvelope: {
        ciphertext: Buffer.from("github-token"),
        encryptedDataKey: Buffer.from("key"),
        iv: Buffer.from("iv"),
        authTag: Buffer.from("tag"),
        keyId: "key-1",
        aadHash: "a".repeat(64),
      },
    });
    const provider = providerFixture([]);
    await expect(issuer(gate, provider).issue(request)).resolves.toMatchObject({
      token: "github-token",
      repository: "acme/repo",
    });
    expect(provider.issueCommentToken).not.toHaveBeenCalled();
  });

  it("bounds a replay vault that ignores abort and zeroes the loaded envelope", async () => {
    vi.useFakeTimers();
    const gate = gateFixture([]);
    gate.prepare = vi
      .fn()
      .mockResolvedValue({ mintId: "same", state: "issued" });
    const envelope = testEnvelope("github-token");
    gate.replayAuthorized = vi.fn().mockResolvedValue({
      tokenHash: createHash("sha256").update("github-token").digest("hex"),
      tokenExpiresAt: new Date("2026-08-25T13:00:00.000Z"),
      repositoryFullName: "acme/repo",
      workspaceId: "workspace-1",
      poolId: "pool-1",
      secretEnvelope: envelope,
    });
    let replaySignal: AbortSignal | undefined;
    const vault = {
      prepareSeal: vi.fn(),
      seal: vi.fn(),
      open: vi.fn(({ signal }: { signal?: AbortSignal }) => {
        replaySignal = signal;
        return new Promise<never>(() => undefined);
      }),
    };

    const pending = issuer(gate, providerFixture([]), vault).issue(request);
    const rejected = expect(pending).rejects.toThrow(
      "hosted_codex_custody_timeout",
    );
    await vi.waitFor(() => expect(vault.open).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(15_001);

    await rejected;
    expect(replaySignal?.aborted).toBe(true);
    expectZeroEnvelope(envelope);
  });

  it("rejects replay when the opened envelope does not match durable token evidence", async () => {
    const gate = gateFixture([]);
    gate.prepare = vi
      .fn()
      .mockResolvedValue({ mintId: "same", state: "issued" });
    const envelope = {
      ciphertext: Buffer.from("github-token"),
      encryptedDataKey: Buffer.from("key"),
      iv: Buffer.from("iv"),
      authTag: Buffer.from("tag"),
      keyId: "key-1",
      aadHash: "a".repeat(64),
    };
    gate.replayAuthorized = vi.fn().mockResolvedValue({
      tokenHash: "f".repeat(64),
      tokenExpiresAt: new Date("2026-08-25T13:00:00.000Z"),
      repositoryFullName: "acme/repo",
      workspaceId: "workspace-1",
      poolId: "pool-1",
      secretEnvelope: envelope,
    });
    const provider = providerFixture([]);
    await expect(issuer(gate, provider).issue(request)).rejects.toThrow(
      "hosted_comment_mint_replay_secret_hash_mismatch",
    );
    expect(provider.issueCommentToken).not.toHaveBeenCalled();
    expectZeroEnvelope(envelope);
  });

  it("rechecks authority after a paused vault decrypt before replay delivery", async () => {
    const gate = gateFixture([]);
    gate.prepare = vi
      .fn()
      .mockResolvedValue({ mintId: "same", state: "issued" });
    const envelope = testEnvelope("github-token");
    gate.replayAuthorized = vi.fn().mockResolvedValue({
      tokenHash: createHash("sha256").update("github-token").digest("hex"),
      tokenExpiresAt: new Date("2026-08-25T13:00:00.000Z"),
      repositoryFullName: "acme/repo",
      workspaceId: "workspace-1",
      poolId: "pool-1",
      secretEnvelope: envelope,
    });
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const vault = {
      prepareSeal: vi.fn(),
      seal: vi.fn(),
      open: vi.fn(async () => {
        await paused;
        return Buffer.from("github-token");
      }),
    };
    gate.confirmReplayDelivery = vi
      .fn()
      .mockRejectedValue(new Error("authority closed during decrypt"));
    const pending = issuer(gate, providerFixture([]), vault).issue(request);
    await vi.waitFor(() => expect(vault.open).toHaveBeenCalledOnce());
    resume();

    await expect(pending).rejects.toThrow("authority closed during decrypt");
    expect(gate.confirmReplayDelivery).toHaveBeenCalledOnce();
    expectZeroEnvelope(envelope);
  });

  it("holds and releases the durable delivery claim at the response boundary", async () => {
    const gate = gateFixture([]);
    const result = await issuer(gate, providerFixture([])).issue(request);
    expect(gate.confirmReplayDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        mintId: "comment-mint-stable",
        tokenHash: createHash("sha256").update("github-token").digest("hex"),
        deliveryClaimIdHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    );
    await result[hostedCommentTokenDelivery]?.();
    expect(gate.releaseDelivery).toHaveBeenCalledOnce();
  });

  it("keeps a post-dispatch provider rejection conservatively ambiguous", async () => {
    const gate = gateFixture([]);
    const error = Object.assign(new Error("rejected"), { effect: "none" });
    const provider = providerFixture([]);
    vi.mocked(provider.issueCommentToken).mockRejectedValue(error);
    await expect(issuer(gate, provider).issue(request)).rejects.toThrow(
      "hosted_comment_mint_ambiguous",
    );
    expect(gate.finalizeOutcomeUnknown).toHaveBeenCalledOnce();
  });

  it("refuses a delayed dispatch before provider POST", async () => {
    const gate = gateFixture([]);
    gate.confirmDispatch = vi
      .fn()
      .mockRejectedValue(
        new Error("hosted_comment_mint_dispatch_authorization_expired"),
      );
    const provider = providerFixture([]);
    await expect(issuer(gate, provider).issue(request)).rejects.toThrow(
      "hosted_comment_mint_ambiguous",
    );
    expect(provider.issueCommentToken).not.toHaveBeenCalled();
    expect(gate.finalizeOutcomeUnknown).toHaveBeenCalledOnce();
  });

  it("releases a prepared attempt after a pre-network authentication failure", async () => {
    const gate = gateFixture([]);
    const provider = providerFixture([]);
    provider.prepareCommentToken = vi
      .fn()
      .mockRejectedValue(new Error("app auth unavailable"));
    await expect(issuer(gate, provider).issue(request)).rejects.toThrow(
      "hosted_comment_mint_preflight_failed",
    );
    expect(provider.issueCommentToken).not.toHaveBeenCalled();
    expect(gate.authorizeDispatch).not.toHaveBeenCalled();
    expect(gate.releasePrepared).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "provider_preflight_failed" }),
    );
    expect(gate.finalizeOutcomeUnknown).not.toHaveBeenCalled();
  });

  it("poisons an indeterminate external result instead of retrying", async () => {
    const gate = gateFixture([]);
    const provider = providerFixture([]);
    vi.mocked(provider.issueCommentToken).mockRejectedValue(
      new Error("socket reset"),
    );
    await expect(issuer(gate, provider).issue(request)).rejects.toThrow(
      "hosted_comment_mint_ambiguous",
    );
    expect(gate.finalizeOutcomeUnknown).toHaveBeenCalledOnce();
    expect(provider.issueCommentToken).toHaveBeenCalledOnce();
  });

  it("records an aborted provider deadline as ambiguous and never sends a second POST", async () => {
    vi.useFakeTimers();
    const gate = gateFixture([]);
    const provider = providerFixture([]);
    provider.issueCommentToken = vi.fn(
      async ({ signal }: { signal?: AbortSignal }) =>
        await new Promise<never>((_resolve, reject) =>
          signal?.addEventListener(
            "abort",
            () =>
              reject(
                Object.assign(new Error("deadline"), { name: "AbortError" }),
              ),
            { once: true },
          ),
        ),
    );
    const result = expect(
      issuer(gate, provider).issue(request),
    ).rejects.toThrow("hosted_comment_mint_timeout");
    await vi.advanceTimersByTimeAsync(15_000);
    await result;
    expect(gate.finalizeOutcomeUnknown).toHaveBeenCalledOnce();
    expect(provider.issueCommentToken).toHaveBeenCalledOnce();
  });

  it.each(["dispatching", "outcome_unknown"] as const)(
    "keeps a restarted %s crash barrier fail-closed without a second POST or token delivery",
    async (state) => {
      const restartedLedger = gateFixture([]);
      restartedLedger.prepare = vi.fn(async () => ({
        mintId: "comment-mint-stable",
        state,
      }));
      const provider = providerFixture([]);

      await expect(
        issuer(restartedLedger, provider).issue(request),
      ).rejects.toThrow(`hosted_comment_mint_${state}`);

      expect(provider.prepareCommentToken).not.toHaveBeenCalled();
      expect(provider.issueCommentToken).not.toHaveBeenCalled();
      expect(provider.revokeCommentToken).not.toHaveBeenCalled();
      expect(restartedLedger.finalizeKnownToken).not.toHaveBeenCalled();
    },
  );

  it("resolves finalize commit acknowledgement loss by observation without revoking or reposting", async () => {
    const gate = gateFixture([]);
    gate.finalizeKnownToken = vi
      .fn()
      .mockRejectedValue(new Error("commit ack lost"));
    gate.observe = vi.fn().mockResolvedValue({
      state: "issued",
      tokenHash: createHash("sha256").update("github-token").digest("hex"),
    });
    const provider = providerFixture([]);
    await expect(issuer(gate, provider).issue(request)).resolves.toMatchObject({
      token: "github-token",
    });
    expect(provider.issueCommentToken).toHaveBeenCalledOnce();
    expect(provider.revokeCommentToken).not.toHaveBeenCalled();
  });

  it("revokes and withholds the token when finalize commit cannot be proven", async () => {
    const gate = gateFixture([]);
    gate.finalizeKnownToken = vi
      .fn()
      .mockRejectedValue(new Error("commit result unavailable"));
    gate.observe = vi.fn().mockResolvedValue(null);
    const provider = providerFixture([]);
    await expect(issuer(gate, provider).issue(request)).rejects.toThrow(
      "hosted_comment_mint_finalize_ambiguous",
    );
    expect(provider.issueCommentToken).toHaveBeenCalledOnce();
    expect(provider.revokeCommentToken).toHaveBeenCalledOnce();
    expect(gate.stageRevocation).toHaveBeenCalledOnce();
    expect(gate.finalizeRevoked).toHaveBeenCalledOnce();
  });

  it("zeroes the captured envelope after a persistence ambiguity", async () => {
    const gate = gateFixture([]);
    gate.finalizeKnownToken = vi.fn().mockRejectedValue(new Error("db failed"));
    gate.observe = vi.fn().mockResolvedValue(null);
    const envelope = testEnvelope("github-token");
    await expect(
      issuer(gate, providerFixture([]), {
        prepareSeal: vi.fn(async () => ({
          capture: () => envelope,
          destroy: vi.fn(),
        })),
        seal: vi.fn(async () => envelope),
        open: vi.fn(),
      }).issue(request),
    ).rejects.toThrow("hosted_comment_mint_finalize_ambiguous");
    expectZeroEnvelope(envelope);
  });

  it("zeroes vault plaintext and loaded envelope buffers in finally", async () => {
    let sealPlaintext: Uint8Array | undefined;
    const failingVault = new HostedCommentTokenEnvelopeVault(
      {
        encrypt: vi.fn(async (plaintext: Uint8Array) => {
          sealPlaintext = plaintext;
          throw new Error("kms failed");
        }),
      } as never,
      "incarnation",
      "resource",
    );
    await expect(
      failingVault.seal({
        mintId: "mint",
        workspaceId: "workspace",
        poolId: "pool",
        token: "plaintext-token",
      }),
    ).rejects.toThrow("kms failed");
    expect(Array.from(sealPlaintext ?? [])).toEqual(
      Array("plaintext-token".length).fill(0),
    );

    const plaintext = Buffer.from("plaintext-token");
    const loadingVault = new HostedCommentTokenEnvelopeVault(
      { decrypt: vi.fn(async () => plaintext) } as never,
      "incarnation",
      "resource",
    );
    const envelope = {
      ciphertext: Buffer.from("ciphertext"),
      encryptedDataKey: Buffer.from(
        JSON.stringify({
          keyId: "key",
          nonce: "nonce",
          ciphertext: "wrapped",
          authenticationTag: "tag",
        }),
      ),
      iv: Buffer.from("iv"),
      authTag: Buffer.from("tag"),
      keyId: "key",
      aadHash: "a".repeat(64),
    };
    await expect(
      loadingVault.open({
        mintId: "mint",
        workspaceId: "workspace",
        poolId: "pool",
        envelope,
      }),
    ).resolves.toEqual(Buffer.from("plaintext-token"));
    expect(Array.from(plaintext)).toEqual(
      Array("plaintext-token".length).fill(0),
    );
    expectZeroEnvelope(envelope);
  });

  it("revokes a remotely minted token when exact authority changed before finalize", async () => {
    const gate = gateFixture([]);
    gate.finalizeKnownToken = vi.fn().mockResolvedValue("revoke_pending");
    const provider = providerFixture([]);
    await expect(issuer(gate, provider).issue(request)).rejects.toThrow(
      "hosted_comment_mint_finalize_conflict",
    );
    expect(provider.revokeCommentToken).toHaveBeenCalledWith(
      expect.objectContaining({ token: "github-token" }),
    );
    expect(gate.finalizeRevoked).toHaveBeenCalledOnce();
  });

  it.each([403, 503])(
    "retains durable reconciliation ownership after unacceptable 201 and DELETE %i",
    async (deleteStatus) => {
      const gate = gateFixture([]);
      const provider = providerFixture([]);
      const expiresAt = new Date("2026-08-25T14:00:00.000Z");
      provider.issueCommentToken = vi.fn(async () => ({
        token: "known-unacceptable-bearer",
        repository: "acme/repo",
        expiresAt,
        permissions: {
          contents: "read" as const,
          pullRequests: "write" as const,
          issues: "write" as const,
          statuses: "write" as const,
        },
        custody: "unacceptable" as const,
        custodyReason: "repository_inventory_mismatch",
      }));
      provider.revokeCommentToken = vi
        .fn()
        .mockRejectedValue(
          new Error(`comment_token_revoke_failed:${deleteStatus}`),
        );

      await expect(issuer(gate, provider).issue(request)).rejects.toThrow(
        "hosted_comment_mint_unacceptable_provider_response",
      );
      expect(gate.stageRevocation).toHaveBeenCalledWith(
        expect.objectContaining({
          tokenHash: createHash("sha256")
            .update("known-unacceptable-bearer")
            .digest("hex"),
          tokenExpiresAt: expiresAt,
        }),
      );
      expect(provider.revokeCommentToken).toHaveBeenCalledWith(
        expect.objectContaining({ token: "known-unacceptable-bearer" }),
      );
      expect(gate.finalizeKnownToken).not.toHaveBeenCalled();
      expect(gate.finalizeOutcomeUnknown).toHaveBeenCalledWith(
        expect.objectContaining({
          mintId: "comment-mint-stable",
          errorCode: "minted_unacceptable:repository_inventory_mismatch",
        }),
      );
    },
  );

  it("restarts after DELETE 503 and revokes the exact durably captured bearer", async () => {
    const gate = gateFixture([]);
    const provider = providerFixture([]);
    const bearer = "restart-exact-known-bearer";
    provider.issueCommentToken = vi.fn(async () => ({
      token: bearer,
      repository: "acme/repo",
      expiresAt: new Date("2026-08-25T13:00:00.000Z"),
      permissions: {
        contents: "read" as const,
        pullRequests: "write" as const,
        issues: "write" as const,
        statuses: "write" as const,
      },
      custody: "unacceptable" as const,
      custodyReason: "repository_inventory_mismatch",
    }));
    provider.revokeCommentToken = vi
      .fn()
      .mockRejectedValue(new Error("DELETE 503"));
    let durableEnvelope: ReturnType<typeof testEnvelope> | undefined;
    gate.stageRevocation = vi.fn(async ({ secretEnvelope }) => {
      durableEnvelope = {
        ciphertext: Buffer.from(secretEnvelope!.ciphertext),
        encryptedDataKey: Buffer.from(secretEnvelope!.encryptedDataKey),
        iv: Buffer.from(secretEnvelope!.iv),
        authTag: Buffer.from(secretEnvelope!.authTag),
        keyId: secretEnvelope!.keyId,
        aadHash: secretEnvelope!.aadHash,
      };
    });

    await expect(
      issuer(gate, provider, {
        prepareSeal: vi.fn(async () => ({
          capture: (token: string) => testEnvelope(token),
          destroy: vi.fn(),
        })),
        seal: vi.fn().mockRejectedValue(new Error("seal unavailable")),
        open: vi.fn(),
      }).issue(request),
    ).rejects.toThrow("hosted_comment_mint_unacceptable_provider_response");
    expect(durableEnvelope).toBeDefined();

    const restartedLedger = gateFixture([]);
    restartedLedger.claimRevocations = vi.fn(async () => [
      {
        mintId: "comment-mint-stable",
        ownerIdHash: "d".repeat(64),
        fenceEpoch: 2n,
        tokenHash: createHash("sha256").update(bearer).digest("hex"),
        tokenExpiresAt: new Date("2026-08-25T13:00:00.000Z"),
        repositoryFullName: "acme/repo",
        workspaceId: "workspace-1",
        poolId: "pool-1",
        secretEnvelope: durableEnvelope!,
      },
    ]);
    const restartRevoke = vi.fn(async ({ token }: { token: string }) => {
      expect(token).toBe(bearer);
      return {
        evidenceHash: "e".repeat(64),
        receipt: {
          authority: "github_token_delete" as const,
          result: "revoked" as const,
        },
      };
    });
    const reconciler = new HostedCommentTokenClosureReconciler({
      ledger: restartedLedger,
      vault: {
        seal: vi.fn(),
        open: vi.fn(async ({ envelope }) => Buffer.from(envelope.ciphertext)),
      },
      provider: { revoke: restartRevoke },
      now: () => instant,
      batchSize: 1,
    });
    await expect(reconciler.reconcile()).resolves.toMatchObject({ revoked: 1 });
    expect(restartRevoke).toHaveBeenCalledOnce();
  });

  it("fails wrapping before POST so a seal outage can never lose a bearer", async () => {
    const gate = gateFixture([]);
    const provider = providerFixture([]);
    const durableIssuer = issuer(gate, provider, {
      prepareSeal: vi.fn().mockRejectedValue(new Error("kms unavailable")),
      seal: vi.fn().mockRejectedValue(new Error("kms unavailable")),
      open: vi.fn(),
    });
    await expect(durableIssuer.issue(request)).rejects.toThrow(
      "hosted_comment_mint_capture_preflight_failed",
    );
    expect(provider.issueCommentToken).not.toHaveBeenCalled();
    expect(provider.revokeCommentToken).not.toHaveBeenCalled();
    expect(gate.stageRevocation).not.toHaveBeenCalled();
    expect(gate.releasePrepared).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "capture_preflight_failed" }),
    );
  });

  it("reuses a reclaimed prepared attempt after a pre-dispatch crash", async () => {
    const calls: string[] = [];
    const gate = gateFixture(calls);
    const stable = prepared();
    gate.prepare = vi.fn().mockResolvedValue(stable);
    await issuer(gate, providerFixture(calls)).issue(request);
    expect(gate.prepare).toHaveBeenCalledOnce();
    expect(gate.authorizeDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ mintId: stable.mintId }),
    );
  });

  it("uses the same durable protocol for initial issuance without a refresh capability", async () => {
    const gate = gateFixture([]);
    await issuer(gate, providerFixture([])).issueInitial({
      grantId: "grant-initial",
      bindingId: "binding-1",
      bindingVersion: 7,
      invocationIdentity: "invocation-initial",
    });
    expect(gate.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: "initial",
        grantId: "grant-initial",
        bindingId: "binding-1",
      }),
    );
    const input = vi.mocked(gate.prepare).mock.calls[0]?.[0];
    expect(input).not.toHaveProperty("presentedTokenHash");
    expect(input).not.toHaveProperty("requestIdHash");
  });
});

function prepared(): PreparedHostedCommentTokenMint {
  return {
    mintId: "comment-mint-stable",
    state: "prepared",
    fenceEpoch: 1n,
    runtimeAuthzEpoch: 9n,
    runtimeGateRevision: 4n,
    githubInstallationId: "11",
    githubRepositoryId: "22",
    repositoryFullName: "acme/repo",
    workspaceId: "workspace-1",
    poolId: "pool-1",
  };
}

function gateFixture(
  calls: string[],
): HostedCommentTokenMintLedgerPort & Record<string, ReturnType<typeof vi.fn>> {
  return {
    recoverStale: vi.fn(async () => 0),
    prepare: vi.fn(async () => {
      calls.push("prepare");
      return prepared();
    }),
    authorizeDispatch: vi.fn(async () => {
      calls.push("dispatch");
    }),
    releasePrepared: vi.fn(async () => undefined),
    confirmDispatch: vi.fn(async () => {
      calls.push("confirm");
      return {
        sendAuthorizedUntil: new Date("2026-08-25T12:00:15.000Z"),
        remainingBudgetMs: 15_000,
      };
    }),
    replayAuthorized: vi.fn(async () => {
      throw new Error("hosted_comment_mint_replay_not_authorized");
    }),
    confirmReplayDelivery: vi.fn(async () => undefined),
    releaseDelivery: vi.fn(async () => undefined),
    finalizeKnownToken: vi.fn(async () => {
      calls.push("success");
      return "issued" as const;
    }),
    stageRevocation: vi.fn(async () => {
      calls.push("revoke-pending");
    }),
    finalizeOutcomeUnknown: vi.fn(async () => {
      calls.push("ambiguous");
    }),
    finalizeRevoked: vi.fn(async () => {
      calls.push("revoked");
    }),
    observe: vi.fn(async () => null),
  } as never;
}

function providerFixture(
  calls: string[],
): GitHubAppCommentTokenIssuerPort &
  Required<Pick<GitHubAppCommentTokenIssuerPort, "prepareCommentToken">> &
  Record<string, ReturnType<typeof vi.fn>> {
  const provider = {
    issueCommentToken: vi.fn(async () => {
      calls.push("network");
      return {
        token: "github-token",
        repository: "acme/repo",
        expiresAt: new Date("2026-08-25T13:00:00.000Z"),
        permissions: {
          contents: "read",
          pullRequests: "write",
          issues: "write",
          statuses: "write",
        },
        custody: "acceptable",
      } as const;
    }),
    revokeCommentToken: vi.fn(async () => {
      calls.push("remote-revoke");
      return { proof: "revoked" as const };
    }),
  } as unknown as GitHubAppCommentTokenIssuerPort &
    Required<Pick<GitHubAppCommentTokenIssuerPort, "prepareCommentToken">> &
    Record<string, ReturnType<typeof vi.fn>>;
  provider.prepareCommentToken = vi.fn(async (input) => ({
    send: async ({ signal }: { signal?: AbortSignal }) =>
      provider.issueCommentToken({
        ...input,
        signal,
      }),
  }));
  return provider;
}

function issuer(
  gate: HostedCommentTokenMintLedgerPort,
  provider: GitHubAppCommentTokenIssuerPort &
    Required<Pick<GitHubAppCommentTokenIssuerPort, "prepareCommentToken">>,
  secretVault?: ConstructorParameters<
    typeof HostedCodexCommentTokenIssuer
  >[0]["secretVault"],
) {
  return new HostedCodexCommentTokenIssuer({
    prisma: {} as never,
    mintLedger: gate,
    commentTokens: provider,
    clock: { now: () => instant },
    secretVault: secretVault ?? {
      prepareSeal: vi.fn(async () => ({
        capture: (token: string) => testEnvelope(token),
        destroy: vi.fn(),
      })),
      seal: vi.fn(async ({ token }) => ({
        ciphertext: Buffer.from(token),
        encryptedDataKey: Buffer.from("key"),
        iv: Buffer.from("iv"),
        authTag: Buffer.from("tag"),
        keyId: "key-1",
        aadHash: "a".repeat(64),
      })),
      open: vi.fn(async ({ envelope }) => Buffer.from(envelope.ciphertext)),
    },
  });
}

function testEnvelope(token: string) {
  return {
    ciphertext: Buffer.from(token),
    encryptedDataKey: Buffer.from("key"),
    iv: Buffer.from("iv"),
    authTag: Buffer.from("tag"),
    keyId: "key-1",
    aadHash: "a".repeat(64),
  };
}

function expectZeroEnvelope(envelope: {
  ciphertext: Uint8Array;
  encryptedDataKey: Uint8Array;
  iv: Uint8Array;
  authTag: Uint8Array;
}) {
  for (const value of [
    envelope.ciphertext,
    envelope.encryptedDataKey,
    envelope.iv,
    envelope.authTag,
  ])
    expect(Array.from(value)).toEqual(Array(value.byteLength).fill(0));
}
