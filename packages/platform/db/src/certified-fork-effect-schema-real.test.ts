import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { managedPg17Fixture } from "../../../../scripts/lib/render-managed-pg17-fixture.js";

// Always executes when selected: unavailable Docker is a FAILED gate, never a skip.
// This fixture accepts no URL/identity and uses a unique labelled PG17.10 container
// with --network=none, no host mounts/ports, and guaranteed owned-container cleanup.
const migration = readFileSync(
  new URL(
    "../prisma/migrations/000098_certified_fork_effect_archive/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const h = (n: number) => n.toString(16).padStart(64, "0");
const quote = (v: unknown) =>
  `'${(typeof v === "string" ? v : JSON.stringify(v)).replaceAll("'", "''")}'`;
const insert = (table: string, row: Record<string, unknown>) =>
  `INSERT INTO public."CertifiedFork${table}" (${Object.keys(row)
    .map((k) => `"${k}"`)
    .join(",")}) VALUES (${Object.values(row)
    .map((v) => (v === null ? "NULL" : quote(v)))
    .join(",")});`;
function artifacts(version = 1, operation = "acquireClaim") {
  const familyKey = h(1),
    reviewHash = h(2);
  const seed = {
    facts: {
      workspaceId: "tenant",
      repositoryId: "repo",
      sourceRepositoryId: "fork",
      baseRepositoryId: "base",
      pullRequest: 1,
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      trustDomain: "fork",
      generation: "0",
    },
    bindingHash: h(3),
    admissionHash: null,
    predecessor: null,
  };
  const row: Record<string, unknown> = {
    familyKey,
    version: String(version),
    formatVersion: 1,
    reviewHash,
    generation: "0",
    seed,
    admissionProof: "disposable-admission",
    fence: "1",
    claimOwnerHash: operation === "releaseClaim" ? null : h(4),
    claimHash: operation === "releaseClaim" ? null : h(5),
    claimEpoch: operation === "releaseClaim" ? null : "1",
    claimExpiresAtMs: operation === "releaseClaim" ? null : "9007199254740991",
    events: [],
    ledgerHash: h(6),
    outcomeHash: null,
    revisions: [],
    committedAtMs: String(version),
  };
  const receipt: Record<string, unknown> = {
    familyKey,
    commandId: `command_${version}`,
    commandHash: h(7),
    ownerHash: h(4),
    reviewHash,
    version: String(version),
    operation,
  };
  const checkpoint: Record<string, unknown> = {
    familyKey,
    version: String(version),
    reviewHash,
    proof: `disposable-proof-${version}`,
    formatVersion: 1,
    prefixLength: 0,
    prefixHash: h(8),
    anchorHash: h(9),
    positionCommandId: receipt.commandId,
    positionCommandHash: receipt.commandHash,
    state: {
      review: {
        facts: seed.facts,
        familyKey,
        logicalKey: h(10),
        bindingHash: seed.bindingHash,
        admissionHash: null,
      },
      states: [],
      inventory: null,
      outcome: null,
    },
  };
  return { row, receipt, checkpoint };
}
function command(a = artifacts(), omit = "") {
  const version = a.row.version;
  return `BEGIN; ${version === "1" ? insert("Family", { familyKey: a.row.familyKey, tipVersion: "1" }) : ""}
    ${omit === "version" ? "" : insert("Version", a.row)}
    ${omit === "receipt" ? "" : insert("Receipt", a.receipt)}
    ${omit === "checkpoint" ? "" : insert("Checkpoint", a.checkpoint)}
    ${version === "1" ? "" : `UPDATE public."CertifiedForkFamily" SET "tipVersion"=${quote(version)} WHERE "familyKey"=${quote(a.row.familyKey)};`}
    COMMIT;`;
}
const catalog = `SELECT jsonb_build_object(
  'columns',(SELECT jsonb_agg(jsonb_build_array(table_name,column_name,data_type,is_nullable) ORDER BY table_name,ordinal_position) FROM information_schema.columns WHERE table_name LIKE 'CertifiedFork%'),
  'constraints',(SELECT jsonb_agg(jsonb_build_array(c.conname,pg_get_constraintdef(c.oid)) ORDER BY c.conname) FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid WHERE t.relname LIKE 'CertifiedFork%'),
  'indexes',(SELECT jsonb_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE tablename LIKE 'CertifiedFork%'),
  'triggers',(SELECT jsonb_agg(pg_get_triggerdef(g.oid) ORDER BY t.relname,g.tgname) FROM pg_trigger g JOIN pg_class t ON t.oid=g.tgrelid WHERE t.relname LIKE 'CertifiedFork%' AND NOT g.tgisinternal),
  'acl',(SELECT jsonb_agg(jsonb_build_array(relname,pg_get_userbyid(relowner),relacl::text) ORDER BY relname) FROM pg_class WHERE relname IN ('CertifiedForkFamily','CertifiedForkVersion','CertifiedForkReceipt','CertifiedForkCheckpoint')));`;

describe("CertifiedFork disposable REAL PG17 schema", () => {
  it("proves fresh/representative-upgrade parity and raw SQL archive/ACL invariants", async () => {
    const catalogs: unknown[] = [];
    for (const upgrade of [false, true]) {
      const pg = managedPg17Fixture();
      const db = `certified_fork_${randomUUID().replaceAll("-", "")}`;
      try {
        await pg.start();
        pg.query(
          "postgres",
          `CREATE ROLE reviewrouter LOGIN CREATEROLE CREATEDB; CREATE ROLE disposable_app LOGIN; CREATE ROLE disposable_inherited; GRANT disposable_inherited TO disposable_app; CREATE DATABASE ${db} OWNER reviewrouter;`,
          "postgres",
        );
        if (upgrade)
          await pg.apply(db, 76, "certified-fork-disposable-upgrade").result;
        pg.query(
          db,
          `CREATE TABLE public.disposable_sentinel (id integer PRIMARY KEY, data text NOT NULL); INSERT INTO public.disposable_sentinel VALUES (1,'retain');`,
        );
        expect(
          pg.query(
            db,
            "SELECT rolsuper FROM pg_roles WHERE rolname=current_user",
          ),
        ).toBe("f");
        // Reproduce the old fixture's externally granted creator ADMIN edge.
        pg.query(
          db,
          "CREATE ROLE reviewrouter_certified_fork_owner NOLOGIN NOINHERIT",
        );
        expect(
          pg.query(
            db,
            `SELECT count(*) FROM pg_auth_members m WHERE m.roleid='reviewrouter_certified_fork_owner'::regrole AND m.member='reviewrouter'::regrole AND m.grantor<>m.member AND m.admin_option`,
          ),
        ).toBe("1");
        expect(
          pg.query(
            db,
            `BEGIN;
          GRANT reviewrouter_certified_fork_owner TO reviewrouter WITH INHERIT TRUE, SET TRUE GRANTED BY reviewrouter;
          REVOKE reviewrouter_certified_fork_owner FROM reviewrouter GRANTED BY reviewrouter RESTRICT;
          SELECT count(*) FROM pg_auth_members WHERE roleid='reviewrouter_certified_fork_owner'::regrole AND member='reviewrouter'::regrole;
          ROLLBACK;`,
          ),
        ).toBe("1");
        expect(() => pg.query(db, migration)).toThrow(
          /certified_fork_existing_membership/u,
        );
        expect(
          pg.query(
            db,
            "SELECT count(*) FROM pg_roles WHERE rolname='reviewrouter_certified_fork_creator'",
          ),
        ).toBe("0");
        expect(
          pg.query(
            db,
            `SELECT count(*) FROM pg_class WHERE relname LIKE 'CertifiedFork%'`,
          ),
        ).toBe("0");
        pg.query(db, "DROP ROLE reviewrouter_certified_fork_owner");
        // Fresh runs the exact migration. Upgrade injects only adversarial default
        // ACL setup at the owner switch, after role creation in the same transaction.
        // This avoids precreating archive roles with irrevocable deployer ADMIN edges.
        const ownerSwitch = "SET LOCAL ROLE reviewrouter_certified_fork_owner;";
        const defaults = `ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO PUBLIC, disposable_inherited;
          ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO disposable_inherited;`;
        pg.query(
          db,
          upgrade
            ? migration.replace(ownerSwitch, `${ownerSwitch}\n${defaults}`)
            : migration,
        );
        expect(
          pg.query(
            db,
            "SELECT count(*) FROM pg_roles WHERE rolname='reviewrouter_certified_fork_creator'",
          ),
        ).toBe("0");
        expect(
          pg.query(
            db,
            `SELECT count(*) FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid WHERE r.rolname LIKE 'reviewrouter_certified_fork_%'`,
          ),
        ).toBe("0");
        for (const role of ["owner", "writer", "reader"]) {
          expect(() =>
            pg.query(db, `SET ROLE reviewrouter_certified_fork_${role}`),
          ).toThrow();
          expect(() =>
            pg.query(
              db,
              `SET ROLE reviewrouter_certified_fork_${role}`,
              "disposable_app",
            ),
          ).toThrow();
        }
        catalogs.push(JSON.parse(pg.query(db, catalog)));
        expect(
          pg.query(db, "SELECT data FROM public.disposable_sentinel"),
        ).toBe("retain");
        // Fixture-only login installation is separate from the migration contract.
        pg.query(
          db,
          `CREATE ROLE disposable_writer LOGIN; CREATE ROLE disposable_reader LOGIN;
          GRANT reviewrouter_certified_fork_writer TO disposable_writer;
          GRANT reviewrouter_certified_fork_reader TO disposable_reader;`,
          "postgres",
        );
        const writer = (sql: string) => pg.query(db, sql, "disposable_writer");
        const rejected = (sql: string, role = "disposable_writer") =>
          expect(() => pg.query(db, sql, role)).toThrow();
        for (const omit of ["version", "receipt", "checkpoint"]) {
          rejected(command(artifacts(), omit));
          expect(
            writer('SELECT count(*) FROM public."CertifiedForkFamily"'),
          ).toBe("0");
        }
        // Explicit rollback between each write also leaves no authenticated artifact.
        const initial = artifacts();
        const pieces = [
          insert("Family", { familyKey: h(1), tipVersion: "1" }),
          insert("Version", initial.row),
          insert("Receipt", initial.receipt),
          insert("Checkpoint", initial.checkpoint),
        ];
        for (let n = 1; n <= pieces.length; n++) {
          writer(`BEGIN; ${pieces.slice(0, n).join("\n")} ROLLBACK;`);
          expect(
            writer('SELECT count(*) FROM public."CertifiedForkFamily"'),
          ).toBe("0");
        }
        for (const [target, key, value] of [
          ["row", "claimHash", null],
          ["row", "claimEpoch", null],
          ["row", "claimOwnerHash", null],
          ["row", "claimExpiresAtMs", null],
          ["row", "claimEpoch", "2"],
          ["row", "generation", "1"],
          ["row", "seed", {}],
          ["row", "revisions", [{ effectKey: h(20), revision: "1" }]],
          ["row", "committedAtMs", "0"],
          ["row", "committedAtMs", "9007199254740992"],
          ["row", "claimExpiresAtMs", "9007199254740992"],
          ["row", "fence", "1000000000000000000"],
          ["row", "generation", "-1"],
          ["receipt", "ownerHash", h(22)],
          ["receipt", "reviewHash", h(22)],
          ["checkpoint", "positionCommandId", null],
          ["checkpoint", "positionCommandHash", null],
          ["checkpoint", "positionCommandHash", h(22)],
          ["checkpoint", "prefixLength", 1],
          ["checkpoint", "state", {}],
        ] as const) {
          const bad = artifacts();
          bad[target][key] = value;
          rejected(command(bad));
          expect(
            writer('SELECT count(*) FROM public."CertifiedForkVersion"'),
          ).toBe("0");
        }
        writer(command()); // REAL first deferred cyclic commit, including zero-event position.
        expect(
          writer(
            'SELECT "claimExpiresAtMs"::text FROM public."CertifiedForkVersion"',
          ),
        ).toBe("9007199254740991");
        for (const table of ["Family", "Version", "Receipt", "Checkpoint"]) {
          const name = `public."CertifiedFork${table}"`;
          rejected(`DELETE FROM ${name}`);
          rejected(`TRUNCATE ${name}`);
          rejected(`ALTER TABLE ${name} DISABLE TRIGGER ALL`);
          rejected(`DROP TABLE ${name} CASCADE`);
          rejected(`SELECT * FROM ${name}`, "disposable_app");
          rejected(
            `INSERT INTO ${name} SELECT * FROM ${name}`,
            "disposable_app",
          );
          rejected(`TRUNCATE ${name}`, "disposable_app");
          rejected(
            `INSERT INTO ${name} SELECT * FROM ${name}`,
            "disposable_reader",
          );
          expect(
            pg.query(db, `SELECT count(*) FROM ${name}`, "disposable_reader"),
          ).toBe("1");
          rejected(`UPDATE ${name} SET "familyKey"="familyKey"`);
          for (const role of ["disposable_reader", "disposable_app"]) {
            for (const statement of [
              `UPDATE ${name} SET "familyKey"="familyKey"`,
              `DELETE FROM ${name}`,
              `TRUNCATE ${name}`,
              `ALTER TABLE ${name} DISABLE TRIGGER ALL`,
              `DROP TABLE ${name} CASCADE`,
            ])
              rejected(statement, role);
          }
        }
        for (const [table, row] of [
          ["Family", { familyKey: h(1), tipVersion: "1" }],
          ["Version", initial.row],
          ["Receipt", initial.receipt],
          ["Checkpoint", initial.checkpoint],
        ] as const)
          rejected(insert(table, row));
        // New commands retain a new version even when the entire event log is unchanged.
        writer(command(artifacts(2, "renewClaim")));
        const release = artifacts(3, "releaseClaim");
        const wrongOwner = structuredClone(release);
        wrongOwner.receipt.ownerHash = h(30);
        rejected(command(wrongOwner));
        writer(command(release));
        const takeover = artifacts(4);
        Object.assign(takeover.row, {
          fence: "2",
          claimEpoch: "2",
          claimOwnerHash: h(30),
        });
        takeover.receipt.ownerHash = h(30);
        writer(command(takeover));
        expect(
          writer(
            'SELECT "ownerHash" FROM public."CertifiedForkReceipt" WHERE "commandId"=\'command_1\'',
          ),
        ).toBe(h(4));
        expect(
          writer('SELECT "tipVersion"::text FROM public."CertifiedForkFamily"'),
        ).toBe("4");
        expect(
          writer('SELECT count(*) FROM public."CertifiedForkVersion"'),
        ).toBe("4");
        // Recovery/replay reads current tip plus original identity; reading writes nothing.
        expect(
          writer(
            `SELECT f."tipVersion"::text||':'||r."version"::text FROM public."CertifiedForkFamily" f JOIN public."CertifiedForkReceipt" r USING ("familyKey") WHERE r."commandId"='command_1'`,
          ),
        ).toBe("4:1");
        expect(
          writer('SELECT count(*) FROM public."CertifiedForkCheckpoint"'),
        ).toBe("4");
        rejected(`UPDATE public."CertifiedForkFamily" SET "tipVersion"=5`);
        rejected(`UPDATE public."CertifiedForkFamily" SET "tipVersion"=1`);
        // High canonical revision counters live in complete checkpoint membership.
        const high = artifacts(5, "compareAndCommit");
        Object.assign(high.row, {
          fence: "2",
          claimEpoch: "2",
          claimOwnerHash: h(30),
        });
        high.receipt.ownerHash = h(30);
        const state = high.checkpoint.state as {
          review: unknown;
          states: unknown[];
        };
        state.states = [
          {
            request: { review: state.review, effect: { effectKey: h(31) } },
            revision: "999999999999999999",
            authority: {},
            attempts: [],
            stops: [],
            sealed: false,
            integrityHold: false,
            inventoryHash: null,
          },
        ];
        high.row.revisions = [
          { effectKey: h(31), revision: "999999999999999999" },
        ];
        writer(command(high));
        expect(
          writer(
            'SELECT "revisions"->0->>\'revision\' FROM public."CertifiedForkVersion" WHERE "version"=5',
          ),
        ).toBe("999999999999999999");
        // Isolate SQL bigint domains from sequential history: maintenance fixture
        // disables USER triggers only inside a rolled-back transaction. FKs/CHECKs
        // remain active; no high-counter imported history is committed or authorized.
        for (const counter of ["9007199254740993", "999999999999999999"]) {
          const large = artifacts();
          Object.assign(large.row, {
            familyKey: h(60),
            version: counter,
            generation: counter,
            fence: counter,
            claimEpoch: counter,
          });
          (
            large.row.seed as { facts: { generation: string } }
          ).facts.generation = counter;
          Object.assign(large.receipt, { familyKey: h(60), version: counter });
          Object.assign(large.checkpoint, {
            familyKey: h(60),
            version: counter,
            proof: "large",
          });
          const disable = ["Family", "Version", "Receipt", "Checkpoint"]
            .map(
              (t) =>
                `ALTER TABLE public."CertifiedFork${t}" DISABLE TRIGGER USER;`,
            )
            .join("\n");
          const seedSql = `BEGIN; ${disable} ${insert("Family", { familyKey: h(60), tipVersion: counter })} ${insert("Version", large.row)} ${insert("Receipt", large.receipt)} ${insert("Checkpoint", large.checkpoint)}`;
          expect(
            pg.query(
              db,
              `${seedSql} SET CONSTRAINTS ALL IMMEDIATE; SELECT "version"::text FROM public."CertifiedForkVersion" WHERE "familyKey"='${h(60)}'; ROLLBACK;`,
              "postgres",
            ),
          ).toBe(counter);
          for (const column of [
            "version",
            "generation",
            "fence",
            "claimEpoch",
          ]) {
            const invalid = structuredClone(large.row);
            invalid[column] = "1000000000000000000";
            rejected(
              `BEGIN; ${disable} ${insert("Family", { familyKey: h(60), tipVersion: counter })} ${insert("Version", invalid)} COMMIT;`,
              "postgres",
            );
          }
        }
        // Even a maintenance grant cannot evade immutable row/statement triggers.
        pg.query(
          db,
          'GRANT UPDATE, DELETE, TRUNCATE ON public."CertifiedForkVersion" TO disposable_writer',
          "postgres",
        );
        rejected(
          'UPDATE public."CertifiedForkVersion" SET "ledgerHash"="ledgerHash"',
        );
        rejected('DELETE FROM public."CertifiedForkVersion"');
        rejected('TRUNCATE public."CertifiedForkVersion"');
        expect(
          pg.query(
            db,
            `SELECT count(*) FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid JOIN pg_roles u ON u.oid=m.member WHERE r.rolname LIKE 'reviewrouter_certified_fork_%' AND u.rolname='reviewrouter'`,
            "postgres",
          ),
        ).toBe("0");
      } finally {
        pg.cleanup();
      }
    }
    expect(catalogs[1]).toEqual(catalogs[0]);
  }, 180_000);
});
