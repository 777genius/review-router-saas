import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { managedPg17Fixture } from "./lib/render-managed-pg17-fixture.js";
import { loadCommittedForkHistory } from "../packages/features/action-control-plane/src/infrastructure/prisma/certified-fork-history-loader.js";
import {
  PrismaCertifiedForkEffectRepository,
  type ForkArchiveTransactions,
} from "../packages/features/action-control-plane/src/infrastructure/prisma/prisma-certified-fork-effect-repository.js";
import {
  CertifiedForkProofFactWriter,
  type RetainedFactSql,
} from "../packages/features/action-control-plane/src/infrastructure/prisma/certified-fork-proof-fact-store.js";
import {
  archiveCommand,
  archiveHooks,
  archiveReview,
  fixtureHistory,
} from "../packages/features/action-control-plane/src/tests/support/certified-fork-archive-fixture.js";
import { inventoryFact } from "../packages/features/action-control-plane/src/tests/certified-fork-proof-fact-fixtures.js";

interface Client extends RetainedFactSql {
  connect(): Promise<void>;
  end(): Promise<void>;
}
const { Client: PgClient } = createRequire(import.meta.url)("pg") as {
  Client: new (options: Record<string, unknown>) => Client;
};
const migration = (name: string) =>
  readFileSync(
    new URL(
      `../packages/platform/db/prisma/migrations/${name}/migration.sql`,
      import.meta.url,
    ),
    "utf8",
  );

// Root execution only. Real offline managed fixture; never an ambient database,
// skip, mock SQL engine or production producer/authentication claim.
describe("committed fork history loader REAL PG17", () => {
  it("pins a committed prefix across append, hides staged facts, checks exact scope and fails closed on broken joins", async () => {
    const pg = managedPg17Fixture(),
      clients = new Set<Client>();
    const db = "fork_history_loader";
    const connect = async (user: string) => {
      const c = new PgClient({
        user,
        database: db,
        host: "127.0.0.1",
        port: 5432,
        password: "",
        ssl: false,
        stream: pg.wireStream,
        connectionTimeoutMillis: 10000,
      });
      clients.add(c);
      await c.connect();
      await c.query("SET statement_timeout='15s'", []);
      return c;
    };
    const transactions: ForkArchiveTransactions = {
      async run(_mode, work) {
        const c = await connect("history_writer");
        try {
          await c.query("BEGIN ISOLATION LEVEL READ COMMITTED", []);
          const result = await work(c);
          await c.query("COMMIT", []);
          return result;
        } catch (error) {
          await c.query("ROLLBACK", []);
          throw error;
        } finally {
          await c.end();
          clients.delete(c);
        }
      },
    };
    const { hooks } = archiveHooks();
    const repository = new PrismaCertifiedForkEffectRepository(
      transactions,
      hooks,
    );
    const family = archiveReview.familyKey;
    let denied = false;
    // Explicit TEST current authorization, independent of retained producer labels.
    const guard = async (sql: RetainedFactSql, key: string) => {
      expect(key).toBe(family);
      const { rows } = await sql.query("SELECT current_user AS principal", []);
      if (denied || rows[0]?.principal !== "history_reader")
        throw new Error("read_denied");
    };
    try {
      await pg.start();
      pg.query(
        "postgres",
        `CREATE ROLE reviewrouter LOGIN CREATEROLE CREATEDB; CREATE DATABASE ${db} OWNER reviewrouter`,
        "postgres",
      );
      pg.query(db, migration("000098_certified_fork_effect_archive"));
      pg.query(db, migration("000099_certified_fork_proof_facts"));
      pg.query(
        db,
        "CREATE ROLE history_writer LOGIN; GRANT reviewrouter_certified_fork_writer TO history_writer; CREATE ROLE history_reader LOGIN; GRANT reviewrouter_certified_fork_reader TO history_reader",
        "postgres",
      );
      const reader = await connect("history_reader");
      await reader.query("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY", []);
      await expect(
        loadCommittedForkHistory(reader, family, guard),
      ).rejects.toThrow();
      const command = archiveCommand("acquireClaim", "history_first");
      const build = command.build;
      const first = await repository.acquireClaim({
        ...command,
        build(prior, at) {
          const built = build(prior, at);
          const history = fixtureHistory(
            archiveReview,
            built.snapshot.claim!,
            at,
          );
          return {
            snapshot: { ...built.snapshot, events: history.events },
            state: history.state,
          };
        },
      });
      expect(first.snapshot).not.toBeNull();
      let appended = false;
      const pinnedConnection: RetainedFactSql = {
        async query(sql, values) {
          const result = await reader.query(sql, values);
          if (sql.startsWith('SELECT "tipVersion"') && !appended) {
            appended = true;
            await repository.renewClaim(
              archiveCommand("renewClaim", "history_later", first.snapshot),
            );
          }
          return result;
        },
      };
      const pinned = await loadCommittedForkHistory(
        pinnedConnection,
        family,
        guard,
      );
      expect(appended).toBe(true);
      expect(pinned.tipVersion).toBe("1");
      expect(pinned.versions.map((v) => v.snapshot)).toEqual([first.snapshot]);
      expect(pinned.versions[0]!.snapshot.events.length).toBeGreaterThan(0);
      const latest = await loadCommittedForkHistory(reader, family, guard);
      expect(latest.tipVersion).toBe("2");
      expect(latest.versions.map((v) => v.snapshot.version)).toEqual([
        "1",
        "2",
      ]);
      expect(pinned.versions).toHaveLength(1);

      const writer = await connect("history_writer");
      const fact = {
        ...inventoryFact("history-inventory"),
        scope: {
          workspaceId: first.snapshot!.seed.facts.workspaceId,
          repositoryConnectionId: first.snapshot!.seed.facts.repositoryId,
          familyKey: family,
          reviewHash: first.snapshot!.reviewHash,
        },
      };
      await writer.query("BEGIN", []);
      await new CertifiedForkProofFactWriter(writer).inventory(fact);
      await expect(
        pinned.readFact("inventory", fact.proofId, fact.scope),
      ).rejects.toThrow();
      await writer.query("COMMIT", []);
      expect(
        (await pinned.readFact("inventory", fact.proofId, fact.scope)).fact,
      ).toEqual(fact);
      await expect(
        pinned.readFact("output", fact.proofId, fact.scope),
      ).rejects.toThrow();
      await expect(
        pinned.readFact("inventory", fact.proofId, {
          ...fact.scope,
          workspaceId: "other",
        }),
      ).rejects.toThrow();
      denied = true;
      await expect(
        loadCommittedForkHistory(reader, family, guard),
      ).rejects.toThrow("read_denied");
      await expect(
        pinned.readFact("inventory", fact.proofId, fact.scope),
      ).rejects.toThrow("read_denied");
      denied = false;
      // Deliberate privileged corruption in this disposable DB only. Committed
      // damage is visible to the actual separate reader; no staged promotion.
      for (const table of [
        "CertifiedForkReceipt",
        "CertifiedForkCheckpoint",
        "CertifiedForkVersion",
      ]) {
        const admin = await connect("postgres");
        await admin.query(
          `CREATE TEMP TABLE saved AS SELECT * FROM public."${table}" WHERE "version"=1`,
          [],
        );
        await admin.query("SET session_replication_role=replica", []);
        await admin.query(
          `DELETE FROM public."${table}" WHERE "version"=1`,
          [],
        );
        await expect(
          loadCommittedForkHistory(reader, family, guard),
        ).rejects.toThrow();
        await admin.query(
          `INSERT INTO public."${table}" SELECT * FROM saved`,
          [],
        );
        await admin.query("SET session_replication_role=origin", []);
        await admin.end();
        clients.delete(admin);
      }
      expect(
        (await loadCommittedForkHistory(reader, family, guard)).versions,
      ).toHaveLength(2);
      await reader.query("COMMIT", []);
    } finally {
      await Promise.allSettled([...clients].map((c) => c.end()));
      pg.cleanup();
    }
  }, 180_000);
});
