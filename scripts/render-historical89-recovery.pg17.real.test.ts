import { disposableRecoveryMetadataValues } from "./lib/render-historical89-recovery-metadata.fixture";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  managedPg17Fixture,
  prepareHistorical89Fixture,
} from "./lib/render-managed-pg17-fixture";
import {
  captureRecoveryArtifact,
  verifyReviewedRestore,
  recoveryIdentitySql,
  recoveryScopeSql,
  type RecoveryIdentity,
  type ReviewedRecoveryPlan,
} from "./lib/render-historical89-recovery";
import { PostgreSqlGenerationAdapter } from "../packages/features/release-rollout/src/adapters/postgres-generation";
import {
  evaluateEffectivePrincipalInventory,
  type EffectivePrincipalPolicy,
} from "../packages/features/release-rollout/src/domain/effective-principal-inventory";
import type { CommandExecutor } from "../packages/features/release-rollout/src/adapters/process-command";

const database = "recovery89";
// These synthetic URLs never leave the fixture executor: dpg-* is mapped
// transparently to loopback INSIDE each owned offline container. No credential
// boundary widening, host TCP publication, actual password or network access.
const sourceUrl = `postgresql://postgres:fixture-only@dpg-source/${database}?sslmode=disable`;
const targetUrl = `postgresql://postgres:fixture-only@dpg-target/${database}?sslmode=disable`;
const seed = `INSERT INTO "Workspace" (id,slug,name,"updatedAt") VALUES ('recovery','recovery','disposable recovery',now()); CREATE SEQUENCE public.recovery_sequence; SELECT setval('public.recovery_sequence',9223372036854775806,true);`;
const enabled = process.env.REVIEW_ROUTER_REQUIRE_HANDOFF_PG17 === "1";
(enabled ? describe.sequential : describe.skip)(
  "historical89 actual custom dump and disposable restore, offline PG17.10",
  () => {
    const source = managedPg17Fixture(),
      referenceModel = managedPg17Fixture();
    const targets: ReturnType<typeof managedPg17Fixture>[] = [];
    let root: string,
      sourceIdentity: RecoveryIdentity,
      plan: ReviewedRecoveryPlan;
    let sharedArtifact: Awaited<ReturnType<typeof captureRecoveryArtifact>>;
    let activeTarget: ReturnType<typeof managedPg17Fixture>;
    let activeDrift: string | undefined;
    let baseline: Awaited<ReturnType<typeof fixture>>;
    let baselineResult: Awaited<ReturnType<typeof verifyReviewedRestore>>;
    // Tests are serial: one immutable artifact, distinct owned target clusters.
    const left = source.recoveryCommands("dpg-source");
    const route = (args: readonly string[]) => args.includes("dpg-source")
      ? left : activeTarget.recoveryCommands("dpg-target");
    // Capture the exact verifier SQL outputs without extra queries. This seam is
    // confined to the owned-container test executor and cannot expose production.
    const metadataPairs = new Map<string, Map<string, string>>();
    let hashCalls = 0;
    let dumpCalls = 0;
    let restoreCalls = 0;
    const commands: CommandExecutor = {
      execute(command, args, options) {
        const started = Date.now();
        if (command === "pg_dump") dumpCalls++;
        if (command === "pg_restore") restoreCalls++;
        try {
          const result = route(args).execute(command, args, options);
          const sql = args.at(-1) ?? "";
          if (command === "psql" && (sql.includes("'kind','object'") || sql.includes("'kind','constraint'"))) {
            const pair = metadataPairs.get(sql) ?? new Map<string, string>();
            pair.set(args.includes("dpg-source") ? "source" : "target", result.stdout);
            metadataPairs.set(sql, pair);
            if (pair.has("source") && pair.has("target")) {
              const category = sql.includes("'kind','object'") ? "acl_ownership_defaults" : "constraints_indexes_triggers";
              try { console.info(`recovery_fixture_metadata_values ${JSON.stringify({ category,
                differences: disposableRecoveryMetadataValues(pair.get("source")!, pair.get("target")!) })}`); } catch {
                console.info(`recovery_fixture_metadata_values_rejected category=${category}`);
              }
            }
          }
          if (command === "pg_restore" && activeDrift) {
            const driftStarted = Date.now();
            try {
              activeTarget.query(database, `SET lock_timeout='5s'; SET statement_timeout='15s'; ${activeDrift}`, "postgres");
            } catch {
              throw new Error("recovery_fixture_drift_command_failed");
            } finally {
              console.info(`recovery_measurement drift_ms=${Date.now() - driftStarted}`);
            }
          }
          return result;
        } finally {
          if (command === "pg_restore" || command === "pg_dump")
            console.info(`recovery_measurement ${command}_ms=${Date.now() - started}`);
        }
      },
      async hashStdout(command, args, options) {
        const result = await route(args).hashStdout(command, args, options);
        if (++hashCalls % 100 === 0)
          console.info(`recovery_measurement completed_hash_calls=${hashCalls}`);
        return result;
      },
      executeExpectingFailure: (command, args, options) => route(args).executeExpectingFailure(command, args, options),
    };
    const read = (pg: ReturnType<typeof managedPg17Fixture>, sql: string) =>
      JSON.parse(pg.query(database, sql, "postgres"));
    beforeAll(async () => {
      root = mkdtempSync(join(tmpdir(), "rr-historical89-recovery-real-"));
      // An independent fixture model supplies TEST expectations before inspecting
      // the source under test. This is not a default production review mechanism:
      // production callers must supply an independently reviewed explicit plan.
      await referenceModel.start();
      await prepareHistorical89Fixture(referenceModel, database, seed);
      const model = new PostgreSqlGenerationAdapter(
        referenceModel.recoveryCommands("dpg-source"),
      ).inventoryEffectivePrincipals(sourceUrl);
      expect(
        model.roles.filter((r) => !r.name.startsWith("pg_")).map((r) => r.name),
      ).toEqual([
        "historical_inherited",
        "postgres",
        "reviewrouter",
        "reviewrouter_api",
        "reviewrouter_comment_token_custody",
        "reviewrouter_release_migration",
        "reviewrouter_release_schema_owner",
      ]);
      expect(model.unsupportedAuthorityFamilies).toEqual([]);
      const baseline: EffectivePrincipalPolicy = {
        version: 1,
        publicPermissions: [],
        principals: [],
      };
      const projected = evaluateEffectivePrincipalInventory(model, baseline);
      const unique = <T>(rows: T[]) => [
        ...new Map(rows.map((r) => [JSON.stringify(r), r])).values(),
      ];
      plan = {
        reviewReference: "independent-disposable-fixture-model-v1",
        databaseOwner: "reviewrouter",
        roles: model.roles,
        memberships: model.memberships,
        grants: model.grants,
        policy: {
          version: 1,
          publicPermissions: unique(
            model.grants
              .filter((g) => g.principal === "PUBLIC")
              .map(({ capability, resource }) => ({ capability, resource })),
          ),
          principals: model.roles.map((r) => ({
            principal: r.name,
            mayLogin: r.canLogin,
            inherit: r.inherit,
            connectionLimit: r.connectionLimit,
            validUntil: r.validUntil,
            permissions: projected.effectivePermissions[r.name]!,
          })),
        },
      };
      await source.start();
      await prepareHistorical89Fixture(source, database, seed);
      const sourceScope = read(source, recoveryScopeSql);
      expect(sourceScope.unsupportedMaterializedViews).toBe(0);
      expect(sourceScope.unsupportedInternalTriggerModes).toBe(0);
      expect(sourceScope.unsupportedRewriteRules).toBe(0);
      expect(Number(source.query(database, `SELECT count(*) FROM pg_trigger t
        JOIN pg_constraint k ON k.oid=t.tgconstraint
        JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND t.tgisinternal AND k.contype='f'`, "postgres"))).toBeGreaterThan(0);
      sourceIdentity = read(source, recoveryIdentitySql);
      expect(sourceIdentity.systemIdentifier).not.toBe(
        read(referenceModel, recoveryIdentitySql).systemIdentifier,
      );
      const captureStarted = Date.now();
      sharedArtifact = await captureRecoveryArtifact({
        sourceUrl, expectedSource: sourceIdentity, directory: join(root, "capture"),
        reviewedPlan: plan, exclusionReference: "fixture-no-writers",
        consistencyReference: "fixture-no-writers", commands,
      });
      console.info(`recovery_measurement capture_ms=${Date.now() - captureStarted}`);
    }, 240_000);
    beforeAll(async () => {
      // A failing baseline fails the suite setup; no negative can pass vacuously.
      baseline = await fixture();
      baselineResult = await baseline.restore();
    }, 180_000);
    afterAll(() => {
      // Attempt every cleanup even if one container reports an identity failure.
      const errors: unknown[] = [];
      for (const pg of [...targets, source, referenceModel]) {
        try {
          pg.cleanup();
        } catch (e) {
          errors.push(e);
        }
      }
      if (root) rmSync(root, { recursive: true, force: true });
      if (errors.length) throw new Error("recovery_fixture_cleanup_failed");
    }, 120_000);
    async function fixture(drift?: string) {
      const target = managedPg17Fixture();
      targets.push(target);
      await target.start();
      target.query("postgres", `CREATE DATABASE ${database};`, "postgres");
      const expectedIdentity = read(target, recoveryIdentitySql);
      metadataPairs.clear();
      activeTarget = target;
      activeDrift = drift;
      const artifact = sharedArtifact;
      const restore = async () => {
        const started = Date.now();
        try { return await verifyReviewedRestore({
          artifact,
          sourceUrl,
          targetUrl,
          metadataDiagnostic: diagnostic => console.info(`recovery_metadata_difference ${JSON.stringify(diagnostic)}`),
          disposableTarget: {
            purpose: "historical89-disposable-restore",
            reviewReference: "owned-offline-container",
            expectedIdentity,
          },
        }); } finally {
          console.info(`recovery_measurement verify_ms=${Date.now() - started}`);
        }
      };
      return { target, artifact, restore };
    }
    it("restores source89 actual rows, sequence state, original ledger, owners, grants and effective principals", async () => {
      const f = baseline;
      try {
        const result = baselineResult;
        expect(
          readFileSync(join(f.artifact.directory, "recovery.dump"))
            .subarray(0, 5)
            .toString(),
        ).toBe("PGDMP");
        expect(result.ledger).toHaveLength(89);
        expect(result.evidence.catalogSha256.sequences).toMatch(/^sha256:/);
        expect(result.evidence.catalogSha256.aclOwnershipDefaults).toMatch(
          /^sha256:/,
        );
        expect(
          result.evidence.tables.find((t) => t.table === "public.Workspace")
            ?.sourceRows,
        ).toBe(1);
        expect(
          result.evidence.tables.every(
            (t) => t.sourceSha256 === t.targetSha256,
          ),
        ).toBe(true);
        expect(
          f.target.query(
            database,
            "SELECT last_value||':'||is_called FROM public.recovery_sequence",
            "postgres",
          ),
        ).toBe("9223372036854775806:true");
        expect(
          f.target.query(
            database,
            "SELECT checksum FROM public._prisma_migrations ORDER BY migration_name LIMIT 1",
            "postgres",
          ),
        ).toBe(
          source.query(
            database,
            "SELECT checksum FROM public._prisma_migrations ORDER BY migration_name LIMIT 1",
            "postgres",
          ),
        );
      } finally {
        f.target.cleanup();
      }
    }, 180_000);
    it.each([
      [
        "row",
        `UPDATE public."Workspace" SET name='changed' WHERE id='recovery'`,
      ],
      [
        "sequence",
        "SELECT setval('public.recovery_sequence',9223372036854775807,true)",
      ],
      [
        "ledger",
        "UPDATE public._prisma_migrations SET started_at=started_at + interval '1 microsecond' WHERE migration_name=(SELECT min(migration_name) FROM public._prisma_migrations)",
      ],
      ["owner", 'ALTER TABLE public."Workspace" OWNER TO postgres'],
      ["ACL", 'GRANT SELECT ON public."Workspace" TO historical_inherited'],
      ["RLS", 'ALTER TABLE public."Workspace" ENABLE ROW LEVEL SECURITY'],
      ["membership", "GRANT reviewrouter_api TO historical_inherited"],
      ["internal FK trigger", `DO $drift$
        DECLARE chosen record;
        BEGIN
          SELECT n.nspname,c.relname,t.tgname INTO STRICT chosen
          FROM pg_trigger t JOIN pg_constraint k ON k.oid=t.tgconstraint
          JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND t.tgisinternal AND k.contype='f' AND t.tgenabled='O'
          ORDER BY c.relname,t.tgname LIMIT 1;
          EXECUTE format('ALTER TABLE %I.%I DISABLE TRIGGER %I', chosen.nspname,chosen.relname,chosen.tgname);
          IF (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
              JOIN pg_namespace n ON n.oid=c.relnamespace
              WHERE n.nspname='public' AND t.tgisinternal AND t.tgenabled<>'O') <> 1 THEN
            RAISE EXCEPTION 'expected exactly one disabled internal trigger';
          END IF;
        END $drift$`],
      ["rewrite rule", 'CREATE RULE recovery_ignore_insert AS ON INSERT TO public."Workspace" DO INSTEAD NOTHING'],
    ])(
      "rejects actual restored %s drift",
      async (kind, sql) => {
        const f = await fixture(sql);
        try {
          const causes: Record<string, string> = {
            row: "restored_equivalence_rows", sequence: "restored_sequences_mismatch",
            ledger: "restored_ledger_mismatch", owner: "restored_owners_mismatch",
            ACL: "restored_grants_mismatch", RLS: "restored_rls_mismatch",
            membership: "restored_memberships_mismatch",
            "internal FK trigger": "unsupported_internal_trigger_modes",
            "rewrite rule": "unsupported_rewrite_rules",
          };
          await expect(f.restore()).rejects.toThrow(new Error(`historical89_recovery_${causes[kind]}`));
        } finally {
          f.target.cleanup();
        }
      },
      180_000,
    );
    it("rejects a target materialized view before restore", async () => {
      const f = await fixture();
      try {
        f.target.query(database, "CREATE MATERIALIZED VIEW public.recovery_matview AS SELECT 1 AS value", "postgres");
        const targetScope = read(f.target, recoveryScopeSql);
        expect(targetScope.unsupportedMaterializedViews).toBe(1);
        expect(targetScope.unsupportedRewriteRules).toBe(1);
        const before = restoreCalls;
        // Existing target relations fail the earlier empty-target gate.
        await expect(f.restore()).rejects.toThrow(new Error("historical89_recovery_target_not_empty"));
        expect(restoreCalls).toBe(before);
        expect(f.target.query(database, "SELECT value FROM public.recovery_matview", "postgres")).toBe("1");
      } finally {
        f.target.cleanup();
      }
    }, 180_000);
    it("supports ordinary view scope but rejects a source materialized view before backup", async () => {
      source.query(database, "CREATE VIEW public.recovery_view AS SELECT 1 AS value", "postgres");
      try {
        const ordinary = read(source, recoveryScopeSql);
        expect(ordinary.relations).toContainEqual(expect.objectContaining({ name: "recovery_view", kind: "v" }));
        expect(ordinary.unsupportedMaterializedViews).toBe(0);
        expect(ordinary.unsupportedRewriteRules).toBe(0);
        source.query(database, "CREATE MATERIALIZED VIEW public.recovery_matview AS SELECT 1 AS value", "postgres");
        try {
          const materialized = read(source, recoveryScopeSql);
          expect(materialized.unsupportedMaterializedViews).toBe(1);
          expect(materialized.unsupportedRewriteRules).toBe(1);
          const before = dumpCalls;
          await expect(captureRecoveryArtifact({
            sourceUrl, expectedSource: sourceIdentity, directory: join(root, "source-matview-rejected"),
            reviewedPlan: plan, exclusionReference: "fixture-no-writers",
            consistencyReference: "fixture-no-writers", commands,
          })).rejects.toThrow(new Error("historical89_recovery_unsupported_materialized_views"));
          expect(dumpCalls).toBe(before);
        } finally {
          source.query(database, "DROP MATERIALIZED VIEW public.recovery_matview", "postgres");
        }
      } finally {
        source.query(database, "DROP VIEW public.recovery_view", "postgres");
      }
      expect(read(source, recoveryScopeSql).unsupportedMaterializedViews).toBe(0);
      expect(read(source, recoveryScopeSql).unsupportedRewriteRules).toBe(0);
    }, 180_000);
    it("rejects a source user rewrite rule before capturing a dump", async () => {
      source.query(database, 'CREATE RULE recovery_ignore_insert AS ON INSERT TO public."Workspace" DO INSTEAD NOTHING', "postgres");
      try {
        expect(read(source, recoveryScopeSql).unsupportedRewriteRules).toBe(1);
        await expect(captureRecoveryArtifact({
          sourceUrl, expectedSource: sourceIdentity, directory: join(root, "source-rule-rejected"),
          reviewedPlan: plan, exclusionReference: "fixture-no-writers",
          consistencyReference: "fixture-no-writers", commands,
        })).rejects.toThrow(new Error("historical89_recovery_unsupported_rewrite_rules"));
      } finally {
        source.query(database, 'DROP RULE recovery_ignore_insert ON public."Workspace"', "postgres");
      }
      expect(read(source, recoveryScopeSql).unsupportedRewriteRules).toBe(0);
    }, 180_000);
    it("rejects changed real dump bytes before restoring anything", async () => {
      const f = await fixture();
      const path = join(f.artifact.directory, "recovery.dump");
      const original = readFileSync(path);
      try {
        const corrupt = Buffer.from(original);
        corrupt[corrupt.length - 1] ^= 1;
        writeFileSync(path, corrupt);
        await expect(f.restore()).rejects.toThrow("artifact_changed");
        expect(
          f.target.query(
            database,
            "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'",
            "postgres",
          ),
        ).toBe("0");
        expect(readFileSync(path)).toEqual(corrupt);
      } finally {
        writeFileSync(path, original);
        f.target.cleanup();
      }
    }, 180_000);
  },
);
