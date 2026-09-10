import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  managedPg17Fixture,
  prepareHistorical89Fixture,
  waitFor,
} from "./lib/render-managed-pg17-fixture";
import { cleanupHistorical89RecoveryFixture } from "./lib/render-historical89-recovery-cleanup.fixture";

// Supplements verifyReviewedRestore's different-cluster data/ACL qualification;
// it does not establish password recovery or real production authentication.
// These fixed TEST passwords authenticate only synthetic roles in an offline,
// disposable container. No role/password is recreated during logical restore.
const principals = [
  { user: "reviewrouter", password: "TEST-owner-same-database-89" },
  { user: "reviewrouter_api", password: "TEST-api-same-database-89" },
  { user: "rr_auth_reader", password: "TEST-reader-same-database-89" },
] as const;
const database = "rr_recovery_auth89";
const seed = `INSERT INTO public."Workspace" (id,slug,name,"updatedAt")
  VALUES ('auth89','auth89','disposable auth recovery',now());`;

// Opt-in follows the existing real PG17 suites: requested prerequisites fail
// hard, including missing Docker, pinned image, pg, or installed Prisma engine.
(process.env.REVIEW_ROUTER_REQUIRE_HANDOFF_PG17 === "1"
  ? describe
  : describe.skip)(
  "historical89 same-database credential retention, offline PG17.10",
  () => {
    const pg = managedPg17Fixture();
    let root: string | undefined;
    const query = (sql: string) => pg.query(database, sql, "postgres");
    const json = (sql: string) => JSON.parse(query(sql));
    afterAll(() => cleanupHistorical89RecoveryFixture([pg], root), 120_000);

    // A new Client and backend for every probe, including rejected credentials.
    // The fixture transports the real Client's SCRAM exchange through Docker
    // stdio; both TCP endpoints stay inside its --network none container.
    async function probe(user: string, password: string, sql: string) {
      const { Client } = createRequire(import.meta.url)("pg");
      const client = new Client({
        user,
        password,
        database,
        host: "127.0.0.1",
        port: 5432,
        ssl: false,
        stream: pg.wireStream,
        connectionTimeoutMillis: 5_000,
        query_timeout: 10_000,
      });
      try {
        await client.connect();
        return (await client.query(sql)).rows;
      } finally {
        await client.end();
      }
    }

    // Observe actual cluster identity, every role attribute/OID and every PG17
    // membership option/grantor. Verifiers stay inside PG; only hashes leave it.
    const cluster = () =>
      json(`SELECT jsonb_build_object(
    'systemIdentifier',(SELECT system_identifier::text FROM pg_control_system()),
    'databaseOid',(SELECT oid::text FROM pg_database WHERE datname=current_database()),
    'databaseOwner',(SELECT datdba::regrole::text FROM pg_database WHERE datname=current_database()),
    'roles',(SELECT jsonb_agg((to_jsonb(r)-'rolpassword') ||
      jsonb_build_object('verifierHash',md5(rolpassword)) ORDER BY rolname)
      FROM pg_authid r WHERE rolname !~ '^pg_'),
    'memberships',(SELECT jsonb_agg(to_jsonb(m) ORDER BY roleid,member,grantor)
      FROM pg_auth_members m))`);
    const relation = () =>
      json(`SELECT jsonb_build_object(
    'owner',relowner::regrole::text,'acl',relacl::text)
    FROM pg_class WHERE oid='public."Workspace"'::regclass`);

    async function authenticateAndAuthorize() {
      for (const principal of principals) {
        await expect(
          probe(principal.user, "TEST-deliberately-wrong", "SELECT 1"),
        ).rejects.toMatchObject({ code: "28P01" });
        expect(
          await probe(
            principal.user,
            principal.password,
            "SELECT session_user AS principal, current_database() AS database",
          ),
        ).toEqual([{ principal: principal.user, database }]);
        expect(
          await probe(
            principal.user,
            principal.password,
            `SELECT id,slug,name FROM public."Workspace" WHERE id='auth89'`,
          ),
        ).toEqual([
          { id: "auth89", slug: "auth89", name: "disposable auth recovery" },
        ]);
      }
      const reader = principals[2];
      // A real attempted mutation must fail with insufficient_privilege, not an
      // authentication, syntax, missing-table, or constraint error.
      await expect(
        probe(
          reader.user,
          reader.password,
          `UPDATE public."Workspace" SET name='reader mutation' WHERE id='auth89'`,
        ),
      ).rejects.toMatchObject({ code: "42501" });
      const api = principals[1];
      expect(
        await probe(
          api.user,
          api.password,
          `UPDATE public."Workspace" SET name=name WHERE id='auth89' RETURNING id`,
        ),
      ).toEqual([{ id: "auth89" }]);
    }

    it("keeps TEST credentials and cluster principals while restoring data and ACLs into the existing database", async () => {
      await pg.start();
      await prepareHistorical89Fixture(pg, database, seed);
      query(`SET password_encryption='scram-sha-256';
      CREATE ROLE rr_auth_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
        INHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 3;
      CREATE ROLE rr_auth_read_access NOLOGIN;
      GRANT rr_auth_read_access TO rr_auth_reader
        WITH ADMIN FALSE, INHERIT TRUE, SET FALSE GRANTED BY postgres;
      GRANT CONNECT ON DATABASE ${database} TO reviewrouter_api, rr_auth_reader;
      GRANT USAGE ON SCHEMA public TO reviewrouter_api, rr_auth_read_access;
      GRANT SELECT, UPDATE ON public."Workspace" TO reviewrouter_api;
      GRANT SELECT ON public."Workspace" TO rr_auth_read_access;`);
      for (const principal of principals) {
        query(`SET password_encryption='scram-sha-256';
        ALTER ROLE ${principal.user} PASSWORD '${principal.password}';`);
      }
      expect(
        json(`SELECT jsonb_agg(rolname ORDER BY rolname) FROM pg_authid
        WHERE rolpassword LIKE 'SCRAM-SHA-256$%'`),
      ).toEqual(principals.map((p) => p.user).sort());

      // Replace, rather than append after, the fixture's trust rules. Only the
      // postgres maintenance connection stays trusted for fixed fixture helpers.
      const loaded = query("SELECT pg_conf_load_time()::text");
      query(`DO $hba$ BEGIN
      EXECUTE format('COPY (SELECT unnest(ARRAY[%L,%L])) TO %L',
        'host all postgres 127.0.0.1/32 trust',
        'host all all 127.0.0.1/32 scram-sha-256', current_setting('hba_file'));
      END $hba$; SELECT pg_reload_conf();`);
      await waitFor(() => query("SELECT pg_conf_load_time()::text") !== loaded);
      expect(
        json(`SELECT jsonb_agg(jsonb_build_object(
        'users',user_name,'method',auth_method,'error',error) ORDER BY rule_number)
        FROM pg_hba_file_rules`),
      ).toEqual([
        { users: ["postgres"], method: "trust", error: null },
        { users: ["all"], method: "scram-sha-256", error: null },
      ]);

      const before = cluster();
      expect(before.databaseOwner).toBe("reviewrouter");
      const role = (name: string) =>
        before.roles.find((r: { rolname: string }) => r.rolname === name);
      expect(role("reviewrouter")).toMatchObject({
        rolcanlogin: true,
        rolsuper: false,
        rolcreatedb: true,
        rolcreaterole: true,
      });
      expect(role("reviewrouter_api")).toMatchObject({
        rolcanlogin: true,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
      });
      expect(role("rr_auth_reader")).toMatchObject({
        rolcanlogin: true,
        rolsuper: false,
        rolconnlimit: 3,
        rolinherit: true,
      });
      expect(before.memberships).toContainEqual(
        expect.objectContaining({
          roleid: role("rr_auth_read_access").oid,
          member: role("rr_auth_reader").oid,
          grantor: role("postgres").oid,
          admin_option: false,
          inherit_option: true,
          set_option: false,
        }),
      );
      const aclBefore = relation();
      expect(aclBefore.owner).toBe("reviewrouter");
      expect(aclBefore.acl).toContain("rr_auth_read_access=r/");
      expect(query("SELECT count(*) FROM public._prisma_migrations")).toBe(
        "89",
      );
      await authenticateAndAuthorize();

      root = mkdtempSync(join(tmpdir(), "rr-recovery-auth89-"));
      const archive = join(root, "recovery.dump");
      const commands = pg.recoveryCommands("dpg-source");
      const connection = [
        "--host",
        "dpg-source",
        "--port",
        "5432",
        "--username",
        "postgres",
        "--dbname",
        database,
      ];
      commands.execute("pg_dump", [
        ...connection,
        "--format=custom",
        "--file",
        archive,
      ]);
      expect(cluster()).toEqual(before);
      await authenticateAndAuthorize();

      // Remove dumped objects, never DROP DATABASE/ROLE. The missing table proves
      // subsequent SELECTs cannot pass on the pre-restore seed left in place.
      query("DROP SCHEMA public CASCADE");
      expect(query(`SELECT to_regclass('public."Workspace"') IS NULL`)).toBe(
        "t",
      );
      expect(cluster()).toEqual(before);
      // pg_dump treats public as a pre-existing database schema; recreate only
      // its empty namespace after proving that the original objects are gone.
      query("CREATE SCHEMA public AUTHORIZATION reviewrouter");
      commands.execute("pg_restore", [
        ...connection,
        "--exit-on-error",
        "--single-transaction",
        archive,
      ]);

      expect(cluster()).toEqual(before);
      expect(relation()).toEqual(aclBefore);
      expect(query("SELECT count(*) FROM public._prisma_migrations")).toBe(
        "89",
      );
      await authenticateAndAuthorize();
    }, 300_000);
  },
);
