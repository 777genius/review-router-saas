import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
  chmodSync,
  linkSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  captureRecoveryArtifact,
  verifyReviewedRestore,
  recoveryIdentitySql,
  recoveryScopeSql,
  recoveryEmptySql,
  type ReviewedRecoveryPlan,
} from "./render-historical89-recovery";
import { effectivePrincipalInventorySql } from "../../packages/features/release-rollout/src/adapters/postgres-generation";
import type { CommandExecutor } from "../../packages/features/release-rollout/src/adapters/process-command";
import {
  readRenderSchemaHandoffCatalog,
  renderManagedLedgerSql,
} from "./render-schema-handoff-policy.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
const sourceUrl =
  "postgresql://reviewrouter:fixture-secret@dpg-source/recovery?sslmode=disable";
const targetUrl =
  "postgresql://reviewrouter:fixture-secret@dpg-target/recovery?sslmode=disable";
const source = {
  systemIdentifier: "111",
  database: "recovery",
  databaseOid: "16384",
  serverVersion: "170010",
  inRecovery: false as const,
};
const target = { ...source, systemIdentifier: "222" };
const role = {
  name: "reviewrouter",
  canLogin: true,
  inherit: true,
  superuser: false,
  bypassRls: false,
  replication: false,
  createDatabase: false,
  createRole: false,
  connectionLimit: -1,
  validUntil: null,
};
// Independent literal expectations, never inferred from the mocked observation.
const plan: ReviewedRecoveryPlan = {
  reviewReference: "fixture-review-1",
  databaseOwner: "reviewrouter",
  grants: [],
  roles: [role],
  memberships: [],
  policy: {
    version: 1,
    publicPermissions: [],
    principals: [
      {
        principal: "reviewrouter",
        mayLogin: true,
        inherit: true,
        connectionLimit: -1,
        validUntil: null,
        permissions: [],
      },
    ],
  },
};
const ledgerRows = readRenderSchemaHandoffCatalog()
  .slice(0, 89)
  .map((r: any) => ({
    id: "12345678-1234-1234-1234-123456789012",
    migrationName: r.migrationName,
    checksum: r.checksum,
    startedAt: "2026-01-01T00:00:00.000001Z",
    finishedAt: "2026-01-01T00:00:00.000002Z",
    rolledBackAt: null,
    appliedStepsCount: 1,
    logsPresent: false,
    hasLogs: false,
    logsDigest: null,
  }));
const bytes = Buffer.from("PGDMPfixture-bytes-no-rows");
function setup() {
  const directory = join(
    mkdtempSync(join(tmpdir(), "rr-recovery-unit-")),
    "artifact",
  );
  roots.push(join(directory, ".."));
  const passfiles: string[] = [],
    calls: { command: string; args: readonly string[] }[] = [];
  const state = {
    empty: true,
    restored: false,
    corruptData: false,
    corruptSequence: false,
    corruptLedger: false,
    corruptAcl: false,
    corruptOwner: false,
    corruptCatalog: false,
    corruptRls: false,
    corruptMembership: false,
    missingVisibility: false,
    rls: false,
    unsupported: false,
    identity: false,
    sourceDrift: false,
    throwDump: false,
    throwRestore: false,
    dumpLink: false,
    targetRole: false,
    unknownMembership: false,
    beforeRestore: undefined as (() => void) | undefined,
  };
  const commands: CommandExecutor = {
    execute(command, args, options) {
      calls.push({ command, args });
      if (options?.env?.PGPASSFILE) {
        expect(existsSync(options.env.PGPASSFILE)).toBe(true);
        passfiles.push(options.env.PGPASSFILE);
      }
      const isTarget = args.includes("dpg-target");
      const sql = args.at(-1)!;
      if (command === "pg_dump") {
        if (state.throwDump)
          throw new Error("postgresql://secret:password@dpg-hidden/private");
        const path = args.at(-1)!;
        if (state.dumpLink) {
          const outside = join(directory, "..", "outside");
          writeFileSync(outside, bytes);
          symlinkSync(outside, path);
        } else writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
        return { stdout: "" };
      }
      if (command === "pg_restore") {
        state.beforeRestore?.();
        if (state.throwRestore) throw new Error("token=secret");
        expect(readFileSync(sql)).toEqual(bytes);
        state.restored = true;
        return { stdout: "" };
      }
      if (state.restored && isTarget && state.corruptCatalog && sql.includes("'kind','object'"))
        return { stdout: JSON.stringify({ private: "token=secret postgresql://secret@dpg-hidden/private" }) };
      let value: unknown = null;
      if (sql === recoveryIdentitySql)
        value = isTarget
          ? {
              ...target,
              systemIdentifier: state.identity
                ? source.systemIdentifier
                : target.systemIdentifier,
            }
          : source;
      else if (sql === recoveryEmptySql) value = { empty: state.empty };
      else if (sql === recoveryScopeSql)
        value = {
          schemas: ["public"],
          settings: 0,
          extensions: [{ name: "plpgsql", version: "1.0" }],
          unsupportedTypes: 0,
          unsupportedCatalog: 0,
          visible: !state.rls,
          database: { owner: "reviewrouter", connectionLimit: -1 },
        };
      else if (sql === renderManagedLedgerSql)
        value =
          state.restored && isTarget && state.corruptLedger
            ? ledgerRows.slice(1)
            : ledgerRows;
      else if (sql === effectivePrincipalInventorySql)
        value = {
          version: 1,
          database: "recovery",
          sessionPrincipal: "reviewrouter",
          roles: [{ ...role, createRole: state.targetRole && isTarget }],
          memberships: state.unknownMembership || (state.restored && isTarget && state.corruptMembership)
            ? [
                {
                  member: "unknown",
                  role: "reviewrouter",
                  grantor: "postgres",
                  setOption: true,
                  inheritOption: true,
                  adminOption: true,
                },
              ]
            : [],
          grants:
            state.restored &&
            isTarget &&
            (state.corruptAcl || state.corruptOwner)
              ? [
                  {
                    principal: "reviewrouter",
                    capability: state.corruptOwner
                      ? "owner:object"
                      : "table:read",
                    resource: "relation:public.fixture",
                    source: "privilege",
                    grantable: false,
                    grantor: "reviewrouter",
                  },
                ]
              : [],
          roleReachability: state.missingVisibility ? undefined : [],
          rowSecurity: state.restored && isTarget && state.corruptRls
            ? [{ schema: "public", table: "fixture", enabled: true, forced: false }]
            : [],
          extensions: [],
          unsupportedAuthorityFamilies: state.unsupported
            ? ["event-trigger"]
            : [],
        };
      else if (sql.includes("json_agg(n.nspname||'.'||c.relname"))
        value = ["public.fixture"];
      else if (sql.includes("json_agg(schemaname||'.'||sequencename"))
        value = ["public.fixture_seq"];
      else if (sql.includes("'lastValue'")) {
        const decimal =
          state.restored && isTarget && state.corruptSequence
            ? "9223372036854775807"
            : "9223372036854775806";
        value = {
          lastValue: sql.includes("s.last_value::text")
            ? decimal
            : Number(decimal),
          isCalled: true,
        };
      }
      return { stdout: JSON.stringify(value) };
    },
    async hashStdout(_command, args, options) {
      if (options?.env?.PGPASSFILE) passfiles.push(options.env.PGPASSFILE);
      const drift =
        (state.restored && args.includes("dpg-target") && state.corruptData) ||
        (state.sourceDrift && !args.includes("dpg-target"));
      return {
        rows: 1,
        sha256: `sha256:${createHash("sha256")
          .update(drift ? "drift" : "data")
          .digest("hex")}`,
      };
    },
    executeExpectingFailure() {
      throw new Error("not used");
    },
  };
  const capture = () =>
    captureRecoveryArtifact({
      sourceUrl,
      expectedSource: source,
      directory,
      reviewedPlan: plan,
      exclusionReference: "root-exclusion-1",
      consistencyReference: "root-consistency-1",
      commands,
    });
  const restore = (artifact: Awaited<ReturnType<typeof capture>>) =>
    verifyReviewedRestore({
      artifact,
      sourceUrl,
      targetUrl,
      disposableTarget: {
        purpose: "historical89-disposable-restore",
        reviewReference: "disposable-1",
        expectedIdentity: target,
      },
    });
  const cleaned = () =>
    expect(passfiles.every((p) => !existsSync(p))).toBe(true);
  const mutations = () =>
    calls.filter(
      (c) =>
        c.command === "pg_restore" ||
        c.args.at(-1)?.startsWith("ALTER DATABASE") ||
        c.args.at(-1)?.startsWith("BEGIN;"),
    );
  return {
    directory,
    commands,
    state,
    calls,
    capture,
    restore,
    cleaned,
    mutations,
  };
}
describe("bounded historical89 recovery evidence", () => {
  it("hashes actual custom bytes and verifies restore without stripping owner/ACL", async () => {
    const f = setup();
    const a = await f.capture();
    const result = await f.restore(a);
    expect(a.sha256).toBe(
      `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    );
    expect(a.ledger).toEqual(ledgerRows);
    expect(result.ledger).toEqual(ledgerRows);
    expect(a.exclusionReference.qualification).toBe("external-unverified");
    expect(result.evidence.equivalent).toBe(true);
    expect(result.source.systemIdentifier).not.toBe(
      result.target.systemIdentifier,
    );
    expect(
      f.calls
        .filter((c) => c.command === "pg_dump" || c.command === "pg_restore")
        .every(
          (c) =>
            !c.args.some((v) =>
              /--(?:no-owner|no-acl|no-privileges|clean|create)/.test(v),
            ),
        ),
    ).toBe(true);
    expect(existsSync(join(f.directory, "recovery.dump"))).toBe(true);
    expect(existsSync(join(f.directory, "restore-input"))).toBe(false);
    f.cleaned();
    expect(JSON.stringify(result)).not.toMatch(
      /fixture-secret|postgresql:|PGDMP/,
    );
  });
  it("reports a fixed catalog category without leaking raw observations", async () => {
    const f = setup();
    const a = await f.capture();
    await f.restore(a);
    f.state.restored = false;
    f.state.corruptCatalog = true;
    await expect(f.restore(a)).rejects.toThrow(
      new Error("historical89_recovery_restored_equivalence_acl_ownership_defaults"),
    );
    f.cleaned();
  });
  it("refuses an existing artifact without overwriting it", async () => {
    const f = setup();
    await f.capture();
    await expect(f.capture()).rejects.toThrow("capture_failed");
    expect(readFileSync(join(f.directory, "recovery.dump"))).toEqual(bytes);
    f.cleaned();
  });
  it.each(["changed", "symlink", "hardlink", "permissions", "fifo"])(
    "rejects %s bytes before mutation",
    async (kind) => {
      const f = setup();
      const a = await f.capture();
      const p = join(f.directory, "recovery.dump");
      if (kind === "changed") writeFileSync(p, "PGDMPchanged");
      if (kind === "permissions") chmodSync(p, 0o644);
      if (kind === "fifo") {
        rmSync(p);
        expect(spawnSync("mkfifo", [p], { timeout: 5000 }).status).toBe(0);
      }
      if (kind === "hardlink") linkSync(p, join(f.directory, "other"));
      if (kind === "symlink") {
        rmSync(p);
        symlinkSync("/dev/null", p);
      }
      await expect(f.restore(a)).rejects.toThrow("historical89_recovery_");
      expect(f.mutations()).toHaveLength(0);
      f.cleaned();
    },
  );
  it.each(["empty", "identity", "targetRole", "sourceDrift"] as const)(
    "rejects target/source %s before mutation",
    async (kind) => {
      const f = setup();
      const a = await f.capture();
      if (kind === "empty") f.state.empty = false;
      else f.state[kind] = true;
      await expect(f.restore(a)).rejects.toThrow("historical89_recovery_");
      expect(f.mutations()).toHaveLength(0);
      f.cleaned();
    },
  );
  it.each([
    "corruptData",
    "corruptSequence",
    "corruptLedger",
    "corruptAcl",
    "corruptOwner",
    "corruptRls",
    "corruptMembership",
  ] as const)(
    "fails closed on restored %s and retains artifact",
    async (kind) => {
      const f = setup();
      const a = await f.capture();
      await f.restore(a);
      f.state.restored = false;
      f.state[kind] = true;
      const causes = {
        corruptData: "restored_equivalence_rows",
        corruptSequence: "restored_sequences_mismatch",
        corruptLedger: "ledger_not_full89",
        corruptAcl: "restored_grants_mismatch",
        corruptOwner: "restored_owners_mismatch",
        corruptRls: "restored_rls_mismatch",
        corruptMembership: "restored_memberships_mismatch",
      };
      await expect(f.restore(a)).rejects.toThrow(new Error(`historical89_recovery_${causes[kind]}`));
      expect(f.state.restored).toBe(true);
      expect(existsSync(join(f.directory, "recovery.dump"))).toBe(true);
      expect(existsSync(join(f.directory, "restore-input"))).toBe(false);
      f.cleaned();
    },
  );
  it.each([
    "missingVisibility",
    "rls",
    "unsupported",
    "unknownMembership",
    "dumpLink",
    "throwDump",
  ] as const)("rejects capture %s", async (kind) => {
    const f = setup();
    f.state[kind] = true;
    await expect(f.capture()).rejects.toThrow(
      /^historical89_recovery_[a-z_]+$/,
    );
    expect(existsSync(f.directory)).toBe(false);
    f.cleaned();
  });
  it("does not accept a serialized/forged handle or caller asserted digest", async () => {
    const f = setup();
    const a = await f.capture();
    await expect(f.restore({ ...a })).rejects.toThrow(
      "unmeasured_artifact_handle",
    );
    expect(f.mutations()).toHaveLength(0);
  });
  it("sanitizes failures and cleans passfiles and pinned input, retaining the legitimate dump", async () => {
    const f = setup();
    const a = await f.capture();
    f.state.throwRestore = true;
    await expect(f.restore(a)).rejects.toThrow(
      "historical89_recovery_restore_pg_restore_failed",
    );
    expect(existsSync(join(f.directory, "recovery.dump"))).toBe(true);
    expect(existsSync(join(f.directory, "restore-input"))).toBe(false);
    f.cleaned();
  });
  it("enforces a bound on actual file bytes", async () => {
    const f = setup();
    await expect(
      captureRecoveryArtifact({
        sourceUrl,
        expectedSource: source,
        directory: f.directory,
        reviewedPlan: plan,
        exclusionReference: "root",
        consistencyReference: "root",
        commands: f.commands,
        maxArtifactBytes: 5,
      }),
    ).rejects.toThrow("artifact_file_invalid");
    expect(existsSync(f.directory)).toBe(false);
    f.cleaned();
  });
  it("rejects an explicitly reviewed but unsupported missing role before mutation", async () => {
    const f = setup();
    const unknown = {
      ...role,
      name: "unmanaged_restore_role",
      canLogin: false,
    };
    const commands: CommandExecutor = {
      ...f.commands,
      execute(command, args, options) {
        const result = f.commands.execute(command, args, options);
        if (
          args.at(-1) === effectivePrincipalInventorySql &&
          args.includes("dpg-source")
        ) {
          const value = JSON.parse(result.stdout);
          value.roles.push(unknown);
          return { stdout: JSON.stringify(value) };
        }
        return result;
      },
    };
    const reviewedPlan = {
      ...plan,
      roles: [role, unknown],
      policy: {
        ...plan.policy,
        principals: [
          ...plan.policy.principals,
          {
            ...plan.policy.principals[0]!,
            principal: unknown.name,
            mayLogin: false,
          },
        ],
      },
    };
    const artifact = await captureRecoveryArtifact({
      sourceUrl,
      expectedSource: source,
      directory: f.directory,
      reviewedPlan,
      exclusionReference: "root",
      consistencyReference: "root",
      commands,
    });
    await expect(f.restore(artifact)).rejects.toThrow("unsupported_role_name");
    expect(f.mutations()).toHaveLength(0);
    f.cleaned();
  });
});
