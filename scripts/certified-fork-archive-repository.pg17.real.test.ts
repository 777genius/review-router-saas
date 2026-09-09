import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import {
  managedPg17Fixture,
  waitFor,
} from "./lib/render-managed-pg17-fixture.js";
import {
  PrismaCertifiedForkEffectRepository,
  type ForkArchiveTransactions,
} from "../packages/features/action-control-plane/src/infrastructure/prisma/prisma-certified-fork-effect-repository.js";
import type { RetainedFactSql } from "../packages/features/action-control-plane/src/infrastructure/prisma/certified-fork-proof-fact-store.js";
import type { ForkComparison } from "../packages/features/action-control-plane/src/application/ports/certified-fork-effect-repository-port.js";
import {
  advanced,
  checkpointAnchor,
  forkLedgerHash,
  replayForkLedger,
  rebuildReview,
  commitForkCommand,
} from "../packages/features/action-control-plane/src/application/services/certified-fork-effect-ledger.js";
import {
  archiveCommand,
  archiveHooks,
  archiveReview,
  fixtureStates,
  fixtureHistory,
  archiveSeed,
  ah,
} from "../packages/features/action-control-plane/src/tests/support/certified-fork-archive-fixture.js";
import { createForkReview } from "../packages/features/action-control-plane/src/domain/certified-fork-effect-identity.js";
import {
  fingerprint,
  next,
} from "../packages/features/action-control-plane/src/domain/certified-fork-effect-canonical.js";

import {
  claimCertifiedForkReview,
  manageCertifiedForkClaim,
} from "../packages/features/action-control-plane/src/application/use-cases/claim-certified-fork-review.js";
import { reconcileCertifiedForkEffect } from "../packages/features/action-control-plane/src/application/use-cases/reconcile-certified-fork-effect.js";
import { checkpointComparison } from "../packages/features/action-control-plane/src/infrastructure/prisma/certified-fork-archive-codec.js";

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
const latch = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

// Orchestrator-only real gate: selecting it always attempts the managed offline
// PG17.10 fixture. No ambient DB URL, fake SQL engine, skip or Docker invocation
// by the repository worker. Trusted hooks are TEST authority, not production E2E.
describe("certified fork archive repository REAL PG17", () => {
  it("serializes absent families, compares all siblings, rolls back atomically and recovers original receipts", async () => {
    const pg = managedPg17Fixture(),
      clients = new Set<Client>();
    const db = "archive_repository";
    const admin = (sql: string) => pg.query(db, sql, "postgres");
    const connect = async (name: string) => {
      const c = new PgClient({
        user: "archive_writer",
        database: db,
        host: "127.0.0.1",
        port: 5432,
        password: "",
        ssl: false,
        stream: pg.wireStream,
        application_name: name,
        connectionTimeoutMillis: 10000,
      });
      clients.add(c);
      await c.connect();
      await c.query("SET statement_timeout='15s'", []);
      return c;
    };
    let fault: "before_commit" | "after_commit" | null = null;
    const calls = { write: 0, read: 0 };
    const runner = (name: string): ForkArchiveTransactions => ({
      async run(mode, work) {
        calls[mode]++;
        const c = await connect(name);
        let committed = false;
        try {
          await c.query("BEGIN ISOLATION LEVEL READ COMMITTED", []);
          const result = await work(c);
          if (mode === "write" && fault === "before_commit") {
            fault = null;
            throw new Error("before_commit");
          }
          await c.query("COMMIT", []);
          committed = true;
          if (mode === "write" && fault === "after_commit") {
            fault = null;
            throw new Error("lost_commit_ack");
          }
          return result;
        } catch (error) {
          if (!committed) await c.query("ROLLBACK", []);
          throw error;
        } finally {
          await c.end();
          clients.delete(c);
        }
      },
    });
    const hookA = archiveHooks(),
      hookB = archiveHooks();
    const a = new PrismaCertifiedForkEffectRepository(
      runner("archive-a"),
      hookA.hooks,
    );
    const b = new PrismaCertifiedForkEffectRepository(
      runner("archive-b"),
      hookB.hooks,
    );
    const count = () =>
      admin(`SELECT jsonb_build_array(
      (SELECT count(*) FROM "CertifiedForkFamily"),(SELECT count(*) FROM "CertifiedForkVersion"),
      (SELECT count(*) FROM "CertifiedForkReceipt"),(SELECT count(*) FROM "CertifiedForkCheckpoint"))`);
    const family = archiveReview.familyKey;
    try {
      await pg.start();
      pg.query(
        "postgres",
        `CREATE ROLE reviewrouter LOGIN CREATEROLE CREATEDB; CREATE DATABASE ${db} OWNER reviewrouter`,
        "postgres",
      );
      pg.query(db, migration("000098_certified_fork_effect_archive"));
      pg.query(db, migration("000099_certified_fork_proof_facts"));
      admin(
        "CREATE ROLE archive_writer LOGIN; GRANT reviewrouter_certified_fork_writer TO archive_writer",
      );
      expect(await a.loadReview(family)).toEqual({
        snapshot: null,
        receipt: null,
      });
      // Failure after all four writes still rolls back the initially absent PK.
      fault = "before_commit";
      await expect(
        a.acquireClaim(archiveCommand("acquireClaim", "rolled_back")),
      ).rejects.toThrow("before_commit");
      expect(count()).toBe("[0, 0, 0, 0]");
      expect((await a.loadReview(family, "rolled_back")).receipt).toBeNull();
      const missingBefore = { ...calls };
      fault = "before_commit";
      await expect(
        commitForkCommand(
          {
            enabled: true,
            repository: a,
            proofs: hookA.hooks.proofs,
            ownerProof: "fixture-current-principal",
          },
          "acquireClaim",
          archiveCommand("acquireClaim", "missing_receipt"),
        ),
      ).rejects.toThrow("before_commit");
      expect(calls.write - missingBefore.write).toBe(1);
      expect(calls.read - missingBefore.read).toBe(1);
      expect(count()).toBe("[0, 0, 0, 0]");
      // Observe a real live second connection waiting on the exact family INSERT.
      const entered = latch(),
        release = latch();
      hookA.control.beforeRetain = async () => {
        entered.release();
        await release.promise;
      };
      const first = archiveCommand(
        "acquireClaim",
        "first",
        null,
        ah(20),
        fixtureStates(),
      );
      const second = archiveCommand("acquireClaim", "racer");
      const buildA = vi.fn(first.build),
        buildB = vi.fn(second.build);
      const startedA = a.acquireClaim({ ...first, build: buildA });
      await entered.promise;
      const startedB = b.acquireClaim({ ...second, build: buildB });
      const joined = Promise.allSettled([startedA, startedB]);
      try {
        await waitFor(
          () =>
            admin(
              "SELECT count(*) FROM pg_stat_activity WHERE application_name='archive-b' AND wait_event_type='Lock'",
            ) === "1",
        );
      } finally {
        release.release();
      }
      const raced = await joined;
      expect(raced.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
      expect(buildA).toHaveBeenCalledTimes(1);
      expect(buildB).not.toHaveBeenCalled();
      hookA.control.beforeRetain = null;
      expect(count()).toBe("[1, 1, 1, 1]");
      let current = (await a.loadReview(family, "first")).snapshot!;
      expect(current.checkpoint!.prefixLength).toBe(0);
      expect(current.checkpoint!.state.states).toHaveLength(2);
      // Every scalar/full nullable claim and sibling set component participates.
      const mutations: ((c: ForkComparison) => ForkComparison)[] = [
        (c) => ({ ...c, reviewHash: ah(90) }),
        (c) => ({ ...c, version: "2" }),
        (c) => ({ ...c, fence: "2" }),
        (c) => ({ ...c, claim: null }),
        (c) => ({ ...c, claim: { ...c.claim!, ownerHash: ah(90) } }),
        (c) => ({ ...c, claim: { ...c.claim!, claimHash: ah(90) } }),
        (c) => ({ ...c, claim: { ...c.claim!, epoch: "2" } }),
        (c) => ({
          ...c,
          claim: { ...c.claim!, expiresAt: c.claim!.expiresAt + 1 },
        }),
        (c) => ({ ...c, ledgerHash: ah(90) }),
        (c) => ({ ...c, outcomeHash: ah(90) }),
        (c) => ({ ...c, revisions: c.revisions.slice(0, 1) }),
        (c) => ({
          ...c,
          revisions: [...c.revisions, { effectKey: ah(90), revision: "1" }],
        }),
        (c) => ({
          ...c,
          revisions: c.revisions.map((r, i) =>
            i === 1 ? { ...r, revision: "2" } : r,
          ),
        }),
      ];
      for (const [i, mutate] of mutations.entries()) {
        const command = archiveCommand("renewClaim", `stale_${i}`, current),
          build = vi.fn(command.build);
        await expect(
          b.renewClaim({
            ...command,
            expected: mutate(command.expected!),
            build,
          }),
        ).rejects.toThrow();
        expect(build).not.toHaveBeenCalled();
        expect(count()).toBe("[1, 1, 1, 1]");
      }
      // Same command hash wins before stale expected/lease/admission; wrong hash
      // must never execute build or return someone else's receipt.
      const noBuild = vi.fn(() => {
        throw new Error("dedupe_built");
      });
      expect(
        (await a.acquireClaim({ ...first, expected: null, build: noBuild }))
          .replayed,
      ).toBe(true);
      await expect(
        a.acquireClaim({ ...first, commandHash: ah(99), build: noBuild }),
      ).rejects.toThrow();
      expect(noBuild).not.toHaveBeenCalled();
      // Database deferred guards reject an invalid operation transition after
      // inserts, preserving every table and the original family pointer.
      const malformed = archiveCommand("renewClaim", "bad_release", current);
      await expect(
        a.renewClaim({
          ...malformed,
          build(prior, at) {
            const built = malformed.build(prior, at);
            return { ...built, snapshot: { ...built.snapshot, claim: null } };
          },
        }),
      ).rejects.toThrow(/certified_fork_preserved_claim/u);
      expect(count()).toBe("[1, 1, 1, 1]");
      // Hold the real family lock, observe the waiting command, expire its
      // authenticated test principal at DB time, then allow it to proceed.
      const holder = await connect("archive-holder");
      await holder.query("BEGIN", []);
      await holder.query(
        'SELECT "tipVersion" FROM "CertifiedForkFamily" WHERE "familyKey"=$1 FOR UPDATE',
        [family],
      );
      const expired = archiveCommand("renewClaim", "expired", current),
        expiredBuild = vi.fn(expired.build);
      const waiting = Promise.allSettled([
        a.renewClaim({ ...expired, build: expiredBuild }),
      ]);
      try {
        await waitFor(
          () =>
            admin(
              "SELECT count(*) FROM pg_stat_activity WHERE application_name='archive-a' AND wait_event_type='Lock'",
            ) === "1",
        );
        hookA.control.expiresAt = Number(
          admin(
            "SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint",
          ),
        );
      } finally {
        await holder.query("ROLLBACK", []);
        await holder.end();
        clients.delete(holder);
      }
      expect((await waiting)[0]!.status).toBe("rejected");
      expect(expiredBuild).not.toHaveBeenCalled();
      hookA.control.expiresAt = Number.MAX_SAFE_INTEGER;
      current = (
        await a.renewClaim(archiveCommand("renewClaim", "renew", current))
      ).snapshot!;
      current = (
        await a.compareAndCommit(
          archiveCommand("compareAndCommit", "zero_event", current),
        )
      ).snapshot!;
      const released = await a.releaseClaim(
        archiveCommand("releaseClaim", "release", current),
      );
      expect(released.receipt!.ownerHash).toBe(ah(20));
      expect(released.snapshot!.claim).toBeNull();
      const newer = archiveHooks(ah(30));
      const newOwner = new PrismaCertifiedForkEffectRepository(
        runner("archive-new-owner"),
        newer.hooks,
      );
      current = (
        await newOwner.acquireClaim(
          archiveCommand(
            "acquireClaim",
            "reacquire",
            released.snapshot!,
            ah(30),
          ),
        )
      ).snapshot!;
      expect(current.fence).toBe("2");
      const coldHooks = archiveHooks();
      const cold = new PrismaCertifiedForkEffectRepository(
        runner("archive-cold"),
        coldHooks.hooks,
      );
      const recovered = await cold.acquireClaim({ ...first, build: noBuild });
      expect(recovered.snapshot!.version).toBe("5");
      expect(recovered.receipt!.version).toBe("1");
      expect(recovered.receipt!.ownerHash).toBe(ah(20));
      await expect(newOwner.loadReview(family, "first")).rejects.toThrow();
      coldHooks.control.revoked = true;
      await expect(cold.loadReview(family, "first")).rejects.toThrow();
      coldHooks.control.revoked = false;
      expect(
        admin(
          'SELECT count(*) FROM "CertifiedForkCheckpoint" WHERE "prefixLength"=0',
        ),
      ).toBe("5");
      expect(count()).toBe("[1, 5, 5, 5]");
      // Actual COMMIT followed by thrown acknowledgement; application performs
      // exactly one read, zero write retries, returns reconciliation_required.
      const command = archiveCommand(
        "renewClaim",
        "ambiguous",
        current,
        ah(30),
      );
      const before = { ...calls };
      fault = "after_commit";
      const result = await commitForkCommand(
        {
          enabled: true,
          repository: newOwner,
          proofs: newer.hooks.proofs,
          ownerProof: "fixture-current-principal",
        },
        "renewClaim",
        command,
      );
      expect(result.status).toBe("reconciliation_required");
      expect(calls.write - before.write).toBe(1);
      expect(calls.read - before.read).toBe(1);
      expect(count()).toBe("[1, 6, 6, 6]");
      // A failed recovery read propagates and never retries a committed command.
      const readFailure: ForkArchiveTransactions = {
        run(mode, work) {
          if (mode === "read") throw new Error("recovery_read_failed");
          return runner("archive-read-fault").run(mode, work);
        },
      };
      const broken = new PrismaCertifiedForkEffectRepository(
        readFailure,
        newer.hooks,
      );
      const tip = (await newOwner.loadReview(family)).snapshot!;
      fault = "after_commit";
      const lastWrites = calls.write;
      await expect(
        commitForkCommand(
          {
            enabled: true,
            repository: broken,
            proofs: newer.hooks.proofs,
            ownerProof: "fixture-current-principal",
          },
          "renewClaim",
          archiveCommand("renewClaim", "unreadable_ack", tip, ah(30)),
        ),
      ).rejects.toThrow("recovery_read_failed");
      expect(calls.write - lastWrites).toBe(1);
      expect(count()).toBe("[1, 7, 7, 7]");
      // Actual application writer integration in a separate family. All history
      // below is produced by real domain transitions; only producers are test-trusted.
      const seed = {
        ...archiveSeed,
        facts: { ...archiveSeed.facts, repositoryId: "lifecycle" },
      };
      const review = createForkReview(seed.facts, seed.bindingHash);
      const lifecycleHooks = archiveHooks();
      lifecycleHooks.control.admissions.set("test-lifecycle-admission", review);
      const lifecycle = new PrismaCertifiedForkEffectRepository(
        runner("archive-lifecycle"),
        lifecycleHooks.hooks,
      );
      const deps = {
        enabled: true as const,
        repository: lifecycle,
        proofs: lifecycleHooks.hooks.proofs,
        ownerProof: "test-principal",
      };
      await claimCertifiedForkReview(deps, {
        seed,
        admissionProof: "test-lifecycle-admission",
        ownerHash: ah(20),
        ttlMs: 300_000,
        commandId: "lifecycle-first",
      });
      const acquired = (await lifecycle.loadReview(review.familyKey)).snapshot!;
      let history!: ReturnType<typeof fixtureHistory>;
      await lifecycle.compareAndCommit({
        familyKey: review.familyKey,
        commandId: "lifecycle-history",
        commandHash: ah(80),
        expected: checkpointComparison(acquired),
        build(prior, at) {
          history = fixtureHistory(review, prior!.claim!, at);
          return {
            snapshot: { ...advanced(prior!), events: history.events },
            state: history.state,
          };
        },
      });
      const stored = (await lifecycle.loadReview(review.familyKey)).snapshot!;
      expect(stored.events).toEqual(history.events);
      expect(stored.checkpoint!.state).toEqual(history.state);
      expect(stored.checkpoint!.prefixLength).toBe(6);
      expect(
        replayForkLedger(stored, lifecycleHooks.hooks.proofs).outcome!.status,
      ).toBe("completed");
      const beforePrefix = count();
      for (const events of [
        stored.events.slice(0, -1),
        stored.events.map((e, i) =>
          i === 0 ? { ...e, authorityProof: "changed-prefix" } : e,
        ),
      ]) {
        await expect(
          lifecycle.compareAndCommit({
            familyKey: review.familyKey,
            commandId: "bad-prefix",
            commandHash: ah(81),
            expected: checkpointComparison(stored),
            build(prior) {
              return {
                snapshot: { ...advanced(prior!), events },
                state: history.state,
              };
            },
          }),
        ).rejects.toThrow(/certified_fork_event_prefix/u);
        expect(count()).toBe(beforePrefix);
        expect(
          (await lifecycle.loadReview(review.familyKey, "bad-prefix")).receipt,
        ).toBeNull();
        expect((await lifecycle.loadReview(review.familyKey)).snapshot).toEqual(
          stored,
        );
      }
      await manageCertifiedForkClaim(deps, {
        operation: "release",
        expected: stored,
        commandId: "lifecycle-release",
      });
      const lateHooks = archiveHooks(ah(30));
      lateHooks.control.admissions.set("test-lifecycle-admission", review);
      history.evidence.forEach((e, key) =>
        lateHooks.control.evidence.set(key, e),
      );
      const lateRepository = new PrismaCertifiedForkEffectRepository(
        runner("archive-late"),
        lateHooks.hooks,
      );
      const lateDeps = {
        ...deps,
        repository: lateRepository,
        proofs: lateHooks.hooks.proofs,
      };
      await claimCertifiedForkReview(lateDeps, {
        seed,
        admissionProof: "test-lifecycle-admission",
        ownerHash: ah(30),
        ttlMs: 300_000,
        commandId: "lifecycle-new-owner",
      });
      const beforeLate = (await lateRepository.loadReview(review.familyKey))
        .snapshot!;
      const originalEvidence =
        beforeLate.checkpoint!.state.states[0]!.attempts[0]!.evidence[0]!;
      const originalAuthority =
        beforeLate.checkpoint!.state.states[0]!.authority;
      const evidenceCommand = {
        kind: "evidence" as const,
        effectKey: originalEvidence.effectKey,
        proof: "test-success",
      };
      await reconcileCertifiedForkEffect(lateDeps, {
        expected: beforeLate,
        commandId: "identical-late-evidence",
        command: evidenceCommand,
      });
      expect(lateHooks.control.mutations).toBe(1);
      // A cold read reauthenticates complete retained bytes, not process brands.
      const freshHooks = archiveHooks(ah(30));
      freshHooks.control.admissions.set("test-lifecycle-admission", review);
      const fresh = new PrismaCertifiedForkEffectRepository(
        runner("archive-fresh"),
        freshHooks.hooks,
      );
      const freshDeps = {
        ...deps,
        repository: fresh,
        proofs: freshHooks.hooks.proofs,
      };
      const duplicate = await fresh.loadReview(
        review.familyKey,
        "identical-late-evidence",
      );
      const afterLate = duplicate.snapshot!;
      expect(afterLate.version).toBe(next(beforeLate.version));
      expect(duplicate.receipt!.version).toBe(afterLate.version);
      expect(duplicate.receipt!.ownerHash).toBe(ah(30));
      expect(afterLate.events).toEqual(beforeLate.events);
      expect(afterLate.checkpoint!.state).toEqual(beforeLate.checkpoint!.state);
      expect(afterLate.checkpoint!.state.states[0]!.authority).toEqual(
        originalAuthority,
      );
      expect(originalAuthority.ownerHash).toBe(ah(20));
      expect(
        afterLate.checkpoint!.state.states[0]!.attempts[0]!.evidence[0]!
          .authorityHash,
      ).toBe(originalEvidence.authorityHash);
      expect(afterLate.checkpoint!.proof).not.toBe(
        beforeLate.checkpoint!.proof,
      );
      expect(afterLate.checkpoint!.prefixLength).toBe(afterLate.events.length);
      expect(afterLate.checkpoint!.prefixHash).toBe(forkLedgerHash(afterLate));
      expect(afterLate.checkpoint!.anchorHash).toBe(
        checkpointAnchor(afterLate),
      );
      expect(afterLate.checkpoint!.position).toEqual({
        commandId: duplicate.receipt!.commandId,
        commandHash: duplicate.receipt!.commandHash,
      });
      expect(
        admin(
          `SELECT count(*) FROM "CertifiedForkVersion" WHERE "familyKey"='${review.familyKey}'`,
        ),
      ).toBe("5");
      expect(
        admin(
          `SELECT count(*) FROM "CertifiedForkReceipt" WHERE "familyKey"='${review.familyKey}'`,
        ),
      ).toBe("5");
      expect(
        admin(
          `SELECT count(*) FROM "CertifiedForkCheckpoint" WHERE "familyKey"='${review.familyKey}'`,
        ),
      ).toBe("5");
      await manageCertifiedForkClaim(freshDeps, {
        operation: "release",
        expected: afterLate,
        commandId: "lifecycle-final-release",
      });
      const predecessor = (await fresh.loadReview(review.familyKey)).snapshot!;
      freshHooks.control.predecessors.set(
        "test-authenticated-predecessor",
        predecessor,
      );
      const generationSeed = {
        ...seed,
        facts: { ...seed.facts, generation: "1" },
        admissionHash: ah(83),
        predecessor: "test-authenticated-predecessor",
      };
      const generation = rebuildReview(generationSeed, freshHooks.hooks.proofs);
      freshHooks.control.admissions.set("test-next-admission", generation);
      await claimCertifiedForkReview(freshDeps, {
        seed: generationSeed,
        admissionProof: "test-next-admission",
        ownerHash: ah(30),
        ttlMs: 300_000,
        commandId: "generation",
      });
      const generationLoaded = (
        await fresh.loadReview(review.familyKey, "generation")
      ).snapshot!;
      expect(generationLoaded.seed).toEqual(generationSeed);
      expect(generationLoaded.seed.admissionHash).toBe(ah(83));
      expect(generationLoaded.checkpoint!.state.review.admissionHash).toBe(
        fingerprint("fork-generation", [
          { admissionHash: ah(83) },
          {
            review,
            outcomeHash: predecessor.checkpoint!.state.outcome!.outcomeHash,
            status: "completed",
          },
        ]),
      );
      expect(generationLoaded.checkpoint!.state.review.admissionHash).not.toBe(
        generationLoaded.seed.admissionHash,
      );
      expect(
        rebuildReview(generationLoaded.seed, freshHooks.hooks.proofs),
      ).toEqual(generationLoaded.checkpoint!.state.review);
      expect(generationLoaded.events).toEqual([]);
      expect(generationLoaded.version).toBe("7");
      const originHooks = archiveHooks();
      const origin = new PrismaCertifiedForkEffectRepository(
        runner("archive-origin"),
        originHooks.hooks,
      );
      const recoveredGeneration = await origin.loadReview(
        review.familyKey,
        "lifecycle-first",
      );
      expect(recoveredGeneration.receipt!.version).toBe("1");
      expect(recoveredGeneration.receipt!.ownerHash).toBe(ah(20));
      expect(recoveredGeneration.snapshot!.version).toBe("7");
      await expect(
        fresh.loadReview(review.familyKey, "lifecycle-first"),
      ).rejects.toThrow();
      expect(count()).toBe("[2, 14, 14, 14]");
    } finally {
      await Promise.allSettled([...clients].map((c) => c.end()));
      pg.cleanup();
    }
  }, 180_000);
});
