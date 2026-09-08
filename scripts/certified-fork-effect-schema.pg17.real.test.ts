import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { managedPg17Fixture } from "./lib/render-managed-pg17-fixture.js";

// Always executes when selected: unavailable Docker is a FAILED gate, never a skip.
// This fixture accepts no URL/identity and uses a unique labelled PG17.10 container
// with --network=none, no host mounts/ports, and guaranteed owned-container cleanup.
const migration = readFileSync(
  new URL(
    "../packages/platform/db/prisma/migrations/000098_certified_fork_effect_archive/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
// Deterministic SHA-256 blocks encoded as printable ASCII, not compressible repeats.
// This is an opaque storage fixture, never an authenticated proof.
const longProof = Array.from({ length: 96 }, (_, i) =>
  createHash("sha256")
    .update(`certified-fork-proof-boundary:${i}`)
    .digest("base64"),
)
  .join("")
  .slice(0, 4096);
const h = (n: number) => n.toString(16).padStart(64, "0");
const quote = (v: unknown) =>
  `'${(typeof v === "string" ? v : JSON.stringify(v)).replaceAll("'", "''")}'`;
const proofDigest = (proof: string) =>
  createHash("sha256").update(proof, "utf8").digest("hex");
const rawInsert = (table: string, row: Record<string, unknown>) =>
  `INSERT INTO public."CertifiedFork${table}" (${Object.keys(row)
    .map((k) => `"${k}"`)
    .join(",")}) VALUES (${Object.values(row)
    .map((v) => (v === null ? "NULL" : quote(v)))
    .join(",")});`;
// Normal repository-style writes compute the digest from the final proof value.
// Raw insertion below deliberately bypasses this helper for adversarial inputs.
const insert = (table: string, row: Record<string, unknown>) =>
  rawInsert(
    table,
    table === "Checkpoint"
      ? { ...row, proofSha256: `\\x${proofDigest(String(row.proof))}` }
      : row,
  );

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
function command(a = artifacts(), omit = "", rawCheckpoint = false) {
  const version = a.row.version;
  return `BEGIN; ${version === "1" ? insert("Family", { familyKey: a.row.familyKey, tipVersion: "1" }) : ""}
    ${omit === "version" ? "" : insert("Version", a.row)}
    ${omit === "receipt" ? "" : insert("Receipt", a.receipt)}
    ${omit === "checkpoint" ? "" : (rawCheckpoint ? rawInsert : insert)("Checkpoint", a.checkpoint)}
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
  it("reuses safe cluster roles across databases with authorized ADMIN and atomic denial", async () => {
    const pg = managedPg17Fixture();
    const first = `certified_first_${randomUUID().replaceAll("-", "")}`;
    const second = `certified_second_${randomUUID().replaceAll("-", "")}`;
    try {
      await pg.start();
      pg.query(
        "postgres",
        `CREATE ROLE reviewrouter LOGIN CREATEROLE CREATEDB;
        CREATE ROLE disposable_app LOGIN; CREATE ROLE disposable_parent;
        CREATE DATABASE ${first} OWNER postgres;
        CREATE DATABASE ${second} OWNER reviewrouter;`,
        "postgres",
      );
      const query = (db: string, sql: string) => pg.query(db, sql, "postgres");
      const globalState = () =>
        query(
          "postgres",
          `SELECT jsonb_build_object(
        'roles',(SELECT jsonb_agg(to_jsonb(r) ORDER BY rolname) FROM pg_roles r WHERE rolname LIKE 'reviewrouter_certified_fork_%'),
        'memberships',(SELECT jsonb_agg(to_jsonb(m) ORDER BY roleid,member,grantor) FROM pg_auth_members m));`,
        );
      const clean = () => {
        expect(
          query(
            "postgres",
            "SELECT count(*) FROM pg_roles WHERE rolname='reviewrouter_certified_fork_creator'",
          ),
        ).toBe("0");
        expect(
          query(
            "postgres",
            `SELECT count(*) FROM pg_auth_members m
          WHERE m.roleid IN (SELECT oid FROM pg_roles WHERE rolname LIKE 'reviewrouter_certified_fork_%')
             OR m.member IN (SELECT oid FROM pg_roles WHERE rolname LIKE 'reviewrouter_certified_fork_%')`,
          ),
        ).toBe("0");
      };
      // Exactly the checked-in SQL, twice on one cluster, as CI's dev/test deploys.
      query(first, migration);
      clean();
      query(first, command());
      query(
        first,
        "CREATE TABLE public.disposable_sentinel (id integer PRIMARY KEY, data text); INSERT INTO public.disposable_sentinel VALUES (1,'retain');",
      );
      const firstState = () =>
        query(first, catalog) +
        query(
          first,
          `SELECT jsonb_build_object(
        'functions',(SELECT jsonb_agg(jsonb_build_array(p.oid,pg_get_functiondef(p.oid),p.proowner,p.proacl) ORDER BY p.oid) FROM pg_proc p WHERE proname LIKE 'certified_fork_%'),
        'schema',(SELECT to_jsonb(n) FROM pg_namespace n WHERE nspname='public'),
        'sentinel',(SELECT jsonb_agg(to_jsonb(t)) FROM public.disposable_sentinel t),
        'family',(SELECT jsonb_agg(to_jsonb(t)) FROM public."CertifiedForkFamily" t),
        'version',(SELECT jsonb_agg(to_jsonb(t)) FROM public."CertifiedForkVersion" t),
        'receipt',(SELECT jsonb_agg(to_jsonb(t)) FROM public."CertifiedForkReceipt" t),
        'checkpoint',(SELECT jsonb_agg(to_jsonb(t)) FROM public."CertifiedForkCheckpoint" t));`,
        );
      const beforeFirst = firstState();
      const beforeGlobal = globalState();
      const denied = (error: RegExp, deployer = "postgres") => {
        const before = globalState();
        const beforeSecond = query(second, catalog);
        expect(() => pg.query(second, migration, deployer)).toThrow(error);
        expect(globalState()).toBe(before);
        expect(query(second, catalog)).toBe(beforeSecond);
        expect(firstState()).toBe(beforeFirst);
        expect(
          query(
            second,
            "SELECT count(*) FROM pg_roles WHERE rolname='reviewrouter_certified_fork_creator'",
          ),
        ).toBe("0");
      };
      denied(
        /certified_fork_existing_owner_admin_precondition/u,
        "reviewrouter",
      );
      // A superuser must still reject unsafe prior role attributes and both
      // directions of membership, preserving rather than scrubbing prior grants.
      for (const role of ["owner", "writer", "reader"]) {
        const name = `reviewrouter_certified_fork_${role}`;
        query("postgres", `ALTER ROLE ${name} LOGIN`);
        denied(/certified_fork_unsafe_role/u);
        query("postgres", `ALTER ROLE ${name} NOLOGIN`);
        query(
          "postgres",
          `GRANT ${name} TO disposable_app WITH ADMIN TRUE, INHERIT FALSE, SET FALSE GRANTED BY postgres`,
        );
        denied(/certified_fork_existing_membership/u);
        query(
          "postgres",
          `REVOKE ${name} FROM disposable_app GRANTED BY postgres RESTRICT`,
        );
        query("postgres", `GRANT disposable_parent TO ${name}`);
        denied(/certified_fork_role_membership_precondition/u);
        query(
          "postgres",
          `REVOKE disposable_parent FROM ${name} GRANTED BY postgres RESTRICT`,
        );
      }
      expect(globalState()).toBe(beforeGlobal);
      // Fail after temporary ADMIN/SET installation to prove transactional cleanup.
      query(
        second,
        'CREATE TABLE public."CertifiedForkFamily" (sentinel text)',
      );
      denied(/relation "CertifiedForkFamily" already exists/u);
      query(second, 'DROP TABLE public."CertifiedForkFamily"');
      query(second, migration);
      clean(); // No runtime fixture grants have been installed in either DB.
      expect(globalState()).toBe(beforeGlobal);
      expect(firstState()).toBe(beforeFirst);
      expect(query(second, catalog)).toBe(query(first, catalog));
      expect(
        query(second, 'SELECT count(*) FROM public."CertifiedForkFamily"'),
      ).toBe("0");
    } finally {
      pg.cleanup();
    }
  }, 180_000);
  it("proves fresh/representative-upgrade parity and raw SQL archive/ACL invariants", async () => {
    const catalogs: unknown[] = [];
    for (const upgrade of [false, true]) {
      const pg = managedPg17Fixture();
      const db = `certified_fork_${randomUUID().replaceAll("-", "")}`;
      try {
        await pg.start();
        // PG17 pg_proc.dat marks textsend and convert_to STABLE (s), sha256
        // IMMUTABLE (i). Check the real catalog without altering volatility.
        expect(
          pg.query(
            "postgres",
            `SELECT string_agg(proname || ':' || provolatile::text, ',' ORDER BY proname)
          FROM pg_proc WHERE oid IN ('pg_catalog.textsend(text)'::regprocedure,
            'pg_catalog.convert_to(text,name)'::regprocedure, 'pg_catalog.sha256(bytea)'::regprocedure)`,
            "postgres",
          ),
        ).toBe("convert_to:s,sha256:i,textsend:s");
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
        // Each rejection must preserve all four artifacts and the family tip.
        const archiveSnapshot = () =>
          writer(`SELECT jsonb_build_array(
          (SELECT jsonb_agg(to_jsonb(t) ORDER BY "familyKey") FROM public."CertifiedForkFamily" t),
          (SELECT jsonb_agg(to_jsonb(t) ORDER BY "familyKey","version") FROM public."CertifiedForkVersion" t),
          (SELECT jsonb_agg(to_jsonb(t) ORDER BY "familyKey","version") FROM public."CertifiedForkReceipt" t),
          (SELECT jsonb_agg(to_jsonb(t) ORDER BY "familyKey","version") FROM public."CertifiedForkCheckpoint" t));`);
        const rejectsAtomically = (
          a: ReturnType<typeof artifacts>,
          error: RegExp,
          rawCheckpoint = false,
        ) => {
          const before = archiveSnapshot();
          expect(() => writer(command(a, "", rawCheckpoint))).toThrow(error);
          expect(archiveSnapshot()).toBe(before);
        };
        // Generation zero has no admission input, predecessor or derived hash.
        for (const field of ["admissionHash", "predecessor"]) {
          const bad = artifacts();
          Object.assign(bad.row.seed as object, { [field]: h(81) });
          rejectsAtomically(bad, /certified_fork_checkpoint_consistency/u);
        }
        const badZeroReview = artifacts();
        Object.assign(
          (badZeroReview.checkpoint.state as { review: object }).review,
          { admissionHash: h(82) },
        );
        rejectsAtomically(
          badZeroReview,
          /certified_fork_checkpoint_consistency/u,
        );
        // Explicit missing, NULL, malformed-size, and wrong-content digests.
        for (const digest of [
          undefined,
          null,
          "\\x",
          `\\x${"00".repeat(31)}`,
          `\\x${"00".repeat(33)}`,
          `\\x${"00".repeat(32)}`,
        ]) {
          const badDigest = artifacts();
          if (digest !== undefined) badDigest.checkpoint.proofSha256 = digest;
          rejectsAtomically(
            badDigest,
            digest == null
              ? /null value in column "proofSha256"/u
              : /CertifiedForkCheckpoint_proofSha256_check/u,
            true,
          );
        }
        const emptyProof = artifacts();
        emptyProof.checkpoint.proof = "";
        rejectsAtomically(emptyProof, /CertifiedForkCheckpoint_proof_check/u);
        expect(longProof).toHaveLength(4096);
        expect(longProof).toMatch(/^[\x20-\x7e]+$/u);
        const oversized = artifacts();
        oversized.checkpoint.proof = `${longProof}x`;
        rejectsAtomically(oversized, /CertifiedForkCheckpoint_proof_check/u);
        const fullProof = artifacts();
        fullProof.checkpoint.proof = longProof;
        writer(command(fullProof)); // REAL four-artifact commit with full-length proof.
        // Digest narrows lookup; exact UTF8 equality is mandatory, not authentication.
        const readProof = (digest: string, token: string) =>
          pg.query(
            db,
            `SELECT "proof" FROM public."CertifiedForkCheckpoint"
           WHERE "proofSha256" = decode(${quote(digest)}, 'hex')
             AND pg_catalog.convert_to("proof", 'UTF8') = pg_catalog.convert_to(${quote(token)}::text, 'UTF8')`,
            "disposable_reader",
          );
        expect(readProof(proofDigest(longProof), longProof)).toBe(longProof);
        expect(
          readProof(proofDigest(longProof), `${longProof.slice(0, -1)}!`),
        ).toBe("");
        expect(readProof("00".repeat(32), longProof)).toBe("");
        expect(
          writer(
            'SELECT octet_length("proofSha256") FROM public."CertifiedForkCheckpoint"',
          ),
        ).toBe("32");
        // A forged collision cannot alias or replace the stored full proof.
        const forgedCollision = artifacts(2, "renewClaim");
        forgedCollision.checkpoint.proofSha256 = `\\x${proofDigest(longProof)}`;
        rejectsAtomically(
          forgedCollision,
          /CertifiedForkCheckpoint_proofSha256_check/u,
          true,
        );
        // Non-ASCII UTF8 (including a combining sequence) roundtrips unchanged.
        const unicodeProof = artifacts(2, "renewClaim");
        unicodeProof.checkpoint.proof = "é/e\u0301/🔐";
        const beforeUnicode = archiveSnapshot();
        expect(
          writer(
            command(unicodeProof).replace(
              /COMMIT;$/u,
              `SET CONSTRAINTS ALL IMMEDIATE; SELECT "proof" FROM public."CertifiedForkCheckpoint" WHERE "proofSha256" = decode(${quote(proofDigest(String(unicodeProof.checkpoint.proof)))}, 'hex') AND pg_catalog.convert_to("proof", 'UTF8') = pg_catalog.convert_to(${quote(unicodeProof.checkpoint.proof)}::text, 'UTF8'); ROLLBACK;`,
            ),
          ),
        ).toBe(unicodeProof.checkpoint.proof);
        expect(archiveSnapshot()).toBe(beforeUnicode);
        const duplicateProof = artifacts(2, "renewClaim");
        duplicateProof.checkpoint.proof = longProof;
        rejectsAtomically(
          duplicateProof,
          /CertifiedForkCheckpoint_proof_sha256_key/u,
        );
        const oversizedNext = artifacts(2, "renewClaim");
        oversizedNext.checkpoint.proof = `${longProof}x`;
        rejectsAtomically(
          oversizedNext,
          /CertifiedForkCheckpoint_proof_check/u,
        );
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
        // Exercise actual nonempty retained prefixes with ordinary writer triggers.
        // These inputs satisfy SQL shape only; no proof authenticity is asserted.
        const event = (at: number, kind = "prepare") => ({
          at,
          authorityProof: null,
          input: { kind },
        });
        const successor = (version: number, operation = "compareAndCommit") => {
          const a = artifacts(version, operation);
          Object.assign(a.row, {
            fence: "2",
            claimEpoch: "2",
            claimOwnerHash: h(30),
          });
          a.receipt.ownerHash = h(30);
          return a;
        };
        const withEvents = (
          a: ReturnType<typeof artifacts>,
          events: unknown[],
        ) => {
          a.row.events = events;
          a.checkpoint.prefixLength = events.length;
          return a;
        };
        writer(
          command(withEvents(successor(6), [event(5), event(6, "begin")])),
        );
        rejectsAtomically(
          withEvents(successor(7), [event(5)]),
          /certified_fork_event_prefix/u,
        );
        rejectsAtomically(
          withEvents(successor(7), [event(5, "begin"), event(6)]),
          /certified_fork_event_prefix/u,
        );
        rejectsAtomically(
          withEvents(successor(7), [event(5), event(6, "begin"), event(5)]),
          /certified_fork_event_time/u,
        );
        // Last retained event predates prior commit, so this isolates appended-time guard.
        const retained = withEvents(successor(7), [
          event(5),
          event(6, "begin"),
        ]);
        writer(command(retained));
        rejectsAtomically(
          withEvents(successor(8), [event(5), event(6, "begin"), event(6)]),
          /certified_fork_appended_event_time/u,
        );
        const releaseEvents = withEvents(successor(8, "releaseClaim"), [
          event(5),
          event(6, "begin"),
          event(8, "stop"),
        ]);
        Object.assign(releaseEvents.row, {
          claimOwnerHash: null,
          claimHash: null,
          claimEpoch: null,
          claimExpiresAtMs: null,
        });
        const advance = (
          version: number,
          generation = "1",
          operation = "acquireClaim",
        ) => {
          const a = successor(version, operation);
          Object.assign(a.row, { generation, fence: "3", claimEpoch: "3" });
          (a.row.seed as { facts: { generation: string } }).facts.generation =
            generation;
          Object.assign(a.row.seed as object, {
            admissionHash: h(81),
            predecessor: "test-predecessor-reference",
          });
          (
            a.checkpoint.state as { review: { admissionHash: string | null } }
          ).review.admissionHash = h(82);
          // Different input/derived hashes are structurally valid; SQL does not
          // authenticate this fixture's domain admission or predecessor capability.
          return withEvents(a, [event(version)]);
        };
        rejectsAtomically(advance(8), /certified_fork_acquire_claim/u);
        writer(command(releaseEvents));
        rejectsAtomically(
          advance(9, "2"),
          /certified_fork_history_progression/u,
        );
        rejectsAtomically(
          advance(9, "1", "compareAndCommit"),
          /certified_fork_history_progression/u,
        );
        for (const invalid of [null, "", "bad", "A".repeat(64), 123]) {
          const badInput = advance(9);
          Object.assign(badInput.row.seed as object, {
            admissionHash: invalid,
          });
          rejectsAtomically(badInput, /certified_fork_checkpoint_consistency/u);
          const badDerived = advance(9);
          Object.assign(
            (badDerived.checkpoint.state as { review: object }).review,
            { admissionHash: invalid },
          );
          rejectsAtomically(
            badDerived,
            /certified_fork_checkpoint_consistency/u,
          );
        }
        for (const invalid of [null, "", 123, "p".repeat(4097)]) {
          const bad = advance(9);
          Object.assign(bad.row.seed as object, { predecessor: invalid });
          rejectsAtomically(bad, /certified_fork_checkpoint_consistency/u);
        }
        for (const field of ["admissionHash", "predecessor"]) {
          const missing = advance(9);
          delete (missing.row.seed as Record<string, unknown>)[field];
          rejectsAtomically(missing, /check constraint/u);
        }
        const missingReviewHash = advance(9);
        delete (
          missingReviewHash.checkpoint.state as {
            review: Record<string, unknown>;
          }
        ).review.admissionHash;
        rejectsAtomically(
          missingReviewHash,
          /certified_fork_checkpoint_consistency/u,
        );
        writer(command(advance(9)));
        expect(
          writer(
            'SELECT "generation"::text FROM public."CertifiedForkVersion" WHERE "version"=9',
          ),
        ).toBe("1");
        expect(
          writer(
            'SELECT "prefixLength" FROM public."CertifiedForkCheckpoint" WHERE "version"=9',
          ),
        ).toBe("1");
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
