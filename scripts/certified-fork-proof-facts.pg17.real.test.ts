import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { managedPg17Fixture } from "./lib/render-managed-pg17-fixture.js";
import {
  CertifiedForkProofFactReader as Reader,
  CertifiedForkProofFactWriter as Writer,
  type RetainedFactSql,
} from "../packages/features/action-control-plane/src/infrastructure/prisma/certified-fork-proof-fact-store.js";
import {
  factSha256,
  type RetainedFactInput,
} from "../packages/features/action-control-plane/src/infrastructure/prisma/certified-fork-proof-fact-types.js";
import {
  inventoryFact,
  outputFact,
  fixtureHash,
} from "../packages/features/action-control-plane/src/tests/certified-fork-proof-fact-fixtures.js";

// Selected explicitly by the orchestrator. Real PG17.10 in the established
// offline owned fixture; never mocked, skipped, or redirected to an ambient URL.
// This worker must not execute Docker; local validation selects only unit tests.
const sql = (name: string) =>
  readFileSync(
    new URL(
      `../packages/platform/db/prisma/migrations/${name}/migration.sql`,
      import.meta.url,
    ),
    "utf8",
  );
const archive = sql("000098_certified_fork_effect_archive");
const facts = sql("000099_certified_fork_proof_facts");
const table = 'public."CertifiedForkProofFact"';
const owner = "reviewrouter_certified_fork_fact_owner";
const roles = [
  owner,
  "reviewrouter_certified_fork_writer",
  "reviewrouter_certified_fork_reader",
];
const memberships = `SELECT count(*) FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid OR r.oid=m.member WHERE r.rolname LIKE 'reviewrouter_certified_fork_%'`;
const catalog = `SELECT jsonb_build_object(
 'columns',(SELECT jsonb_agg(jsonb_build_array(attname,format_type(atttypid,atttypmod),attnotnull) ORDER BY attnum) FROM pg_attribute WHERE attrelid='${table}'::regclass AND attnum>0),
 'constraints',(SELECT jsonb_agg(pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid='${table}'::regclass),
 'indexes',(SELECT jsonb_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE tablename='CertifiedForkProofFact'),
 'acl',(SELECT relacl::text FROM pg_class WHERE oid='${table}'::regclass),
 'functions',(SELECT jsonb_agg(jsonb_build_array(proname,pg_get_userbyid(proowner),proacl::text,pg_get_functiondef(oid)) ORDER BY proname) FROM pg_proc WHERE proname LIKE 'certified_fork_fact_%'));`;
interface Client extends RetainedFactSql {
  connect(): Promise<void>;
  end(): Promise<void>;
}
const { Client: PgClient } = createRequire(import.meta.url)("pg") as {
  Client: new (config: Record<string, unknown>) => Client;
};

describe("retained fact REAL PG17 schema and actual store", () => {
  it("fresh nonsuperuser 098->099, second database reuse, cleanup, default ACLs, concurrency and rollback", async () => {
    const pg = managedPg17Fixture(),
      clients: Client[] = [];
    const db = "retained_first",
      second = "retained_second";
    const admin = (database: string, source: string) =>
      pg.query(database, source, "postgres");
    const connect = async (user: string, database = db) => {
      const client = new PgClient({
        user,
        database,
        host: "127.0.0.1",
        port: 5432,
        password: "",
        ssl: false,
        stream: pg.wireStream,
        connectionTimeoutMillis: 10000,
      });
      clients.push(client);
      await client.connect();
      await client.query("SET statement_timeout='15s'", []);
      return client;
    };
    const clean = () => {
      expect(admin(db, memberships)).toBe("0");
      expect(
        admin(
          db,
          "SELECT count(*) FROM pg_roles WHERE rolname IN ('reviewrouter_certified_fork_creator','reviewrouter_certified_fork_fact_creator')",
        ),
      ).toBe("0");
    };
    try {
      await pg.start();
      admin(
        "postgres",
        `CREATE ROLE reviewrouter LOGIN CREATEROLE CREATEDB; CREATE ROLE disposable_app LOGIN; CREATE ROLE disposable_parent; GRANT disposable_parent TO disposable_app; CREATE DATABASE ${db} OWNER reviewrouter; CREATE DATABASE ${second} OWNER reviewrouter;`,
      );
      expect(
        pg.query(
          db,
          "SELECT rolsuper FROM pg_roles WHERE rolname=current_user",
        ),
      ).toBe("f");
      pg.query(db, archive);
      clean();
      pg.query(db, facts);
      clean();
      const originalCatalog = admin(db, catalog);
      // 098 reuse has its own explicit superuser/ADMIN requirement. 099 never
      // tries to assume the sealed archive owner, even on the fresh path above.
      admin(second, archive);
      clean();
      const globalState = () =>
        admin(
          db,
          `SELECT jsonb_build_object('roles',(SELECT jsonb_agg(to_jsonb(r) ORDER BY rolname) FROM pg_roles r WHERE rolname LIKE 'reviewrouter_certified_fork_%'),'edges',(SELECT jsonb_agg(to_jsonb(m) ORDER BY roleid,member,grantor) FROM pg_auth_members m))`,
        );
      const originalGlobal = globalState();
      expect(() => pg.query(second, facts)).toThrow(
        /proof_fact_existing_owner_admin_precondition/u,
      );
      expect(globalState()).toBe(originalGlobal);
      expect(admin(second, `SELECT to_regclass('${table}') IS NULL`)).toBe("t");
      clean();
      for (const role of roles) {
        admin(db, `ALTER ROLE ${role} LOGIN`);
        expect(() => admin(second, facts)).toThrow(/proof_fact_unsafe_role/u);
        admin(db, `ALTER ROLE ${role} NOLOGIN`);
        admin(db, `GRANT ${role} TO disposable_app`);
        expect(() => admin(second, facts)).toThrow(/proof_fact_unsafe_role/u);
        admin(db, `REVOKE ${role} FROM disposable_app`);
        admin(db, `GRANT disposable_parent TO ${role}`);
        expect(() => admin(second, facts)).toThrow(/proof_fact_unsafe_role/u);
        admin(db, `REVOKE disposable_parent FROM ${role}`);
      }
      // Failure AFTER temporary role grants must roll back all of them.
      admin(second, `CREATE TABLE ${table} (sentinel text)`);
      expect(() => admin(second, facts)).toThrow(/already exists/u);
      expect(globalState()).toBe(originalGlobal);
      clean();
      admin(second, `DROP TABLE ${table}`);
      // Contaminate the actual creating owner's defaults in the transaction,
      // not a different deployer's unused defaults. The resulting ACL is equal.
      const switchRole = `SET LOCAL ROLE ${owner};`;
      admin(
        second,
        facts.replace(
          switchRole,
          `${switchRole}\nALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO PUBLIC, disposable_parent; ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO disposable_parent;`,
        ),
      );
      clean();
      expect(globalState()).toBe(originalGlobal);
      expect(admin(second, catalog)).toBe(originalCatalog);
      expect(admin(db, catalog)).toBe(originalCatalog);
      expect(admin(second, `SELECT count(*) FROM ${table}`)).toBe("0");
      // Fresh migration needs schema administration. In PG17 the database
      // owner implicitly owns public through pg_database_owner and can DROP
      // another role's table regardless of its ACL. Prove that trusted power
      // without destroying the fixture; SQL099 cannot revoke this authority.
      expect(
        pg.query(
          db,
          `BEGIN; DROP TABLE ${table}; SELECT to_regclass('${table}') IS NULL; ROLLBACK;`,
        ),
        `reviewrouter: DROP TABLE ${table}`,
      ).toBe("t");
      expect(admin(db, catalog)).toBe(originalCatalog);
      // Fixture-only custody handoff before testing the restricted deployer.
      // Schema/database administrators remain trusted; these denials do not
      // apply while reviewrouter owns either. Like the SQL098 runtime tests,
      // the tested logins must not inherit ownership of the protected objects.
      admin(
        db,
        `ALTER DATABASE ${db} OWNER TO postgres; ALTER SCHEMA public OWNER TO postgres;`,
      );
      const restricted = (user: string) => {
        expect(
          pg.query(
            db,
            `SELECT NOT r.rolsuper
              AND NOT pg_has_role(current_user,d.datdba,'MEMBER')
              AND NOT pg_has_role(current_user,n.nspowner,'MEMBER')
              AND NOT pg_has_role(current_user,c.relowner,'MEMBER')
              AND NOT has_schema_privilege(current_user,'public','CREATE')
            FROM pg_roles r, pg_database d, pg_namespace n, pg_class c
            WHERE r.rolname=current_user AND d.datname=current_database()
              AND n.nspname='public' AND c.oid='${table}'::regclass`,
            user,
          ),
          `${user}: restricted database/schema/table ownership`,
        ).toBe("t");
      };
      for (const role of roles) {
        expect(() => pg.query(db, `SET ROLE ${role}`)).toThrow(
          /permission denied/u,
        );
        expect(() =>
          pg.query(db, `SET ROLE ${role}`, "disposable_app"),
        ).toThrow(/permission denied/u);
      }
      for (const user of ["reviewrouter", "disposable_app"]) {
        restricted(user);
        for (const statement of [
          `SELECT * FROM ${table}`,
          `INSERT INTO ${table} DEFAULT VALUES`,
          `UPDATE ${table} SET "kind"='output'`,
          `DELETE FROM ${table}`,
          `TRUNCATE ${table}`,
          `ALTER TABLE ${table} DISABLE TRIGGER ALL`,
          `DROP TABLE ${table}`,
          "SELECT public.certified_fork_fact_identity(ARRAY['x'])",
        ]) {
          expect(
            () => pg.query(db, statement, user),
            `${user}: ${statement}`,
          ).toThrow(/permission denied|must be owner/u);
        }
      }
      expect(
        admin(db, `SELECT has_schema_privilege('${owner}','public','CREATE')`),
      ).toBe("f");
      expect(
        admin(
          db,
          `SELECT string_agg(relname,',' ORDER BY relname) FROM pg_class WHERE relowner='${owner}'::regrole AND relkind='r'`,
        ),
      ).toBe("CertifiedForkProofFact");
      // Fixture-only runtime grants AFTER the migration custody audit.
      admin(
        db,
        `CREATE ROLE disposable_writer LOGIN; CREATE ROLE disposable_reader LOGIN; GRANT reviewrouter_certified_fork_writer TO disposable_writer; GRANT reviewrouter_certified_fork_reader TO disposable_reader; CREATE TABLE public.disposable_command (id text PRIMARY KEY); GRANT SELECT, INSERT ON public.disposable_command TO disposable_writer;`,
      );
      const a = await connect("disposable_writer"),
        b = await connect("disposable_writer");
      const observer = await connect("postgres"),
        readerSql = await connect("disposable_reader");
      const writerA = new Writer(a),
        writerB = new Writer(b),
        reader = new Reader(readerSql);
      const waitForLock = async (pid: number) => {
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          const state = await observer.query(
            "SELECT wait_event_type, wait_event FROM pg_stat_activity WHERE pid=$1",
            [pid],
          );
          if (
            state.rows[0]?.wait_event_type === "Lock" &&
            state.rows[0]?.wait_event === "transactionid"
          )
            return;
          await delay(20);
        }
        throw new Error(
          "real competing backend did not reach unique-index transaction lock",
        );
      };
      const pid = Number(
        (await b.query("SELECT pg_backend_pid() AS pid", [])).rows[0]?.pid,
      );
      const input = inventoryFact("concurrent");
      await a.query("BEGIN", []);
      const first = await writerA.inventory(input);
      const pending = writerB.inventory(input);
      void pending.catch(() => {});
      await waitForLock(pid);
      expect(
        await reader.read("inventory", input.proofId, input.scope),
      ).toBeNull();
      await a.query("COMMIT", []);
      expect(await pending).toEqual(first);
      expect(admin(db, `SELECT count(*) FROM ${table}`)).toBe("1");
      // A contender waiting on an aborted insert becomes the sole durable writer.
      const aborted = inventoryFact("aborted-winner");
      await a.query("BEGIN", []);
      await writerA.inventory(aborted);
      const afterRollback = writerB.inventory(aborted);
      void afterRollback.catch(() => {});
      await waitForLock(pid);
      await a.query("ROLLBACK", []);
      expect((await afterRollback).fact).toEqual(aborted);
      expect(
        await reader.read("inventory", aborted.proofId, aborted.scope),
      ).not.toBeNull();
      // Different proof, same exact source races on source digest and rejects
      // after commit; a proof collision with changed payload is rejected too.
      const source = inventoryFact("source-race");
      await a.query("BEGIN", []);
      await writerA.inventory(source);
      const collision = writerB.inventory({
        ...source,
        proofId: "substituted",
      });
      void collision.catch(() => {});
      await waitForLock(pid);
      await a.query("COMMIT", []);
      await expect(collision).rejects.toThrow(/contract_rejected/u);
      await expect(
        writerB.inventory({
          ...input,
          payload: { ...input.payload, outputProof: "changed" },
        }),
      ).rejects.toThrow(/contract_rejected/u);
      await expect(
        writerB.inventory({
          ...input,
          provenance: { ...input.provenance, sourceKey: "changed" },
        }),
      ).rejects.toThrow(/contract_rejected/u);
      for (const key of Object.keys(input.scope)) {
        const scope = {
          ...input.scope,
          [key]: key.endsWith("Id") ? "substitution" : fixtureHash(90),
        };
        await expect(writerB.inventory({ ...input, scope })).rejects.toThrow(
          /contract_rejected/u,
        );
        await expect(
          reader.read("inventory", input.proofId, scope),
        ).rejects.toThrow(/contract_rejected/u);
      }
      // Same caller connection: actual command + fact rollback, then commit.
      const command: RetainedFactInput<"command"> = {
        ...inventoryFact("command"),
        kind: "command",
        payload: {
          operation: "acquireClaim",
          preimage: {},
          comparison: null,
          principal: { subject: "disposable" },
          claim: null,
          version: "1",
          commandId: "command",
          commandHash: fixtureHash(9),
          admissionProof: "admission",
          authorityProofs: [],
        },
      };
      await a.query("BEGIN", []);
      await a.query("INSERT INTO public.disposable_command VALUES ($1)", [
        "command",
      ]);
      await writerA.command(command);
      expect(
        await reader.read("command", command.proofId, command.scope),
      ).toBeNull();
      await a.query("ROLLBACK", []);
      expect(admin(db, "SELECT count(*) FROM public.disposable_command")).toBe(
        "0",
      );
      expect(
        await reader.read("command", command.proofId, command.scope),
      ).toBeNull();
      await a.query("BEGIN", []);
      await a.query("INSERT INTO public.disposable_command VALUES ($1)", [
        "command",
      ]);
      await writerA.command(command);
      await a.query("COMMIT", []);
      expect(admin(db, "SELECT count(*) FROM public.disposable_command")).toBe(
        "1",
      );
      expect(
        await reader.read("command", command.proofId, command.scope),
      ).not.toBeNull();
      // SQL error after the fact insert also rolls back the entire command unit.
      await a.query("BEGIN", []);
      await writerA.inventory(inventoryFact("failed"));
      await expect(
        a.query("INSERT INTO public.disposable_command VALUES ($1)", [
          "command",
        ]),
      ).rejects.toThrow(/duplicate key/u);
      await a.query("ROLLBACK", []);
      expect(await reader.read("inventory", "failed", input.scope)).toBeNull();
      // Incompressible proof > usual Btree tuple limit (but within ledger 4096)
      // and source >4096 use only 32-byte indexes, preserving exact identities.
      const large = Array.from({ length: 200 }, (_, i) =>
        createHash("sha256").update(`retained:${i}`).digest("base64"),
      ).join("");
      const output = {
        ...outputFact(large.slice(0, 4096)),
        provenance: {
          ...outputFact().provenance,
          sourceKey: large,
          sourceRevision: large,
        },
      };
      const stored = await writerA.output(output);
      await a.end();
      clients.splice(clients.indexOf(a), 1);
      await readerSql.end();
      clients.splice(clients.indexOf(readerSql), 1);
      vi.resetModules();
      const { CertifiedForkProofFactReader: ColdReader } =
        await import("../packages/features/action-control-plane/src/infrastructure/prisma/certified-fork-proof-fact-store.js");
      const cold = new ColdReader(await connect("disposable_reader"));
      const retained = await cold.read("output", output.proofId, output.scope);
      expect(retained).toEqual(stored);
      expect(retained?.fact.payload.outputBytes).toBe(
        output.payload.outputBytes,
      );
      expect(retained?.fact.payload.modelOutput).toEqual(
        output.payload.modelOutput,
      );
      // Original provenance validity expired long ago; no source/family is needed.
      expect(retained?.fact.provenance.validUntilMs).toBe(2);
      expect(
        admin(db, 'SELECT count(*) FROM public."CertifiedForkFamily"'),
      ).toBe("0");
      // Bypass adapter for SQL CHECK/guard and ACL attacks, preserving row bytes.
      const snapshot = admin(
        db,
        `SELECT jsonb_agg(to_jsonb(t) ORDER BY "proofId") FROM ${table} t`,
      );
      const columns =
        '"proofSha256","sourceSha256","proofId","formatVersion","kind","workspaceId","repositoryConnectionId","familyKey","reviewHash","producerKind","producerId","producerVersion","sourceKey","sourceRevision","observedAtMs","validUntilMs","payload","canonicalBytes","payloadHash"';
      const copy = (proof: string, digest: Buffer) =>
        b.query(
          `INSERT INTO ${table} (${columns}) SELECT $1,"sourceSha256",$2,"formatVersion","kind","workspaceId","repositoryConnectionId","familyKey","reviewHash","producerKind","producerId","producerVersion","sourceKey","sourceRevision","observedAtMs","validUntilMs","payload","canonicalBytes","payloadHash" FROM ${table} LIMIT 1`,
          [digest, proof],
        );
      await expect(
        copy("x".repeat(4097), factSha256("x".repeat(4097))),
      ).rejects.toThrow(/check constraint/u);
      await expect(copy("invalid-digest", Buffer.alloc(32))).rejects.toThrow(
        /check constraint/u,
      );
      const rawCopy = (replaced: Record<string, string>, values: unknown[]) => {
        const names = columns.split(",");
        return b.query(
          `INSERT INTO ${table} (${columns}) SELECT ${names.map((name) => replaced[name] ?? name).join(",")} FROM ${table} LIMIT 1`,
          values,
        );
      };
      const newProof = { '"proofSha256"': "$1", '"proofId"': "$2" };
      await expect(
        rawCopy({ ...newProof, '"sourceSha256"': "$3" }, [
          factSha256("bad-source"),
          "bad-source",
          Buffer.alloc(32),
        ]),
      ).rejects.toThrow(/proof_fact_source_digest/u);
      await expect(
        rawCopy({ ...newProof, '"payloadHash"': "$3" }, [
          factSha256("bad-hash"),
          "bad-hash",
          fixtureHash(0),
        ]),
      ).rejects.toThrow(/check constraint/u);
      await expect(
        rawCopy({ ...newProof, '"canonicalBytes"': "'{}'" }, [
          factSha256("bad-bytes"),
          "bad-bytes",
        ]),
      ).rejects.toThrow(/check constraint/u);
      await expect(
        rawCopy({ ...newProof, '"validUntilMs"': '"observedAtMs"-1' }, [
          factSha256("bad-time"),
          "bad-time",
        ]),
      ).rejects.toThrow(/check constraint/u);
      for (const user of ["disposable_writer", "disposable_reader"]) {
        restricted(user);
        for (const statement of [
          `UPDATE ${table} SET "kind"='output'`,
          `DELETE FROM ${table}`,
          `TRUNCATE ${table}`,
          `ALTER TABLE ${table} DISABLE TRIGGER ALL`,
          `DROP TABLE ${table}`,
        ])
          expect(
            () => pg.query(db, statement, user),
            `${user}: ${statement}`,
          ).toThrow(/permission denied|must be owner/u);
      }
      expect(() =>
        pg.query(
          db,
          `INSERT INTO ${table} DEFAULT VALUES`,
          "disposable_reader",
        ),
      ).toThrow(/permission denied/u);
      admin(
        db,
        `GRANT UPDATE,DELETE,TRUNCATE ON ${table} TO disposable_writer`,
      );
      for (const statement of [
        `UPDATE ${table} SET "kind"="kind"`,
        `DELETE FROM ${table}`,
        `TRUNCATE ${table}`,
      ])
        expect(() => pg.query(db, statement, "disposable_writer")).toThrow(
          /proof_fact_immutable/u,
        );
      expect(
        admin(
          db,
          `SELECT jsonb_agg(to_jsonb(t) ORDER BY "proofId") FROM ${table} t`,
        ),
      ).toBe(snapshot);
    } finally {
      await Promise.allSettled(clients.map((client) => client.end()));
      pg.cleanup();
    }
  }, 180_000);
});
