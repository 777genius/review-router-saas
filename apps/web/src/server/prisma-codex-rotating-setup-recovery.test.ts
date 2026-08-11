import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  codexRotatingAccountSwitchAcknowledgement,
  codexRotatingForcedRecoveryAttemptTransitions,
  codexRotatingForcedRecoveryClaimTransitions,
  codexRotatingSetupRecoveryAcknowledgement,
} from "@reviewrouter/features-provider-setup";
import { fingerprintDatabaseRecoveryWitness } from "@reviewrouter/features-provider-setup";
import {
  PrismaCodexRotatingSetupRecovery,
  retirePriorNamespaceGeneration,
  supersedeMismatchedActiveRecoveryRequests,
  validateCodexRotatingSetupRecoveryAcknowledgement,
} from "./prisma-codex-rotating-setup-recovery";

const sqlText = (call: readonly unknown[]) =>
  Array.from(call[0] as readonly string[]).join("?");
const sqlValues = (call: readonly unknown[]): readonly unknown[] =>
  call.slice(1).flatMap(flattenSqlValue);

function flattenSqlValue(value: unknown): readonly unknown[] {
  if (
    value &&
    typeof value === "object" &&
    "values" in value &&
    Array.isArray(value.values)
  ) {
    return value.values.flatMap(flattenSqlValue);
  }
  return [value];
}

describe("Prisma setup recovery acknowledgement boundary", () => {
  it.each([
    {
      acknowledgement: codexRotatingSetupRecoveryAcknowledgement,
      accountSwitch: false,
    },
    {
      acknowledgement: codexRotatingAccountSwitchAcknowledgement,
      accountSwitch: true,
    },
  ] as const)(
    "preserves the exact operator acknowledgement for accountSwitch=$accountSwitch",
    ({ acknowledgement, accountSwitch }) => {
      expect(
        validateCodexRotatingSetupRecoveryAcknowledgement({
          acknowledgement,
          accountSwitch,
        }),
      ).toBe(acknowledgement);
    },
  );

  it("rejects a mismatched acknowledgement before opening a transaction", async () => {
    const prisma = { $transaction: vi.fn() };
    const recovery = new PrismaCodexRotatingSetupRecovery(prisma as never);

    await expect(
      recovery.recover({
        workspaceId: "workspace:ack-boundary",
        repositoryId: "repository:ack-boundary",
        githubRepositoryId: "1234567",
        recoveryRequestId: "recovery:ack-boundary",
        actor: "operator:ack-boundary",
        acknowledgement: codexRotatingAccountSwitchAcknowledgement,
        accountSwitch: false,
        decide: vi.fn(),
        now: new Date("2026-08-10T00:00:00.000Z"),
      }),
    ).rejects.toThrow("codex_rotating_setup_recovery_acknowledgement_required");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("Prisma setup recovery status witness admission", () => {
  it("filters resolved provider quarantine history from setup, status, and recovery", () => {
    const recoverySource = readFileSync(
      resolve(import.meta.dirname, "prisma-codex-rotating-setup-recovery.ts"),
      "utf8",
    );
    const setupSource = readFileSync(
      resolve(import.meta.dirname, "codex-rotating-setup-manifest.ts"),
      "utf8",
    );

    expect(
      recoverySource.match(/quarantine\."resolvedAt" IS NULL/g),
    ).toHaveLength(2);
    expect(recoverySource).toContain('AND "resolvedAt" IS NULL');
    expect(setupSource).toContain('AND "resolvedAt" IS NULL');
  });

  function statusAdapter(configuredWitness: string, persistedWitness: string) {
    const prisma = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ databaseRecoveryWitness: persistedWitness }]),
      codexOAuthProviderInstance: {
        findFirst: vi.fn().mockResolvedValue({
          id: "provider:status",
          mutationOwner: null,
          writebackIntents: [],
          setupManifests: [],
        }),
      },
    };
    return new PrismaCodexRotatingSetupRecovery(
      prisma as never,
      configuredWitness,
    );
  }

  it("fails status closed after a W1 to W2 restore", async () => {
    await expect(
      statusAdapter(
        "b".repeat(43),
        fingerprintDatabaseRecoveryWitness("a".repeat(43)),
      ).inspectStatus({
        workspaceId: "workspace:status",
        repositoryId: "repository:status",
        issuanceEnabled: true,
      }),
    ).resolves.toEqual({ status: "recovery_required" });
  });

  it("reports ready only when the configured witness matches durable evidence", async () => {
    const witness = "a".repeat(43);
    await expect(
      statusAdapter(
        witness,
        fingerprintDatabaseRecoveryWitness(witness),
      ).inspectStatus({
        workspaceId: "workspace:status",
        repositoryId: "repository:status",
        issuanceEnabled: true,
      }),
    ).resolves.toEqual({ status: "ready" });
  });
});

describe("forced setup recovery authority retirement", () => {
  it("makes the explicit admission decision before superseding stale recovery rows", async () => {
    const events: string[] = [];
    const tx = {
      $queryRaw: vi.fn().mockImplementation((query: unknown) => {
        const text = sqlQueryText(query);
        if (text.includes("pg_try_advisory_xact_lock")) {
          return Promise.resolve([{ acquired: true }]);
        }
        if (text.includes('FROM "CodexOAuthProviderInstance"')) {
          return Promise.resolve([{ id: "provider:ordering" }]);
        }
        return Promise.resolve([]);
      }),
      $executeRawUnsafe: vi.fn().mockResolvedValue(0),
      $executeRaw: vi.fn().mockImplementation((query: unknown) => {
        if (
          sqlQueryText(query).includes(
            'UPDATE "CodexOAuthSetupRecoveryRequest"',
          )
        ) {
          events.push("stale-recovery-update");
          throw new Error("stop_after_ordering_observation");
        }
        return Promise.resolve(0);
      }),
      codexOAuthProviderInstance: {
        findUnique: vi.fn().mockResolvedValue({ id: "provider:ordering" }),
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: "provider:ordering",
          workspaceId: "workspace:ordering",
          repositoryId: "repository:ordering",
          providerInstanceId: "codex-rotating:1234567",
          authMode: "oauth_rotating",
          secretName: "REVIEWROUTER_CODEX_AUTH_JSON",
          mutationEpoch: 7n,
          mutationOwner: null,
          mutationOwnerId: null,
          activeAccountIdentityHash: null,
          activeLeaseId: null,
          repository: {
            workspaceId: "workspace:ordering",
            githubRepositoryId: 1234567n,
          },
        }),
      },
      codexOAuthSecretNamespace: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      codexOAuthSetupManifest: { findFirst: vi.fn().mockResolvedValue(null) },
      codexOAuthWritebackIntent: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      codexOAuthLease: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    const prisma = {
      $transaction: vi.fn(
        (operation: (transaction: typeof tx) => Promise<unknown>) =>
          operation(tx),
      ),
    };
    const recovery = new PrismaCodexRotatingSetupRecovery(
      prisma as never,
      "w".repeat(43),
    );

    await expect(
      recovery.recover({
        workspaceId: "workspace:ordering",
        repositoryId: "repository:ordering",
        githubRepositoryId: "1234567",
        recoveryRequestId: "recovery:ordering",
        actor: "operator:ordering",
        acknowledgement: codexRotatingSetupRecoveryAcknowledgement,
        accountSwitch: false,
        decide: () => {
          events.push("domain-admission");
          return { kind: "recover" };
        },
        now: new Date("2026-08-10T00:00:00.000Z"),
      }),
    ).rejects.toThrow("stop_after_ordering_observation");

    expect(events).toEqual(["domain-admission", "stale-recovery-update"]);
    const activeOtherRequestRead = tx.$queryRaw.mock.calls.find((call) =>
      sqlQueryText(call[0]).includes('"recoveryRequestId" <>'),
    );
    expect(activeOtherRequestRead).toBeDefined();
    expect(sqlText(activeOtherRequestRead!)).toContain(
      '"databaseRecoveryWitness" IS NOT DISTINCT FROM ?',
    );
    expect(sqlValues(activeOtherRequestRead!)).toContain(
      fingerprintDatabaseRecoveryWitness("w".repeat(43)),
    );
  });

  it("atomically supersedes only active recovery authority from an older writer witness", async () => {
    const tx = { $executeRaw: vi.fn().mockResolvedValue(2) };
    await expect(
      supersedeMismatchedActiveRecoveryRequests(tx as never, {
        providerInstanceRowId: "provider:restored-writer",
        currentWitness: "b".repeat(64),
        now: new Date("2026-08-10T00:00:00.000Z"),
      }),
    ).resolves.toBe(2);

    const update = sqlText(tx.$executeRaw.mock.calls[0]!);
    const values = sqlValues(tx.$executeRaw.mock.calls[0]!);
    expect(update).toContain("SET \"state\" = 'superseded'");
    expect(update).toContain("\"state\" IN ('active', 'manifest_issued')");
    expect(update).toContain('"databaseRecoveryWitness" IS DISTINCT FROM ?');
    expect(values).toEqual(
      expect.arrayContaining(["provider:restored-writer", "b".repeat(64)]),
    );
  });

  it("retires prepared, confirmed, confirmed-candidate, and active authority before proving zero live rows", async () => {
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn().mockResolvedValue([{ count: 0n }]),
    };
    await expect(
      retirePriorNamespaceGeneration(tx as never, {
        providerInstanceRowId: "provider:recovery-proof",
        now: new Date("2026-08-10T00:00:00.000Z"),
      }),
    ).resolves.toBeUndefined();

    expect(tx.$executeRaw).toHaveBeenCalledTimes(3);
    const updates = tx.$executeRaw.mock.calls.map(sqlText).join("\n");
    const updateValues = tx.$executeRaw.mock.calls.flatMap(sqlValues);
    expect(updateValues).toEqual(
      expect.arrayContaining(
        Object.entries(codexRotatingForcedRecoveryAttemptTransitions).flat(),
      ),
    );
    expect(updateValues).toEqual(
      expect.arrayContaining(
        Object.entries(codexRotatingForcedRecoveryClaimTransitions).flat(),
      ),
    );
    expect(updates).toContain("THEN 'retired_superseded'");

    const proof = sqlText(tx.$queryRaw.mock.calls[0]!);
    const proofValues = sqlValues(tx.$queryRaw.mock.calls[0]!);
    expect(proofValues).toEqual(
      expect.arrayContaining([
        ...Object.keys(codexRotatingForcedRecoveryAttemptTransitions),
        ...Object.keys(codexRotatingForcedRecoveryClaimTransitions),
      ]),
    );
    expect(proof).toMatch(
      /'dispatch_authorized',\s*'confirmed_candidate',\s*'active'/u,
    );
  });

  it("rolls the recovery transaction back when even one live authority row remains", async () => {
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn().mockResolvedValue([{ count: 1n }]),
    };
    await expect(
      retirePriorNamespaceGeneration(tx as never, {
        providerInstanceRowId: "provider:drift-proof",
        now: new Date("2026-08-10T00:00:00.000Z"),
      }),
    ).rejects.toThrow("codex_rotating_setup_recovery_retirement_conflict");
  });
});

function sqlQueryText(query: unknown): string {
  if (Array.isArray(query)) return query.join("?");
  if (
    query &&
    typeof query === "object" &&
    "strings" in query &&
    Array.isArray(query.strings)
  ) {
    return query.strings.join("?");
  }
  return String(query);
}
