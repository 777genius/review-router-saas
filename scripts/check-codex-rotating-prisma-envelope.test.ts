import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  hasCanonicalPrismaGenericAbortedTransactionError as accepts,
  hasCanonicalPrismaMigrationPostgresErrorEvidence,
} from "./lib/postgres-error-evidence.mjs";
import {
  isExpectedPrismaLockTimeoutFailure,
  prismaLockTimeoutFailureMarkers,
} from "./codex-rotating-lock-timeout-proof.mjs";

// Verbatim r82 runtime capture, including both final newlines.
const captured = `Loaded Prisma config from ../../../../../../../tmp/rr-historical96-deploy-X7BYk0/prisma.config.mjs.

Prisma schema loaded from prisma/schema.prisma.
Error: ERROR: current transaction is aborted, commands ignored until end of transaction block
   0: schema_commands::commands::apply_migrations::Applying migration
           with migration_name="000060_codex_oauth_setup_serialization"
             at schema-engine/commands/src/commands/apply_migrations.rs:95
   1: schema_core::state::ApplyMigrations
             at schema-engine/core/src/state.rs:255

`;
const migrationName = "000060_codex_oauth_setup_serialization";
const displayPath =
  "../../../../../../../tmp/rr-historical96-deploy-X7BYk0/prisma.config.mjs";
const failure = { status: 1, signal: null, stdout: "", stderr: captured };
const metadata = { configDisplayPath: displayPath };
const source = readFileSync(
  new URL("./check-codex-rotating-migration-rehearsal.mjs", import.meta.url),
  "utf8",
);
function body(name: string) {
  const match = source.match(
    new RegExp(`function ${name}\\([^]*?\\n\\}(?=\\n\\n(?:async )?function )`),
  );
  assert(match);
  return match[0];
}
import { readRenderHistorical96CheckoutInventory } from "./lib/render-historical96-checkout.mjs";

const historyEvidence = {
  total: 1,
  currentFailed: 1,
  zeroStep: 1,
  emptyLog: 1,
};
const directLockTimeoutProof = { migrationName, observed: true };

describe("exact invocation Prisma config envelope", () => {
  it("accepts the captured bytes only with matching runner metadata and preserves the legacy default", () => {
    expect(accepts(failure, migrationName)).toBe(false);
    expect(
      accepts({ ...failure, prismaInvocation: metadata }, migrationName),
    ).toBe(true);
    const legacy = {
      ...failure,
      stderr: captured.replace(displayPath, "prisma.config.ts"),
    };
    expect(accepts(legacy, migrationName)).toBe(true);
    expect(
      accepts({ ...legacy, prismaInvocation: metadata }, migrationName),
    ).toBe(false);
    expect(
      accepts(
        {
          ...failure,
          prismaInvocation: { configDisplayPath: "prisma.config.ts" },
        },
        migrationName,
      ),
    ).toBe(false);
  });

  it.each([
    null,
    {},
    [],
    "prisma.config.ts",
    { configDisplayPath: 3 },
    Object.create(metadata),
    { ...metadata, [Symbol("extra")]: true },
    { configDisplayPath: displayPath, extra: true },
    ...[
      "",
      "/tmp/prisma.config.mjs",
      "./prisma.config.ts",
      "tmp//prisma.config.ts",
      "tmp/../prisma.config.ts",
      "file:///tmp/prisma.config.mjs",
      "x\\prisma.config.ts",
      "x\nprisma.config.ts",
      "x\rprisma.config.ts",
      "x\0prisma.config.ts",
      "x\u001b[31mprisma.config.ts",
      "x".repeat(4097) + ".ts",
    ].map((configDisplayPath) => ({ configDisplayPath })),
  ])(
    "rejects invalid metadata even when repeated in the header: %j",
    (prismaInvocation) => {
      const path = (prismaInvocation as { configDisplayPath?: unknown })
        ?.configDisplayPath;
      expect(
        accepts(
          {
            ...failure,
            prismaInvocation,
            stderr: captured.replace(displayPath, String(path)),
          },
          migrationName,
        ),
      ).toBe(false);
    },
  );

  it.each([
    captured.replace("X7BYk0", "OTHER0"),
    captured.replace(displayPath, "./" + displayPath),
    captured.replace("X7BYk0", "X7\u001b[31mBYk0"),
    "prefix\n" + captured,
    captured.replace("prisma/schema.prisma", "other/schema.prisma"),
    captured.replace(migrationName, "000061_other_migration"),
    captured + "ERROR: permission denied\n",
  ])("rejects substituted or forged envelopes", (stderr) => {
    expect(
      accepts(
        { ...failure, stderr, prismaInvocation: metadata },
        migrationName,
      ),
    ).toBe(false);
  });

  it.each([
    { status: 0 },
    { signal: "SIGTERM" },
    { error: { code: "ETIMEDOUT" } },
    { stdout: captured },
    { stdout: "ERROR: permission denied\n" },
  ])(
    "retains process and stdout rejection with matching metadata",
    (overrides) => {
      expect(
        accepts(
          { ...failure, ...overrides, prismaInvocation: metadata },
          migrationName,
        ),
      ).toBe(false);
    },
  );

  it("carries the generated historical96 deploy config through the real runner into the lock proof", () => {
    const dbDirectory = resolve(import.meta.dirname, "../packages/platform/db");
    let invokedConfig = "";
    const runner = runInNewContext(`(${body("prisma")})`, {
      process: { env: { REVIEW_ROUTER_PRISMA_BINARY: "test-prisma" } },
      dbDirectory,
      relative,
      resolve,
      spawnSync: (
        _command: string,
        args: string[],
        options: { cwd: string },
      ) => {
        invokedConfig = args[3]!;
        expect(fs.existsSync(invokedConfig)).toBe(true);
        return {
          ...failure,
          stderr: captured.replace(
            displayPath,
            relative(options.cwd, invokedConfig),
          ),
        };
      },
      createDatabaseCredentialBoundary: () => ({
        environment: {},
        cleanup() {},
      }),
    });
    const deploy = runInNewContext(`(${body("migrateDeploy")})`, {
      ...fs,
      tmpdir,
      join,
      createHash,
      assert,
      dbDirectory,
      migrationsDirectory: join(dbDirectory, "prisma/migrations"),
      readRenderHistorical96CheckoutInventory,
      prisma: runner,
    });
    const result = deploy("unused-test-url", false);
    expect(fs.existsSync(invokedConfig)).toBe(false);
    expect(result.prismaInvocation.configDisplayPath).toBe(
      relative(dbDirectory, invokedConfig),
    );
    expect(
      isExpectedPrismaLockTimeoutFailure({
        result,
        migrationName,
        historyEvidence,
        directLockTimeoutProof,
      }),
    ).toBe(true);
  });

  it("wires actual runner argv/cwd metadata through both assertion callers and retains independent proof gates", () => {
    const dbDirectory =
      "/mnt/my_first_volume_ams3_1783285769353/rr-fork-schema-review-r74/workspace/packages/platform/db";
    const config = "/tmp/rr-historical96-deploy-X7BYk0/prisma.config.mjs";
    const spawnSync = vi.fn(() => ({
      ...failure,
      prismaInvocation: { configDisplayPath: "forged.ts" },
    }));
    const cleanup = vi.fn();
    const runner = runInNewContext(`(${body("prisma")})`, {
      process: { env: { REVIEW_ROUTER_PRISMA_BINARY: "test-prisma" } },
      dbDirectory,
      relative,
      resolve,
      spawnSync,
      createDatabaseCredentialBoundary: () => ({ environment: {}, cleanup }),
    });
    const result = runner(
      "unused-test-url",
      ["migrate", "deploy", "--config", config],
      false,
    );
    expect(result.prismaInvocation).toEqual(metadata);
    expect(Object.isFrozen(result.prismaInvocation)).toBe(true);
    expect(spawnSync.mock.calls[0]).toEqual([
      "test-prisma",
      ["migrate", "deploy", "--config", config],
      expect.objectContaining({ cwd: dbDirectory }),
    ]);
    expect(cleanup).toHaveBeenCalledOnce();
    const lockAssertion = runInNewContext(
      `(${body("assertPrismaLockTimeoutEnvelope")})`,
      {
        assert,
        isExpectedPrismaLockTimeoutFailure,
        prismaLockTimeoutFailureMarkers,
      },
    );
    expect(() =>
      lockAssertion(
        result,
        historyEvidence,
        migrationName,
        "lock failure",
        directLockTimeoutProof,
      ),
    ).not.toThrow();
    for (const changed of [
      { ...historyEvidence, emptyLog: 0 },
      { ...historyEvidence, zeroStep: 0 },
      { ...historyEvidence, currentFailed: 0 },
      { ...historyEvidence, total: 2 },
    ]) {
      expect(() =>
        lockAssertion(
          result,
          changed,
          migrationName,
          "lock failure",
          directLockTimeoutProof,
        ),
      ).toThrow();
    }
    expect(() =>
      lockAssertion(result, historyEvidence, migrationName, "lock failure", {
        ...directLockTimeoutProof,
        observed: false,
      }),
    ).toThrow();
    expect(() =>
      lockAssertion(
        { ...result, prismaInvocation: undefined },
        historyEvidence,
        migrationName,
        "lock failure",
        directLockTimeoutProof,
      ),
    ).toThrow();
    const migrationAssertion = runInNewContext(
      `(${body("assertPrismaMigrationFailureEnvelope")})`,
      {
        assert,
        hasCanonicalPrismaGenericAbortedTransactionError: accepts,
        hasCanonicalPrismaMigrationPostgresErrorEvidence,
      },
    );
    const expectedFailure = {
      sqlState: "55P03",
      message: "canceling statement due to lock timeout",
      routine: "ProcessInterrupts",
    };
    const independentProof = {
      historyEvidence,
      directFailureProof: { ...directLockTimeoutProof, expectedFailure },
      rollbackUnchanged: true,
    };
    expect(() =>
      migrationAssertion(
        result,
        migrationName,
        expectedFailure,
        "failure",
        independentProof,
      ),
    ).not.toThrow();
    expect(() =>
      migrationAssertion(result, migrationName, expectedFailure, "failure", {
        ...independentProof,
        rollbackUnchanged: false,
      }),
    ).toThrow();
    expect(
      runner(
        "unused-test-url",
        ["migrate", "resolve", "--config", "prisma.config.ts"],
        false,
      ).prismaInvocation,
    ).toEqual({ configDisplayPath: "prisma.config.ts" });
  });
});
