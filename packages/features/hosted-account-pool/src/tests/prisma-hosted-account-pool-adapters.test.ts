import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  hostedAccountId,
  hostedBindingId,
  hostedPoolId,
  repositoryId,
  workspaceId,
} from "../domain/identifiers";
import { CredentialEnvelopeVault } from "../infrastructure/crypto/credential-envelope-vault";
import {
  PrismaHostedCredentialEnrollment,
  PrismaHostedAccountRepository,
  PrismaHostedPoolBindingRepository,
  PrismaHostedPoolQuery,
  PrismaRepositoryAuthModeSwitch,
} from "../infrastructure/prisma/prisma-hosted-account-pool-adapters";

const now = new Date("2026-08-15T12:00:00.000Z");
const workspace = workspaceId("workspace-1");
const pool = hostedPoolId("pool-1");
const account = hostedAccountId("account-1");

describe("Prisma hosted pool admin adapters", () => {
  it("atomically enrolls encrypted auth and zeroes caller plaintext", async () => {
    const stored: unknown[] = [];
    const transaction = enrollmentTransaction({ stored });
    const prisma = fakePrisma(transaction);
    const rawSecret = "refresh-token-never-store";
    const authJsonBytes = validAuthJson(rawSecret);
    const enrollment = new PrismaHostedCredentialEnrollment(
      prisma,
      testVault(),
      "database-incarnation-1",
      "database-resource-test-1",
      Buffer.alloc(32, 7),
    );

    const result = await enrollment.importCodexAuth({
      workspaceId: workspace,
      poolId: pool,
      accountId: account,
      label: "Primary",
      priority: 10,
      expectedPoolRevision: 4,
      authJsonBytes,
      now,
    });

    expect(result).toMatchObject({
      id: account,
      label: "Primary",
      authGeneration: 1,
      healthVersion: 1,
    });
    expect("credentialRef" in result).toBe(false);
    expect("subjectFingerprint" in result).toBe(false);
    expect(authJsonBytes.every((byte) => byte === 0)).toBe(true);
    const serializedStored = JSON.stringify(stored, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    expect(serializedStored).not.toContain(rawSecret);
    expect(serializedStored).not.toContain("id-token-signature");
    expect(
      transaction.hostedCodexGenerationReceipt.create,
    ).toHaveBeenCalledTimes(2);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 15_000,
    });
    expect(transaction.hostedCodexAccount.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: workspace,
          poolId: pool,
          state: "provisioning_pending",
          activeGeneration: null,
        }),
        data: expect.objectContaining({
          state: "healthy",
          activeGeneration: 1n,
          healthVersion: 1n,
        }),
      }),
    );
  });

  it("rejects duplicate fingerprint inside the enrollment transaction", async () => {
    const transaction = enrollmentTransaction({ duplicate: true });
    const authJsonBytes = validAuthJson("duplicate-refresh-secret");
    const enrollment = new PrismaHostedCredentialEnrollment(
      fakePrisma(transaction),
      testVault(),
      "database-incarnation-1",
      "database-resource-test-1",
      Buffer.alloc(32, 9),
    );

    await expect(
      enrollment.importCodexAuth({
        workspaceId: workspace,
        poolId: pool,
        accountId: account,
        label: "Duplicate",
        priority: 1,
        expectedPoolRevision: 1,
        authJsonBytes,
        now,
      }),
    ).rejects.toThrow("hosted_account_subject_already_enrolled");
    expect(transaction.hostedCodexAccount.create).not.toHaveBeenCalled();
    expect(authJsonBytes.every((byte) => byte === 0)).toBe(true);
  });

  it("fails enrollment on pool revision CAS before storing an account", async () => {
    const transaction = enrollmentTransaction({ poolCas: false });
    const enrollment = new PrismaHostedCredentialEnrollment(
      fakePrisma(transaction),
      testVault(),
      "database-incarnation-1",
      "database-resource-test-1",
      Buffer.alloc(32, 3),
    );

    await expect(
      enrollment.importCodexAuth({
        workspaceId: workspace,
        poolId: pool,
        accountId: account,
        label: "CAS",
        priority: 1,
        expectedPoolRevision: 99,
        authJsonBytes: validAuthJson("cas-refresh-secret"),
        now,
      }),
    ).rejects.toThrow("hosted_pool_revision_conflict");
    expect(transaction.hostedCodexAccount.findFirst).not.toHaveBeenCalled();
    expect(transaction.hostedCodexAccount.create).not.toHaveBeenCalled();
  });

  it("fails closed when repository tenant eligibility does not match", async () => {
    const transaction = {
      repositoryConnection: { findFirst: vi.fn().mockResolvedValue(null) },
      hostedCodexPool: {
        findFirst: vi.fn().mockResolvedValue({ id: pool }),
      },
      hostedCodexRepositoryBinding: {
        create: vi.fn(),
        updateMany: vi.fn(),
      },
    };
    const bindings = new PrismaHostedPoolBindingRepository(
      fakePrisma(transaction),
    );

    await expect(
      bindings.save({
        binding: {
          bindingId: hostedBindingId("binding-1"),
          repositoryId: repositoryId("repository-1"),
          workspaceId: workspace,
          poolId: pool,
          authMode: "codex_subscription_oauth_hosted_pool",
          status: "pending_activation",
          revision: 1,
          stateVersion: 1,
          attestedBindingRevision: null,
          activatedAt: null,
          drainingAt: null,
          boundAt: now,
          updatedAt: now,
        },
        expectedRevision: null,
        expectedStateVersion: null,
      }),
    ).resolves.toBe(false);
    expect(transaction.repositoryConnection.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: workspace,
          provider: "github",
          selected: true,
          archived: false,
          visibility: { in: ["private", "internal"] },
        }),
      }),
    );
    expect(
      transaction.hostedCodexRepositoryBinding.create,
    ).not.toHaveBeenCalled();
  });

  it("uses exact binding identity and revision for update CAS", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const transaction = {
      repositoryConnection: {
        findFirst: vi.fn().mockResolvedValue({ id: "repository-1" }),
      },
      hostedCodexPool: { findFirst: vi.fn().mockResolvedValue({ id: pool }) },
      hostedCodexRepositoryBinding: { updateMany },
    };
    const bindings = new PrismaHostedPoolBindingRepository(
      fakePrisma(transaction),
    );

    await expect(
      bindings.save({
        binding: {
          bindingId: hostedBindingId("binding-1"),
          repositoryId: repositoryId("repository-1"),
          workspaceId: workspace,
          poolId: pool,
          authMode: "codex_subscription_oauth_hosted_pool",
          status: "active",
          revision: 3,
          stateVersion: 5,
          attestedBindingRevision: 3,
          activatedAt: now,
          drainingAt: null,
          boundAt: now,
          updatedAt: now,
        },
        expectedRevision: 2,
        expectedStateVersion: 4,
      }),
    ).resolves.toBe(true);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "binding-1",
          repositoryConnectionId: "repository-1",
          workspaceId: "workspace-1",
          poolId: "pool-1",
          revision: 2n,
          stateVersion: 4n,
          tombstonedAt: null,
        },
      }),
    );
  });

  it("builds account read models without selecting fingerprint or credential id", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "account-1",
        label: "Safe",
        priority: 0,
        state: "healthy",
        cooldownUntil: null,
        healthVersion: 1n,
        activeGeneration: 1n,
        createdAt: now,
        updatedAt: now,
        credentialVersions: [
          { generation: 1n, credentialExpiresAt: null, createdAt: now },
        ],
      },
    ]);
    const query = new PrismaHostedPoolQuery({
      hostedCodexAccount: { findMany },
    } as unknown as PrismaClient);

    const summaries = await query.listAccountSummaries(pool);

    expect(summaries[0]).not.toHaveProperty("credentialRef");
    expect(summaries[0]).not.toHaveProperty("subjectFingerprint");
    const select = findMany.mock.calls[0]?.[0]?.select;
    expect(select).not.toHaveProperty("accountFingerprint");
    expect(select.credentialVersions.select).not.toHaveProperty("id");
  });

  it("does not mutate binding when review-config authority is absent", async () => {
    const transactionRunner = vi.fn();
    const authSwitch = new PrismaRepositoryAuthModeSwitch({
      $transaction: transactionRunner,
    } as unknown as PrismaClient);

    await expect(
      authSwitch.switchToRepositoryOwnedRotating({
        repositoryId: repositoryId("repository-1"),
        workspaceId: workspace,
        expectedBindingRevision: 2,
        nextBindingRevision: 3,
        switchedAt: now,
      }),
    ).resolves.toBe(false);
    expect(transactionRunner).not.toHaveBeenCalled();
  });

  it("requires healthVersion to advance by exactly one before availability CAS", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const accounts = new PrismaHostedAccountRepository({
      hostedCodexAccount: { updateMany },
    } as unknown as PrismaClient);
    const base = {
      id: account,
      poolId: pool,
      label: "Primary",
      priority: 0,
      credential: {
        credentialRef: "credential-1",
        subjectFingerprint: "fingerprint-1",
        authGeneration: 1,
        validatedAt: now,
        expiresAt: null,
      },
      availability: { status: "paused" as const, reason: "operator" },
      createdAt: now,
      updatedAt: now,
    };

    await expect(
      accounts.saveAvailability({
        account: { ...base, healthVersion: 4 },
        expectedHealthVersion: 2,
      }),
    ).resolves.toBe(false);
    expect(updateMany).not.toHaveBeenCalled();

    await expect(
      accounts.saveAvailability({
        account: { ...base, healthVersion: 3 },
        expectedHealthVersion: 2,
      }),
    ).resolves.toBe(true);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ healthVersion: 2n }),
        data: expect.objectContaining({ healthVersion: 3n }),
      }),
    );
  });

  it("never includes malformed raw auth in errors or logs", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const raw = Buffer.from('not-json-with-secret-"refresh-token-value"');
    const enrollment = new PrismaHostedCredentialEnrollment(
      fakePrisma(enrollmentTransaction({})),
      testVault(),
      "database-incarnation-1",
      "database-resource-test-1",
      Buffer.alloc(32, 3),
    );

    let message = "";
    try {
      await enrollment.importCodexAuth({
        workspaceId: workspace,
        poolId: pool,
        accountId: account,
        label: "Invalid",
        priority: 1,
        expectedPoolRevision: 1,
        authJsonBytes: raw,
        now,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe("hosted_account_enrollment_failed");
    expect(message).not.toContain("refresh-token-value");
    expect(log).not.toHaveBeenCalled();
    expect(raw.every((byte) => byte === 0)).toBe(true);
    log.mockRestore();
  });
});

function enrollmentTransaction(input: {
  readonly stored?: unknown[];
  readonly duplicate?: boolean;
  readonly poolCas?: boolean;
}) {
  const capture = (value: unknown) => {
    input.stored?.push(value);
    return value;
  };
  return {
    hostedCodexPool: {
      updateMany: vi
        .fn()
        .mockResolvedValue({ count: input.poolCas === false ? 0 : 1 }),
    },
    hostedCodexAccount: {
      findFirst: vi
        .fn()
        .mockResolvedValue(input.duplicate ? { id: "duplicate" } : null),
      create: vi.fn(async (value) => capture(value)),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    hostedCodexCredentialVersion: {
      create: vi.fn(async (value) => {
        capture(value);
        return { id: "credential-version-1" };
      }),
    },
    hostedCodexCredentialEnvelopeRevision: {
      create: vi.fn(async (value) => capture(value)),
    },
    hostedCodexGenerationReceipt: {
      create: vi.fn(async (value) => capture(value)),
    },
  };
}

function fakePrisma(transaction: object): PrismaClient {
  return {
    $transaction: vi.fn(async (callback: (tx: object) => Promise<unknown>) =>
      callback(transaction),
    ),
  } as unknown as PrismaClient;
}

function testVault(): CredentialEnvelopeVault {
  return new CredentialEnvelopeVault({
    currentKeyId: "test-key",
    async wrapDataEncryptionKey() {
      return {
        keyId: "test-key",
        nonce: Buffer.alloc(12, 1).toString("base64"),
        ciphertext: Buffer.alloc(32, 2).toString("base64"),
        authenticationTag: Buffer.alloc(16, 3).toString("base64"),
      };
    },
    async unwrapDataEncryptionKey() {
      return Buffer.alloc(32, 4);
    },
  });
}

function validAuthJson(refreshToken: string): Uint8Array {
  const claims = Buffer.from(
    JSON.stringify({
      iss: "https://auth.openai.com",
      sub: "user-1",
      "https://api.openai.com/auth": { chatgpt_account_id: "chatgpt-1" },
    }),
  ).toString("base64url");
  return Buffer.from(
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        refresh_token: refreshToken,
        id_token: `e30.${claims}.id-token-signature`,
      },
      last_refresh: now.toISOString(),
    }),
  );
}
