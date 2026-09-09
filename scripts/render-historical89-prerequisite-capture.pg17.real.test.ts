import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  managedPg17Fixture,
  prepareHistorical89Fixture,
} from "./lib/render-managed-pg17-fixture";
import { captureHistorical89Prerequisites } from "./lib/render-historical89-prerequisite-capture.mjs";
import { renderManagedCatalogSql } from "./lib/render-managed-catalog.mjs";
import { projectionOf } from "./lib/render-managed-transaction-bodies.mjs";
import {
  renderManagedEvidenceDigest,
  renderManagedLedgerSql,
} from "./lib/render-schema-handoff-policy.mjs";

const source = {
  commit: "7403be15644ee634e565d77f06355df1713e45fb",
  label: "offline-pg17-prerequisite-proof",
};

// Required mode deliberately runs setup even when Docker is unavailable.
(process.env.REVIEW_ROUTER_REQUIRE_HANDOFF_PG17 === "1"
  ? describe
  : describe.skip)("historical89 prerequisite capture, offline PG17.10", () => {
  const pg = managedPg17Fixture();
  const disposableDB = "rr_prerequisite89";
  let expected: {
    databaseName: string;
    databaseOid: string;
    systemIdentifier: string;
    sessionUser: string;
    currentRole: string;
  };
  let ledgerBefore: unknown[];
  const ledger = () =>
    JSON.parse(pg.query(disposableDB, renderManagedLedgerSql));

  beforeAll(async () => {
    await pg.start();
    await prepareHistorical89Fixture(pg, disposableDB, "");
    // Explicit disposable observer grants; production privileges are not assumed.
    pg.query(
      disposableDB,
      `
      REVOKE EXECUTE ON FUNCTION pg_catalog.pg_control_system() FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO reviewrouter;
      CREATE ROLE rr_capture_restricted LOGIN;
      REVOKE EXECUTE ON FUNCTION pg_catalog.pg_control_system() FROM rr_capture_restricted;
      REVOKE ALL ON ALL TABLES IN SCHEMA public FROM rr_capture_restricted;
    `,
      "postgres",
    );
    expected = JSON.parse(
      pg.query(
        disposableDB,
        `SELECT jsonb_build_object(
      'databaseName',current_database(),
      'databaseOid',(SELECT oid::text FROM pg_database WHERE datname=current_database()),
      'systemIdentifier',(SELECT system_identifier::text FROM pg_control_system()),
      'sessionUser','reviewrouter','currentRole','reviewrouter')`,
        "postgres",
      ),
    );
    ledgerBefore = ledger();
    expect(ledgerBefore).toHaveLength(89);
  }, 300_000);
  afterAll(() => pg.cleanup());

  async function connected(user = "reviewrouter") {
    // One real pg.Client, one raw wire stream, one backend for the entire capture.
    // Both TCP endpoints are inside the fixture's --network none container.
    const { Client } = createRequire(import.meta.url)("pg");
    const client = new Client({
      user,
      database: disposableDB,
      host: "127.0.0.1",
      port: 5432,
      ssl: false,
      stream: pg.wireStream,
      connectionTimeoutMillis: 5_000,
      password: () => {
        throw new Error("offline_fixture_auth_unexpected");
      },
    });
    await client.connect();
    return client;
  }

  async function assertReusable(
    client: Awaited<ReturnType<typeof connected>>,
    pid: number,
  ) {
    expect(
      pg.query(
        disposableDB,
        `SELECT state||':'||(xact_start IS NULL)::text FROM pg_stat_activity WHERE pid=${pid}`,
        "postgres",
      ),
    ).toBe("idle:true");
    const { rows } = await client.query(`SELECT pg_backend_pid() AS pid,
      current_setting('transaction_read_only') AS readonly`);
    expect(rows).toEqual([{ pid, readonly: "off" }]);
    expect(ledger()).toEqual(ledgerBefore);
  }

  it("collects the entire authentic89 snapshot read-only without changing the ledger", async () => {
    const client = await connected();
    try {
      const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]
        .pid;
      // Capture first: no catalog dimension probe warms this fixture beforehand.
      await client.query("SET jit = on");
      const queries = vi.spyOn(client, "query");
      const result = await captureHistorical89Prerequisites({
        client,
        expected,
        source,
        idleClient: true,
      });
      expect(result.collectionComplete, JSON.stringify(result.collection)).toBe(
        true,
      );
      expect(
        Object.values(result.collection).every(
          (value) => value === "collected",
        ),
      ).toBe(true);
      expect(result.observations.identity).toMatchObject({
        ...Object.fromEntries(
          Object.entries(expected).filter(
            ([key]) => key !== "systemIdentifier",
          ),
        ),
        backendPid: pid,
        readOnly: "on",
        isolation: "repeatable read",
      });
      expect(result.observations.cluster.systemIdentifier).toBe(
        expected.systemIdentifier,
      );
      expect(result.observations.ledger).toEqual(ledgerBefore);
      expect(result.ledgerObservation?.count).toBe(89);
      expect(result.observations.catalog.facts.length).toBeGreaterThan(0);
      expect(result.observations.objectAcl.rows.length).toBeGreaterThan(0);
      expect(result.migrationIdentities).toBeDefined();
      expect(result.rollbackConfirmed).toBe(true);
      expect(result.authorizesProductionMutation).toBe(false);
      expect(result.unresolvedCapabilities).toContain(
        "independent-admission-review",
      );
      const catalogQuery = queries.mock.calls
        .map(([query]) => query)
        .find(
          (query) =>
            typeof query === "object" &&
            query.text.includes(projectionOf(renderManagedCatalogSql)),
        );
      queries.mockRestore();
      expect(catalogQuery).toBeDefined();
      expect((await client.query("SHOW jit")).rows).toEqual([{ jit: "on" }]);
      // Reuse the exact bounded collector query, same owner and snapshot for both
      // modes. Full deep equality and canonical digests preserve order/duplicates.
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      try {
        await client.query("SET LOCAL statement_timeout = '4s'");
        await client.query("SET LOCAL lock_timeout = '1s'");
        await client.query(
          "SET LOCAL idle_in_transaction_session_timeout = '5s'",
        );
        await client.query("SET LOCAL search_path = pg_catalog, public");
        await client.query("SET LOCAL jit = on");
        const on = await client.query(catalogQuery);
        await client.query("SET LOCAL jit = off");
        const off = await client.query(catalogQuery);
        expect(on.rows).toHaveLength(1);
        expect(on.rows[0].exceeded).toBe(false);
        expect(off.rows).toEqual(on.rows);
        expect(renderManagedEvidenceDigest(off.rows[0].value)).toBe(
          renderManagedEvidenceDigest(on.rows[0].value),
        );
        expect(off.rows[0].value).toEqual(result.observations.catalog);
      } finally {
        await client.query("ROLLBACK");
      }
      expect((await client.query("SHOW jit")).rows).toEqual([{ jit: "on" }]);
      await assertReusable(client, pid);
    } finally {
      await client.end();
    }
  }, 60_000);

  it("allows a deliberately delayed catalog above 4s and resets subsequent reads to 4s", async () => {
    const client = await connected();
    try {
      await client.query("SET jit = on");
      await client.query("SET statement_timeout = '3s'");
      const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]
        .pid;
      const query = client.query.bind(client);
      let elapsedMs = 0;
      let afterCatalog = false;
      let subsequentReads = 0;
      const queries = vi
        .spyOn(client, "query")
        .mockImplementation(async (config: any) => {
          if (config.text?.includes(projectionOf(renderManagedCatalogSql))) {
            expect(config.query_timeout).toBe(16_000);
            expect((await query("SHOW statement_timeout")).rows).toEqual([
              { statement_timeout: "15s" },
            ]);
            expect((await query("SHOW jit")).rows).toEqual([{ jit: "off" }]);
            const started = performance.now();
            // Deliberate fixture delay in the same statement, not production performance evidence.
            const response = await query({
              ...config,
              text: `WITH delayed AS MATERIALIZED (SELECT pg_sleep(4.2)) SELECT captured.* FROM delayed CROSS JOIN (${config.text}) captured`,
            });
            elapsedMs = performance.now() - started;
            afterCatalog = true;
            return response;
          }
          expect(config.query_timeout).toBe(5_000);
          if (afterCatalog && config.text?.startsWith("WITH capture")) {
            subsequentReads++;
            expect((await query("SHOW statement_timeout")).rows).toEqual([
              { statement_timeout: "4s" },
            ]);
          }
          return query(config);
        });
      const result = await captureHistorical89Prerequisites({
        client,
        expected,
        source,
        idleClient: true,
      });
      expect(result.collectionComplete, JSON.stringify(result.collection)).toBe(
        true,
      );
      expect(result.rollbackConfirmed).toBe(true);
      expect(result.authorizesProductionMutation).toBe(false);
      expect(result.observations.catalog.facts.length).toBeGreaterThan(0);
      expect(elapsedMs).toBeGreaterThan(4_000);
      expect(elapsedMs).toBeLessThan(15_000);
      expect(subsequentReads).toBe(3);
      queries.mockRestore();
      expect((await client.query("SHOW statement_timeout")).rows).toEqual([
        { statement_timeout: "3s" },
      ]);
      expect((await client.query("SHOW jit")).rows).toEqual([{ jit: "on" }]);
      await assertReusable(client, pid);
    } finally {
      await client.end();
    }
  }, 30_000);

  it("retains prior evidence after a real server timeout and restores JIT on rollback", async () => {
    const client = await connected();
    try {
      await client.query("SET jit = on");
      await client.query("SET statement_timeout = '3s'");
      const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]
        .pid;
      const query = client.query.bind(client);
      let serverCode: string | undefined;
      let elapsedMs = 0;
      const queries = vi
        .spyOn(client, "query")
        .mockImplementation(async (config: any) => {
          if (config.text?.includes(projectionOf(renderManagedCatalogSql))) {
            expect(config.query_timeout).toBe(16000);
            expect((await query("SHOW jit")).rows).toEqual([{ jit: "off" }]);
            expect((await query("SHOW statement_timeout")).rows).toEqual([
              { statement_timeout: "15s" },
            ]);
            const started = performance.now();
            try {
              // Only this disposable fault injection replaces the catalog read.
              return await query({ ...config, text: "SELECT pg_sleep(20)" });
            } catch (error: any) {
              elapsedMs = performance.now() - started;
              serverCode = error.code;
              throw error;
            }
          }
          return query(config);
        });
      const result = await captureHistorical89Prerequisites({
        client,
        expected,
        source,
        idleClient: true,
      });
      expect(result.authorizesProductionMutation).toBe(false);
      expect(serverCode).toBe("57014");
      expect(elapsedMs).toBeGreaterThanOrEqual(14_900);
      expect(elapsedMs).toBeLessThan(16_000);
      for (const stage of [
        "identity",
        "cluster",
        "capabilities",
        "gate",
        "ledger",
      ])
        expect(result.collection[stage]).toBe("collected");
      expect(result.collection.catalog).toBe("query-timeout");
      expect(result.digests.ledger).toBe(
        renderManagedEvidenceDigest(ledgerBefore),
      );
      expect(result.collection.memberships).toBe("not-collected");
      expect(result.collectionComplete).toBe(false);
      expect(result.rollbackConfirmed).toBe(true);
      expect(queries.mock.calls.at(-1)?.[0].text).toBe("ROLLBACK");
      expect(
        queries.mock.calls.filter(([q]) => q.text?.startsWith("WITH capture")),
      ).toHaveLength(6);
      queries.mockRestore();
      expect((await client.query("SHOW statement_timeout")).rows).toEqual([
        { statement_timeout: "3s" },
      ]);
      expect((await client.query("SHOW jit")).rows).toEqual([{ jit: "on" }]);
      await assertReusable(client, pid);
    } finally {
      await client.end();
    }
  }, 60_000);

  it.each(["databaseName", "systemIdentifier"] as const)(
    "refuses wrong %s before broad reads",
    async (key) => {
      const client = await connected();
      try {
        const pid = (await client.query("SELECT pg_backend_pid() AS pid"))
          .rows[0].pid;
        // A call-through spy observes real SQL; no rows or errors are substituted.
        const queries = vi.spyOn(client, "query");
        const result = await captureHistorical89Prerequisites({
          client,
          expected: {
            ...expected,
            [key]:
              key === "databaseName"
                ? "wrong_disposable"
                : `${expected.systemIdentifier}0`,
          },
          source,
          idleClient: true,
        });
        const stage = key === "databaseName" ? "identity" : "cluster";
        expect(result.collection[stage]).toBe("identity-mismatch");
        expect(result.collection.capabilities).toBe("not-collected");
        expect(result.collection.ledger).toBe("not-collected");
        expect(result.collection.cluster).toBe(
          key === "databaseName" ? "not-collected" : "identity-mismatch",
        );
        expect(queries.mock.calls).toHaveLength(key === "databaseName" ? 8 : 9);
        expect(result.collectionComplete).toBe(false);
        expect(result.authorizesProductionMutation).toBe(false);
        expect(result.rollbackConfirmed).toBe(true);
        queries.mockRestore();
        await assertReusable(client, pid);
      } finally {
        await client.end();
      }
    },
    60_000,
  );

  it("returns partial unresolved evidence for a restricted role and rolls back to reusable idle", async () => {
    const client = await connected("rr_capture_restricted");
    try {
      const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]
        .pid;
      expect(
        (
          await client.query(`SELECT has_function_privilege(current_user,
          'pg_catalog.pg_control_system()', 'EXECUTE') AS allowed`)
        ).rows,
      ).toEqual([{ allowed: false }]);
      const result = await captureHistorical89Prerequisites({
        client,
        expected: {
          ...expected,
          sessionUser: "rr_capture_restricted",
          currentRole: "rr_capture_restricted",
        },
        source,
        idleClient: true,
      });
      expect(result.collection.identity).toBe("collected");
      expect(result.observations.identity.backendPid).toBe(pid);
      expect(result.collection.cluster).toBe("permission-denied");
      expect(result.collection.capabilities).toBe("not-collected");
      expect(result.collection.ledger).toBe("not-collected");
      expect(result.unresolvedCapabilities).toContain(
        "cluster:permission-denied",
      );
      expect(result.collectionComplete).toBe(false);
      expect(result.authorizesProductionMutation).toBe(false);
      expect(result.rollbackConfirmed).toBe(true);
      await assertReusable(client, pid);
    } finally {
      await client.end();
    }
  }, 60_000);
});
