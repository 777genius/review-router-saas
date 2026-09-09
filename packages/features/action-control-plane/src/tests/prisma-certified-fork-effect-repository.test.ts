import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  PrismaCertifiedForkEffectRepository,
  type ForkArchiveTransactions,
  type ForkArchiveVersion,
  prismaForkArchiveTransactions,
} from "../infrastructure/prisma/prisma-certified-fork-effect-repository.js";
import { checkpointComparison } from "../infrastructure/prisma/certified-fork-archive-codec.js";
import type { RetainedFactSql } from "../infrastructure/prisma/certified-fork-proof-fact-store.js";
import {
  archiveCommand,
  archiveHooks,
  archiveReview,
  archiveRow,
  fixtureStates,
  fixtureHistory,
  archiveSeed,
  ah,
} from "./support/certified-fork-archive-fixture.js";

import { reconcileCertifiedForkEffect } from "../application/use-cases/reconcile-certified-fork-effect.js";
import { claimCertifiedForkReview } from "../application/use-cases/claim-certified-fork-review.js";
import { rebuildReview } from "../application/services/certified-fork-effect-ledger.js";
import { fingerprint } from "../domain/certified-fork-effect-canonical.js";
import type { ForkCheckpointState } from "../application/ports/certified-fork-effect-proof-port.js";

// Controlled results test failure/lifetime boundaries, NOT PostgreSQL behavior.
// The separate managedPg17Fixture suite executes every write against SQL098/099.
const initialSql = (): RetainedFactSql => ({
  async query(sql) {
    if (sql.startsWith('INSERT INTO public."CertifiedForkFamily"'))
      return { rows: [{ familyKey: archiveReview.familyKey }] };
    if (sql.startsWith('SELECT "tipVersion"'))
      return { rows: [{ tipVersion: 1n }] };
    if (sql.includes("clock_timestamp()")) return { rows: [{ at: 100n }] };
    return { rows: [] };
  },
});
async function signedRow(complete = false): Promise<Record<string, unknown>> {
  const { hooks } = archiveHooks(),
    sql = initialSql();
  const command = archiveCommand(
    "acquireClaim",
    "stored",
    null,
    ah(20),
    fixtureStates(),
  );
  let built = command.build(null, 100);
  if (complete) {
    const history = fixtureHistory(archiveReview, built.snapshot.claim!, 100);
    built = {
      snapshot: { ...built.snapshot, events: history.events },
      state: history.state,
    };
  }
  const scope = await hooks.lockScope(sql, command.familyKey);
  const binding = await scope.prepareCommand(
    sql,
    command,
    null,
    "acquireClaim",
  );
  const cp = binding.run(100, () =>
    hooks.proofs.issueCheckpoint(built.snapshot, built.state, {
      commandId: command.commandId,
      commandHash: command.commandHash,
    }),
  );
  scope.close();
  const snapshot = { ...built.snapshot, checkpoint: cp };
  const version: ForkArchiveVersion = {
    snapshot,
    receipt: {
      ownerHash: ah(20),
      commandId: command.commandId,
      commandHash: command.commandHash,
      reviewHash: snapshot.reviewHash,
      version: "1",
    },
    operation: "acquireClaim",
    comparison: checkpointComparison(snapshot),
    committedAt: 100,
  };
  return {
    ...archiveRow(version),
    proofSha256: createHash("sha256").update(cp.proof).digest(),
  };
}
const readRunner = (
  row: Record<string, unknown>,
  at = 100,
  queries: { sql: string; values: readonly unknown[] }[] = [],
): ForkArchiveTransactions => ({
  async run(_mode, work) {
    return work({
      async query(sql, values) {
        queries.push({ sql, values });
        if (sql.startsWith('SELECT "tipVersion"'))
          return { rows: [{ tipVersion: "1" }] };
        if (sql.includes('FROM public."CertifiedForkVersion"'))
          return { rows: [row] };
        if (sql.includes("clock_timestamp()"))
          return { rows: [{ at: String(at) }] };
        return { rows: [] };
      },
    });
  },
});

describe("PostgreSQL repository transaction and trust boundaries", () => {
  it("runs the real trusted binding exactly once and resolves only after runner commit", async () => {
    const { hooks, control } = archiveHooks();
    const close = vi.fn();
    const lock = hooks.lockScope;
    hooks.lockScope = async (sql, family) => {
      const scope = await lock(sql, family);
      return {
        ...scope,
        close() {
          scope.close();
          close();
        },
      };
    };
    let committed = false,
      callbackDone!: () => void,
      permitCommit!: () => void;
    const callback = new Promise<void>((resolve) => {
      callbackDone = resolve;
    });
    const permission = new Promise<void>((resolve) => {
      permitCommit = resolve;
    });
    const run = vi.fn(async (_mode, work) => {
      const result = await work(initialSql());
      callbackDone();
      await permission;
      committed = true;
      return result;
    });
    const repository = new PrismaCertifiedForkEffectRepository({ run }, hooks);
    const command = archiveCommand("acquireClaim", "once"),
      build = vi.fn(command.build);
    let resolved = false;
    const pending = repository.acquireClaim({ ...command, build }).then((r) => {
      resolved = true;
      return r;
    });
    await callback;
    expect(resolved).toBe(false);
    expect(committed).toBe(false);
    expect(control.promoted).toBe(0);
    expect(close).not.toHaveBeenCalled();
    expect(build).toHaveBeenCalledTimes(1);
    expect(control.buildsBound).toBe(1);
    expect(() =>
      hooks.proofs.issueCheckpoint(
        command.build(null, 100).snapshot,
        command.build(null, 100).state,
        null,
      ),
    ).toThrow();
    permitCommit();
    const loaded = await pending;
    expect(committed).toBe(true);
    expect(control.promoted).toBe(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(loaded.snapshot!.checkpoint!.position!.commandId).toBe("once");
    expect(Object.isFrozen(loaded.snapshot!.checkpoint!.state.states)).toBe(
      true,
    );
  });
  it("propagates precommit and ambiguous commit errors without retries/promotions", async () => {
    for (const message of ["rollback", "lost_ack"]) {
      const { hooks, control } = archiveHooks();
      const run = vi.fn(async (_mode, work) => {
        await work(initialSql());
        throw new Error(message);
      });
      const repository = new PrismaCertifiedForkEffectRepository(
        { run },
        hooks,
      );
      await expect(
        repository.acquireClaim(archiveCommand("acquireClaim", message)),
      ).rejects.toThrow(message);
      expect(run).toHaveBeenCalledTimes(1);
      expect(control.promoted).toBe(0);
    }
  });
  it("reads immutable data with a fresh authenticated history binding", async () => {
    const row = await signedRow(),
      { hooks, control } = archiveHooks();
    const repository = new PrismaCertifiedForkEffectRepository(
      readRunner(row),
      hooks,
    );
    const loaded = await repository.loadReview(archiveReview.familyKey);
    expect(loaded.snapshot!.checkpoint!.state.states).toHaveLength(2);
    expect(control.histories).toBe(1);
    expect(control.buildsBound).toBe(0);
    expect(loaded.receipt).toBeNull();
  });
  it("rejects missing checkpoints, altered state, cached siblings and original receipt owner", async () => {
    const original = await signedRow();
    const edits: ((row: Record<string, unknown>) => void)[] = [
      (r) => {
        r.checkpointFormat = null;
      },
      (r) => {
        r.proofSha256 = Buffer.alloc(32);
      },
      (r) => {
        r.ownerHash = ah(30);
      },
      (r) => {
        r.revisions = [];
      },
      (r) => {
        r.positionCommandId = "different";
      },
      (r) => {
        const state = r.state as { states: { sealed: boolean }[] };
        state.states[0]!.sealed = true;
      },
    ];
    for (const edit of edits) {
      const row = structuredClone(original);
      edit(row);
      const repository = new PrismaCertifiedForkEffectRepository(
        readRunner(row),
        archiveHooks().hooks,
      );
      await expect(
        repository.loadReview(archiveReview.familyKey),
      ).rejects.toThrow();
    }
  });
  it("drives the actual generation claim with an authenticated completed predecessor and original admission through repository serialization", async () => {
    const row = await signedRow(true),
      { hooks, control } = archiveHooks();
    const queries: { sql: string; values: readonly unknown[] }[] = [];
    // Controlled SQL results model an expired original lease. Real deferred
    // constraints and atomicity are exercised only by the separate PG gate.
    const repository = new PrismaCertifiedForkEffectRepository(
      readRunner(row, 200_000, queries),
      hooks,
    );
    const predecessor = (await repository.loadReview(archiveReview.familyKey))
      .snapshot!;
    expect(predecessor.checkpoint!.state.outcome!.status).toBe("completed");
    control.predecessors.set("authenticated-prior", predecessor);
    const seed = {
      ...archiveSeed,
      facts: { ...archiveSeed.facts, generation: "1" },
      admissionHash: ah(83),
      predecessor: "authenticated-prior",
    };
    const review = rebuildReview(seed, hooks.proofs);
    control.admissions.set("admitted-original-input", review);
    const result = await claimCertifiedForkReview(
      {
        enabled: true,
        repository,
        proofs: hooks.proofs,
        ownerProof: "test-principal",
      },
      {
        seed,
        admissionProof: "admitted-original-input",
        ownerHash: ah(20),
        ttlMs: 120_000,
        commandId: "real-generation-claim",
      },
    );
    expect(result.status).toBe("committed");
    if (!("loaded" in result)) throw new Error("missing_committed_result");
    const snapshot = result.loaded.snapshot!;
    expect(snapshot.seed).toEqual(seed);
    expect(snapshot.checkpoint!.state.review).toEqual(review);
    expect(review.admissionHash).toBe(
      fingerprint("fork-generation", [
        { admissionHash: ah(83) },
        {
          review: archiveReview,
          outcomeHash: predecessor.checkpoint!.state.outcome!.outcomeHash,
          status: "completed",
        },
      ]),
    );
    expect(review.admissionHash).not.toBe(snapshot.seed.admissionHash);
    expect(rebuildReview(snapshot.seed, hooks.proofs)).toEqual(review);
    expect(snapshot.events).toEqual([]);
    const versionWrite = queries.find((q) =>
      q.sql.startsWith('INSERT INTO public."CertifiedForkVersion"'),
    )!;
    const checkpointWrite = queries.find((q) =>
      q.sql.startsWith('INSERT INTO public."CertifiedForkCheckpoint"'),
    )!;
    expect(JSON.parse(versionWrite.values[5] as string)).toEqual(seed);
    expect(
      (
        JSON.parse(
          checkpointWrite.values.at(-1) as string,
        ) as ForkCheckpointState
      ).review,
    ).toEqual(review);
    expect(control.buildsBound).toBe(1);
    expect(() => hooks.proofs.predecessor("unprovisioned")).toThrow();
    const tampered = structuredClone(predecessor);
    Object.assign(tampered.checkpoint!.state.outcome!, { outcomeHash: ah(99) });
    control.predecessors.set("tampered", tampered);
    expect(() =>
      rebuildReview({ ...seed, predecessor: "tampered" }, hooks.proofs),
    ).toThrow();
  });

  it("executes identical authenticated late evidence through the reconciliation writer with a new receipt/checkpoint and unchanged history", async () => {
    const row = await signedRow(true),
      { hooks, control } = archiveHooks();
    const queries: { sql: string; values: readonly unknown[] }[] = [];
    const repository = new PrismaCertifiedForkEffectRepository(
      readRunner(row, 101, queries),
      hooks,
    );
    const before = (await repository.loadReview(archiveReview.familyKey))
      .snapshot!;
    const evidence =
      before.checkpoint!.state.states[0]!.attempts[0]!.evidence[0]!;
    control.admissions.set("test-admission", archiveReview);
    control.evidence.set("original-success", evidence);
    const result = await reconcileCertifiedForkEffect(
      {
        enabled: true,
        repository,
        proofs: hooks.proofs,
        ownerProof: "test-principal",
      },
      {
        expected: before,
        commandId: "duplicate-evidence",
        command: {
          kind: "evidence",
          effectKey: evidence.effectKey,
          proof: "original-success",
        },
      },
    );
    expect(result.status).toBe("committed");
    if (!("loaded" in result)) throw new Error("missing_committed_result");
    const after = result.loaded.snapshot!;
    expect(after.version).toBe("2");
    expect(result.loaded.receipt!.version).toBe("2");
    expect(after.events).toEqual(before.events);
    expect(after.checkpoint!.state).toEqual(before.checkpoint!.state);
    expect(after.checkpoint!.proof).not.toBe(before.checkpoint!.proof);
    expect(after.checkpoint!.prefixLength).toBe(6);
    expect(after.checkpoint!.prefixHash).toBe(before.checkpoint!.prefixHash);
    expect(after.checkpoint!.anchorHash).not.toBe(
      before.checkpoint!.anchorHash,
    );
    expect(after.checkpoint!.position).toEqual({
      commandId: result.loaded.receipt!.commandId,
      commandHash: result.loaded.receipt!.commandHash,
    });
    expect(control.mutations).toBe(1);
    expect(
      queries.filter((q) =>
        /^INSERT INTO public."CertifiedFork(?:Version|Receipt|Checkpoint)"/u.test(
          q.sql,
        ),
      ),
    ).toHaveLength(3);
    // A substituted authority is not identical authenticated late evidence.
    control.evidence.set("substituted", { ...evidence, authorityHash: ah(99) });
    const writes = queries.filter((q) =>
      q.sql.startsWith('INSERT INTO public."CertifiedForkVersion"'),
    ).length;
    await expect(
      reconcileCertifiedForkEffect(
        {
          enabled: true,
          repository,
          proofs: hooks.proofs,
          ownerProof: "test-principal",
        },
        {
          expected: before,
          commandId: "bad-evidence",
          command: {
            kind: "evidence",
            effectKey: evidence.effectKey,
            proof: "substituted",
          },
        },
      ),
    ).rejects.toThrow();
    expect(
      queries.filter((q) =>
        q.sql.startsWith('INSERT INTO public."CertifiedForkVersion"'),
      ),
    ).toHaveLength(writes);
  });

  it("authenticates every nested inventory/output/outcome/evidence byte on a fresh repository load", async () => {
    const original = await signedRow(true);
    const loaded = await new PrismaCertifiedForkEffectRepository(
      readRunner(original),
      archiveHooks().hooks,
    ).loadReview(archiveReview.familyKey);
    expect(loaded.snapshot!.events).toHaveLength(6);
    expect(loaded.snapshot!.checkpoint!.state.outcome!.status).toBe(
      "completed",
    );
    const edits = [
      (s: ForkCheckpointState) =>
        Object.assign(s.inventory!.output!, { canonicalOutputHash: ah(99) }),
      (s: ForkCheckpointState) =>
        Object.assign(s.inventory!.durability!, { commitReceiptHash: ah(99) }),
      (s: ForkCheckpointState) =>
        Object.assign(s.inventory!.entries[0]!.request.facts, {
          contextHash: ah(99),
        }),
      (s: ForkCheckpointState) =>
        Object.assign(s.states[0]!.attempts[0]!.evidence[0]!, {
          authorityHash: ah(99),
        }),
      (s: ForkCheckpointState) =>
        Object.assign(s.outcome!.states[0]!.attempts[0]!, {
          originOwnerHash: ah(99),
        }),
      (s: ForkCheckpointState) =>
        Object.assign(s.outcome!.output!, { outputHash: ah(99) }),
      (s: ForkCheckpointState) =>
        Object.assign(s.outcome!.inventory!, { inventoryHash: ah(99) }),
    ];
    for (const edit of edits) {
      const row = structuredClone(original);
      edit(row.state as ForkCheckpointState);
      await expect(
        new PrismaCertifiedForkEffectRepository(
          readRunner(row),
          archiveHooks().hooks,
        ).loadReview(archiveReview.familyKey),
      ).rejects.toThrow();
    }
  });

  it("uses the caller Prisma transaction connection and ReadCommitted once", async () => {
    const query = vi.fn().mockResolvedValue([{ at: 1n }]);
    const $transaction = vi.fn(async (work, options: unknown) => {
      expect(options).toEqual({ isolationLevel: "ReadCommitted" });
      return work({ $queryRawUnsafe: query });
    });
    const runner = prismaForkArchiveTransactions({ $transaction });
    expect(
      await runner.run("read", (sql) => sql.query("SELECT $1::bigint", ["1"])),
    ).toEqual({ rows: [{ at: 1n }] });
    expect($transaction).toHaveBeenCalledTimes(1);
    expect($transaction.mock.calls[0]![1]).toEqual({
      isolationLevel: "ReadCommitted",
    });
    expect(query).toHaveBeenCalledWith("SELECT $1::bigint", "1");
  });
});
