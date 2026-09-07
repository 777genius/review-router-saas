import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { PrismaHostedCodexSessionPersistence } from "../infrastructure/prisma/prisma-hosted-codex-session-persistence";
import { hostedCodexMutationLeaseAuthority } from "../infrastructure/prisma/prisma-hosted-codex-mutation-fence";
import {
  CredentialEnvelopeVault,
  EnvCredentialKeyring,
} from "../infrastructure/crypto/credential-envelope-vault";
import { fingerprintCodexAuthJson } from "../infrastructure/security/codex-account-identity";

function auth(subject = "fake-subject") {
  const claims = Buffer.from(
    JSON.stringify({
      iss: "https://auth.openai.com",
      sub: subject,
      "https://api.openai.com/auth": { chatgpt_account_id: "fake-account" },
    }),
  ).toString("base64url");
  return Buffer.from(
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        refresh_token: "test-fixture-literal",
        id_token: `e30.${claims}.fake-signature`,
      },
      last_refresh: "2026-09-06T00:00:00Z",
    }),
  );
}
function fixture(state = "paused") {
  const pepper = Buffer.alloc(32, 7);
  let account = {
    id: "account",
    workspaceId: "workspace",
    poolId: "pool",
    state,
    activeGeneration: 3n,
    healthVersion: 9n,
    tombstonedAt: null,
    accountFingerprint: fingerprintCodexAuthJson(auth(), pepper),
  };
  let versions: Record<string, unknown>[] = [];
  let envelopes: Record<string, unknown>[] = [];
  let receipts: Record<string, unknown>[] = [];
  const leaseId = `hcmf1.${Buffer.from("account").toString("base64url")}.1.${Buffer.alloc(32, 3).toString("base64url")}`;
  const authority = hostedCodexMutationLeaseAuthority(leaseId);
  const fence = {
    accountId: "account",
    expectedGeneration: 3n,
    ownerIdHash: authority.ownerIdHash,
    fenceEpoch: 1n,
    expiresAt: new Date(Date.now() + 30000),
  };
  let beforeCommit = () => {};
  const tx = {
    hostedCodexAccount: {
      findUnique: async () => ({ ...account }),
      findUniqueOrThrow: async () => ({ ...account }),
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        if (
          Object.entries(where).some(
            ([key, value]) => account[key as keyof typeof account] !== value,
          )
        )
          return { count: 0 };
        account = {
          ...account,
          ...data,
          healthVersion: account.healthVersion + 1n,
        } as typeof account;
        return { count: 1 };
      },
    },
    hostedCodexMutationFence: {
      findUnique: async () => fence,
      updateMany: async ({
        where,
      }: {
        where: {
          expectedGeneration: bigint;
          ownerIdHash: string;
          fenceEpoch: bigint;
        };
      }) => ({
        count:
          where.expectedGeneration === fence.expectedGeneration &&
          where.ownerIdHash === fence.ownerIdHash &&
          where.fenceEpoch === fence.fenceEpoch
            ? 1
            : 0,
      }),
    },
    hostedCodexCredentialVersion: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { ...data, id: "version" };
        versions.push(row);
        return row;
      },
      findUnique: async () => ({ generationHash: "current-hash" }),
    },
    hostedCodexCredentialEnvelopeRevision: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        envelopes.push(data);
        return data;
      },
    },
    hostedCodexGenerationReceipt: {
      findUnique: async ({ where }: { where: { receiptHash: string } }) => {
        const receipt = receipts.find(
          (row) => row.receiptHash === where.receiptHash,
        );
        return receipt
          ? {
              ...receipt,
              credentialVersion: versions.find(
                (row) => row.id === receipt.credentialVersionId,
              ),
            }
          : null;
      },
      findFirst: async () => ({ receiptHash: "previous-receipt" }),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        receipts.push(data);
        return data;
      },
    },
  };
  const prisma = {
    ...tx,
    $transaction: async (work: (client: typeof tx) => Promise<unknown>) => {
      // Simulate an independently committed health/generation change before write transaction.
      beforeCommit();
      beforeCommit = () => {};
      const snapshot = {
        account: { ...account },
        versions: [...versions],
        envelopes: [...envelopes],
        receipts: [...receipts],
      };
      try {
        return await work(tx);
      } catch (error) {
        account = snapshot.account;
        versions = snapshot.versions;
        envelopes = snapshot.envelopes;
        receipts = snapshot.receipts;
        throw error;
      }
    },
  } as unknown as PrismaClient;
  const vault = new CredentialEnvelopeVault(
    new EnvCredentialKeyring({
      REVIEW_ROUTER_HOSTED_CODEX_KEK_CURRENT_ID: "test",
      REVIEW_ROUTER_HOSTED_CODEX_KEK_KEYRING_JSON: JSON.stringify({
        test: Buffer.alloc(32, 4).toString("base64"),
      }),
    }),
  );
  const originalEncrypt = vault.encrypt.bind(vault);
  const encrypt = vi
    .spyOn(vault, "encrypt")
    .mockImplementation(async (...args) => originalEncrypt(...args));
  const persistence = new PrismaHostedCodexSessionPersistence(
    prisma,
    vault,
    "test-incarnation",
    "test-resource-identity",
    pepper,
  );
  const bytes = auth();
  const command = {
    accountId: "account",
    workspaceId: "workspace",
    poolId: "pool",
    expectedGeneration: 3,
    expectedHealthVersion: 9,
    nextAuthJsonBytes: bytes,
    nextGenerationHash: createHash("sha256").update(bytes).digest("hex"),
    idempotencyKey: "reconnect-test",
    leaseId,
  };
  return {
    persistence,
    command,
    encrypt,
    state: () => ({ account, versions, envelopes, receipts }),
    race: (update: Partial<typeof account>) => {
      encrypt.mockImplementationOnce(async (...args) => {
        const envelope = await originalEncrypt(...args);
        beforeCommit = () => {
          account = { ...account, ...update };
        };
        return envelope;
      });
    },
  };
}

describe("explicit Prisma reconnect persistence", () => {
  it("writes an encrypted generation and chained receipt while preserving pause", async () => {
    const f = fixture();
    expect(await f.persistence.reconnect(f.command)).toMatchObject({
      status: "accepted",
      generation: 4,
    });
    const stored = f.state();
    expect(stored.account).toMatchObject({
      state: "paused",
      activeGeneration: 4n,
      healthVersion: 10n,
    });
    expect(stored.versions).toHaveLength(1);
    expect(stored.envelopes).toHaveLength(1);
    expect(stored.receipts[0]).toMatchObject({
      previousReceiptHash: "previous-receipt",
      generation: 4n,
    });
    expect(
      JSON.stringify(stored.versions, (_key, value) =>
        typeof value === "bigint" ? String(value) : value,
      ),
    ).not.toContain(f.command.nextAuthJsonBytes.toString());
  });
  it("replays a committed reconnect receipt without a second encrypted generation", async () => {
    const f = fixture();
    await f.persistence.reconnect(f.command);
    expect(await f.persistence.reconnect(f.command)).toMatchObject({
      status: "idempotent_replay",
      generation: 4,
    });
    expect(f.encrypt).toHaveBeenCalledTimes(1);
    expect(f.state().receipts).toHaveLength(1);
    await expect(
      f.persistence.reconnect({ ...f.command, workspaceId: "foreign" }),
    ).rejects.toThrow("reconnect_conflict");
    await expect(
      f.persistence.reconnect({
        ...f.command,
        nextGenerationHash: "different",
      }),
    ).rejects.toThrow("reconnect_conflict");
  });
  it("rejects identity mismatch before encryption or quarantine effects", async () => {
    const f = fixture();
    await expect(
      f.persistence.reconnect({
        ...f.command,
        nextAuthJsonBytes: auth("different-subject"),
      }),
    ).rejects.toThrow("identity_drift");
    expect(f.encrypt).not.toHaveBeenCalled();
    expect(f.state().account).toMatchObject({
      state: "paused",
      healthVersion: 9n,
    });
    expect(f.state().versions).toHaveLength(0);
  });
  it.each([
    { expectedHealthVersion: 8 },
    { workspaceId: "foreign" },
    { poolId: "foreign" },
  ])("rejects scope/version mismatch %j", async (change) => {
    const f = fixture();
    await expect(
      f.persistence.reconnect({ ...f.command, ...change }),
    ).rejects.toThrow("reconnect_conflict");
    expect(f.encrypt).not.toHaveBeenCalled();
  });
  it.each([
    { healthVersion: 10n },
    { activeGeneration: 4n, healthVersion: 10n },
    { state: "healthy", healthVersion: 10n },
  ])(
    "rolls back the entire replacement on a concurrent administrative/generation change",
    async (change) => {
      const f = fixture();
      f.race(change);
      expect(await f.persistence.reconnect(f.command)).toMatchObject({
        status: "stale_generation",
      });
      expect(f.state().versions).toHaveLength(0);
      expect(f.state().envelopes).toHaveLength(0);
      expect(f.state().receipts).toHaveLength(0);
      expect(f.state().account).toMatchObject(change);
    },
  );
  it("keeps ordinary healthy refresh behavior", async () => {
    const f = fixture("healthy");
    expect(await f.persistence.compareAndSwap(f.command)).toMatchObject({
      status: "accepted",
      generation: 4,
    });
    expect(f.state().account).toMatchObject({
      state: "healthy",
      activeGeneration: 4n,
    });
  });
  it("never lets refresh undo a concurrent pause", async () => {
    const f = fixture("healthy");
    f.race({ state: "paused", healthVersion: 10n });
    expect(await f.persistence.compareAndSwap(f.command)).toMatchObject({
      status: "stale_generation",
    });
    expect(f.state().account.state).toBe("paused");
    expect(f.state().versions).toHaveLength(0);
  });
  it("rejects refresh that observes an already paused account", async () => {
    const f = fixture();
    await expect(f.persistence.compareAndSwap(f.command)).rejects.toThrow(
      "not_servable",
    );
    expect(f.encrypt).not.toHaveBeenCalled();
  });
});
