import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activationMigrationExclusionSql } from "./run-codex-rotating-release-migration.mjs";
import {
  assertEmptyApplicableRenderDefaultAcl,
  classifyRenderManagedMembership,
  inspectRenderManagedLedger,
  readRenderSchemaHandoffCatalog,
  readReviewedRenderManagedContract,
  renderManagedEvidenceDigest,
  renderManagedLedgerSql,
  renderManagedMembershipCleanupSql,
  renderManagedMembershipSql,
  renderManagedTemporaryMembershipSql,
  renderSchemaHandoffDefaultAclSql,
} from "./lib/render-schema-handoff-policy.mjs";
import {
  assertRenderManagedCatalogMatches,
  renderManagedCatalogSql,
} from "./lib/render-managed-catalog.mjs";

// These are prerequisite SQL proofs. Until the production adapter and its
// authenticated baseline exist, this suite cannot qualify a production repair.
const required = process.env.REVIEW_ROUTER_REQUIRE_HANDOFF_PG17 === "1";
const image =
  "postgres:17.10@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317";
const describePg = required ? describe : describe.skip;
const docker = (args: string[], input?: string, timeout = 30_000) =>
  spawnSync("docker", args, {
    input,
    encoding: "utf8",
    timeout,
    maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH, LANG: "C.UTF-8" },
  });
const checked = (args: string[], input?: string) => {
  const result = docker(args, input);
  if (result.status !== 0 || result.error)
    throw new Error(`handoff_pg17_disposable_command_failed:${result.stderr}`);
  return result.stdout.trim();
};

describePg(
  "managed handoff PostgreSQL 17.10 prerequisites (not adapter evidence)",
  () => {
    const token = randomUUID();
    const name = `rr-handoff-prerequisites-${token}`;
    let created = false;
    const psqlArgs = [
      "exec",
      "-i",
      name,
      "psql",
      "-h",
      "127.0.0.1",
      "-U",
      "postgres",
      "-XqAt",
      "-v",
      "ON_ERROR_STOP=1",
    ];
    const sql = (source: string) => checked(psqlArgs, source);
    const ownerSql = (source: string) =>
      checked(
        psqlArgs.map((argument, i) =>
          psqlArgs[i - 1] === "-U" ? "reviewrouter" : argument,
        ),
        source,
      );
    const observe = () => JSON.parse(sql(renderSchemaHandoffDefaultAclSql));
    const principals = ["reviewrouter", "reviewrouter_release_schema_owner"];
    const assertDefaults = () =>
      assertEmptyApplicableRenderDefaultAcl(observe(), principals);

    beforeAll(async () => {
      // No remote Docker context, host port, host mount, shared database, network
      // access or image pull is used. Only our uniquely labelled container exists.
      expect(
        checked([
          "context",
          "inspect",
          "--format",
          "{{.Endpoints.docker.Host}}",
        ]),
      ).toMatch(/^unix:\//u);
      checked(["image", "inspect", image]);
      checked([
        "create",
        "--pull=never",
        "--name",
        name,
        "--label",
        `reviewrouter.handoff.proof=${token}`,
        "--network",
        "none",
        "--read-only",
        "--tmpfs",
        "/var/lib/postgresql/data:rw",
        "--tmpfs",
        "/var/run/postgresql:rw",
        "--tmpfs",
        "/tmp:rw",
        "--env",
        "POSTGRES_HOST_AUTH_METHOD=trust",
        image,
      ]);
      created = true;
      checked(["start", name]);
      let ready = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        const response = docker([...psqlArgs, "-c", "SELECT 1"]);
        if (response.status === 0) {
          ready = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(ready).toBe(true);
      expect(sql("SHOW server_version_num;")).toBe("170010");
      sql(`CREATE ROLE reviewrouter LOGIN;
      CREATE ROLE reviewrouter_release_schema_owner;
      CREATE ROLE reviewrouter_release_migration LOGIN;
      CREATE ROLE unrelated;
      CREATE SCHEMA unrelated;
      GRANT CONNECT ON DATABASE postgres TO reviewrouter;
      GRANT USAGE, CREATE ON SCHEMA public TO reviewrouter;
      GRANT reviewrouter_release_schema_owner TO reviewrouter
        WITH ADMIN TRUE, INHERIT FALSE, SET FALSE GRANTED BY postgres;`);
      // Explicit -d avoids libpq's default database=user when using a fresh
      // managed-owner login. This cluster has no external connections or data.
      psqlArgs.push("-d", "postgres");
    }, 40_000);

    afterAll(() => {
      // Inspect by our unique name even when create acknowledgement was lost.
      const identity = docker([
        "inspect",
        "--format",
        '{{ index .Config.Labels "reviewrouter.handoff.proof" }}',
        name,
      ]);
      if (identity.status === 0 && identity.stdout.trim() === token) {
        checked(["rm", "--force", "--volumes", name]);
        expect(docker(["inspect", name]).status).not.toBe(0);
      } else if (created) {
        throw new Error("handoff_pg17_disposable_cleanup_identity_unresolved");
      }
    });

    it("accepts a real empty applicable default-ACL set", () => {
      expect(observe()).toEqual({ version: 1, rows: [] });
      expect(assertDefaults).not.toThrow();
    });

    it("does not confuse an empty ACL override with an empty applicable set", () => {
      try {
        sql(`ALTER DEFAULT PRIVILEGES FOR ROLE reviewrouter
        REVOKE ALL ON FUNCTIONS FROM PUBLIC;
        ALTER DEFAULT PRIVILEGES FOR ROLE reviewrouter
        REVOKE ALL ON FUNCTIONS FROM reviewrouter;`);
        const observed = observe();
        expect(observed.rows).toHaveLength(1);
        expect(observed.rows[0].entries).toEqual([]);
        expect(assertDefaults).toThrow("default_acl_policy");
      } finally {
        sql(`ALTER DEFAULT PRIVILEGES FOR ROLE reviewrouter
        GRANT ALL ON FUNCTIONS TO PUBLIC;
        ALTER DEFAULT PRIVILEGES FOR ROLE reviewrouter
        GRANT ALL ON FUNCTIONS TO reviewrouter;`);
      }
      expect(observe().rows).toEqual([]);
    });

    it("retains unrelated defaults and detects applicable grantees and PUBLIC", () => {
      try {
        sql(`ALTER DEFAULT PRIVILEGES FOR ROLE unrelated IN SCHEMA unrelated
        GRANT SELECT ON TABLES TO reviewrouter;`);
        expect(observe().rows).toHaveLength(1);
        expect(assertDefaults).not.toThrow();
        sql(`ALTER DEFAULT PRIVILEGES FOR ROLE unrelated IN SCHEMA public
        GRANT SELECT ON TABLES TO reviewrouter;`);
        expect(assertDefaults).toThrow("default_acl_policy");
        sql(`ALTER DEFAULT PRIVILEGES FOR ROLE unrelated IN SCHEMA public
        REVOKE SELECT ON TABLES FROM reviewrouter;
        ALTER DEFAULT PRIVILEGES FOR ROLE unrelated IN SCHEMA public
        GRANT SELECT ON TABLES TO PUBLIC;`);
        expect(assertDefaults).toThrow("default_acl_policy");
      } finally {
        sql(`ALTER DEFAULT PRIVILEGES FOR ROLE unrelated IN SCHEMA unrelated
        REVOKE SELECT ON TABLES FROM reviewrouter;
        ALTER DEFAULT PRIVILEGES FOR ROLE unrelated IN SCHEMA public
        REVOKE SELECT ON TABLES FROM reviewrouter, PUBLIC;`);
      }
      expect(observe().rows).toEqual([]);
    });

    it("preserves unresolved catalog identities rather than dropping them", () => {
      // Deliberate catalog corruption is confined to the owned disposable
      // container and rolled back in the same session. Production never writes it.
      const observed = JSON.parse(
        sql(`BEGIN;
      ALTER DEFAULT PRIVILEGES FOR ROLE reviewrouter
        GRANT SELECT ON TABLES TO unrelated;
      UPDATE pg_catalog.pg_default_acl SET defaclrole=4294967294
        WHERE defaclrole='reviewrouter'::regrole;
      ${renderSchemaHandoffDefaultAclSql}
      ROLLBACK;`),
      );
      expect(observed.rows).toHaveLength(1);
      expect(observed.rows[0].owner).toBeNull();
      expect(() =>
        assertEmptyApplicableRenderDefaultAcl(observed, principals),
      ).toThrow("default_acl_unresolved");
      expect(observe().rows).toEqual([]);
    });

    it("projects full ledger metadata on fresh restricted-owner connections", () => {
      const catalog = readRenderSchemaHandoffCatalog();
      // This is a metadata-projection fixture, not a populated adapter replay or
      // a production trust root. Every source/checksum is the fixed real catalog.
      sql(`CREATE TABLE public._prisma_migrations (
        id varchar(36) PRIMARY KEY, checksum varchar(64) NOT NULL,
        finished_at timestamptz, migration_name varchar(255) NOT NULL,
        logs text, rolled_back_at timestamptz,
        started_at timestamptz NOT NULL DEFAULT now(), applied_steps_count integer NOT NULL DEFAULT 0
      );
      ALTER TABLE public._prisma_migrations OWNER TO reviewrouter;
      INSERT INTO public._prisma_migrations(id,checksum,migration_name,finished_at,applied_steps_count)
      SELECT gen_random_uuid()::text,x->>'checksum',x->>'migrationName',now(),1
      FROM jsonb_array_elements($fixture$${JSON.stringify(catalog.slice(0, 76))}$fixture$::jsonb) x;`);
      try {
        const read = (change = "") =>
          JSON.parse(
            ownerSql(`BEGIN; ${change}\n${renderManagedLedgerSql}\nROLLBACK;`),
          );
        expect(
          inspectRenderManagedLedger(
            catalog,
            read(),
            "managed-retained-upgrade",
          ).count,
        ).toBe(76);
        for (const change of [
          "finished_at=NULL",
          "rolled_back_at=now()",
          "logs='fixture diagnostic which must remain hashed'",
          "applied_steps_count=0",
        ]) {
          const observed = read(`UPDATE public._prisma_migrations SET ${change}
            WHERE migration_name='${catalog[0]!.migrationName}';`);
          expect(JSON.stringify(observed)).not.toContain("fixture diagnostic");
          expect(() =>
            inspectRenderManagedLedger(
              catalog,
              observed,
              "managed-retained-upgrade",
            ),
          ).toThrow("managed_ledger_history");
        }
        expect(
          inspectRenderManagedLedger(
            catalog,
            read(),
            "managed-retained-upgrade",
          ).count,
        ).toBe(76);
      } finally {
        sql("DROP TABLE public._prisma_migrations;");
      }
    });

    it("compares complete catalog facts without promoting an observation into approval", () => {
      ownerSql(`CREATE TABLE public.handoff_catalog_fixture(id integer);
        CREATE FUNCTION public.handoff_catalog_fixture() RETURNS integer LANGUAGE sql AS 'SELECT 1';
        CREATE FUNCTION public.sha256(bytea) RETURNS bytea LANGUAGE sql
          AS 'SELECT decode(repeat(''00'',32),''hex'')';`);
      const capture = () => JSON.parse(ownerSql(renderManagedCatalogSql));
      try {
        const baseline = capture();
        const fixtureDigest = renderManagedEvidenceDigest(baseline);
        expect(() =>
          assertRenderManagedCatalogMatches(capture(), fixtureDigest),
        ).not.toThrow();
        const hostileSearchPath = JSON.parse(
          ownerSql(
            `SET search_path = public, pg_catalog;\n${renderManagedCatalogSql}`,
          ),
        );
        expect(() =>
          assertRenderManagedCatalogMatches(hostileSearchPath, fixtureDigest),
        ).not.toThrow();
        for (const phase of [
          "managed-retained-upgrade",
          "managed-schema-handoff",
        ])
          expect(() => readReviewedRenderManagedContract(phase)).toThrow(
            "managed_independent_review_missing",
          );
        for (const change of [
          "GRANT SELECT ON public.handoff_catalog_fixture TO unrelated;",
          "ALTER DEFAULT PRIVILEGES REVOKE ALL ON FUNCTIONS FROM PUBLIC;",
          "CREATE OR REPLACE FUNCTION public.handoff_catalog_fixture() RETURNS integer LANGUAGE sql AS 'SELECT 2';",
        ]) {
          const changed = JSON.parse(
            ownerSql(`BEGIN; ${change}\n${renderManagedCatalogSql}\nROLLBACK;`),
          );
          expect(() =>
            assertRenderManagedCatalogMatches(changed, fixtureDigest),
          ).toThrow("drift");
          expect(() =>
            assertRenderManagedCatalogMatches(capture(), fixtureDigest),
          ).not.toThrow();
        }
        const ownershipDrift = JSON.parse(
          sql(`BEGIN;
          ALTER TABLE public.handoff_catalog_fixture OWNER TO unrelated;
          SET SESSION AUTHORIZATION reviewrouter;
          ${renderManagedCatalogSql} ROLLBACK;`),
        );
        expect(() =>
          assertRenderManagedCatalogMatches(ownershipDrift, fixtureDigest),
        ).toThrow("drift");
        expect(() =>
          assertRenderManagedCatalogMatches(capture(), fixtureDigest),
        ).not.toThrow();
      } finally {
        sql(
          "DROP FUNCTION public.handoff_catalog_fixture(); DROP FUNCTION public.sha256(bytea); DROP TABLE public.handoff_catalog_fixture;",
        );
      }
    });

    it.each([
      "REVOKE reviewrouter_release_schema_owner FROM reviewrouter GRANTED BY postgres RESTRICT;",
      "GRANT reviewrouter_release_schema_owner TO reviewrouter WITH ADMIN FALSE, INHERIT FALSE, SET FALSE GRANTED BY postgres;",
      "GRANT reviewrouter_release_schema_owner TO reviewrouter WITH ADMIN TRUE, INHERIT TRUE, SET FALSE GRANTED BY postgres;",
      "GRANT reviewrouter_release_schema_owner TO reviewrouter WITH ADMIN TRUE, INHERIT FALSE, SET TRUE GRANTED BY postgres;",
      `SET ROLE reviewrouter; ${renderManagedTemporaryMembershipSql}
        GRANT reviewrouter_release_schema_owner TO reviewrouter WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY reviewrouter; RESET ROLE;`,
      `SET ROLE reviewrouter; ${renderManagedTemporaryMembershipSql}
        GRANT reviewrouter_release_schema_owner TO reviewrouter WITH ADMIN FALSE, INHERIT TRUE, SET FALSE GRANTED BY reviewrouter; RESET ROLE;`,
      // PG17 forbids granting ADMIN back to one's own grantor (including a
      // self-grant). Model a real extra ADMIN edge through an independent
      // provider-authorized grantor, without corrupting pg_auth_members.
      `GRANT reviewrouter_release_schema_owner TO unrelated WITH ADMIN TRUE, INHERIT FALSE, SET FALSE GRANTED BY postgres;
        SET ROLE unrelated; GRANT reviewrouter_release_schema_owner TO reviewrouter WITH ADMIN TRUE, INHERIT TRUE, SET TRUE GRANTED BY unrelated; RESET ROLE;`,
      `GRANT reviewrouter_release_schema_owner TO unrelated WITH ADMIN TRUE, INHERIT FALSE, SET FALSE GRANTED BY postgres;
        SET ROLE unrelated; GRANT reviewrouter_release_schema_owner TO reviewrouter WITH ADMIN FALSE, INHERIT TRUE, SET TRUE GRANTED BY unrelated; RESET ROLE;`,
      `SET ROLE reviewrouter; ${renderManagedTemporaryMembershipSql} RESET ROLE;
        DELETE FROM pg_catalog.pg_auth_members WHERE roleid='reviewrouter_release_schema_owner'::regrole
          AND member='reviewrouter'::regrole AND grantor='postgres'::regrole;`,
    ])(
      "rejects real missing or drifted explicit-grantor state %#",
      (change) => {
        // Every fault is confined to this owned disposable cluster and rolled
        // back. The last case simulates damaged catalog history, never repair SQL.
        const original = {
          role: "reviewrouter_release_schema_owner",
          member: "reviewrouter",
          grantor: "postgres",
          adminOption: true,
          inheritOption: false,
          setOption: false,
        };
        const observed = JSON.parse(
          sql(`BEGIN; ${change} ${renderManagedMembershipSql} ROLLBACK;`),
        );
        if (change.includes("SET ROLE unrelated;")) {
          expect(observed).toEqual([
            original,
            {
              ...original,
              grantor: "unrelated",
              adminOption: change.includes("TO reviewrouter WITH ADMIN TRUE"),
              inheritOption: true,
              setOption: true,
            },
          ]);
        }
        expect(() =>
          classifyRenderManagedMembership(observed, original),
        ).toThrow("managed_membership_drift");
        expect(
          classifyRenderManagedMembership(
            JSON.parse(ownerSql(renderManagedMembershipSql)),
            original,
          ),
        ).toBe("original");
      },
    );

    it("reconciles only the exact self-grant and retains the original provider ADMIN edge", () => {
      const original = {
        role: "reviewrouter_release_schema_owner",
        member: "reviewrouter",
        grantor: "postgres",
        adminOption: true,
        inheritOption: false,
        setOption: false,
      };
      const membership = () => JSON.parse(ownerSql(renderManagedMembershipSql));
      expect(classifyRenderManagedMembership(membership(), original)).toBe(
        "original",
      );
      try {
        ownerSql(renderManagedTemporaryMembershipSql);
        expect(classifyRenderManagedMembership(membership(), original)).toBe(
          "temporary",
        );
        ownerSql(renderManagedMembershipCleanupSql);
        expect(classifyRenderManagedMembership(membership(), original)).toBe(
          "original",
        );
        const denied = docker(
          psqlArgs.map((argument, i) =>
            psqlArgs[i - 1] === "-U" ? "reviewrouter" : argument,
          ),
          "SET ROLE reviewrouter_release_schema_owner;",
        );
        expect(denied.status).not.toBe(0);
        expect(denied.stderr).toContain(
          'permission denied to set role "reviewrouter_release_schema_owner"',
        );
      } finally {
        // Only our exact known temporary row is eligible for cleanup.
        if (
          classifyRenderManagedMembership(membership(), original) ===
          "temporary"
        )
          ownerSql(renderManagedMembershipCleanupSql);
      }
    });

    it("competes with the exact canonical migration lock and releases on rollback", async () => {
      const holder = spawn("docker", psqlArgs, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { PATH: process.env.PATH, LANG: "C.UTF-8" },
      });
      const ended = new Promise<number | null>((resolve) =>
        holder.once("close", resolve),
      );
      const ready = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("lock_holder_not_ready")),
          10_000,
        );
        holder.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        holder.stdout.on("data", (data) => {
          if (String(data).includes("lock-held")) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      holder.stdin.write(
        `BEGIN;\n${activationMigrationExclusionSql}\n\\echo lock-held\n`,
      );
      try {
        await ready;
        const contender = docker(
          psqlArgs,
          `BEGIN;\n${activationMigrationExclusionSql}\nCOMMIT;`,
        );
        expect(contender.status).not.toBe(0);
        expect(contender.stderr).toContain("lock timeout");
      } finally {
        holder.stdin.end("ROLLBACK;\n");
        expect(await ended).toBe(0);
      }
      expect(() =>
        sql(`BEGIN;\n${activationMigrationExclusionSql}\nCOMMIT;`),
      ).not.toThrow();
    }, 25_000);
  },
);
