import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { readRenderHistorical96CheckoutInventory } from "./lib/render-historical96-checkout.mjs";

const root = resolve(import.meta.dirname, "..");
const dbDirectory = join(root, "packages/platform/db");
const migrationsDirectory = join(dbDirectory, "prisma/migrations");
const source = fs.readFileSync(
  join(root, "scripts/check-codex-rotating-migration-rehearsal.mjs"),
  "utf8",
);
const historical = readRenderHistorical96CheckoutInventory();
const extension = "000098_certified_fork_effect_archive";
function body(name: string) {
  const match = source.match(
    new RegExp(`function ${name}\\([^]*?\\n\\}(?=\\n\\nfunction )`),
  );
  assert(match, `missing function ${name}`);
  return match[0];
}
type RunnerResult = { status: number; stdout: string; stderr: string };
type PrismaRunner = (
  url: string,
  args: string[],
  requireSuccess: boolean,
) => RunnerResult;
function deploy(prisma: PrismaRunner, overrides = {}) {
  return runInNewContext(`(${body("migrateDeploy")})`, {
    ...fs,
    tmpdir,
    join,
    createHash,
    assert,
    dbDirectory,
    migrationsDirectory,
    readRenderHistorical96CheckoutInventory,
    prisma,
    ...overrides,
  });
}
function noOp(
  migrateDeploy: (url: string) => unknown,
  digests = ["unchanged", "unchanged"],
) {
  const migrationHistoryDigest = vi.fn<(url: string) => string | undefined>(
    () => digests.shift(),
  );
  const proveMigrationRunnerHistory = vi.fn();
  const run = runInNewContext(`(${body("proveMigrateDeployNoOp")})`, {
    assert,
    readRenderHistorical96CheckoutInventory,
    migrateDeploy,
    migrationHistoryDigest,
    proveMigrationRunnerHistory,
  });
  return { run, migrationHistoryDigest, proveMigrationRunnerHistory };
}

describe("historical96 Prisma deploy boundary", () => {
  it("gives the actual Prisma config loader all 96 admitted SQL files and excludes only checkout-only 098", () => {
    expect(
      fs.existsSync(join(migrationsDirectory, extension, "migration.sql")),
    ).toBe(true);
    let directory = "";
    const prisma = vi.fn((url, args, requireSuccess) => {
      expect(url).toBe("disposable-test-url");
      expect(requireSuccess).toBe(true);
      expect(args.slice(0, 3)).toEqual(["migrate", "deploy", "--config"]);
      directory = dirname(args[3]!);
      const require = createRequire(import.meta.url);
      const configModule = createRequire(
        require.resolve("prisma/config"),
      ).resolve("@prisma/config");
      // Config loading only: no engine, database, network, or real credentials.
      const loaded = spawnSync(
        process.execPath,
        [
          "-e",
          `
        require(${JSON.stringify(configModule)}).loadConfigFromFile({configFile: process.argv[1]})
          .then(result => { if (result.error) throw new Error(JSON.stringify(result.error));
            process.stdout.write(JSON.stringify(result.config)); });
      `,
          args[3],
        ],
        { encoding: "utf8", env: {}, timeout: 15_000 },
      );
      expect(loaded.status, loaded.stderr).toBe(0);
      const config = JSON.parse(loaded.stdout);
      expect(config.schema).toBe(join(dbDirectory, "prisma/schema.prisma"));
      expect(config.datasource.url).toBe("");
      const names = fs.readdirSync(config.migrations.path).sort();
      expect(names).toEqual(historical.map((row) => row.migrationName));
      expect(names).not.toContain(extension);
      for (const row of historical) {
        const bytes = fs.readFileSync(
          join(config.migrations.path, row.migrationName, "migration.sql"),
        );
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(
          row.checksum,
        );
      }
      return {
        status: 0,
        stdout: "No pending migrations to apply.",
        stderr: "",
      };
    });
    const proof = noOp(deploy(prisma));
    proof.run("disposable-test-url");
    expect(prisma).toHaveBeenCalledOnce();
    expect(fs.existsSync(directory)).toBe(false);
    expect(proof.migrationHistoryDigest.mock.calls).toEqual([
      ["disposable-test-url"],
      ["disposable-test-url"],
    ]);
    expect(proof.proveMigrationRunnerHistory.mock.calls).toEqual(
      historical.map((row) => ["disposable-test-url", row.migrationName, true]),
    );
  });

  it.each([false, true])(
    "cleans the bounded checkout on runner failure (throw=%s)",
    (throws) => {
      let directory = "";
      const result = { status: 1, stdout: "", stderr: "migration failed" };
      const run = deploy((_url, args, requireSuccess) => {
        directory = dirname(args[3]!);
        expect(requireSuccess).toBe(throws);
        if (throws) throw new Error("runner failed");
        return result;
      });
      if (throws) expect(() => run("test-url", true)).toThrow("runner failed");
      else expect(run("test-url", false)).toBe(result);
      expect(fs.existsSync(directory)).toBe(false);
    },
  );

  it("propagates full-checkout admission rejection before invoking Prisma", () => {
    const prisma = vi.fn();
    const run = deploy(prisma, {
      readRenderHistorical96CheckoutInventory() {
        throw new Error("render_schema_handoff_rejected:checkout_extension");
      },
    });
    expect(() => run("test-url")).toThrow(
      "render_schema_handoff_rejected:checkout_extension",
    );
    expect(prisma).not.toHaveBeenCalled();
  });

  it("rejects source drift between admission and the isolated copy", () => {
    const prisma = vi.fn();
    expect(() =>
      deploy(prisma, { readFileSync: () => Buffer.from("drift") })("test-url"),
    ).toThrow("historical96_deploy_source_mismatch:");
    expect(prisma).not.toHaveBeenCalled();
  });

  it("still rejects pending in-scope migrations and any history change", () => {
    expect(() =>
      noOp(() => ({ stdout: "Applied pending migration", stderr: "" })).run(
        "test-url",
      ),
    ).toThrow("post-success migrate deploy did not report a no-op");
    expect(() =>
      noOp(
        () => ({ stdout: "No pending migrations", stderr: "" }),
        ["before", "after"],
      ).run("test-url"),
    ).toThrow("post-success migrate deploy changed migration history");
  });

  it("hashes the complete history for no-op while preserving filtered callers", () => {
    const psql = vi
      .fn<(url: string, args: string[]) => { stdout: string }>()
      .mockReturnValue({ stdout: "digest\n" });
    const digest = runInNewContext(`(${body("migrationHistoryDigest")})`, {
      psql,
      quoteLiteral: (s: string) => `'${s}'`,
    });
    expect(digest("test-url")).toBe("digest");
    expect(psql.mock.calls[0]![1][1]).not.toContain("WHERE");
    digest("test-url", [extension]);
    expect(psql.mock.calls[1]![1][1]).toContain(
      `WHERE migration_name IN ('${extension}')`,
    );
  });
});
