import { describe, expect, it, vi } from "vitest";
import { fingerprintDatabaseRecoveryWitness } from "@reviewrouter/features-provider-setup";
import {
  assertCodexRotatingSetupRecoveryWitness,
  assertSetupManifestRecoveryWitness,
  issueCodexRotatingSetupCommand,
  transitionRecoveryRequestToManifestIssued,
} from "./codex-rotating-setup-manifest";

const firstWitness = "a".repeat(43);
const secondWitness = "b".repeat(43);
const firstFingerprint = fingerprintDatabaseRecoveryWitness(firstWitness);
const secondFingerprint = fingerprintDatabaseRecoveryWitness(secondWitness);

function transition(affectedRows: number) {
  const tx = { $executeRaw: vi.fn().mockResolvedValue(affectedRows) };
  return {
    tx,
    result: transitionRecoveryRequestToManifestIssued(tx as never, {
      recoveryRequestRowId: "recovery-row:exact",
      providerInstanceRowId: "provider:exact",
      recoveryRequestId: "recovery:exact",
      recoveryEpoch: 4n,
      databaseRecoveryWitness: secondFingerprint,
      manifestId: "manifest:exact",
      now: new Date("2026-08-10T00:00:00.000Z"),
    }),
  };
}

describe("recovery manifest issuance transition", () => {
  it("requires exactly one recovery request row", async () => {
    await expect(transition(0).result).rejects.toThrow(
      "codex_rotating_setup_recovery_transition_conflict",
    );
  });

  it("binds row id, provider, request id, epoch, state, and manifest", async () => {
    const { tx, result } = transition(1);
    await expect(result).resolves.toBeUndefined();
    const sql = Array.from(
      tx.$executeRaw.mock.calls[0]![0] as readonly string[],
    ).join("?");
    for (const token of [
      '"id" =',
      '"providerInstanceRowId" =',
      '"recoveryRequestId" =',
      '"mutationEpoch" =',
      '"databaseRecoveryWitness" =',
      "\"state\" = 'active'",
      '"latestManifestId" IS NULL',
    ]) {
      expect(sql).toContain(token);
    }
  });
});

function witnessTransaction(...results: readonly unknown[]) {
  let resultIndex = 0;
  return {
    $queryRaw: vi
      .fn()
      .mockImplementation(() => Promise.resolve(results[resultIndex++])),
  };
}

function witnessAssertion(
  tx: ReturnType<typeof witnessTransaction>,
  options: {
    readonly configuredRecoveryWitness?: string;
    readonly forcedRecoveryAuthority?: {
      readonly kind: "allocation" | "replay";
      readonly databaseRecoveryWitness: string | null;
      readonly manifestDatabaseRecoveryWitness: string | null;
    };
  } = {},
) {
  return assertCodexRotatingSetupRecoveryWitness(tx as never, {
    providerInstanceRowId: "provider:exact",
    ...(options.configuredRecoveryWitness !== undefined
      ? { configuredRecoveryWitness: options.configuredRecoveryWitness }
      : {}),
    forcedRecoveryAuthority: options.forcedRecoveryAuthority
      ? {
          ...options.forcedRecoveryAuthority,
          requestId: "recovery:exact",
          epoch: 4n,
        }
      : null,
  });
}

describe("ordinary setup recovery-witness admission", () => {
  it("runs admitted operation exactly once before first provider allocation", async () => {
    const order: string[] = [];
    const provider = {
      id: "provider:new",
      workspaceId: "workspace:new",
      repositoryId: "repository:new",
      providerInstanceId: "codex-rotating:123456",
      authMode: "codex_subscription_oauth_rotating",
      secretName: "REVIEWROUTER_CODEX_AUTH_JSON",
      generationHashSalt: "a".repeat(43),
      accountFingerprintSalt: "b".repeat(43),
      mutationEpoch: 0n,
      mutationOwner: null,
      mutationOwnerId: null,
      activeLeaseExpiresAt: null,
    };
    const tx = {
      codexOAuthProviderInstance: {
        findUnique: vi.fn().mockResolvedValueOnce(null),
        findUniqueOrThrow: vi.fn().mockResolvedValue(provider),
        create: vi.fn(async () => {
          order.push("provider_allocation");
          return provider;
        }),
        update: vi.fn(async () => {
          order.push("setup_fence_allocation");
          return provider;
        }),
      },
      codexOAuthWritebackIntent: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ acquired: true }])
        .mockResolvedValueOnce([{ id: provider.id }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]),
      $executeRawUnsafe: vi.fn(),
      $executeRaw: vi.fn(async () => {
        order.push("setup_sql_allocation");
        return 1;
      }),
    };
    const admittedOperation = vi.fn(async () => {
      order.push("admitted_operation");
    });

    await issueCodexRotatingSetupCommand({
      prisma: {
        $transaction: vi.fn((operation: (transaction: typeof tx) => unknown) =>
          operation(tx),
        ),
      } as never,
      workspaceId: provider.workspaceId,
      repositoryId: provider.repositoryId,
      repositoryFullName: "owner/repository",
      githubRepositoryId: "123456",
      installer: {
        url: "https://reviewrouter.site/installer.sh",
        version: "v1",
        sha256: "a".repeat(64),
      },
      setupManifestUrl:
        "https://reviewrouter.site/api/codex-rotating/setup-manifest",
      databaseRecoveryWitness: firstWitness,
      admittedOperation,
      runtimeEnvironment: {
        NODE_ENV: "test",
        REVIEW_ROUTER_CODEX_ROTATING_SETUP_ISSUANCE_ENABLED: "1",
      },
      now: new Date("2026-08-10T00:00:00.000Z"),
    });

    expect(admittedOperation).toHaveBeenCalledTimes(1);
    expect(order[0]).toBe("admitted_operation");
    expect(order).toEqual([
      "admitted_operation",
      "provider_allocation",
      "setup_sql_allocation",
      "setup_fence_allocation",
      "setup_sql_allocation",
    ]);
    expect(tx.codexOAuthProviderInstance.update).toHaveBeenCalledWith({
      where: { id: provider.id },
      data: {
        state: "setup_pending",
        mutationEpoch: 1n,
        mutationOwner: "setup",
        mutationOwnerId: expect.stringMatching(/^codex_setup_/u),
      },
    });
  });

  it("does not allocate a provider when admitted operation denies setup", async () => {
    const create = vi.fn();
    const tx = {
      codexOAuthProviderInstance: {
        findUnique: vi.fn().mockResolvedValue(null),
        create,
      },
      $queryRaw: vi.fn().mockResolvedValue([{ acquired: true }]),
    };

    await expect(
      issueCodexRotatingSetupCommand({
        prisma: {
          $transaction: vi.fn(
            (operation: (transaction: typeof tx) => unknown) => operation(tx),
          ),
        } as never,
        workspaceId: "workspace:denied",
        repositoryId: "repository:denied",
        repositoryFullName: "owner/repository",
        githubRepositoryId: "123456",
        installer: {
          url: "https://reviewrouter.site/installer.sh",
          version: "v1",
          sha256: "a".repeat(64),
        },
        setupManifestUrl:
          "https://reviewrouter.site/api/codex-rotating/setup-manifest",
        databaseRecoveryWitness: firstWitness,
        admittedOperation: async () => {
          throw new Error("rate_limit_exceeded:setup");
        },
        runtimeEnvironment: {
          NODE_ENV: "test",
          REVIEW_ROUTER_CODEX_ROTATING_SETUP_ISSUANCE_ENABLED: "1",
        },
      }),
    ).rejects.toThrow("rate_limit_exceeded:setup");
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects W1 to W2 before any mutating adapter call", async () => {
    const admittedOperation = vi.fn();
    const provider = {
      id: "provider:exact",
      workspaceId: "workspace:exact",
      repositoryId: "repository:exact",
      providerInstanceId: "codex-rotating:123456",
      authMode: "codex_subscription_oauth_rotating",
      secretName: "REVIEWROUTER_CODEX_AUTH_JSON",
    };
    const create = vi.fn();
    const update = vi.fn();
    const executeRaw = vi.fn();
    const executeRawUnsafe = vi.fn();
    const tx = {
      codexOAuthProviderInstance: {
        findUnique: vi.fn().mockResolvedValue(provider),
        findUniqueOrThrow: vi.fn(),
        create,
        update,
      },
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ acquired: true }])
        .mockResolvedValueOnce([{ databaseRecoveryWitness: firstFingerprint }]),
      $executeRaw: executeRaw,
      $executeRawUnsafe: executeRawUnsafe,
    };
    const prisma = {
      $transaction: vi.fn((callback: (transaction: typeof tx) => unknown) =>
        callback(tx),
      ),
    };

    await expect(
      issueCodexRotatingSetupCommand({
        prisma: prisma as never,
        workspaceId: provider.workspaceId,
        repositoryId: provider.repositoryId,
        repositoryFullName: "owner/repository",
        githubRepositoryId: "123456",
        installer: {
          url: "https://reviewrouter.site/install/codex-rotating",
          version: "v1",
          sha256: "a".repeat(64),
        },
        setupManifestUrl:
          "https://reviewrouter.site/api/codex-rotating/setup-manifest",
        databaseRecoveryWitness: secondWitness,
        admittedOperation,
        runtimeEnvironment: {
          NODE_ENV: "test",
          REVIEW_ROUTER_CODEX_ROTATING_SETUP_ISSUANCE_ENABLED: "1",
        },
      }),
    ).rejects.toThrow("codex_rotating_setup_recovery_required");

    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    const witnessSql = Array.from(
      tx.$queryRaw.mock.calls[1]![0] as readonly string[],
    ).join("?");
    expect(witnessSql).toContain('evidence."authorityEpoch" DESC');
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(executeRaw).not.toHaveBeenCalled();
    expect(executeRawUnsafe).not.toHaveBeenCalled();
    expect(admittedOperation).not.toHaveBeenCalled();
  });

  it("validates witness syntax before opening provider state", async () => {
    const transaction = vi.fn();
    const admittedOperation = vi.fn();

    await expect(
      issueCodexRotatingSetupCommand({
        prisma: { $transaction: transaction } as never,
        workspaceId: "workspace:exact",
        repositoryId: "repository:exact",
        repositoryFullName: "owner/repository",
        githubRepositoryId: "123456",
        installer: {
          url: "https://reviewrouter.site/install/codex-rotating",
          version: "v1",
          sha256: "a".repeat(64),
        },
        setupManifestUrl:
          "https://reviewrouter.site/api/codex-rotating/setup-manifest",
        databaseRecoveryWitness: "malformed",
        admittedOperation,
        runtimeEnvironment: {
          NODE_ENV: "test",
          REVIEW_ROUTER_CODEX_ROTATING_SETUP_ISSUANCE_ENABLED: "1",
        },
      }),
    ).rejects.toThrow("codex_rotating_setup_recovery_required");

    expect(transaction).not.toHaveBeenCalled();
    expect(admittedOperation).not.toHaveBeenCalled();
  });

  it("does not substitute an ambient witness for a missing explicit fetch witness", () => {
    vi.stubEnv("REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS", firstWitness);
    try {
      expect(() =>
        assertSetupManifestRecoveryWitness(
          firstFingerprint,
          undefined as never,
        ),
      ).toThrow("codex_rotating_setup_recovery_required");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("fails closed with the stable setup error when the witness is unavailable", async () => {
    const tx = witnessTransaction();

    await expect(witnessAssertion(tx)).rejects.toThrow(
      "codex_rotating_setup_recovery_required",
    );
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it("admits matching evidence and orders every durable authority source by mutation epoch", async () => {
    const tx = witnessTransaction([
      { databaseRecoveryWitness: firstFingerprint },
    ]);

    await expect(
      witnessAssertion(tx, { configuredRecoveryWitness: firstWitness }),
    ).resolves.toBe(firstFingerprint);

    const sql = Array.from(
      tx.$queryRaw.mock.calls[0]![0] as readonly string[],
    ).join("?");
    for (const table of [
      "CodexOAuthSetupManifest",
      "CodexOAuthSetupPayloadClaim",
      "CodexOAuthWritebackIntent",
      "CodexOAuthSecretNamespace",
    ]) {
      expect(sql).toContain(`"${table}"`);
    }
    expect(sql).toContain('evidence."authorityEpoch" DESC');
  });

  it("rejects an ordinary W1 to W2 transition", async () => {
    const tx = witnessTransaction([
      { databaseRecoveryWitness: firstFingerprint },
    ]);

    await expect(
      witnessAssertion(tx, { configuredRecoveryWitness: secondWitness }),
    ).rejects.toThrow("codex_rotating_setup_recovery_required");
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("admits only a witness-bound allocation after all prior authority is retired", async () => {
    const tx = witnessTransaction(
      [{ allowed: true }],
      [{ databaseRecoveryWitness: firstFingerprint }],
      [{ count: 0n }],
    );

    await expect(
      witnessAssertion(tx, {
        configuredRecoveryWitness: secondWitness,
        forcedRecoveryAuthority: {
          kind: "allocation",
          databaseRecoveryWitness: secondFingerprint,
          manifestDatabaseRecoveryWitness: null,
        },
      }),
    ).resolves.toBe(secondFingerprint);

    const retirementSql = Array.from(
      tx.$queryRaw.mock.calls[2]![0] as readonly string[],
    ).join("?");
    expect(retirementSql).toContain("CodexOAuthSetupManifest");
    expect(retirementSql).toContain("CodexOAuthSetupDispatchAttempt");
    expect(retirementSql).toContain("CodexOAuthWritebackIntent");
  });

  it("rejects partial retirement without allocating", async () => {
    const tx = witnessTransaction(
      [{ allowed: true }],
      [{ databaseRecoveryWitness: firstFingerprint }],
      [{ count: 1n }],
    );

    await expect(
      witnessAssertion(tx, {
        configuredRecoveryWitness: secondWitness,
        forcedRecoveryAuthority: {
          kind: "allocation",
          databaseRecoveryWitness: secondFingerprint,
          manifestDatabaseRecoveryWitness: null,
        },
      }),
    ).rejects.toThrow("codex_rotating_setup_recovery_required");
  });

  it("binds forced retries to both request and issued-manifest witnesses", async () => {
    const staleRequest = witnessTransaction();
    await expect(
      witnessAssertion(staleRequest, {
        configuredRecoveryWitness: secondWitness,
        forcedRecoveryAuthority: {
          kind: "replay",
          databaseRecoveryWitness: firstFingerprint,
          manifestDatabaseRecoveryWitness: secondFingerprint,
        },
      }),
    ).rejects.toThrow("codex_rotating_setup_recovery_required");
    expect(staleRequest.$queryRaw).not.toHaveBeenCalled();

    const exactReplay = witnessTransaction(
      [{ allowed: true }],
      [{ databaseRecoveryWitness: secondFingerprint }],
    );
    await expect(
      witnessAssertion(exactReplay, {
        configuredRecoveryWitness: secondWitness,
        forcedRecoveryAuthority: {
          kind: "replay",
          databaseRecoveryWitness: secondFingerprint,
          manifestDatabaseRecoveryWitness: secondFingerprint,
        },
      }),
    ).resolves.toBe(secondFingerprint);
  });

  it("rechecks the exact request, provider, epoch, and owner inside the locked transaction", async () => {
    const tx = witnessTransaction([{ allowed: false }]);

    await expect(
      witnessAssertion(tx, {
        configuredRecoveryWitness: secondWitness,
        forcedRecoveryAuthority: {
          kind: "allocation",
          databaseRecoveryWitness: secondFingerprint,
          manifestDatabaseRecoveryWitness: null,
        },
      }),
    ).rejects.toThrow("codex_rotating_setup_recovery_required");

    const sql = Array.from(
      tx.$queryRaw.mock.calls[0]![0] as readonly string[],
    ).join("?");
    for (const token of [
      'recovery."recoveryRequestId"',
      'recovery."mutationEpoch"',
      'recovery."databaseRecoveryWitness"',
      'provider."mutationOwnerId"',
      'manifest."databaseRecoveryWitness"',
    ]) {
      expect(sql).toContain(token);
    }
  });
});
