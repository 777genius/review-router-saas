import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedLegacyRows } from "./hosted-pool-e2e/legacy-migration-fixture";
import { managedPg17Fixture, waitFor } from "./lib/render-managed-pg17-fixture";
import { renderSchemaHandoffTransaction } from "./lib/render-schema-handoff-transaction.mjs";
import {
  renderManagedCoordinatorExclusionSql,
  renderRetainedLedgerGuard,
} from "./lib/render-retained-exclusion.mjs";
import {
  classifyRenderManagedMembership,
  inspectRenderManagedLedger,
  readRenderSchemaHandoffCatalog,
  renderManagedLedgerSql,
  renderManagedMembershipCleanupSql,
  renderManagedMembershipSql,
  renderManagedTemporaryMembershipSql,
  renderManagedTerminalCustodySql,
} from "./lib/render-schema-handoff-policy.mjs";

// A real Prisma/PG17 qualification of writer exclusion and the retained SQL.
// This fixture supplies no independently approved production topology, fence,
// custody or receipt. It cannot qualify either complete production adapter.
const required = process.env.REVIEW_ROUTER_REQUIRE_HANDOFF_PG17 === "1";
(required ? describe : describe.skip)(
  "retained Prisma writer exclusion on disposable PG17.10",
  () => {
    const pg = managedPg17Fixture();
    const catalog = readRenderSchemaHandoffCatalog();
    const original = {
      role: "reviewrouter_release_schema_owner",
      member: "reviewrouter",
      grantor: "postgres",
      adminOption: true,
      inheritOption: false,
      setOption: false,
    };
    const retainedBinding = {
      operationId: randomUUID(),
      implementationSha: "a".repeat(40),
      custodyDigest: `sha256:${"b".repeat(64)}`,
    };
    const guard = renderRetainedLedgerGuard(retainedBinding);
    const prefix = (database: string) =>
      inspectRenderManagedLedger(
        catalog,
        JSON.parse(pg.query(database, renderManagedLedgerSql)),
        "managed-retained-upgrade",
      );
    const clone = (database: string, installGuard = true) => {
      pg.query(
        "postgres",
        `CREATE DATABASE ${database} WITH TEMPLATE managed_baseline OWNER reviewrouter`,
        "postgres",
      );
      pg.query(
        database,
        `GRANT USAGE, CREATE ON SCHEMA public TO reviewrouter_release_schema_owner;
      ${renderManagedTemporaryMembershipSql}`,
      );
      if (installGuard)
        pg.query(
          database,
          `BEGIN; ${renderManagedCoordinatorExclusionSql} ${guard.installSql} COMMIT;`,
        );
      expect(prefix(database).count).toBe(76);
    };
    const releaseSession = async (session: ReturnType<typeof pg.session>) => {
      session.end("ROLLBACK;\n");
      await session.result;
    };
    const hold = async (database: string, source: string) => {
      const session = pg.session(database);
      session.write(
        `BEGIN; ${source}\nSELECT 'fixture-pid:'||pg_backend_pid();\n\\echo fixture-ready\n`,
      );
      await waitFor(() => session.stdout().includes("fixture-ready"));
      const pid = Number(
        session
          .stdout()
          .split("\n")
          .find((line: string) => /^fixture-pid:\d+$/u.test(line))
          ?.slice("fixture-pid:".length),
      );
      expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
      return { session, pid };
    };

    beforeAll(async () => {
      await pg.start();
      // Historical pre-76 migrations take the self-hosted branch here, as in the
      // managed source-prefix candidate. Restricted release roles are added at76.
      pg.query(
        "postgres",
        "CREATE ROLE reviewrouter LOGIN; CREATE DATABASE managed_baseline OWNER reviewrouter;",
        "postgres",
      );
      expect(
        await pg.apply("managed_baseline", 76, "rr-fixture-baseline").result,
      ).toEqual(catalog.slice(0, 76).map((r) => r.migrationName));
      pg.query(
        "managed_baseline",
        "ALTER SCHEMA public OWNER TO reviewrouter;",
      );
      pg.query("managed_baseline", seedLegacyRows);
      expect(prefix("managed_baseline").count).toBe(76);
      pg.query(
        "postgres",
        `CREATE ROLE reviewrouter_release_schema_owner;
      CREATE ROLE reviewrouter_release_migration LOGIN;
      CREATE ROLE reviewrouter_comment_token_custody LOGIN;
      GRANT reviewrouter_release_schema_owner TO reviewrouter
        WITH ADMIN TRUE, INHERIT FALSE, SET FALSE GRANTED BY postgres;`,
        "postgres",
      );
    }, 150_000);
    afterAll(() => pg.cleanup());

    it.each([
      "reviewrouter_release_schema_owner",
      "reviewrouter_release_migration",
    ])("published scope 000079 rejects missing %s before DDL", (missing) => {
      const sql = readFileSync(
        new URL(
          "../packages/platform/db/prisma/migrations/000079_remove_account_wide_provider_lane_serialization/migration.sql",
          import.meta.url,
        ),
        "utf8",
      );
      // Role changes and exact migration bytes are rolled back when psql exits
      // on the topology exception. No published bytes or ledger are patched.
      expect(() =>
        pg.query(
          "managed_baseline",
          `BEGIN; ALTER ROLE ${missing} RENAME TO fixture_absent;
        SET SESSION AUTHORIZATION reviewrouter; ${sql}`,
          "postgres",
        ),
      ).toThrow(
        `provider_scope_concurrency_authority_roles_partial:${missing}_missing`,
      );
      expect(prefix("managed_baseline").count).toBe(76);
    });

    it("shows why the both-absent self-hosted branch cannot qualify managed upgrade", () => {
      const sql = readFileSync(
        new URL(
          "../packages/platform/db/prisma/migrations/000079_remove_account_wide_provider_lane_serialization/migration.sql",
          import.meta.url,
        ),
        "utf8",
      );
      const observed = pg.query(
        "managed_baseline",
        `BEGIN;
      ALTER ROLE reviewrouter_release_schema_owner RENAME TO fixture_owner_absent;
      ALTER ROLE reviewrouter_release_migration RENAME TO fixture_release_absent;
      SET SESSION AUTHORIZATION reviewrouter; ${sql}
      SELECT to_regprocedure('public.reviewrouter_provider_scope_concurrency_status()') IS NULL;
      ROLLBACK;`,
        "postgres",
      );
      expect(observed).toBe("t");
      expect(prefix("managed_baseline").count).toBe(76);
    });

    it("retains populated data and exclusion after the installing coordinator backend dies, then verifies89 from fresh restricted sessions", async () => {
      const database = "retained_success";
      clone(database, false);
      const coordinator = await hold(
        database,
        `${renderManagedCoordinatorExclusionSql} ${guard.installSql} COMMIT;`,
      );
      const blocker = await hold(
        database,
        'LOCK TABLE public."HostedCodexRelayRequest" IN ACCESS EXCLUSIVE MODE;',
      );
      const engine = pg.apply(database, 89, guard.applicationName);
      try {
        // The committed start row and both advisory locks belong to the actual
        // Prisma backend, even while migration75 waits in its own transaction.
        await waitFor(
          () =>
            pg.query(
              database,
              `SELECT count(*) FROM pg_catalog.pg_locks l
        JOIN pg_catalog.pg_stat_activity a ON a.pid=l.pid
        WHERE a.application_name='${guard.applicationName}' AND l.locktype='advisory'
          AND l.classid=1381126735 AND l.objid=1129271120 AND l.objsubid=2 AND l.granted;`,
            ) === "1",
        );
        expect(() => prefix(database)).toThrow("managed_ledger_history");
        expect(
          pg.query(
            database,
            `SELECT pg_terminate_backend(${coordinator.pid}) WHERE EXISTS (
        SELECT 1 FROM pg_catalog.pg_stat_activity WHERE pid=${coordinator.pid} AND datname='${database}' AND usename='reviewrouter');`,
            "postgres",
          ),
        ).toBe("t");
        // psql waits on stdin while idle. Force a round trip so it observes the
        // terminated backend instead of waiting for the fixture timeout.
        coordinator.session.end("SELECT 1;\n");
        await coordinator.session.result;
        expect(
          pg.query(
            database,
            "SELECT pg_try_advisory_xact_lock(1381126735,1129271120)",
          ),
        ).toBe("f");
      } finally {
        await releaseSession(blocker.session);
        await coordinator.session.terminateAndWait();
      }
      expect(await engine.result).toEqual(
        catalog.slice(76, 89).map((r) => r.migrationName),
      );
      expect(prefix(database).count).toBe(89);
      expect(
        JSON.parse(
          pg.query(
            database,
            `SELECT jsonb_build_object(
      'account',(SELECT jsonb_build_array(state,"healthVersion") FROM "HostedCodexAccount" WHERE id='account-legacy'),
      'grant',(SELECT jsonb_build_array(status,"inFlight","requestCount","revokedAt" IS NOT NULL) FROM "HostedCodexInvocationGrant" WHERE id='grant-legacy'),
      'request',(SELECT jsonb_build_array(status,"errorCode","completedAt" IS NOT NULL) FROM "HostedCodexRelayRequest" WHERE id='request-legacy'),
      'revision',(SELECT jsonb_build_array("custodyMode",reason,"encryptedCiphertext") FROM "HostedCodexCredentialEnvelopeRevision" WHERE "credentialVersionId"='credential-legacy'),
      'gate',(SELECT status FROM "HostedCodexRuntimeGate" WHERE id='global'),
      'legacyBarriers',(SELECT count(*) FROM "HostedCodexRuntimeClosure" WHERE state='draining' AND "legacyBarrier"));`,
          ),
        ),
      ).toEqual({
        account: ["restore_quarantined", 2],
        grant: ["revoked", 0, 1, true],
        request: [
          "terminal_unknown",
          "security_certification_upgrade_unknown",
          true,
        ],
        revision: ["legacy_env", "legacy_upgrade", "Y2lwaGVydGV4dA=="],
        gate: "closed",
        legacyBarriers: 1,
      });
      pg.query(
        database,
        `BEGIN; ${renderManagedCoordinatorExclusionSql} ${guard.verifySql}
      ALTER TABLE public."ReviewProviderScopeConcurrencyControl" OWNER TO reviewrouter_release_schema_owner;
      ALTER TABLE public."ReviewInvocationLeaseV2" OWNER TO reviewrouter_release_schema_owner;
      REVOKE CREATE ON SCHEMA public FROM reviewrouter_release_schema_owner;
      ${renderManagedMembershipCleanupSql} COMMIT;`,
      );
      const membership = () =>
        JSON.parse(pg.query(database, renderManagedMembershipSql));
      expect(classifyRenderManagedMembership(membership(), original)).toBe(
        "original",
      );
      expect(() =>
        pg.query(database, "SET ROLE reviewrouter_release_schema_owner"),
      ).toThrow("permission denied to set role");
      expect(() =>
        pg.query(
          database,
          'SELECT * FROM public."ReviewProviderScopeConcurrencyControl"',
        ),
      ).toThrow("permission denied");
      expect(
        JSON.parse(
          pg.query(
            database,
            "SELECT reviewrouter_provider_scope_concurrency_status()",
            "reviewrouter_release_migration",
          ),
        ),
      ).toMatchObject({
        activated: false,
        duplicateActiveVoteLanes: 0,
        legacyProviderVoteIndex: { exact: true },
      });
      expect(
        JSON.parse(
          pg.query(
            database,
            renderManagedTerminalCustodySql,
            "reviewrouter_comment_token_custody",
          ),
        ),
      ).toMatchObject({ gateStatus: "closed", authorityProbeCount: 0 });
      pg.query(
        database,
        `BEGIN; ${renderManagedCoordinatorExclusionSql} ${guard.verifySql} COMMIT;`,
      );
      expect(prefix(database).count).toBe(89);
      // A stale full-catalog engine cannot start87, even after temporary cleanup.
      await expect(
        pg.apply(database, 92, guard.applicationName).result,
      ).rejects.toThrow("render_retained_ledger_identity");
      expect(prefix(database).count).toBe(89);
    }, 90_000);

    it.each([87, 88, 89])(
      "rolls back the complete handoff after migration%i, including owners, grants and guard adoption",
      async (faultAfter) => {
        const database = `handoff_rollback_${faultAfter}`;
        pg.query(
          "postgres",
          `CREATE DATABASE ${database} WITH TEMPLATE retained_success OWNER reviewrouter`,
          "postgres",
        );
        const ledger = JSON.parse(pg.query(database, renderManagedLedgerSql));
        const plan = renderSchemaHandoffTransaction({
          ledger,
          retainedBinding,
          originalMembership: original,
        });
        const starts = [
          ...plan.matchAll(/^INSERT INTO public\._prisma_migrations/gmu),
        ].map((match) => match.index!);
        const partial =
          faultAfter === 89 ? plan : plan.slice(0, starts[faultAfter - 86]);
        const session = pg.session(database);
        session.write(partial + "\n\\echo handoff-applied\n");
        try {
          await waitFor(() => {
            if (session.closedResult())
              throw new Error(
                `handoff_fixture_session_ended:${session.stderr()}`,
              );
            return session.stdout().includes("handoff-applied");
          });
          // The canonical lock stays held despite each removed migration envelope.
          expect(
            pg.query(
              database,
              "SELECT pg_try_advisory_xact_lock(1381126735,1129271120)",
            ),
          ).toBe("f");
          session.end("SELECT 1/0;\nCOMMIT;\n");
          await session.result;
          expect(session.stderr()).toContain("division by zero");
        } finally {
          await session.terminateAndWait();
        }
        expect(JSON.parse(pg.query(database, renderManagedLedgerSql))).toEqual(
          ledger,
        );
        expect(
          pg.query(
            database,
            `SELECT count(*) FROM pg_attribute WHERE attrelid='public."CodexOAuthSecretNamespace"'::regclass AND attname='workflowSchemaVersion' AND NOT attisdropped`,
          ),
        ).toBe("0");
        expect(
          pg.query(
            database,
            `SELECT to_regclass('public."CodexOAuthWorkflowCompatibility"') IS NULL`,
          ),
        ).toBe("t");
        expect(
          pg.query(
            database,
            `SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='public'`,
          ),
        ).toBe("reviewrouter");
        expect(
          pg.query(
            database,
            `SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public."CodexOAuthSecretNamespace"'::regclass`,
          ),
        ).toBe("reviewrouter");
        expect(
          classifyRenderManagedMembership(
            JSON.parse(pg.query(database, renderManagedMembershipSql)),
            original,
          ),
        ).toBe("original");
        expect(() =>
          pg.query(database, "SET ROLE reviewrouter_release_schema_owner"),
        ).toThrow("permission denied to set role");
        pg.query(
          database,
          `BEGIN; ${renderManagedCoordinatorExclusionSql} ${guard.verifySql} COMMIT;`,
        );
      },
      45_000,
    );

    it("commits exact92 with fresh restricted witnesses and rejects a second handoff plan", () => {
      const database = "handoff_committed";
      pg.query(
        "postgres",
        `CREATE DATABASE ${database} WITH TEMPLATE retained_success OWNER reviewrouter`,
        "postgres",
      );
      const ledger = JSON.parse(pg.query(database, renderManagedLedgerSql));
      pg.query(
        database,
        renderSchemaHandoffTransaction({
          ledger,
          retainedBinding,
          originalMembership: original,
        }) + "\nCOMMIT;",
      );
      const complete = JSON.parse(pg.query(database, renderManagedLedgerSql));
      expect(
        inspectRenderManagedLedger(catalog, complete, "managed-schema-handoff"),
      ).toMatchObject({ count: 92, position: "target" });
      expect(() =>
        renderSchemaHandoffTransaction({
          ledger: complete,
          retainedBinding,
          originalMembership: original,
        }),
      ).toThrow("committed_requires_reconciliation");
      expect(
        classifyRenderManagedMembership(
          JSON.parse(pg.query(database, renderManagedMembershipSql)),
          original,
        ),
      ).toBe("original");
      expect(() =>
        pg.query(database, "SET ROLE reviewrouter_release_schema_owner"),
      ).toThrow("permission denied to set role");
      expect(() =>
        pg.query(database, 'SELECT * FROM public."CodexOAuthSecretNamespace"'),
      ).toThrow("permission denied");
      expect(
        JSON.parse(
          pg.query(
            database,
            "SELECT reviewrouter_provider_scope_concurrency_status()",
            "reviewrouter_release_migration",
          ),
        ),
      ).toMatchObject({
        activated: false,
        duplicateActiveVoteLanes: 0,
        legacyProviderVoteIndex: { exact: true },
      });
      expect(
        JSON.parse(
          pg.query(
            database,
            renderManagedTerminalCustodySql,
            "reviewrouter_comment_token_custody",
          ),
        ),
      ).toMatchObject({ gateStatus: "closed", authorityProbeCount: 0 });
      expect(
        pg.query(
          database,
          `SELECT string_agg(pronargs::text,',') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='codex_oauth_reattest_active_namespace_v4_to_v5'`,
        ),
      ).toBe("21");
    }, 45_000);

    it("reads the new closed-gate revision after a concurrent gate writer commits", async () => {
      const database = "handoff_custody_snapshot";
      pg.query(
        "postgres",
        `CREATE DATABASE ${database} WITH TEMPLATE handoff_committed OWNER reviewrouter`,
        "postgres",
      );
      expect(
        inspectRenderManagedLedger(
          catalog,
          JSON.parse(pg.query(database, renderManagedLedgerSql)),
          "managed-schema-handoff",
        ),
      ).toMatchObject({ count: 92, position: "target" });
      const before = JSON.parse(
        pg.query(
          database,
          renderManagedTerminalCustodySql,
          "reviewrouter_comment_token_custody",
        ),
      );
      // Reaffirm HOLD in the disposable database. Admission remains closed.
      const writer = await hold(
        database,
        `UPDATE public."HostedCodexRuntimeGate"
        SET "revision"="revision"+1,"authzEpoch"="authzEpoch"+1,
          "changedAt"=clock_timestamp(),"reasonCode"='fixture_reaffirm_closed'
        WHERE id='global' AND status='closed';`,
      );
      const reader = pg.session(database, "reviewrouter_comment_token_custody");
      try {
        reader.end(renderManagedTerminalCustodySql + "\n");
        await waitFor(
          () =>
            pg.query(
              database,
              `SELECT count(*) FROM pg_stat_activity
          WHERE datname=current_database() AND usename='reviewrouter_comment_token_custody'
            AND wait_event_type='Lock'`,
              "postgres",
            ) === "1",
        );
        expect(reader.stdout()).toBe("");
        writer.session.end("COMMIT;\n");
        await writer.session.result;
        await reader.result;
        expect(JSON.parse(reader.stdout())).toEqual({
          ...before,
          gateStatus: "closed",
          authzEpoch: (BigInt(before.authzEpoch) + 1n).toString(),
          revision: (BigInt(before.revision) + 1n).toString(),
        });
      } finally {
        await writer.session.terminateAndWait();
        await reader.terminateAndWait();
      }
    }, 30_000);

    it("re-observes committed92 after the server COMMIT response is lost on the wire", async () => {
      const database = "handoff_commit_response_loss";
      pg.query(
        "postgres",
        `CREATE DATABASE ${database} WITH TEMPLATE retained_success OWNER reviewrouter`,
        "postgres",
      );
      expect(pg.query(database, "SHOW synchronous_commit")).toBe("on");
      const ledger = JSON.parse(pg.query(database, renderManagedLedgerSql));
      const loss = await pg.loseCommitResponse(database);
      try {
        loss.client.end(
          renderSchemaHandoffTransaction({
            ledger,
            retainedBinding,
            originalMembership: original,
          }) + "\nCOMMIT;\n",
        );
        await loss.client.result;
        expect(loss.committedResponseDropped()).toBe(true);
        expect(loss.client.stderr()).toContain(
          "server closed the connection unexpectedly",
        );
      } finally {
        await loss.close();
      }
      // Both the client acknowledgement and its connection are absent. Only
      // fresh database observations establish the committed, post-cleanup side.
      const complete = JSON.parse(pg.query(database, renderManagedLedgerSql));
      expect(
        inspectRenderManagedLedger(catalog, complete, "managed-schema-handoff"),
      ).toMatchObject({ count: 92, position: "target" });
      expect(complete.slice(0, 89)).toEqual(ledger);
      expect(() =>
        renderSchemaHandoffTransaction({
          ledger: complete,
          retainedBinding,
          originalMembership: original,
        }),
      ).toThrow("committed_requires_reconciliation");
      expect(
        classifyRenderManagedMembership(
          JSON.parse(pg.query(database, renderManagedMembershipSql)),
          original,
        ),
      ).toBe("original");
      expect(() =>
        pg.query(database, "SET ROLE reviewrouter_release_schema_owner"),
      ).toThrow("permission denied to set role");
      expect(
        pg.query(
          database,
          `SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='public'`,
        ),
      ).toBe("reviewrouter_release_schema_owner");
      expect(
        pg.query(
          database,
          `SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public."CodexOAuthSecretNamespace"'::regclass`,
        ),
      ).toBe("reviewrouter_release_schema_owner");
      expect(
        JSON.parse(
          pg.query(
            database,
            "SELECT reviewrouter_provider_scope_concurrency_status()",
            "reviewrouter_release_migration",
          ),
        ),
      ).toMatchObject({
        activated: false,
        duplicateActiveVoteLanes: 0,
        legacyProviderVoteIndex: { exact: true },
      });
      expect(
        JSON.parse(
          pg.query(
            database,
            renderManagedTerminalCustodySql,
            "reviewrouter_comment_token_custody",
          ),
        ),
      ).toMatchObject({ gateStatus: "closed", authorityProbeCount: 0 });
    }, 60_000);

    it("resumes an exact committed81 prefix with the original guard and rejects guard drift", async () => {
      const database = "retained_resume";
      clone(database);
      expect(
        await pg.apply(database, 81, guard.applicationName).result,
      ).toEqual(catalog.slice(76, 81).map((r) => r.migrationName));
      expect(prefix(database)).toMatchObject({
        count: 81,
        position: "partial",
      });
      pg.query(
        database,
        `BEGIN; ${renderManagedCoordinatorExclusionSql} ${guard.verifySql} COMMIT;`,
      );
      const altered = renderRetainedLedgerGuard({
        operationId: randomUUID(),
        implementationSha: "c".repeat(40),
        custodyDigest: `sha256:${"d".repeat(64)}`,
      });
      expect(() =>
        pg.query(
          database,
          `BEGIN; ${renderManagedCoordinatorExclusionSql} ${altered.verifySql} COMMIT;`,
        ),
      ).toThrow("render_retained_guard_drift");
      await expect(
        pg.apply(database, 89, altered.applicationName).result,
      ).rejects.toThrow("render_retained_writer_identity");
      expect(prefix(database).count).toBe(81);
      expect(
        await pg.apply(database, 89, guard.applicationName).result,
      ).toEqual(catalog.slice(81, 89).map((r) => r.migrationName));
      expect(prefix(database).count).toBe(89);
    }, 90_000);

    it("keeps actual partial Prisma success plus a failed logged row on HOLD without resolve", async () => {
      const database = "retained_failed";
      clone(database);
      // The fault is a competing database session, after guard installation.
      // The earlier output-limit transaction must commit before scope79 fails.
      pg.query(
        "postgres",
        `ALTER ROLE reviewrouter IN DATABASE ${database} SET lock_timeout='1000ms'`,
        "postgres",
      );
      const blocker = await hold(
        database,
        'LOCK TABLE public."ReviewInvocationLeaseV2" IN ACCESS EXCLUSIVE MODE;',
      );
      try {
        await expect(
          pg.apply(database, 89, guard.applicationName).result,
        ).rejects.toThrow("prisma_apply_failed");
      } finally {
        await releaseSession(blocker.session);
      }
      const ledger = JSON.parse(pg.query(database, renderManagedLedgerSql));
      expect(ledger).toHaveLength(82);
      expect(
        ledger.filter(
          (row: { finishedAt: unknown }) => row.finishedAt !== null,
        ),
      ).toHaveLength(81);
      expect(
        ledger.find(
          (row: { migrationName: string }) =>
            row.migrationName === catalog[81]!.migrationName,
        ),
      ).toMatchObject({
        finishedAt: null,
        rolledBackAt: null,
        appliedStepsCount: 0,
        logsPresent: true,
        hasLogs: true,
      });
      expect(() => prefix(database)).toThrow("managed_ledger_history");
      await expect(
        pg.apply(database, 89, guard.applicationName).result,
      ).rejects.toThrow("prisma_apply_failed");
      expect(JSON.parse(pg.query(database, renderManagedLedgerSql))).toEqual(
        ledger,
      );
    }, 90_000);

    it("holds an unfinished row after writer death and only then releases its exclusion", async () => {
      const database = "retained_writer_death";
      clone(database);
      const blocker = await hold(
        database,
        'LOCK TABLE public."HostedCodexRelayRequest" IN ACCESS EXCLUSIVE MODE;',
      );
      const engine = pg.apply(database, 89, guard.applicationName);
      try {
        await waitFor(
          () =>
            pg.query(
              database,
              `SELECT count(*) FROM public._prisma_migrations WHERE finished_at IS NULL`,
            ) === "1",
        );
        expect(
          pg.query(
            database,
            "SELECT pg_try_advisory_xact_lock(1381126735,1129271120)",
          ),
        ).toBe("f");
        expect(
          pg.query(
            database,
            `SELECT pg_terminate_backend(a.pid) FROM pg_catalog.pg_stat_activity a
        WHERE a.application_name='${guard.applicationName}' AND a.datname='${database}' AND a.usename='reviewrouter'`,
            "postgres",
          ),
        ).toBe("t");
        await expect(engine.result).rejects.toThrow();
      } finally {
        await releaseSession(blocker.session);
      }
      expect(
        pg.query(
          database,
          "SELECT pg_try_advisory_xact_lock(1381126735,1129271120)",
        ),
      ).toBe("t");
      expect(() => prefix(database)).toThrow("managed_ledger_history");
      const ledger = JSON.parse(pg.query(database, renderManagedLedgerSql));
      await expect(
        pg.apply(database, 89, guard.applicationName).result,
      ).rejects.toThrow("prisma_apply_failed");
      expect(JSON.parse(pg.query(database, renderManagedLedgerSql))).toEqual(
        ledger,
      );
    }, 60_000);
  },
);
