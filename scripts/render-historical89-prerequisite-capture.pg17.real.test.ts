import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  managedPg17Fixture,
  prepareHistorical89Fixture,
} from "./lib/render-managed-pg17-fixture";
import { captureHistorical89Prerequisites } from "./lib/render-historical89-prerequisite-capture.mjs";
import { renderManagedCatalogSql } from "./lib/render-managed-catalog.mjs";
import { projectionOf } from "./lib/render-managed-transaction-bodies.mjs";
import { renderManagedLedgerSql } from "./lib/render-schema-handoff-policy.mjs";

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
      // Numeric-only diagnosis of the exact projection, using the same role and
      // bounded read-only transaction. Do not raise caps before measuring PG17.
      let dimensions;
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      try {
        await client.query("SET LOCAL statement_timeout = '4s'");
        await client.query("SET LOCAL lock_timeout = '1s'");
        await client.query("SET LOCAL search_path = pg_catalog, public");
        dimensions = await client.query(`WITH capture(value) AS MATERIALIZED (
          ${projectionOf(renderManagedCatalogSql)}
        ) SELECT octet_length(value::text) AS "sqlBytes",
          jsonb_array_length(value->'facts') AS "factRows",
          (SELECT max(jsonb_array_length(a)) FROM jsonb_path_query(
            value, 'strict $.** ? (@.type() == "array")') AS arrays(a)) AS "maxArrayRows",
          octet_length(value::text)>2000000 AS exceeded
        FROM capture LIMIT 2`);
        // No catalog values, identities or credentials are logged.
        console.log("catalog projection dimensions", {
          rows: dimensions.rows,
          fields: dimensions.fields.map(
            ({ name, dataTypeID }: { name: string; dataTypeID: number }) => ({
              name,
              dataTypeID,
            }),
          ),
        });
        expect(dimensions.rows).toHaveLength(1);
        expect(typeof dimensions.rows[0].exceeded).toBe("boolean");
      } finally {
        await client.query("ROLLBACK");
      }
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
        expect(queries.mock.calls).toHaveLength(key === "databaseName" ? 7 : 8);
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
